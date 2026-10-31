import { readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const src = readFileSync('packages/aurora-system-stats/lib/client.js', 'utf8')
const pending = []
const patched = Object.create(React)
patched.useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
patched.useEffect = () => {}
patched.useRef = (v) => ({ current: v })
patched.useCallback = (fn) => fn
patched.useMemo = (fn) => fn()
const snapshot = { sampledAt: 0, seq: 1, hostname: 'h', platform: 'linux', arch: 'x64', release: 'r',
  uptime: 1000, cpuCount: 4, cpuModel: 'm', cpuUsage: 0.25, cpuCores: [0.2,0.3,0.25,0.2],
  cpuBusyMs: 1, load: [0.5,0.4,0.3], memory: { total: 8e9, used: 4e9, free: 4e9, available: 4e9, ratio: 0.5 },
  swap: null, disks: [], proc: { rss: 1e8, heapUsed: 5e7 } }
patched.useState = (init) => {
  const v = typeof init === 'function' ? init() : init
  if (v && typeof v === 'object' && Array.isArray(v.cpuHistory)) return [{ snapshot, live: true, failures: 0, cpuHistory: [0.2], memHistory: [0.5] }, () => {}]
  return [v, () => {}]
}
const context = {
  AbortController,
  window: { innerWidth: 1440, innerHeight: 900, __ModuleLoader__: { mode: 'queue', pendingQueue: pending, load(r) { pending.push(r) } }, addEventListener() {}, removeEventListener() {} },
  document: { documentElement: { lang: 'en' }, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector() { return null }, createElement() { return { dataset: {} } }, head: { appendChild() {} } },
  navigator: { language: 'en' }, localStorage: { getItem() { return null }, setItem() {} }, console,
  require: (s) => (s === 'react' ? patched : require(s)),
  MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
  setInterval, clearInterval, setTimeout: () => 0, clearTimeout() {}, fetch: async () => { throw new Error('x') },
}
vm.createContext(context)
vm.runInContext(src, context, { filename: 'c.js' })
const mod = pending[0].factory(context.require)
let Entry = null
mod.apply({ slots: { inject(s, cb) { cb() }, register(o, c) { Entry = c; return () => {} } } }, {})
const html = renderToStaticMarkup(Entry())
const m = /<svg class="aurora-ball-svg"[^>]*>[\s\S]*?<\/svg>/.exec(html)
if (!m) throw new Error('no svg found')
let svg = m[0]
  .replace(/var\(--aurora-surface\)/g, '#f7f7f8')
  .replace(/color-mix\(in srgb, var\(--aurora-surface\) 88%, var\(--aurora-brand\)\)/g, '#eef1fa')
  .replace(/color-mix\(in srgb, var\(--aurora-surface\) 78%, var\(--aurora-brand\)\)/g, '#e8edf9')
  .replace(/var\(--aurora-glass\)/g, '#f2f5ff')
  .replace(/var\(--aurora-glass-edge\)/g, '#cfcfcf')
  .replace(/\swidth="[^"]*"/, ' width="240"')
  .replace(/\sheight="[^"]*"/, ' height="240"')
  .replace(/class="aurora-ball-svg"/, 'class="aurora-ball-svg" xmlns="http://www.w3.org/2000/svg"')
writeFileSync('/tmp/ball.svg', svg)
console.log('svg bytes', svg.length)
console.log(svg.slice(0, 200))
