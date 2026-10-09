import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { buildElectron, electronPlugin, resolveConfig } from '../dist/index.js'

const execFileAsync = promisify(execFile)
const apiUrl = pathToFileURL(path.resolve('dist/index.js')).href

function write(root, name, content) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

function fixture(t, mainFormat = 'esm') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-electron-esm-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(root, 'package.json', {
    name: 'electron-esm-fixture',
    private: true,
    type: 'module',
    dependencies: { '@fixture/native': '1.0.0' },
  })
  write(root, 'index.html', '<html><script type="module" src="./renderer.js"></script></html>')
  write(root, 'renderer.js', 'globalThis.renderer = true')
  write(root, 'nasti.config.mjs', `export default {
    framework: 'vue', logLevel: 'silent',
    electron: { main: 'main.mts', preload: 'preload.ts', mainFormat: '${mainFormat}' },
    build: { minify: false, rolldownOptions: {
      transform: { define: { __CUSTOM_DEFINE__: '"custom"' } },
      output: { banner: '// custom banner' }
    } }
  }`)
  write(root, 'node_modules/electron/package.json', { name: 'electron', version: '41.0.0' })
  write(root, 'node_modules/dual/package.json', {
    name: 'dual',
    type: 'module',
    exports: {
      '.': {
        browser: './browser.mjs',
        node: { import: './import.mjs', require: './require.cjs' },
        default: './browser.mjs',
      },
    },
  })
  write(root, 'node_modules/dual/browser.mjs', 'throw new Error("browser branch in Node bundle")')
  write(root, 'node_modules/dual/import.mjs', 'export default "node-import"')
  write(root, 'node_modules/dual/require.cjs', 'module.exports = "node-require"')
  write(root, 'node_modules/esm-only/package.json', {
    name: 'esm-only', type: 'module', exports: { import: './index.mjs' },
  })
  write(root, 'node_modules/esm-only/index.mjs', 'export default "esm-only"')
  write(root, 'node_modules/@fixture/native/package.json', {
    name: '@fixture/native',
    gypfile: true,
    exports: { './subpath': './index.cjs' },
  })
  write(root, 'node_modules/@fixture/native/index.cjs', 'module.exports = "native-external"')
  // 使用 .mjs/.cjs specifier 指向 TypeScript 源码，模拟 NodeNext 项目。
  write(root, 'helper.mts', 'export const value: string = "typed-helper"')
  write(root, 'helper.mjs', 'throw new Error("stale emitted helper selected")')
  write(root, 'legacy.cts', 'module.exports = require("node:path").basename("/fixture/legacy")')
  write(root, 'legacy.cjs', 'throw new Error("stale emitted legacy selected")')
  write(root, 'preload.ts', 'globalThis.preloadValue = __CUSTOM_DEFINE__')
  return root
}

const esmMain = `
import dual from 'dual'
import esmOnly from 'esm-only'
import native from '@fixture/native/subpath'
import legacy from './legacy.cjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const dynamicBuiltin = require('node:' + 'path').basename('/fixture/local-require')
const { value } = await import('./helper.mjs')
export const result = {
  dual, esmOnly, native, legacy, dynamicBuiltin, value,
  url: import.meta.url, ssr: import.meta.env.SSR,
  custom: __CUSTOM_DEFINE__,
  devUrl: typeof __NASTI_DEV_SERVER_URL__ === 'undefined' ? null : __NASTI_DEV_SERVER_URL__
}
`

async function loadBundle(file) {
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    `const { result } = await import(${JSON.stringify(pathToFileURL(file).href)});
     console.log(JSON.stringify(result));`,
  ], { timeout: 20000 })
  return JSON.parse(stdout)
}

function assertESMResult(result, mainFile) {
  assert.equal(result.dual, 'node-import')
  assert.equal(result.esmOnly, 'esm-only')
  assert.equal(result.native, 'native-external')
  assert.equal(result.legacy, 'legacy')
  assert.equal(result.dynamicBuiltin, 'local-require')
  assert.equal(result.value, 'typed-helper')
  assert.equal(result.url, pathToFileURL(fs.realpathSync(mainFile)).href)
  assert.equal(result.ssr, true)
  assert.equal(result.custom, 'custom')
}

test('Electron ESM build executes TLA, NodeNext imports, CJS and external subpaths', async (t) => {
  const root = fixture(t)
  write(root, 'main.mts', esmMain)
  const output = await buildElectron({ root, build: { sourcemap: 'inline' } })
  assert.equal(path.basename(output.mainFile), 'main.mjs')
  assert.equal(path.basename(output.preloadFiles[0]), 'preload.cjs')
  const code = fs.readFileSync(output.mainFile, 'utf8')
  assert.match(code, /@fixture\/native\/subpath/)
  assert.match(code, /\/\/ custom banner/)
  assert.match(code, /sourceMappingURL=data:/)
  const result = await loadBundle(output.mainFile)
  assertESMResult(result, output.mainFile)
  assert.equal(result.devUrl, null)
})

test('Electron --no-spawn dev uses the same ESM resolution and exits without open servers', async (t) => {
  const root = fixture(t)
  write(root, 'main.mts', esmMain)
  await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    `const { startElectronDev } = await import(${JSON.stringify(apiUrl)});
     await startElectronDev({root: ${JSON.stringify(root)}, noSpawn: true, server: {port: 0}});`,
  ], { timeout: 20000 })
  const file = path.join(root, '.nasti/main.mjs')
  const result = await loadBundle(file)
  assertESMResult(result, file)
  assert.match(result.devUrl, /^http:\/\/localhost:\d+\/$/)
  assert.ok(fs.existsSync(file + '.map'))
  assert.equal(fs.readdirSync(path.join(root, '.nasti')).filter((name) => name.endsWith('.mjs')).length, 1)
})

test('Electron CJS remains supported and resolves import/require conditions separately', async (t) => {
  const root = fixture(t, 'cjs')
  write(root, 'main.mts', `
    import dual from 'dual'
    export const result = { imported: dual, required: require('dual') }
  `)
  const { mainFile } = await buildElectron({ root })
  assert.equal(path.basename(mainFile), 'main.cjs')
  assert.deepEqual(await loadBundle(mainFile), { imported: 'node-import', required: 'node-require' })
})

test('Electron aliases use NodeNext extensions and mode/custom package resolution in dev and build', async (t) => {
  const root = fixture(t)
  write(root, 'nasti.config.mjs', `export default {
    framework: 'vue', logLevel: 'silent',
    resolve: {alias: {'@': 'src'}, conditions: ['custom', 'browser'], mainFields: ['customMain', 'main']},
    electron: {main: 'main.mts', preload: '', mainFormat: 'esm'},
    build: {minify: false}
  }`)
  write(root, 'src/helper.ts', 'export const js: string = "alias-ts"')
  write(root, 'src/helper.js', 'throw new Error("stale emitted alias selected")')
  write(root, 'src/helper.mts', 'export const value: string = "alias-mts"')
  write(root, 'src/legacy.cts', 'module.exports = "alias-cts"')
  write(root, 'node_modules/mode-package/package.json', {
    name: 'mode-package', type: 'module',
    exports: { development: './dev.mjs', production: './prod.mjs', default: './fallback.mjs' },
  })
  for (const [file, value] of [['dev', 'development'], ['prod', 'production'], ['fallback', 'wrong']]) {
    write(root, `node_modules/mode-package/${file}.mjs`, `export default "${value}"`)
  }
  write(root, 'node_modules/custom-package/package.json', {
    name: 'custom-package', type: 'module',
    exports: { browser: './bad.mjs', custom: './custom.mjs', default: './bad.mjs' },
  })
  write(root, 'node_modules/custom-package/bad.mjs', 'throw new Error("wrong condition")')
  write(root, 'node_modules/custom-package/custom.mjs', 'export default "custom"')
  write(root, 'node_modules/mainfield-package/package.json', {
    name: 'mainfield-package', type: 'module', main: './bad.mjs', customMain: './custom.mjs',
  })
  write(root, 'node_modules/mainfield-package/bad.mjs', 'throw new Error("wrong main field")')
  write(root, 'node_modules/mainfield-package/custom.mjs', 'export default "custom-main"')
  write(root, 'main.mts', `
    import { js } from '@/helper.js'
    import { value } from '@/helper.mjs'
    import legacy from '@/legacy.cjs'
    import mode from 'mode-package'
    import custom from 'custom-package'
    import field from 'mainfield-package'
    export const result = {js, value, legacy, mode, custom, field}
  `)
  const { mainFile } = await buildElectron({ root })
  const expected = { js: 'alias-ts', value: 'alias-mts', legacy: 'alias-cts', custom: 'custom', field: 'custom-main' }
  assert.deepEqual(await loadBundle(mainFile), { ...expected, mode: 'production' })
  await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    `const { startElectronDev } = await import(${JSON.stringify(apiUrl)});
     await startElectronDev({root: ${JSON.stringify(root)}, noSpawn: true, server: {port: 0}});`,
  ], { timeout: 20000 })
  assert.deepEqual(await loadBundle(path.join(root, '.nasti/main.mjs')), { ...expected, mode: 'development' })
  write(root, 'main.mts', 'import "@/missing.js"')
  await assert.rejects(buildElectron({ root }), /Cannot resolve alias/)
})

test('Electron externalization respects package boundaries and scoped subpaths', async (t) => {
  const root = fixture(t)
  const config = await resolveConfig({ root, target: 'electron' }, 'build')
  const plugin = electronPlugin(config)
  for (const source of ['electron', 'electron/main', 'node:fs', 'fs/promises', '@fixture/native/subpath']) {
    assert.deepEqual(plugin.resolveId(source), { id: source, external: true })
  }
  assert.equal(plugin.resolveId('@fixture/native-other'), null)
})

test('Electron ESM on a detected pre-28 runtime fails before deleting output', async (t) => {
  const root = fixture(t)
  write(root, 'node_modules/electron/package.json', { name: 'electron', version: '27.3.0' })
  write(root, 'dist/keep.txt', 'keep')
  await assert.rejects(buildElectron({ root }), /Electron.*28.*required/)
  assert.equal(fs.readFileSync(path.join(root, 'dist/keep.txt'), 'utf8'), 'keep')
})

test('Electron failed --no-spawn compilation closes the renderer server', async (t) => {
  const root = fixture(t)
  write(root, 'main.mts', 'export const invalid = ;')
  await execFileAsync(process.execPath, [
    '--input-type=module', '-e',
    `const { startElectronDev } = await import(${JSON.stringify(apiUrl)});
     try {
       await startElectronDev({root: ${JSON.stringify(root)}, noSpawn: true, server: {port: 0}});
       process.exitCode = 1;
     } catch { console.log('expected compilation failure'); }`,
  ], { timeout: 20000 })
})

test('Electron dev restarts when an imported ESM module changes', { timeout: 20000 }, async (t) => {
  const root = fixture(t)
  write(root, 'helper.mts', 'export const value = "before"')
  write(root, 'main.mts', `
    import { value } from './helper.mjs'
    console.log('watch-value:' + value + ':' + process.pid)
    if (value === 'after') setTimeout(() => process.exit(0), 50)
    else setInterval(() => {}, 1000)
  `)
  const child = spawn(process.execPath, [
    '--input-type=module', '-e',
    `const { startElectronDev } = await import(${JSON.stringify(apiUrl)});
     await startElectronDev({root: ${JSON.stringify(root)}, server: {port: 0},
       electron: {electronPath: ${JSON.stringify(process.execPath)}}});`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let firstPid
  child.stderr.on('data', (data) => { output += data })
  t.after(() => {
    child.kill()
    if (firstPid) {
      try { process.kill(firstPid) } catch { /* already restarted */ }
    }
  })
  const exited = once(child, 'exit')
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => {
      output += data
      const match = output.match(/watch-value:before:(\d+)/)
      if (!match || firstPid) return
      firstPid = Number(match[1])
      write(root, 'helper.mts', 'export const value = "after"')
      resolve()
    })
    child.once('error', reject)
    child.once('exit', () => {
      if (!firstPid) reject(new Error(`Dev exited before startup: ${output}`))
    })
  })
  const [code] = await exited
  assert.equal(code, 0, output)
  assert.match(output, /watch-value:after:\d+/)
})

test('Electron dev recovers when a missing new import is created and watches subsequent edits', { timeout: 20000 }, async (t) => {
  const root = fixture(t)
  const source = (specifier) => `
    import { value } from '${specifier}'
    console.log('recovery-value:' + value + ':' + process.pid)
    if (value === 'final') setTimeout(() => process.exit(0), 50)
    else setInterval(() => {}, 1000)
  `
  write(root, 'helper.mts', 'export const value = "before"')
  write(root, 'main.mts', source('./helper.mjs'))
  const child = spawn(process.execPath, [
    '--input-type=module', '-e',
    `const { startElectronDev } = await import(${JSON.stringify(apiUrl)});
     await startElectronDev({root: ${JSON.stringify(root)}, server: {port: 0},
       electron: {electronPath: ${JSON.stringify(process.execPath)}}});`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const pids = new Set()
  const pidLiveness = new Map()
  let changedImport = false
  let createdModule = false
  let editedModule = false
  t.after(() => {
    child.kill()
    for (const pid of pids) {
      try { process.kill(pid) } catch { /* already restarted */ }
    }
  })
  const consume = (data) => {
    output += data
    for (const match of output.matchAll(/recovery-value:[a-z]+:(\d+)/g)) pids.add(Number(match[1]))
    if (!changedImport && output.includes('recovery-value:before:')) {
      changedImport = true
      write(root, 'main.mts', source('./new.mjs'))
    }
    if (!createdModule && output.includes('保留上一次进程')) {
      createdModule = true
      // 失败的编译不能结束上一次已经加载的应用。
      for (const pid of pids) {
        try {
          process.kill(pid, 0)
          pidLiveness.set(pid, true)
        } catch {
          pidLiveness.set(pid, false)
        }
      }
      write(root, 'new.mts', 'export const value = "recovered"')
    }
    if (!editedModule && output.includes('recovery-value:recovered:')) {
      editedModule = true
      write(root, 'new.mts', 'export const value = "final"')
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
  assert.ok(createdModule, output)
  for (const [pid, alive] of pidLiveness) {
    assert.ok(alive, `Previous process ${pid} exited after a failed compilation: ${output}`)
  }
  assert.match(output, /recovery-value:final:\d+/)
})
