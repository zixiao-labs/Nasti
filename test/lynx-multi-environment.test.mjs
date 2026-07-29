import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { build } from '../dist/index.js'

const BACKGROUND = 'lynx-background'
const MAIN_THREAD = 'lynx-main-thread'

test('native Lynx background and main-thread environments build and aggregate independently', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-lynx-multi-env-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { react: '^19.0.0' } }),
  )
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(
    path.join(root, 'src/entry.js'),
    [
      'import { runtime } from "fixture-lynx-runtime";',
      'export const thread = "__LYNX_THREAD__";',
      'export const selectedRuntime = runtime;',
      '',
    ].join('\n'),
  )

  const runtimeRoot = path.join(root, 'node_modules/fixture-lynx-runtime')
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({
      name: 'fixture-lynx-runtime',
      type: 'module',
      exports: {
        '.': {
          [BACKGROUND]: './background.js',
          [MAIN_THREAD]: './main-thread.js',
          default: './default.js',
        },
      },
    }),
  )
  fs.writeFileSync(path.join(runtimeRoot, 'background.js'), 'export const runtime = "BG_RUNTIME";\n')
  fs.writeFileSync(path.join(runtimeRoot, 'main-thread.js'), 'export const runtime = "MT_RUNTIME";\n')
  fs.writeFileSync(path.join(runtimeRoot, 'default.js'), 'export const runtime = "DEFAULT_RUNTIME";\n')

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist/stale.lynx.bundle'), 'stale')

  const events = []
  const plugin = {
    name: 'fixture:lynx-dual-thread',
    applyToEnvironment(environment) {
      return environment.name === BACKGROUND || environment.name === MAIN_THREAD
    },
    transform(code, id) {
      if (!/[\\/]src[\\/]entry\.js$/.test(id)) return null
      const environmentName = this.environment.name
      events.push(`transform:${environmentName}`)
      return code.replace('__LYNX_THREAD__', environmentName)
    },
    generateBundle() {
      const environmentName = this.environment.name
      const manifest = {
        environment: environmentName,
        runtime: environmentName === BACKGROUND ? 'js' : 'lepus',
      }
      this.environment.setBuildMetadata({
        manifest,
        // final result must normalize plugin-provided entry paths before app lookup.
        entries: { entry: 'nested/../entry.js' },
      })
      const fileName = `metadata/${environmentName}.json`
      const referenceId = this.emitFile({
        type: 'asset',
        fileName,
        source: JSON.stringify(manifest),
      })
      assert.equal(this.getFileName(referenceId), fileName)
      events.push(`generateBundle:${environmentName}`)
    },
    closeBundle() {
      events.push(`closeBundle:${this.environment.name}`)
    },
    afterBuildApp(results, _api, context) {
      assert.deepEqual(Object.keys(results), [BACKGROUND, MAIN_THREAD])
      assert.equal(context.getResult('client'), undefined)

      const backgroundEntry = context.getEntry(BACKGROUND, 'entry')
      const mainThreadEntry = context.getEntry(MAIN_THREAD, 'entry')
      assert.ok(backgroundEntry)
      assert.ok(mainThreadEntry)
      assert.match(backgroundEntry.code, /lynx-background/)
      assert.match(backgroundEntry.code, /BG_RUNTIME/)
      assert.doesNotMatch(backgroundEntry.code, /lynx-main-thread|MT_RUNTIME|DEFAULT_RUNTIME/)
      assert.match(mainThreadEntry.code, /lynx-main-thread/)
      assert.match(mainThreadEntry.code, /MT_RUNTIME/)
      assert.doesNotMatch(mainThreadEntry.code, /lynx-background|BG_RUNTIME|DEFAULT_RUNTIME/)

      assert.deepEqual(context.getManifest(BACKGROUND), {
        environment: BACKGROUND,
        runtime: 'js',
      })
      assert.deepEqual(context.getManifest(MAIN_THREAD), {
        environment: MAIN_THREAD,
        runtime: 'lepus',
      })
      assert.ok(context.getArtifact(BACKGROUND, `metadata/${BACKGROUND}.json`))
      assert.ok(context.getArtifact(MAIN_THREAD, `metadata/${MAIN_THREAD}.json`))

      context.emitFile({
        type: 'asset',
        fileName: 'app.native.lynx.bundle',
        source: JSON.stringify({
          background: backgroundEntry.fileName,
          mainThread: mainThreadEntry.fileName,
        }),
      })
      events.push('afterBuildApp')
    },
  }

  const result = await build({
    root,
    logLevel: 'silent',
    plugins: [plugin],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      minify: false,
      rolldownOptions: {
        // Per-environment resolve.conditions must override inherited low-level conditions.
        resolve: { conditionNames: ['default'] },
        output: { entryFileNames: '[name].js' },
      },
    },
    environments: {
      client: { buildEnabled: false },
      [BACKGROUND]: {
        consumer: 'client',
        entry: 'src/entry.js',
        resolve: { conditions: [BACKGROUND, 'browser', 'import'] },
        build: { outDir: 'dist/background' },
      },
      [MAIN_THREAD]: {
        consumer: 'client',
        entry: 'src/entry.js',
        resolve: { conditions: [MAIN_THREAD, 'browser', 'import'] },
        build: { outDir: 'dist/main-thread' },
      },
    },
  })

  assert.deepEqual(result.output, [])
  assert.deepEqual(Object.keys(result.environments), [BACKGROUND, MAIN_THREAD])
  assert.equal(result.environmentResults[BACKGROUND].entries.entry, 'entry.js')
  assert.equal(result.environmentResults[MAIN_THREAD].entries.entry, 'entry.js')
  assert.deepEqual(result.appOutput.map((artifact) => artifact.fileName), [
    'app.native.lynx.bundle',
  ])
  assert.ok(fs.existsSync(path.join(root, 'dist/app.native.lynx.bundle')))
  assert.equal(fs.existsSync(path.join(root, 'dist/stale.lynx.bundle')), false)

  for (const environmentName of [BACKGROUND, MAIN_THREAD]) {
    assert.ok(events.includes(`transform:${environmentName}`))
    assert.ok(events.includes(`generateBundle:${environmentName}`))
    assert.ok(events.includes(`closeBundle:${environmentName}`))
  }
  assert.equal(events.filter((event) => event === 'afterBuildApp').length, 1)
})

test('app finalizer rejects dangling symlink paths', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-lynx-symlink-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'dist'))
  const outside = path.join(root, 'outside/missing.lynx.bundle')
  fs.symlinkSync(outside, path.join(root, 'dist/escape.lynx.bundle'))

  await assert.rejects(
    () =>
      build({
        root,
        logLevel: 'silent',
        build: { outDir: 'dist', emptyOutDir: false },
        environments: { client: { buildEnabled: false } },
        plugins: [
          {
            name: 'fixture:symlink-finalizer',
            afterBuildApp(_results, _api, app) {
              app.emitFile({
                type: 'asset',
                fileName: 'escape.lynx.bundle',
                source: 'must-stay-inside-out-dir',
              })
            },
          },
        ],
      }),
    /app artifact path cannot traverse a symlink/,
  )
  assert.equal(fs.existsSync(outside), false)
})

test('environment metadata rejects Windows absolute entry paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-lynx-entry-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/entry.js'), 'export const ready = true;\n')

  await assert.rejects(
    () =>
      build({
        root,
        logLevel: 'silent',
        environments: {
          client: { buildEnabled: false },
          [BACKGROUND]: {
            consumer: 'client',
            entry: 'src/entry.js',
          },
        },
        plugins: [
          {
            name: 'fixture:absolute-entry',
            generateBundle() {
              this.environment.setBuildMetadata({
                entries: { entry: 'C:\\outside\\entry.js' },
              })
            },
          },
        ],
      }),
    /environment "lynx-background" returned invalid entry "entry": C:\\outside\\entry\.js/,
  )
})

test('app finalizer cannot overwrite an environment artifact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-lynx-artifact-conflict-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/entry.js'), 'export const ready = true;\n')

  await assert.rejects(
    () =>
      build({
        root,
        logLevel: 'silent',
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          rolldownOptions: { output: { entryFileNames: 'collision.js' } },
        },
        environments: {
          client: { buildEnabled: false },
          [BACKGROUND]: {
            consumer: 'client',
            entry: 'src/entry.js',
            build: { outDir: 'dist' },
          },
        },
        plugins: [
          {
            name: 'fixture:conflicting-finalizer',
            afterBuildApp(_results, _api, app) {
              app.emitFile({
                type: 'asset',
                fileName: 'collision.js',
                source: 'must-not-overwrite',
              })
            },
          },
        ],
      }),
    /app artifact conflicts with environment output: collision\.js/,
  )
})
