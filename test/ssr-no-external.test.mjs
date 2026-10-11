import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { build, createServer, resolveConfig } from '../dist/index.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-no-external-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, content) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  write('package.json', JSON.stringify({ private: true, type: 'module' }))
  write('node_modules/fixture-inline/package.json', JSON.stringify({
    name: 'fixture-inline',
    type: 'module',
    exports: {
      '.': {
        node: { require: './wrong.cjs', import: './index.js' },
        default: './index.js',
      },
      './subpath': './subpath.js',
    },
  }))
  write('node_modules/fixture-inline/index.js', 'export const value = "RAW_INLINE";')
  write('node_modules/fixture-inline/subpath.js', 'export const subpath = "RAW_SUBPATH";')
  write('node_modules/fixture-inline/wrong.cjs', 'throw new Error("require branch must not run");')
  write('node_modules/fixture-native/package.json', JSON.stringify({
    name: 'fixture-native', type: 'module', exports: './index.js',
  }))
  write('node_modules/fixture-native/index.js', 'export const native = "native";')
  write('src/entry.js', [
    'import { value } from "fixture-inline";',
    'import { subpath } from "fixture-inline/subpath";',
    'import { native } from "fixture-native";',
    'import { basename } from "node:path";',
    'export const result = [value, subpath, native, basename("/fixture/entry.js")];',
  ].join('\n'))
  const transformed = []
  const plugin = {
    name: 'fixture:ssr-compiler',
    transform(code, id) {
      if (id.includes('node_modules')) transformed.push(id)
      return code.replace('RAW_INLINE', 'COMPILED_INLINE').replace('RAW_SUBPATH', 'COMPILED_SUBPATH')
    },
  }
  const config = {
    root,
    logLevel: 'silent',
    plugins: [plugin],
    environments: {
      client: { buildEnabled: false },
      ssr: {
        consumer: 'server',
        entry: 'src/entry.js',
        resolve: { conditions: ['node', 'import'] },
      },
    },
  }
  return { root, write, config, transformed }
}

async function loadBuild(config) {
  const result = await build(config)
  const entry = result.environments.ssr.find((output) => output.type === 'chunk' && output.isEntry)
  assert.ok(entry, 'SSR build must produce a real entry chunk')
  return {
    module: await import(pathToFileURL(path.join(config.root, 'dist/ssr', entry.fileName)).href),
    code: entry.code,
  }
}

for (const [name, noExternal] of [
  ['package and subpaths', ['fixture-inline']],
  ['wildcard', ['fixture-in*']],
  ['stateful regex', [/^fixture-inline(?:\/|$)/g]],
  ['all dependencies', true],
]) {
  test(`SSR noExternal ${name} compiles dependencies in dev and build`, { timeout: 15000 }, async (t) => {
    const { config, transformed } = fixture(t)
    config.environments.ssr.resolve.noExternal = noExternal
    const server = await createServer(config)
    t.after(() => server.close())
    const expected = ['COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js']
    assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
    const built = await loadBuild(config)
    assert.deepEqual(built.module.result, expected)
    assert.match(built.code, /node:path/)
    assert.equal(transformed.some((id) => id.endsWith('fixture-native/index.js')), noExternal === true)
    if (noExternal !== true) assert.match(built.code, /fixture-native/)
  })
}

test('SSR defaults keep native dependencies external in dev and build', { timeout: 15000 }, async (t) => {
  const { config, transformed } = fixture(t)
  const server = await createServer(config)
  t.after(() => server.close())
  const expected = ['RAW_INLINE', 'RAW_SUBPATH', 'native', 'entry.js']
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
  const built = await loadBuild(config)
  assert.deepEqual(built.module.result, expected)
  assert.match(built.code, /fixture-inline/)
  assert.deepEqual(transformed, [])
})

test('SSR inlined dependencies use ESM conditions even when require is configured', { timeout: 15000 }, async (t) => {
  const { config } = fixture(t)
  config.environments.ssr.resolve = {
    conditions: ['node', 'require', 'import'],
    noExternal: ['fixture-inline'],
  }
  const server = await createServer(config)
  t.after(() => server.close())
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, [
    'COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js',
  ])
  assert.deepEqual((await loadBuild(config)).module.result, [
    'COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js',
  ])
})

test('SSR noExternal respects mainFields in both dev and build', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  write('node_modules/fixture-fields/package.json', JSON.stringify({
    name: 'fixture-fields', type: 'module', module: './module.js', main: './main.js',
  }))
  write('node_modules/fixture-fields/module.js', 'export const value = "module";')
  write('node_modules/fixture-fields/main.js', 'export const value = "main";')
  write('src/entry.js', 'export { value } from "fixture-fields";')
  config.environments.ssr.resolve.noExternal = ['fixture-fields']
  config.environments.ssr.resolve.mainFields = ['module', 'main']
  const server = await createServer(config)
  t.after(() => server.close())
  assert.equal((await server.ssrLoadModule('/src/entry.js')).value, 'module')
  assert.equal((await loadBuild(config)).module.value, 'module')
})

test('SSR noExternal resolves package JavaScript exports to TypeScript sources', { timeout: 15000 }, async (t) => {
  const { root, config, write } = fixture(t)
  fs.unlinkSync(path.join(root, 'node_modules/fixture-inline/index.js'))
  write('node_modules/fixture-inline/index.ts', 'export const value: string = "RAW_INLINE";')
  config.environments.ssr.resolve.noExternal = ['fixture-inline']
  const server = await createServer(config)
  t.after(() => server.close())
  const expected = ['COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js']
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
  assert.deepEqual((await loadBuild(config)).module.result, expected)
})

test('SSR noExternal prefers an existing exported JavaScript file over TypeScript fallback', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  write('node_modules/fixture-inline/index.ts', 'export const value: string = "WRONG_TS_FALLBACK";')
  config.environments.ssr.resolve.noExternal = ['fixture-inline']
  const server = await createServer(config)
  t.after(() => server.close())
  const expected = ['COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js']
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
  assert.deepEqual((await loadBuild(config)).module.result, expected)
})

test('SSR inlined package imports resolve in the owning package rather than output scope', { timeout: 15000 }, async (t) => {
  const { root, config, write } = fixture(t)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/fixture-inline/package.json'), 'utf8'))
  manifest.imports = { '#internal': './internal.js' }
  write('node_modules/fixture-inline/package.json', JSON.stringify(manifest))
  write('node_modules/fixture-inline/index.js', 'export { value } from "#internal";')
  write('node_modules/fixture-inline/internal.js', 'export const value = "RAW_INLINE";')
  config.environments.ssr.resolve.noExternal = ['fixture-inline']
  const server = await createServer(config)
  t.after(() => server.close())
  const expected = ['COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js']
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
  const built = await loadBuild(config)
  assert.deepEqual(built.module.result, expected)
  assert.doesNotMatch(built.code, /#internal/)
})

test('SSR ESM inputs keep import conditions even when emitting CommonJS output', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  write('src/entry.js', 'export { value } from "fixture-inline";')
  config.environments.ssr.resolve = {
    noExternal: ['fixture-inline'],
    conditions: ['node', 'require', 'import'],
  }
  config.environments.ssr.build = {
    rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
  }
  assert.equal((await loadBuild(config)).module.value, 'COMPILED_INLINE')
})

test('noExternal inherits top-level configuration and permits per-environment overrides', async (t) => {
  const { root } = fixture(t)
  const config = await resolveConfig({
    root,
    resolve: { noExternal: ['fixture-inline'] },
    environments: {
      ssr: { consumer: 'server' },
      isolated: { consumer: 'server', resolve: { noExternal: [] } },
    },
  }, 'serve')
  assert.deepEqual(config.environments.ssr.resolve.noExternal, ['fixture-inline'])
  assert.notEqual(config.environments.ssr.resolve.noExternal, config.resolve.noExternal)
  assert.deepEqual(config.environments.isolated.resolve.noExternal, [])
  assert.equal(config.environments.client.resolve, config.resolve)
})

test('SSR aliases and virtual modules resolve before native externalization', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  write('src/aliased.ts', 'export const aliased: string = "alias";')
  write('src/entry.js', [
    'import { aliased } from "fixture-alias";',
    'import { virtual } from "virtual:fixture";',
    'export const result = [aliased, virtual];',
  ].join('\n'))
  config.environments.ssr.resolve.alias = { 'fixture-alias': './src/aliased.ts' }
  config.plugins.push({
    name: 'fixture:virtual',
    resolveId(id) {
      if (id === 'virtual:fixture') return '\0virtual:fixture'
    },
    load(id) {
      if (id === '\0virtual:fixture') return 'export const virtual = "virtual";'
    },
  })
  const server = await createServer(config)
  t.after(() => server.close())
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, ['alias', 'virtual'])
  assert.equal((await server.ssrLoadModule('virtual:fixture')).virtual, 'virtual')
  assert.deepEqual((await loadBuild(config)).module.result, ['alias', 'virtual'])
})

test('SSR virtual queries preserve module identity and parser errors reject loading', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  write('src/entry.js', [
    'import { value as a } from "virtual:query?one";',
    'import { value as b } from "virtual:query?two";',
    'export const result = [a, b];',
  ].join('\n'))
  const loaded = []
  config.plugins.push({
    name: 'fixture:virtual-queries',
    resolveId(id) {
      if (id.startsWith('virtual:query?')) return '\0' + id
      if (id === 'virtual:broken') return '\0virtual:broken'
    },
    load(id) {
      if (id === '\0virtual:broken') return 'export const = ;'
      if (id.startsWith('\0virtual:query?')) {
        loaded.push(id)
        return `export const value = ${JSON.stringify(id.split('?')[1])};`
      }
    },
  })
  const server = await createServer(config)
  t.after(() => server.close())
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, ['one', 'two'])
  assert.deepEqual(loaded, ['\0virtual:query?one', '\0virtual:query?two'])
  await assert.rejects(server.ssrLoadModule('virtual:broken'), /cannot transform module/)
})

test('SSR public and canonical virtual IDs share one evaluated module', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  write('src/entry.js', 'export { token } from "virtual:identity";')
  let loads = 0
  config.plugins.push({
    name: 'fixture:virtual-identity',
    resolveId(id) {
      if (id === 'virtual:identity') return '\0virtual:identity'
    },
    load(id) {
      if (id === '\0virtual:identity') {
        loads++
        return 'export const token = {};'
      }
    },
  })
  const server = await createServer(config)
  t.after(() => server.close())
  const entry = await server.ssrLoadModule('/src/entry.js')
  const direct = await server.ssrLoadModule('virtual:identity')
  const canonical = await server.ssrLoadModule('\0virtual:identity')
  assert.equal(entry.token, direct.token)
  assert.equal(direct, canonical)
  assert.equal(loads, 1)
})

test('SSR noExternal resolves bare dependencies of virtual importers from the project', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  config.environments.ssr.resolve.noExternal = ['fixture-inline']
  write('src/entry.js', 'export { value } from "virtual:with-dependency";')
  config.plugins.push({
    name: 'fixture:virtual-dependency',
    resolveId(id) {
      if (id === 'virtual:with-dependency') return '\0virtual:with-dependency'
    },
    load(id) {
      if (id === '\0virtual:with-dependency') return 'export { value } from "fixture-inline";'
    },
  })
  const server = await createServer(config)
  t.after(() => server.close())
  assert.equal((await server.ssrLoadModule('/src/entry.js')).value, 'COMPILED_INLINE')
  assert.equal((await loadBuild(config)).module.value, 'COMPILED_INLINE')
})

test('virtual build importers preserve user resolver precedence over native package fallback', { timeout: 15000 }, async (t) => {
  const { config, write } = fixture(t)
  config.environments.ssr.resolve.noExternal = ['fixture-inline']
  write('src/entry.js', 'export { value } from "virtual:with-dependency";')
  config.plugins.push({
    name: 'fixture:override-native-dependency',
    enforce: 'post',
    resolveId(id, importer) {
      if (id === 'virtual:with-dependency') return '\0virtual:with-dependency'
      if (id === 'fixture-inline' && importer === '\0virtual:with-dependency') {
        return '\0virtual:custom-dependency'
      }
    },
    load(id) {
      if (id === '\0virtual:with-dependency') return 'export { value } from "fixture-inline";'
      if (id === '\0virtual:custom-dependency') return 'export const value = "CUSTOM_DEPENDENCY";'
    },
  })
  assert.equal((await loadBuild(config)).module.value, 'CUSTOM_DEPENDENCY')
})

test('explicit external overrides noExternal and preserves low-level replacement semantics', { timeout: 15000 }, async (t) => {
  const { config, transformed } = fixture(t)
  config.environments.ssr.resolve.noExternal = true
  config.environments.ssr.build = {
    rolldownOptions: { external: ['fixture-inline', 'fixture-inline/subpath'] },
  }
  const server = await createServer(config)
  t.after(() => server.close())
  const expected = ['RAW_INLINE', 'RAW_SUBPATH', 'native', 'entry.js']
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
  assert.deepEqual((await loadBuild(config)).module.result, expected)
  assert.equal(transformed.some((id) => id.includes('fixture-inline/')), false)
  assert.equal(transformed.some((id) => id.endsWith('fixture-native/index.js')), true)
})

test('SSR external callbacks see resolved IDs and cannot inline Node builtins', { timeout: 15000 }, async (t) => {
  const { config } = fixture(t)
  config.environments.ssr.resolve.noExternal = true
  config.environments.ssr.build = {
    rolldownOptions: {
      external: (id, _importer, isResolved) => isResolved && id.endsWith('fixture-inline/index.js'),
    },
  }
  const server = await createServer(config)
  t.after(() => server.close())
  const expected = ['RAW_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js']
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, expected)
  const built = await loadBuild(config)
  assert.deepEqual(built.module.result, expected)
  assert.match(built.code, /node:path/)
})

test('CommonJS public entry exposes the same SSR noExternal behavior', { timeout: 15000 }, async (t) => {
  const { config } = fixture(t)
  config.environments.ssr.resolve.noExternal = ['fixture-inline']
  const { createServer: createCjsServer } = createRequire(import.meta.url)('../dist/index.cjs')
  const server = await createCjsServer(config)
  t.after(() => server.close())
  assert.deepEqual((await server.ssrLoadModule('/src/entry.js')).result, [
    'COMPILED_INLINE', 'COMPILED_SUBPATH', 'native', 'entry.js',
  ])
})
