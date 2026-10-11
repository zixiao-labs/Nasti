import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createServer } from '../dist/index.js'

async function fixture(t, { realWatcher = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-invalidation-'))
  let server
  t.after(async () => {
    try {
      await server?.close()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true,"type":"module"}')
  fs.writeFileSync(path.join(root, 'src/entry.ts'),
    "import { value } from './middle.ts'\nexport const render = () => value\n")
  fs.writeFileSync(path.join(root, 'src/middle.ts'),
    "import { value as dep } from './dep.ts'\nexport const value = `middle:${dep}`\n")
  const dep = path.join(root, 'src/dep.ts')
  fs.writeFileSync(dep, 'export const value = "old"\n')
  server = await createServer({ root, logLevel: 'silent' })
  if (!realWatcher) await server.watcher.unwatch(root)
  return { server, root, dep }
}

test('SSR change invalidates transitive importers on the next load', { timeout: 10000 }, async (t) => {
  const { server, dep } = await fixture(t)
  assert.equal((await server.ssrLoadModule('/src/entry.ts')).render(), 'middle:old')
  fs.writeFileSync(dep, 'export const value = "new"\n')
  server.watcher.emit('change', dep)
  assert.equal((await server.ssrLoadModule('/src/entry.ts')).render(), 'middle:new')
})

test('SSR unlink rejects instead of returning stale importer exports', { timeout: 10000 }, async (t) => {
  const { server, dep } = await fixture(t)
  assert.equal((await server.ssrLoadModule('/src/entry.ts')).render(), 'middle:old')
  fs.unlinkSync(dep)
  server.watcher.emit('unlink', dep)
  await assert.rejects(server.ssrLoadModule('/src/entry.ts'), /cannot load module:.*dep\.ts/)
})

test('SSR add recovers a previously missing transitive dependency', { timeout: 10000 }, async (t) => {
  const { server, dep } = await fixture(t)
  fs.unlinkSync(dep)
  await assert.rejects(server.ssrLoadModule('/src/entry.ts'), /cannot load module:.*dep\.ts/)
  fs.writeFileSync(dep, 'export const value = "created"\n')
  server.watcher.emit('add', dep)
  assert.equal((await server.ssrLoadModule('/src/entry.ts')).render(), 'middle:created')
})

test('SSR change invalidates extension aliases', { timeout: 10000 }, async (t) => {
  const { server, root, dep } = await fixture(t)
  fs.writeFileSync(path.join(root, 'src/aliases.ts'),
    "import { value as a } from './dep'\nimport { value as b } from './dep.ts'\nexport const value = `${a}:${b}`\n")
  const urls = ['/src/aliases.ts', '/src/aliases']
  for (const url of urls) assert.equal((await server.ssrLoadModule(url)).value, 'old:old')
  fs.writeFileSync(dep, 'export const value = "new"\n')
  server.watcher.emit('change', dep)
  for (const url of urls) assert.equal((await server.ssrLoadModule(url)).value, 'new:new')
})

test('file events clear server transform graphs without using client HMR boundaries', { timeout: 10000 }, async (t) => {
  const { server, root, dep } = await fixture(t)
  const graph = server.environments.ssr.moduleGraph
  const dependency = await graph.ensureEntryFromUrl('/src/dep.ts')
  const importer = await graph.ensureEntryFromUrl('/src/middle.ts')
  graph.registerModule(dependency, dep)
  graph.registerModule(importer, path.join(root, 'src/middle.ts'))
  await graph.updateModuleInfo(importer, new Set([dependency.url]), new Set([dependency.url]), true)
  for (const event of ['change', 'unlink', 'add']) {
    dependency.transformResult = { code: 'old dependency' }
    importer.transformResult = { code: 'old importer' }
    const version = importer.invalidationVersion
    server.watcher.emit(event, dep)
    assert.equal(dependency.transformResult, null)
    assert.equal(importer.transformResult, null)
    assert.ok(importer.invalidationVersion > version)
  }
})

test('an old in-flight failure cannot evict the replacement SSR cache entry', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-inflight-'))
  let server
  let failOld
  t.after(async () => {
    failOld?.(new Error('test cleanup'))
    await server?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'src'))
  const entry = path.join(root, 'src/entry.js')
  fs.writeFileSync(entry, 'export const value = "new";')
  let started
  const loading = new Promise((resolve) => { started = resolve })
  let first = true
  server = await createServer({
    root,
    logLevel: 'silent',
    plugins: [{
      name: 'fixture:delayed-load',
      load(id) {
        if (id !== entry || !first) return null
        first = false
        started()
        return new Promise((_, reject) => { failOld = reject })
      },
    }],
  })
  await server.watcher.unwatch(root)
  const old = assert.rejects(server.ssrLoadModule(entry), /old load failed/)
  await loading
  server.watcher.emit('change', entry)
  const replacement = await server.ssrLoadModule(entry)
  failOld(new Error('old load failed'))
  await old
  assert.equal((await server.ssrLoadModule(entry)), replacement)
})

test('SSR real watcher change updates the next load', { timeout: 10000 }, async (t) => {
  const { server, dep } = await fixture(t, { realWatcher: true })
  assert.equal((await server.ssrLoadModule('/src/entry.ts')).render(), 'middle:old')
  const changed = new Promise((resolve, reject) => {
    const onChange = (file) => {
      if (file !== dep) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for dependency change'))
    }, 5000)
    const cleanup = () => {
      clearTimeout(timer)
      server.watcher.off('change', onChange)
    }
    t.after(cleanup)
    server.watcher.on('change', onChange)
  })
  fs.writeFileSync(dep, 'export const value = "watched"\n')
  await changed
  assert.equal((await server.ssrLoadModule('/src/entry.ts')).render(), 'middle:watched')
})
