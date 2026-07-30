import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { build, createServer } from '../dist/index.js'

const BACKGROUND = 'lynx-background'
const MAIN_THREAD = 'lynx-main-thread'

function createFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'src'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('non-default client environments expose independent Vue/CSS dev pipelines and app HMR', async (t) => {
  const root = createFixture(t, 'nasti-environment-dev-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<div id="app"></div><script type="module" src="/src/App.vue"></script>',
  )
  fs.writeFileSync(
    path.join(root, 'src/App.vue'),
    [
      '<template><view class="root">__ENVIRONMENT__</view></template>',
      '<style>.root { color: red }</style>',
    ].join('\n'),
  )

  let resolveAppUpdate
  const appUpdate = new Promise((resolve) => {
    resolveAppUpdate = resolve
  })
  const plugin = {
    name: 'fixture:multi-environment-hmr',
    handleHotUpdateApp(context) {
      if (context.file.endsWith('App.vue')) resolveAppUpdate(context)
    },
  }

  const environmentConfig = {
    consumer: 'client',
    entry: 'src/App.vue',
    build: { css: { inject: false, emit: false } },
    vue: {
      transformTemplate(source, context) {
        return source.replace('__ENVIRONMENT__', context.environmentName)
      },
    },
  }
  const server = await createServer({
    root,
    framework: 'vue',
    logLevel: 'silent',
    plugins: [plugin],
    environments: {
      client: { buildEnabled: false },
      [BACKGROUND]: environmentConfig,
      [MAIN_THREAD]: environmentConfig,
    },
  })
  await server.listen(0)
  t.after(() => server.close())

  const background = await server.transformEnvironmentRequest(BACKGROUND, '/src/App.vue')
  const mainThread = await server.environments[MAIN_THREAD].transformRequest('/src/App.vue')
  assert.ok(background)
  assert.ok(mainThread)
  assert.match(background.code, /lynx-background/)
  assert.match(mainThread.code, /lynx-main-thread/)

  const backgroundHmrId = background.code.match(/__hmrId\s*=\s*"([^"]+)"/)?.[1]
  const mainThreadHmrId = mainThread.code.match(/__hmrId\s*=\s*"([^"]+)"/)?.[1]
  assert.ok(backgroundHmrId)
  assert.equal(backgroundHmrId, mainThreadHmrId)

  const styleRequest = background.code.match(/import "([^"]+\?vue&type=style[^"]+)"/)?.[1]
  assert.ok(styleRequest)
  const backgroundStyle = await server.transformEnvironmentRequest(BACKGROUND, styleRequest)
  const mainThreadStyle = await server.transformEnvironmentRequest(MAIN_THREAD, styleRequest)
  assert.match(backgroundStyle.code, /export default ".*color: red/s)
  assert.doesNotMatch(backgroundStyle.code, /document\.createElement/)
  assert.doesNotMatch(mainThreadStyle.code, /document\.createElement/)

  const backgroundGraph = server.environments[BACKGROUND].moduleGraph
  const mainThreadGraph = server.environments[MAIN_THREAD].moduleGraph
  assert.notEqual(backgroundGraph, mainThreadGraph)
  const backgroundModule = backgroundGraph.getModuleByUrl('/src/App.vue')
  const mainThreadModule = mainThreadGraph.getModuleByUrl('/src/App.vue')
  assert.ok(backgroundModule)
  assert.ok(mainThreadModule)
  assert.equal(backgroundModule.environment, BACKGROUND)
  assert.equal(mainThreadModule.environment, MAIN_THREAD)
  assert.match(
    server.environments[BACKGROUND].getCssModule(styleRequest).source,
    /\.root \{ color: red\s*\}/,
  )

  await server.watcher.unwatch(root)
  const payloads = []
  server.ws.send = (payload) => payloads.push(payload)
  fs.writeFileSync(
    path.join(root, 'src/App.vue'),
    [
      '<template><view class="root">__ENVIRONMENT__ updated</view></template>',
      '<style>.root { color: blue }</style>',
    ].join('\n'),
  )
  server.watcher.emit('change', path.join(root, 'src/App.vue'))

  let updateTimeout
  let update
  try {
    update = await Promise.race([
      appUpdate,
      new Promise((_, reject) => {
        updateTimeout = setTimeout(
          () => reject(new Error('app-level HMR did not run')),
          2000,
        )
      }),
    ])
  } finally {
    clearTimeout(updateTimeout)
  }
  assert.deepEqual(
    Object.keys(update.environments).sort(),
    [BACKGROUND, MAIN_THREAD].sort(),
  )
  for (const environmentName of [BACKGROUND, MAIN_THREAD]) {
    const environmentUpdate = update.environments[environmentName]
    assert.equal(environmentUpdate.environment.name, environmentName)
    assert.ok(environmentUpdate.modules.every((module) => module.environment === environmentName))
    assert.ok(
      environmentUpdate.transformed.some(({ result }) =>
        result?.code.includes(`${environmentName} updated`),
      ),
    )
    assert.ok(payloads.some((payload) => payload.environment === environmentName))
  }
})

test('build finalization exposes target-lowered chunks, assets, CSS ownership and source maps', async (t) => {
  const root = createFixture(t, 'nasti-environment-build-metadata-')
  fs.writeFileSync(
    path.join(root, 'src/entry.ts'),
    [
      "import './style.css'",
      "import logo from './logo.svg'",
      'export const value: number = globalThis.fixture?.value ?? 0',
      'export const asset = logo',
      "export const load = () => import('./lazy.ts')",
    ].join('\n'),
  )
  fs.writeFileSync(path.join(root, 'src/lazy.ts'), 'export const lazy: number = 42\n')
  fs.writeFileSync(path.join(root, 'src/style.css'), '.native { color: rebeccapurple }\n')
  fs.writeFileSync(
    path.join(root, 'src/logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
  )

  let inspected = false
  const plugin = {
    name: 'fixture:inspect-finalization',
    afterBuildApp(results, _api, context) {
      const result = results[MAIN_THREAD]
      const entryFile = result.entries.entry
      const entry = context.getEntry(MAIN_THREAD, 'entry')
      const entryChunk = context.getChunk(MAIN_THREAD, entryFile)
      assert.equal(entry.fileName, entryChunk.fileName)
      assert.equal(entryChunk.isEntry, true)
      assert.equal(entryChunk.dynamicImports.length, 1)
      assert.equal(entryChunk.assets.length, 1)
      assert.ok(context.getArtifact(MAIN_THREAD, entryChunk.assets[0]))
      assert.ok(context.getSourceMap(MAIN_THREAD, entryFile))
      assert.equal(
        context.resolvePublicPath(MAIN_THREAD, entryFile),
        `/runtime/${entryFile}`,
      )

      const css = context.getCss(MAIN_THREAD)
      assert.equal(Object.keys(css.modules).length, 1)
      assert.match(Object.values(css.modules)[0].source, /rebeccapurple/)
      assert.deepEqual(css.chunks[entryFile].cssFileNames, [])
      assert.equal(css.chunks[entryFile].moduleIds.length, 1)

      context.emitFile({
        type: 'asset',
        fileName: `native/${entryChunk.name}.manifest.json`,
        source: JSON.stringify({
          entry: context.resolvePublicPath(MAIN_THREAD, entryFile),
          lazy: entryChunk.dynamicImports,
        }),
      })
      inspected = true
    },
  }

  const result = await build({
    root,
    base: '/runtime/',
    logLevel: 'silent',
    plugins: [plugin],
    environments: {
      client: { buildEnabled: false },
      [MAIN_THREAD]: {
        consumer: 'client',
        entry: 'src/entry.ts',
        build: {
          outDir: 'dist/main-thread',
          target: 'es2018',
          sourcemap: true,
          minify: false,
          css: { inject: false, emit: false },
          rolldownOptions: {
            output: {
              entryFileNames: '[name].js',
              chunkFileNames: 'chunks/[name].js',
            },
          },
        },
      },
    },
  })

  assert.equal(inspected, true)
  const entry = result.environmentResults[MAIN_THREAD].output.find(
    (artifact) => artifact.type === 'chunk' && artifact.isEntry,
  )
  assert.ok(entry)
  assert.doesNotMatch(entry.code, /\?\.|\?\?/)
  assert.equal(
    result.environmentResults[MAIN_THREAD].output.some(
      (artifact) => artifact.fileName.endsWith('.css'),
    ),
    false,
  )
  assert.equal(result.appOutput.length, 1)
  assert.ok(
    fs.existsSync(path.join(root, 'dist/native/entry.manifest.json')),
  )
})
