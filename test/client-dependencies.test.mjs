import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createServer, resolveConfig } from '../dist/index.js'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-client-deps-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true,"type":"module"}')
  const pkg = path.join(root, 'node_modules/fixture')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'fixture', type: 'module',
    exports: { '.': { browser: './client.js', node: './server.js', default: './server.js' } },
    imports: { '#runtime': { browser: './runtime.js', node: './server.js', default: './server.js' } },
  }))
  fs.writeFileSync(path.join(pkg, 'server.js'), 'import "node:async_hooks"; export const value = "SERVER_SECRET_SENTINEL";')
  fs.writeFileSync(path.join(pkg, 'runtime.js'), 'export const runtime = "browser-runtime";')
  fs.writeFileSync(path.join(pkg, 'client.js'), `
    import { runtime } from '#runtime';
    export const value = COMPILER_TARGET + runtime;
    export const server = import.meta.env.SSR;
    export const flag = CLIENT_FLAG;
    if (import.meta.env.SSR) import('./server.js');
  `)
  return { root, pkg }
}

test('native dependency bundling uses client hooks, private imports, conditions and pre-tree-shake defines', async (t) => {
  const { root, pkg } = fixture(t)
  const seen = []
  const server = await createServer({
    root, framework: 'react', logLevel: 'silent',
    environments: {
      client: { build: { rolldownOptions: { transform: { define: { CLIENT_FLAG: '"defined"' } } } } },
      alternate: {
        consumer: 'client',
        build: { rolldownOptions: { transform: { define: { CLIENT_FLAG: '"alternate"' } } } },
      },
    },
    plugins: [{
      name: 'fixture:client-compiler',
      transform: {
        filter: { id: '**/fixture/client.js' },
        handler(code, id) {
          seen.push([this.environment.name, id])
          return code.replace('COMPILER_TARGET', JSON.stringify(this.environment.name))
        },
      },
    }],
  })
  t.after(() => server.close())
  for (const name of ['client', 'alternate']) {
    const result = await server.environments[name].transformRequest('/@modules/fixture')
    assert.ok(result)
    assert.match(result.code, /browser-runtime/)
    assert.match(result.code, new RegExp(name))
    assert.doesNotMatch(result.code, /COMPILER_TARGET|CLIENT_FLAG|SERVER_SECRET_SENTINEL|async_hooks|#runtime|server\.js/)
    assert.match(result.code, /server = false/)
  }
  assert.deepEqual(seen.map(([name]) => name), ['client', 'alternate'])
  assert.equal(seen[0][1], path.join(pkg, 'client.js'))
})

test('dependency package-import resolution keeps custom browser conditions and transitive external URLs', async (t) => {
  const { root, pkg } = fixture(t)
  const dep = path.join(pkg, 'node_modules/transitive')
  fs.mkdirSync(dep, { recursive: true })
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
    name: 'transitive', type: 'module',
    exports: { custom: './custom.js', default: './wrong.js' },
  }))
  fs.writeFileSync(path.join(dep, 'custom.js'), 'export const value = "custom-condition";')
  fs.writeFileSync(path.join(dep, 'wrong.js'), 'export const value = "wrong-condition";')
  fs.writeFileSync(path.join(pkg, 'client.js'), 'export { value } from "transitive";')
  const server = await createServer({
    root, framework: 'react', logLevel: 'silent',
    resolve: { conditions: ['custom', 'browser', 'import', 'default'] },
  })
  t.after(() => server.close())
  const result = await server.transformRequest('/@modules/fixture')
  const match = result.code.match(/["'](\/@modules\/transitive\?id=[^"']+)["']/)
  assert.ok(match, result.code)
  const dependency = await server.transformRequest(match[1])
  assert.ok(dependency, match[1])
  assert.match(dependency.code, /custom-condition/)
  assert.doesNotMatch(dependency.code, /wrong-condition/)
})

test('environment output overrides preserve inherited transform defines without crossing environments', async (t) => {
  const { root } = fixture(t)
  const config = await resolveConfig({
    root, logLevel: 'silent',
    build: { rolldownOptions: { transform: { define: { SHARED: '"shared"', VALUE: '"global"' } } } },
    environments: {
      client: { build: { rolldownOptions: { output: { sourcemapExcludeSources: true } } } },
      alternate: {
        consumer: 'client',
        build: { rolldownOptions: { transform: { define: { VALUE: '"alternate"' } }, output: { format: 'esm' } } },
      },
    },
  }, 'serve')
  assert.deepEqual(config.build.rolldownOptions.transform.define, { SHARED: '"shared"', VALUE: '"global"' })
  assert.equal(config.environments.client.build, config.build)
  assert.deepEqual(config.environments.alternate.build.rolldownOptions.transform.define,
    { SHARED: '"shared"', VALUE: '"alternate"' })
  assert.equal(config.build.rolldownOptions.output.sourcemapExcludeSources, true)
})

test('client dependencies reject live Node imports rather than stubbing or externalizing server code', async (t) => {
  const { root, pkg } = fixture(t)
  fs.writeFileSync(path.join(pkg, 'client.js'), 'import { AsyncLocalStorage } from "node:async_hooks"; export { AsyncLocalStorage };')
  const server = await createServer({ root, framework: 'react', logLevel: 'silent' })
  t.after(() => server.close())
  await assert.rejects(server.transformRequest('/@modules/fixture'), /Node builtin.*node:async_hooks.*client dependency/)
})

test('application aliases retain browser module identity and compiler absolute query imports remain servable', async (t) => {
  const { root, pkg } = fixture(t)
  const app = path.join(root, 'app.js')
  fs.writeFileSync(app, 'export const value = "APP_IDENTITY_SENTINEL";')
  fs.writeFileSync(path.join(pkg, 'client.js'), 'export { value } from "#app";')
  fs.writeFileSync(path.join(root, 'main.js'), `export const load = () => import(${JSON.stringify(app + '?split=component')});`)
  const calls = []
  const server = await createServer({
    root, framework: 'react', logLevel: 'silent',
    resolve: { alias: { '#app': app } },
    plugins: [{
      name: 'fixture:query',
      load(id) {
        if (id === app + '?split=component') {
          calls.push(id)
          return 'export const value = "split-component";'
        }
      },
    }],
  })
  t.after(() => server.close())
  const dependency = await server.transformRequest('/@modules/fixture')
  assert.match(dependency.code, /from "\/app\.js"/)
  assert.doesNotMatch(dependency.code, /APP_IDENTITY_SENTINEL/)
  const main = await server.transformRequest('/main.js')
  assert.match(main.code, /import\("\/app\.js\?split=component"\)/)
  const split = await server.transformRequest('/app.js?split=component')
  assert.match(split.code, /split-component/)
  assert.deepEqual(calls, [app + '?split=component'])
})
