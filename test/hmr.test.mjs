import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createServer } from '../dist/index.js'

async function createHmrFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-hmr-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
  )
  fs.writeFileSync(
    path.join(root, 'src/main.ts'),
    [
      "import { value } from './dep.ts'",
      "import './style.css'",
      'globalThis.__fixtureValue = value',
      'if (import.meta.hot) {',
      "  import.meta.hot.accept('./dep.ts', (mod) => {",
      '    globalThis.__fixtureValue = mod.value',
      '  })',
      '}',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(root, 'src/dep.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(root, 'src/style.css'), 'body { color: red }\n')
  fs.writeFileSync(
    path.join(root, 'src/Component.tsx'),
    "import { label } from './leaf.ts'\nexport function Component() { return <div>{label}</div> }\n",
  )
  fs.writeFileSync(path.join(root, 'src/leaf.ts'), "export const label = 'old'\n")
  fs.writeFileSync(
    path.join(root, 'src/diamond.ts'),
    "import './left.ts'\nimport './right.ts'\nif (import.meta.hot) import.meta.hot.accept('./left.ts', () => {})\n",
  )
  fs.writeFileSync(path.join(root, 'src/left.ts'), "import './shared.ts'\n")
  fs.writeFileSync(path.join(root, 'src/right.ts'), "import './shared.ts'\n")
  fs.writeFileSync(path.join(root, 'src/shared.ts'), 'export const shared = true\n')
  fs.writeFileSync(
    path.join(root, 'src/docs.ts'),
    [
      "export const docs = \"import.meta.hot.accept('./dep.ts')\"",
      'export const pattern = /import\\.meta\\.hot\\.accept/',
      '// import.meta.hot.accept()',
    ].join('\n'),
  )

  const server = await createServer({
    root,
    logLevel: 'silent',
    server: { port: 0 },
  })
  await server.listen(0)
  t.after(async () => {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, server }
}

test('unbundled HMR records explicit accept boundaries and propagates timestamps', async (t) => {
  const { root, server } = await createHmrFixture(t)

  const mainResult = await server.transformRequest('/src/main.ts')
  await server.transformRequest('/src/dep.ts')
  await server.transformRequest('/src/style.css')
  const componentResult = await server.transformRequest('/src/Component.tsx')
  await server.transformRequest('/src/leaf.ts')
  await server.transformRequest('/src/diamond.ts')
  await server.transformRequest('/src/left.ts')
  await server.transformRequest('/src/right.ts')
  await server.transformRequest('/src/shared.ts')
  const docsResult = await server.transformRequest('/src/docs.ts')

  const main = server.moduleGraph.getModuleByUrl('/src/main.ts')
  const dep = server.moduleGraph.getModuleByUrl('/src/dep.ts')
  const style = server.moduleGraph.getModuleByUrl('/src/style.css')
  assert.ok(main)
  assert.ok(dep)
  assert.ok(style)
  assert.ok(main.importedModules.has(dep))
  assert.ok(main.acceptedHmrDeps.has(dep))
  assert.equal(style.isSelfAccepting, true)
  assert.match(mainResult.code, /accept\("\/src\/dep\.ts"/)

  assert.deepEqual(server.moduleGraph.getHmrBoundaries(dep), [
    { boundary: main, acceptedVia: dep },
  ])

  const component = server.moduleGraph.getModuleByUrl('/src/Component.tsx')
  const leaf = server.moduleGraph.getModuleByUrl('/src/leaf.ts')
  assert.deepEqual(server.moduleGraph.getHmrBoundaries(leaf), [
    { boundary: component, acceptedVia: component },
  ])
  assert.match(componentResult.code, /validateRefreshBoundaryAndEnqueueUpdate/)

  // 菱形图中只有 left 分支被入口接受，right 分支仍应形成死路并要求 full reload。
  const shared = server.moduleGraph.getModuleByUrl('/src/shared.ts')
  assert.deepEqual(server.moduleGraph.getHmrBoundaries(shared), [])

  const docs = server.moduleGraph.getModuleByUrl('/src/docs.ts')
  assert.equal(docs.isSelfAccepting, false)
  assert.doesNotMatch(docsResult.code, /createHotContext/)
  assert.match(docsResult.code, /import\.meta\.hot\.accept/)

  // 显式 accept 会在 main 前停止；自接受 React 边界则会失效并重转，沿依赖链加时间戳。
  server.moduleGraph.invalidateModuleAndImporters(dep, 123456)
  assert.ok(main.transformResult)
  server.moduleGraph.invalidateModuleAndImporters(leaf, 123456)
  const updatedComponent = await server.transformRequest('/src/Component.tsx?t=123456')
  assert.match(updatedComponent.code, /from ["']\/src\/leaf\.ts\?t=123456["']/)
  assert.equal(server.moduleGraph.getModuleByUrl('/src/Component.tsx?t=123456'), component)

  // 删除 CSS import 后必须发送 prune，否则取消整页刷新会让旧 <style> 永久残留。
  await server.watcher.unwatch(root)
  const payloads = []
  const originalSend = server.ws.send
  server.ws.send = (payload) => payloads.push(payload)
  fs.writeFileSync(
    path.join(root, 'src/main.ts'),
    [
      "import { value } from './dep.ts'",
      'globalThis.__fixtureValue = value',
      'if (import.meta.hot) {',
      "  import.meta.hot.accept('./dep.ts', (mod) => {",
      '    globalThis.__fixtureValue = mod.value',
      '  })',
      '}',
    ].join('\n'),
  )
  server.moduleGraph.invalidateModule(main, 123457)
  await server.transformRequest('/src/main.ts?t=123457')
  server.ws.send = originalSend
  assert.ok(payloads.some((payload) =>
    payload.type === 'prune' && payload.paths.includes('/src/style.css')
  ))
})

test('HMR client applies updates without page reload and preserves hot.data', async (t) => {
  const { root, server } = await createHmrFixture(t)
  const clientResponse = await fetch(
    `http://localhost:${server.config.server.port}/@nasti/client`,
  )
  assert.equal(clientResponse.status, 200)
  const clientCode = await clientResponse.text()

  const previousGlobals = {
    WebSocket: globalThis.WebSocket,
    document: globalThis.document,
    location: globalThis.location,
  }
  let reloads = 0

  class FakeWebSocket {
    static instance

    constructor(url, protocol) {
      this.url = url
      this.protocol = protocol
      this.listeners = new Map()
      FakeWebSocket.instance = this
    }

    addEventListener(event, listener) {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
    }

    async dispatch(event, payload) {
      for (const listener of this.listeners.get(event) ?? []) {
        await listener(payload)
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.location = {
    protocol: 'http:',
    host: `localhost:${server.config.server.port}`,
    reload() {
      reloads++
    },
  }
  globalThis.document = {
    getElementById() {
      return null
    },
    createElement() {
      throw new Error('error overlay should not be created for a valid update')
    },
  }

  t.after(() => {
    globalThis.WebSocket = previousGlobals.WebSocket
    globalThis.document = previousGlobals.document
    globalThis.location = previousGlobals.location
  })

  const encodedClient = Buffer.from(clientCode).toString('base64')
  const client = await import(`data:text/javascript;base64,${encodedClient}#${Date.now()}`)
  assert.equal(FakeWebSocket.instance.protocol, 'nasti-hmr')

  const updatedFile = path.join(root, 'updated.mjs')
  fs.writeFileSync(updatedFile, 'export const value = 2\n')
  const ownerPath = pathToFileURL(updatedFile).href
  const hot = client.createHotContext(ownerPath)
  hot.data.counter = 41

  let disposedData
  let acceptedValue
  hot.dispose((data) => {
    disposedData = data
    data.counter++
  })
  hot.accept((mod) => {
    acceptedValue = mod.value
  })

  await FakeWebSocket.instance.dispatch('message', {
    data: JSON.stringify({
      type: 'update',
      updates: [
        {
          type: 'js-update',
          path: ownerPath,
          acceptedPath: ownerPath,
          timestamp: Date.now(),
        },
      ],
    }),
  })

  assert.equal(acceptedValue, 2)
  assert.equal(disposedData, hot.data)
  assert.equal(reloads, 0)

  const nextHot = client.createHotContext(ownerPath)
  assert.equal(nextHot.data, hot.data)
  assert.equal(nextHot.data.counter, 42)

  await FakeWebSocket.instance.dispatch('message', {
    data: JSON.stringify({ type: 'full-reload', path: '*' }),
  })
  assert.equal(reloads, 1)
})
