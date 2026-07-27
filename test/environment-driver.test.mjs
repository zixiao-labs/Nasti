import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { build, createServer } from '../dist/index.js'

test('external environment driver receives shared plugin API and app lifecycle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-driver-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { react: '^19.0.0' } }),
  )

  const events = []
  const apiKey = Symbol('driver-fixture')
  const consumer = {
    name: 'fixture:consumer',
    pre: ['fixture:provider'],
    setup(api) {
      events.push(`consumer:${api.useExposed(apiKey)}`)
    },
  }
  const provider = {
    name: 'fixture:provider',
    setup(api) {
      events.push('provider')
      api.expose(apiKey, 'ready')
    },
  }
  const driverPlugin = {
    name: 'fixture:driver',
    createEnvironmentDriver(environment, api) {
      if (environment.options.driver !== 'fixture') return
      assert.equal(api.useExposed(apiKey), 'ready')
      return {
        name: 'fixture',
        async build() {
          events.push('build')
          return {
            output: [
              {
                type: 'asset',
                fileName: 'main.fixture.bundle',
                source: 'fixture',
              },
            ],
            entries: { main: 'main.fixture.bundle' },
            publicPath: 'http://localhost:3000/main.fixture.bundle',
          }
        },
        async close() {
          events.push('close')
        },
      }
    },
    afterBuildApp(results, api) {
      assert.equal(api.useExposed(apiKey), 'ready')
      assert.equal(results.client.entries.main, 'main.fixture.bundle')
      events.push('afterBuildApp')
    },
  }

  const result = await build({
    root,
    logLevel: 'silent',
    plugins: [consumer, provider, driverPlugin],
    environments: {
      client: { driver: 'fixture' },
    },
  })

  assert.deepEqual(events, [
    'provider',
    'consumer:ready',
    'build',
    'afterBuildApp',
    'close',
  ])
  assert.equal(result.output[0].fileName, 'main.fixture.bundle')
  assert.equal(result.environmentResults.client.publicPath, 'http://localhost:3000/main.fixture.bundle')
})

test('plugin setup dependency cycles fail during config resolution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-driver-cycle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))

  await assert.rejects(
    () =>
      build({
        root,
        logLevel: 'silent',
        plugins: [
          { name: 'fixture:a', pre: ['fixture:b'] },
          { name: 'fixture:b', pre: ['fixture:a'] },
        ],
        environments: { client: { driver: 'never-reached' } },
      }),
    /circular plugin setup dependency/,
  )
})

test('external environment driver participates in dev serve, watch, and close', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-driver-dev-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><script type="module" src="/src/main.ts"></script>',
  )
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/main.ts'), 'export const ready = true')
  fs.writeFileSync(path.join(root, 'src/changed.ts'), 'export const changed = false')

  const events = []
  let resolveWatch
  const watched = new Promise((resolve) => {
    resolveWatch = resolve
  })
  const plugin = {
    name: 'fixture:dev-driver',
    createEnvironmentDriver(environment) {
      if (environment.options.driver !== 'fixture-dev') return
      return {
        name: 'fixture-dev',
        serve() {
          events.push('serve')
          return { localUrls: ['http://localhost:3999/main.lynx.bundle'] }
        },
        watchChange(file, event) {
          if (file.endsWith('changed.ts')) {
            events.push(`watch:${event}`)
            resolveWatch()
          }
        },
        close() {
          events.push('close')
        },
      }
    },
  }

  const server = await createServer({
    root,
    logLevel: 'silent',
    plugins: [plugin],
    environments: {
      lynx: { consumer: 'client', driver: 'fixture-dev' },
    },
    server: { port: 0 },
  })
  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 250)
    server.watcher.once('ready', () => {
      clearTimeout(fallback)
      resolve()
    })
  })
  try {
    await server.listen(0)
    assert.deepEqual(server.environmentServices.lynx.localUrls, [
      'http://localhost:3999/main.lynx.bundle',
    ])

    fs.writeFileSync(path.join(root, 'src/changed.ts'), 'export const changed = true')
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('driver watchChange timeout')),
        3000,
      )
      watched.then(() => {
        clearTimeout(timeout)
        resolve()
      }, reject)
    })
  } finally {
    await server.close()
  }

  assert.equal(events[0], 'serve')
  assert.equal(events[1], 'watch:change')
  assert.equal(events[2], 'close')
})
