import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import * as esm from '../dist/index.js'

const cjs = createRequire(import.meta.url)('../dist/index.cjs')

async function fixture(t, api) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-watcher-change-'))
  let server
  t.after(async () => {
    try {
      await server?.close()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  for (const [name, source] of Object.entries({
    'package.json': '{"type":"module"}',
    'entry.js': 'import { value } from "./middle.js"; export { value };',
    'middle.js': 'import { value } from "./dep.js"; export { value };',
    'dep.js': 'export const value = "before";',
  })) await fs.writeFile(path.join(root, name), source)
  // A whole-second mtime survives utimes round-trips without precision loss.
  const seconds = Math.floor(Date.now() / 1000)
  await fs.utimes(path.join(root, 'dep.js'), seconds, seconds)
  server = await api.createServer({
    root, configFile: false, logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', hmr: false },
  })
  return { root, server, dep: path.join(root, 'dep.js'), mtimeSeconds: seconds }
}

async function fileEvent(server, event, file, mutate) {
  let cleanup
  const observed = new Promise((resolve, reject) => {
    const onEvent = (changed) => {
      if (path.resolve(changed) !== path.resolve(file)) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for real watcher ${event}: ${file}`))
    }, 5000)
    cleanup = () => {
      clearTimeout(timer)
      server.watcher.off(event, onEvent)
    }
    server.watcher.on(event, onEvent)
  })
  try {
    // Attach a rejection handler before mutating so cleanup cannot leave an
    // unhandled timeout if the mutation fails.
    await Promise.all([observed, mutate()])
  } finally {
    cleanup()
  }
}

for (const [format, api] of [['esm', esm], ['cjs', cjs]]) {
  test(`${format}: real watcher preserves the last write in rapid SSR edit bursts`,
    { timeout: 20000 }, async (t) => {
      const { server, dep } = await fixture(t, api)
      assert.equal((await server.ssrLoadModule('/entry.js')).value, 'before')
      const graph = server.environments.ssr.moduleGraph
      const entry = graph.getModuleByUrl('/entry.js')
      assert.ok(entry.transformResult)
      // Each next edit follows the preceding change immediately, inside
      // Chokidar's 5 ms native / 50 ms change throttle windows. No sleeps,
      // synthetic events, mutation retries, or polling mode.
      for (let i = 0; i < 12; i++) {
        const value = `edit-${String(i).padStart(2, '0')}`
        await fileEvent(server, 'change', dep,
          () => fs.writeFile(dep, `export const value = "${value}";`))
        assert.equal(entry.transformResult, null)
        assert.equal((await server.ssrLoadModule('/entry.js')).value, value)
      }
      await fileEvent(server, 'unlink', dep, () => fs.rm(dep))
      await assert.rejects(server.ssrLoadModule('/entry.js'), /cannot load|resolve|ENOENT/i)
      await fileEvent(server, 'add', dep,
        () => fs.writeFile(dep, 'export const value = "recreated";'))
      assert.equal((await server.ssrLoadModule('/entry.js')).value, 'recreated')
    })

  test(`${format}: watcher ignores read-only metadata and unwatched files`,
    { timeout: 10000 }, async (t) => {
      const { server, dep, mtimeSeconds } = await fixture(t, api)
      await server.ssrLoadModule('/entry.js')
      const events = []
      server.watcher.on('change', (file) => {
        if (path.resolve(file) === dep) events.push(file)
      })
      // Explicit access-time updates make this independent of relatime/noatime.
      const before = await fs.stat(dep)
      // Reuse the original seconds: converting a rounded NTFS mtimeMs back to
      // seconds can actually change mtime, making this no longer a read-only test.
      await fs.utimes(dep, new Date(Date.now() + 1000), mtimeSeconds)
      assert.equal((await fs.stat(dep)).mtimeMs, before.mtimeMs)
      await fs.readFile(dep)
      await delay(150)
      assert.deepEqual(events, [], 'reads must not trigger an SSR reload loop')
      await server.watcher.unwatch(dep)
      await fs.writeFile(dep, 'export const value = "unwatched";')
      await delay(150)
      assert.deepEqual(events, [], 'parent raw events must respect unwatch')
    })

  test(`${format}: close cancels a pending recheck on a still-watched file`,
    { timeout: 10000 }, async (t) => {
      const { server, dep } = await fixture(t, api)
      await server.ssrLoadModule('/entry.js')
      const raw = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing native raw event')), 5000)
        server.watcher.once('raw', () => { clearTimeout(timer); resolve() })
      })
      const before = await fs.stat(dep)
      await Promise.all([
        raw,
        fs.utimes(dep, new Date(Date.now() + 1000), before.mtimeMs / 1000),
      ])
      await server.close()
      const events = []
      // close removes old listeners; new listeners can observe a rogue callback.
      server.watcher.on('all', (...event) => events.push(event))
      await fs.writeFile(dep, 'export const value = "closed";')
      await delay(100)
      assert.deepEqual(events, [], 'close must cancel pending native rechecks')
    })

  test(`${format}: atomic replacements stay changes and ignored files stay unwatched`,
    { timeout: 10000 }, async (t) => {
      const { root, server, dep } = await fixture(t, api)
      assert.equal((await server.ssrLoadModule('/entry.js')).value, 'before')
      const events = []
      server.watcher.on('all', (event, file) => {
        events.push([event, path.resolve(file)])
      })
      for (const value of ['atomic-1', 'atomic-2']) {
        const replacement = `${dep}.tmp`
        await fs.writeFile(replacement, `export const value = "${value}";`)
        await fileEvent(server, 'change', dep, () => fs.rename(replacement, dep))
        assert.equal((await server.ssrLoadModule('/entry.js')).value, value)
      }
      const ignored = ['.git', 'node_modules', '.nasti', 'dist']
        .map((directory) => path.join(root, directory, 'ignored.js'))
      for (const file of ignored) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, 'export const ignored = true;')
      }
      await delay(200)
      assert.deepEqual(events.filter(([, file]) => file === dep).map(([event]) => event),
        ['change', 'change'], 'native and trailing events must not double-notify')
      assert.deepEqual(events.filter(([, file]) => ignored.includes(file)), [])
    })

  test(`${format}: trailing recovery reconciles a pending atomic unlink`,
    { timeout: 10000 }, async (t) => {
      const { server, dep } = await fixture(t, api)
      await server.ssrLoadModule('/entry.js')
      await fileEvent(server, 'change', dep,
        () => fs.writeFile(dep, 'export const value = "first";'))
      const events = []
      server.watcher.on('all', (event, file) => {
        if (path.resolve(file) === dep) events.push(event)
      })
      // Unit-level adverse-path setup: model a native unlink whose matching
      // add was lost. Use Chokidar's normalization API to queue its real atomic
      // timer; the replacement and recovered change below are real disk events.
      await server.watcher._emit('unlink', dep)
      const replacement = `${dep}.tmp`
      await fs.writeFile(replacement, 'export const value = "recovered";')
      await fileEvent(server, 'change', dep, () => fs.rename(replacement, dep))
      assert.equal((await server.ssrLoadModule('/entry.js')).value, 'recovered')
      await delay(200)
      assert.deepEqual(events, ['change'], 'no stale atomic unlink after recovery')
      // Even when raw delivery/replacement is later than the atomic timer,
      // an extant file must retain its snapshot and stay eligible for recovery.
      await server.watcher._emit('unlink', dep)
      await delay(150)
      assert.deepEqual(events, ['change'], 'expiry must not unlink an extant file')
      await fs.writeFile(replacement, 'export const value = "late";')
      await fileEvent(server, 'change', dep, () => fs.rename(replacement, dep))
      assert.equal((await server.ssrLoadModule('/entry.js')).value, 'late')
      await delay(200)
      assert.deepEqual(events, ['change', 'change'])
    })

  test(`${format}: dynamically added paths preserve ignoreInitial and recover edits`,
    { timeout: 10000 }, async (t) => {
      const { server } = await fixture(t, api)
      const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-watcher-extra-'))
      t.after(() => fs.rm(extra, { recursive: true, force: true }))
      const file = path.join(extra, 'existing.js')
      await fs.writeFile(file, 'export const value = "existing";')
      const adds = []
      server.watcher.on('add', (added) => adds.push(added))
      server.watcher.add(extra)
      // Chokidar emits ready only once. Wait for its watch registration, not
      // file contents or an invalidation fallback, before editing a new target.
      const deadline = Date.now() + 5000
      while (!Object.entries(server.watcher.getWatched()).some(([directory, files]) =>
        path.resolve(directory) === extra && files.includes('existing.js'))) {
        assert.ok(Date.now() < deadline, 'dynamic target must become watched')
        await delay(5)
      }
      assert.deepEqual(adds, [], 'existing files must not cause an add/HMR storm')
      for (let i = 0; i < 4; i++) {
        await fileEvent(server, 'change', file,
          () => fs.writeFile(file, `export const value = "${i}";`))
      }
    })
}
