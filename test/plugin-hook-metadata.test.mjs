import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { and, exclude, id, importerId, include } from 'rolldown/filter'

import { build, createServer, NastiEnvironment, resolveConfig } from '../dist/index.js'

function createFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'src'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

async function createPluginContainer(t, plugins) {
  const root = createFixture(t, 'nasti-hook-filters-')
  const config = await resolveConfig({ root, framework: 'vue', logLevel: 'silent' }, 'serve')
  const environment = new NastiEnvironment('client', config, { plugins })
  t.after(() => environment.close())
  await environment.init()
  return { container: environment.pluginContainer, root }
}

test('dev resolveId filters receive importer IDs, including missing and excluded importers', async (t) => {
  const calls = []
  const { container, root } = await createPluginContainer(t, [{
    name: 'fixture:importer-filter',
    resolveId: {
      filter: [
        exclude(importerId(/[\\/]blocked[\\/]/)),
        include(and(id(/^virtual:importer$/), importerId(/[\\/]main\.js$/, { cleanUrl: true }))),
      ],
      handler(source, importer) {
        calls.push(importer)
        return `\0${source}`
      },
    },
  }])
  const importer = path.join(root, 'src/main.js')
  assert.equal(await container.resolveId('virtual:importer', importer), '\0virtual:importer')
  assert.equal(await container.resolveId('virtual:importer', `${importer}?raw`), '\0virtual:importer')
  assert.equal(await container.resolveId('virtual:importer', path.join(root, 'src/blocked/main.js')), null)
  assert.equal(await container.resolveId('virtual:importer', path.join(root, 'src/other.js')), null)
  assert.equal(await container.resolveId('virtual:importer'), null)
  assert.equal(await container.resolveId('virtual:other', importer), null)
  assert.deepEqual(calls, [importer, `${importer}?raw`])
})

test('dev object id filters match globs in load and transform with include/exclude and code filters', async (t) => {
  const { container, root } = await createPluginContainer(t, [{
    name: 'fixture:glob-filter',
    load: {
      filter: { id: '**/*.js' },
      handler() {
        return 'LOAD_TARGET'
      },
    },
    transform: {
      filter: {
        id: { include: ['src/**/*.js', '**/*.ts'], exclude: ['**/ignored.*', '**/vendor/**'] },
        code: { include: 'TARGET', exclude: 'SKIP' },
      },
      handler(code) {
        return code.replace('TARGET', 'MATCHED')
      },
    },
  }])
  for (const file of ['src/main.js', 'src/nested/main.js', 'src/.hidden.js']) {
    const moduleId = path.join(root, file)
    assert.equal(await container.load(moduleId), 'LOAD_TARGET', file)
    assert.equal((await container.transform('export const value = "TARGET";', moduleId)).code,
      'export const value = "MATCHED";', file)
  }
  assert.equal((await container.transform('TARGET', path.join(root, 'src/main.ts'))).code, 'MATCHED')
  assert.equal(await container.load(path.join(root, 'src/main.ts')), null)
  for (const file of ['src/ignored.js', 'src/vendor/main.js', 'other/main.js', 'src/main.css']) {
    assert.equal(await container.transform('TARGET', path.join(root, file)), null, file)
  }
  assert.equal(await container.transform('OTHER', path.join(root, 'src/main.js')), null)
  assert.equal(await container.transform('TARGET SKIP', path.join(root, 'src/main.js')), null)
})

test('dev expression id and importerId strings retain exact matching', async (t) => {
  const { container } = await createPluginContainer(t, [{
    name: 'fixture:exact-expression-filter',
    resolveId: {
      filter: [include(and(id('virtual:exact'), importerId('/src/main.js')))],
      handler(source) {
        return `\0${source}`
      },
    },
    load: {
      filter: [include(id('**/*.js'))],
      handler() {
        return 'EXACT_MATCH'
      },
    },
  }])
  assert.equal(await container.resolveId('virtual:exact', '/src/main.js'), '\0virtual:exact')
  assert.equal(await container.resolveId('virtual:exact', '/other/src/main.js'), null)
  assert.equal(await container.load('/src/main.js'), null)
  assert.equal(await container.load('**/*.js'), 'EXACT_MATCH')
})

test('build preserves object hook handlers, filters, ordering, metadata, and context', async (t) => {
  const root = createFixture(t, 'nasti-object-hooks-build-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<script type="module" src="/src/main.js"></script>',
  )
  fs.writeFileSync(
    path.join(root, 'src/main.js'),
    'import { virtualValue } from "virtual:hook-metadata"; export const answer = "BUILD_TARGET" + virtualValue;\n',
  )
  fs.writeFileSync(path.join(root, 'src/ignored.js'), 'export const ignored = true;\n')

  const events = []
  const result = await build({
    root,
    framework: 'vue',
    logLevel: 'silent',
    plugins: [
      {
        name: 'fixture:middle-transform',
        enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/src/main.js')) events.push('middle')
          return null
        },
      },
      {
        name: 'fixture:post-transform',
        transform: {
          order: 'post',
          filter: {
            id: { include: /\.js$/, exclude: /ignored\.js$/ },
            code: { include: /BUILD_TRANSFORMED/, exclude: /BUILD_IGNORED/ },
          },
          handler(code, id) {
            assert.equal(this.environment.name, 'client')
            assert.ok(id.endsWith('/src/main.js'))
            events.push('post')
            return code.replace('BUILD_TRANSFORMED', 'BUILD_POSTED')
          },
        },
        renderChunk: {
          filter: { code: { include: /BUILD_POSTED/, exclude: /BUILD_IGNORED/ } },
          async handler(code) {
            assert.equal(this.environment.name, 'client')
            events.push('renderChunk')
            return code.replace('BUILD_POSTED', 'BUILD_RENDERED')
          },
        },
      },
      {
        name: 'fixture:pre-transform',
        transform: {
          order: 'pre',
          sequential: false,
          filter: {
            id: { include: /\.js$/, exclude: /ignored\.js$/ },
            code: { include: /BUILD_TARGET/, exclude: /BUILD_IGNORED/ },
          },
          async handler(code, id) {
            assert.equal(this.environment.name, 'client')
            assert.ok(id.endsWith('/src/main.js'))
            await Promise.resolve()
            events.push('pre')
            return code.replace('BUILD_TARGET', 'BUILD_TRANSFORMED')
          },
        },
      },
      {
        name: 'fixture:enforced-post-transform',
        enforce: 'post',
        transform(code, id) {
          if (id.endsWith('/src/main.js')) events.push('enforced-post')
          return null
        },
      },
      {
        name: 'fixture:virtual-module',
        apply: 'build',
        buildStart: {
          order: 'pre',
          handler() {
            assert.equal(this.environment.name, 'client')
            events.push('buildStart')
          },
        },
        resolveId: {
          order: 'pre',
          filter: { id: /^virtual:hook-metadata$/ },
          handler(source) {
            assert.equal(this.environment.name, 'client')
            events.push('resolveId')
            return `\0${source}`
          },
        },
        load: {
          filter: { id: /^\0virtual:hook-metadata$/ },
          handler(id) {
            assert.equal(this.environment.name, 'client')
            events.push('load')
            return 'export const virtualValue = "VIRTUAL_VALUE";'
          },
        },
      },
      {
        name: 'fixture:serve-only',
        apply: 'serve',
        transform() {
          throw new Error('serve-only plugin must not run during build')
        },
      },
    ],
    build: { minify: false },
  })

  assert.equal(events[0], 'buildStart')
  assert.ok(events.indexOf('resolveId') < events.indexOf('load'))
  assert.ok(events.indexOf('pre') < events.indexOf('middle'))
  assert.ok(events.indexOf('middle') < events.indexOf('enforced-post'))
  assert.ok(events.indexOf('enforced-post') < events.indexOf('post'))
  assert.ok(events.includes('renderChunk'))
  assert.ok(!events.includes('serve-only'))
  assert.match(
    result.output.find((item) => item.type === 'chunk' && item.isEntry).code,
    /BUILD_RENDERED/,
  )
})

test('dev applies object hook order and include/exclude filters in its custom pipeline', async (t) => {
  const root = createFixture(t, 'nasti-object-hooks-dev-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<script type="module" src="/src/main.js"></script>',
  )
  fs.writeFileSync(path.join(root, 'src/main.js'), 'export const value = "DEV_TARGET";\n')
  fs.writeFileSync(path.join(root, 'src/ignored.js'), 'export const value = "DEV_TARGET";\n')

  const events = []
  const server = await createServer({
    root,
    framework: 'vue',
    logLevel: 'silent',
    plugins: [
      {
        name: 'fixture:middle-transform',
        transform(code, id) {
          if (id.endsWith('/src/main.js') || id.endsWith('/src/ignored.js')) {
            events.push(`middle:${path.basename(id)}`)
          }
          return null
        },
      },
      {
        name: 'fixture:post-transform',
        transform: {
          order: 'post',
          filter: {
            id: { include: /\.js$/, exclude: /ignored\.js$/ },
            code: { include: /DEV_PRE/, exclude: /DEV_IGNORED/ },
          },
          handler(code, id) {
            assert.equal(this.environment.name, 'client')
            events.push(`post:${path.basename(id)}`)
            return code.replace('DEV_PRE', 'DEV_POST')
          },
        },
      },
      {
        name: 'fixture:pre-transform',
        transform: {
          order: 'pre',
          sequential: true,
          filter: {
            id: { include: /\.js$/, exclude: /ignored\.js$/ },
            code: { include: /DEV_TARGET/, exclude: /DEV_IGNORED/ },
          },
          async handler(code, id) {
            assert.equal(this.environment.name, 'client')
            await Promise.resolve()
            events.push(`pre:${path.basename(id)}`)
            return code.replace('DEV_TARGET', 'DEV_PRE')
          },
        },
      },
      {
        name: 'fixture:virtual-object-hooks',
        resolveId: {
          order: 'pre',
          filter: { id: /^virtual:dev-object$/ },
          handler(source) {
            events.push('resolve:dev-object')
            return `\0${source}`
          },
        },
        load: {
          filter: { id: /^\0virtual:dev-object$/ },
          handler() {
            events.push('load:dev-object')
            return {
              code: 'export const value = "DEV_VIRTUAL_TARGET";',
              moduleType: 'jsx',
            }
          },
        },
        transform: {
          filter: {
            moduleType: ['jsx'],
            code: /DEV_VIRTUAL_TARGET/,
          },
          handler(code, id) {
            assert.equal(this.environment.name, 'client')
            assert.equal(id, '\0virtual:dev-object')
            events.push('transform:dev-object')
            return code.replace('DEV_VIRTUAL_TARGET', 'DEV_VIRTUAL_TRANSFORMED')
          },
        },
      },
    ],
  })
  t.after(() => server.close())

  const transformed = await server.transformRequest('/src/main.js')
  assert.match(transformed.code, /DEV_POST/)
  assert.deepEqual(events.slice(0, 3), [
    'pre:main.js',
    'middle:main.js',
    'post:main.js',
  ])

  events.length = 0
  const ignored = await server.transformRequest('/src/ignored.js')
  assert.match(ignored.code, /DEV_TARGET/)
  assert.deepEqual(events, ['middle:ignored.js'])

  events.length = 0
  const virtual = await server.transformRequest('/@modules/virtual:dev-object')
  assert.match(virtual.code, /DEV_VIRTUAL_TRANSFORMED/)
  assert.deepEqual(events, [
    'resolve:dev-object',
    'load:dev-object',
    'transform:dev-object',
  ])
})

test('invalid object hooks fail with plugin and hook names', async (t) => {
  const root = createFixture(t, 'nasti-object-hooks-invalid-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<script type="module" src="/src/main.js"></script>',
  )
  fs.writeFileSync(path.join(root, 'src/main.js'), 'export const answer = 42;\n')

  await assert.rejects(
    build({
      root,
      framework: 'vue',
      logLevel: 'silent',
      plugins: [{ name: 'fixture:invalid-transform', transform: { order: 'pre' } }],
    }),
    /plugin "fixture:invalid-transform".*"transform" hook.*handler function/,
  )
})
