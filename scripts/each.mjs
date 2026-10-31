#!/usr/bin/env node
/**
 * Run one script in every package of the workspace, without requiring pnpm.
 *
 * `node scripts/each.mjs build` reads each `packages/<name>/package.json` and runs
 * that package's own `build` script in dependency order (so a package that
 * depends on a sibling builds after it). `dev` runs them all at once and keeps
 * going until interrupted.
 * @module aurora/scripts/each
 */

import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const task = process.argv[2]
if (task === undefined) {
  console.error('usage: node scripts/each.mjs <build|dev|typecheck>')
  process.exit(2)
}

/** Every workspace package with its manifest and script. */
const packages = []
for (const entry of await readdir(join(REPO, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(REPO, 'packages', entry.name)
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const command = manifest.scripts?.[task]
  if (command === undefined) continue
  packages.push({
    name: manifest.name,
    dir,
    command,
    dependencies: Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }),
  })
}

if (packages.length === 0) {
  console.error(`no package defines a "${task}" script`)
  process.exit(1)
}

/** Run one package script, resolving when it exits. */
function run(pkg) {
  // The workspace's own tool binaries first, so package scripts need no global install.
  const env = { ...process.env, PATH: `${join(REPO, 'node_modules/.bin')}:${process.env.PATH ?? ''}` }
  return new Promise((resolveRun) => {
    const child = spawn(pkg.command, { shell: true, cwd: pkg.dir, stdio: 'inherit', env })
    child.on('exit', (code) => resolveRun({ name: pkg.name, code: code ?? 1 }))
  })
}

if (task === 'dev') {
  // Watchers never exit on their own: start them all and stop together.
  const env = { ...process.env, PATH: `${join(REPO, 'node_modules/.bin')}:${process.env.PATH ?? ''}` }
  const children = packages.map((pkg) => spawn(pkg.command, { shell: true, cwd: pkg.dir, stdio: 'inherit', env }))
  const stop = () => {
    for (const child of children) child.kill('SIGTERM')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else {
  // Dependency order: a package builds after every sibling it names.
  const order = []
  const pending = new Set(packages)
  while (pending.size > 0) {
    const ready = [...pending].filter(
      (pkg) => !pkg.dependencies.some((dep) => [...pending].some((other) => other.name === dep)),
    )
    if (ready.length === 0) {
      order.push(...pending)
      break
    }
    for (const pkg of ready) {
      order.push(pkg)
      pending.delete(pkg)
    }
  }
  let failed = 0
  for (const pkg of order) {
    const { code } = await run(pkg)
    if (code !== 0) {
      failed += 1
      console.error(`\n${pkg.name}: "${task}" exited ${code}`)
      if (task === 'build') break
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}
