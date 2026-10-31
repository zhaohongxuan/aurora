#!/usr/bin/env node
/**
 * Builds both halves of an Aurora plugin package.
 *
 * Run from a package directory (`pnpm --filter <pkg> build`). The script reads
 * `src/host/index.ts` and `src/client/index.ts` and writes:
 *
 *   lib/index.js     host Cordis plugin (ESM, Node, types via tsc)
 *   lib/client.js    browser bundle in the DSH loader format
 *
 * The browser bundle is wrapped the way the DSH client module system expects: a
 * classic script calling `window.__ModuleLoader__.load({ id, factory })`, with
 * React required from the shell's frozen module table instead of bundled. Every
 * other bare import would fail at materialization, so the wrapper refuses any
 * specifier outside that table.
 * @module aurora/scripts/build
 */

import { build, context } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
/** The package being built: always the directory the script is invoked from. */
const PKG_DIR = process.cwd()
const WATCH = process.argv.includes('--watch')

/** Modules the web shell seeds into its frozen module table. */
const SHELL_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
])

const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'))
const ID = pkg.name

/**
 * The bindings of one import statement.
 * @param {string} statement - a whole `import ... from "spec"` statement.
 * @returns {Array<{ local: string, imported: string | null }>} local names with the
 *   property each one reads; `null` means the whole module object (a namespace import).
 */
function localNames(statement) {
  const clause = statement
    .replace(/^import\s+/, '')
    .replace(/\s*from\s*["'][^"']+["'];?$/, '')
    .trim()
  const locals = []
  const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? ''
  const before = clause.replace(/\{[^}]*\}/, '')
  for (const piece of before.split(',')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(trimmed)
    if (namespace !== null) locals.push({ local: namespace[1], imported: null })
    else locals.push({ local: trimmed, imported: 'default' })
  }
  for (const piece of named.split(',')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const [imported, alias] = trimmed.split(/\s+as\s+/)
    locals.push({ local: (alias ?? imported).trim(), imported: imported.trim() })
  }
  return locals
}

/** A collision-free variable name for one imported module object. */
function moduleVar(specifier) {
  return `__m${specifier.replace(/[^a-zA-Z0-9]/g, '_')}`
}

/**
 * Wrap an ESM browser bundle into the loader registration format.
 *
 * `window.__ModuleLoader__.load` runs the factory as a plain function inside a
 * classic script, so the bundle must leave no `import` or `export` behind.
 * esbuild hoists every external import into a contiguous block at the top, which
 * is collected here and re-emitted as `require` bindings. Modules in one bundle
 * frequently import the same specifier with different local names, and duplicate
 * top-level declarations are a syntax error: the build emits exactly one
 * declaration per specifier and rebinds every other name onto it.
 * @param {string} body - bundled code whose imports are all hoisted to the top.
 * @returns {string} the classic script the module system executes.
 */
function wrapClient(input) {
  // esbuild keeps the sources' line endings, and CRLF would defeat the line-anchored
  // patterns below (`$` matches before a stray `\r` only in the ECMAScript sense).
  const body = input.replace(/\r\n/g, '\n')
  /** One entry per imported specifier: the bindings its first import statement declared. */
  const modules = new Map()
  /** Bindings introduced by later imports of an already-declared specifier. */
  const extra = []
  const importLine = /^import\s+[^;\n]*?from\s*["'][^"']+["'];?|^import\s*["'][^"']+["'];?/
  const HEADER = '/* aurora: hoisted imports, rewritten to require() by scripts/build.mjs */'

  // Every external import is a whole line above the first statement that is not an
  // import. Comments and blank lines between them belong to the split modules and
  // stay where they are, so the bundle's section headers keep their module.
  const kept = []
  const removed = new Set()
  let offset = 0
  for (const line of body.split('\n')) {
    const isImport = line.startsWith('import ') || line.startsWith('import\t')
    const statement = isImport ? importLine.exec(line)?.[0] : undefined
    if (statement === undefined) {
      kept.push(line.endsWith('\r') ? line.slice(0, -1) : line)
      offset += line.length + 1
      continue
    }
    const specifier = /["']([^"']+)["']/.exec(statement)?.[1] ?? ''
    if (specifier !== '' && !SHELL_MODULES.has(specifier)) {
      throw new Error(
        `${ID}: the client bundle imports "${specifier}", which the DSH module table does not provide. ` +
          'Only React, React DOM, cordis and zod may stay external — anything else must be bundled.',
      )
    }
    const bindings = localNames(statement)
    const first = modules.get(specifier)
    if (first === undefined) modules.set(specifier, bindings)
    // Later imports of the same specifier only expose properties of its object.
    else for (const binding of bindings) extra.push({ specifier, ...binding })
    removed.add(offset)
    kept.push(HEADER)
    offset += line.length + 1
  }
  // A bundle's re-export list spans several lines; join the source into one string
  // first, then drop it, so the guard below only sees what would really execute.
  const truncated = collapseBlocks(kept.join('\n'), /^export\s*\{[^}]*\}\s*;?[ \t]*$/gm)

  // Nothing may remain that a classic script cannot parse: once the hoisted block is
  // rewritten, a surviving import or top-level export means the bundle format moved.
  const leftover = /^import[ \t].*$/m.exec(truncated)
  if (leftover !== null && !leftover[0].startsWith(HEADER.slice(0, 9))) {
    throw new Error(`${ID}: the client bundle still imports after the hoisted block: ${leftover[0].trim()}`)
  }
  const exported = /^export\s+(?:(?:const|let|var|function|class|async)\s|default\s)/m.exec(truncated)
  if (exported !== null) {
    throw new Error(
      `${ID}: the client bundle carries a top-level export ("${exported[0].trim()}") that a classic script cannot parse`,
    )
  }

  const declared = new Set()
  const lines = []
  for (const [specifier, bindings] of modules) {
    const target = JSON.stringify(specifier)
    const object = moduleVar(specifier)
    if (bindings.length === 0) {
      lines.push(`    require(${target});`)
      continue
    }
    lines.push(`    var ${object} = require(${target});`)
    for (const { local, imported } of bindings) {
      if (declared.has(local)) continue
      declared.add(local)
      // A namespace binding keeps the whole object; anything else reads one property.
      lines.push(
        imported === null
          ? `    var ${local} = ${object};`
          : `    var ${local} = ${object}[${JSON.stringify(imported)}];`,
      )
    }
  }
  // Later imports of one specifier share its module object; their own names are
  // aliases, so only the property lookup is new.
  for (const { specifier, local, imported } of extra) {
    if (declared.has(local)) continue
    declared.add(local)
    const object = moduleVar(specifier)
    lines.push(
      imported === null
        ? `    var ${local} = ${object};`
        : `    var ${local} = ${object}[${JSON.stringify(imported)}];`,
    )
  }

  // Belt and braces: a re-export list can only appear at the end of a bundled entry,
  // so strip one more time from the final text before it enters the factory body.
  const rest = collapseBlocks(truncated, /^export\s*\{[^}]*\}\s*;?[ \t]*$/gm).replace(
    /^export\s+default\s+/gm,
    'module.exports.default = ',
  )

  return `/**
 * ${ID} ${pkg.version}
 * ${pkg.description ?? ''}
 * built ${new Date().toISOString()}
 * externals: ${[...modules.keys()].join(', ') || 'none'}
 */

window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${lines.join('\n')}
${rest}
    return module.exports;
  },
});
`
}

/**
 * Remove every match of `pattern` from `text`, including matches that span lines.
 * @param {string} text
 * @param {RegExp} pattern - a global, multiline pattern.
 * @returns {string}
 */
function collapseBlocks(text, pattern) {
  let previous = text
  for (let pass = 0; pass < 8; pass += 1) {
    const next = previous.replace(pattern, '')
    if (next === previous) return next
    previous = next
  }
  return previous
}

/** The package entry that re-exports the compiled host plugin. */
function hostWrapper() {
  return `// Package entry: the compiled host plugin lives in ./host/index.js.
export { apply, inject, name } from './host/index.js'
`
}

/** Write the browser bundle once esbuild hands back its text. */
async function writeClient(result) {
  const text = result.outputFiles?.[0]?.text
  if (text === undefined) return
  await mkdir(join(PKG_DIR, 'lib'), { recursive: true })
  await writeFile(join(PKG_DIR, 'lib/client.js'), wrapClient(text))
}

const CLIENT_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: [...SHELL_MODULES],
  legalComments: 'none',
  logLevel: 'warning',
  write: false,
}

/** Build both halves once, then emit declarations. */
async function once() {
  const out = join(PKG_DIR, 'lib')
  await mkdir(out, { recursive: true })

  const hostEntry = join(PKG_DIR, 'src/host/index.ts')
  if (existsSync(hostEntry)) {
    // Not bundled: one file per module, imports left as they are. The entry becomes
    // lib/host/index.js and rewrites the package path (see the export step below).
    // Both host sources are entry points: an ESM graph keeps one file per module,
    // but `bundle: false` alone would copy only the entry and leave imports broken.
    await build({
      entryPoints: [hostEntry, join(PKG_DIR, 'src/host/sampler.ts')],
      outdir: join(out, 'host'),
      bundle: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: true,
      logLevel: 'warning',
    })
  }

  const clientEntry = join(PKG_DIR, 'src/client/index.ts')
  if (existsSync(clientEntry)) {
    await writeClient(await build({ ...CLIENT_OPTIONS, entryPoints: [clientEntry] }))
  }

  // The package main is `lib/index.js`; the compiled host entry lives one level
  // down so a plain tree layout works whether or not the host half has a sibling
  // module, and the wrapper forwards the plugin face to it.
  if (existsSync(join(out, 'host/index.js'))) {
    await writeFile(join(out, 'index.js'), hostWrapper())
  }

  const tsconfig = join(PKG_DIR, 'tsconfig.json')
  const tsc = join(REPO, 'node_modules/.bin/tsc')
  if (existsSync(tsconfig) && existsSync(tsc)) {
    try {
      execFileSync(tsc, ['-p', tsconfig], { stdio: 'inherit', cwd: PKG_DIR })
    } catch {
      // Declaration emit is best effort: a type error must not block the artifact
      // that `typecheck` reports separately.
    }
  }

  process.stdout.write(`${ID}: built ${existsSync(join(out, 'client.js')) ? 'host + client' : 'host'}\n`)
}

if (WATCH) {
  const clientEntry = join(PKG_DIR, 'src/client/index.ts')
  const hostEntry = join(PKG_DIR, 'src/host/index.ts')
  const watcher = await context({
    ...CLIENT_OPTIONS,
    entryPoints: [clientEntry, hostEntry],
    plugins: [
      {
        name: 'aurora-wrap',
        setup(builder) {
          builder.onEnd(async (result) => {
            if (result.errors.length > 0) return
            await writeClient(result)
            // Touch the entry so the DSH HMR revision advances on a rebuild.
            const stamp = new Date()
            await stat(join(PKG_DIR, 'lib/client.js')).catch(() => undefined)
            await writeFile(join(PKG_DIR, 'lib/.rebuilt'), stamp.toISOString())
            process.stdout.write(`${ID}: client rebuilt ${stamp.toLocaleTimeString()}\n`)
          })
        },
      },
    ],
  })
  await watcher.watch()
  process.stdout.write(`${ID}: watching src/host and src/client\n`)
} else {
  await once()
}
