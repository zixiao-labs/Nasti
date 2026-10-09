// 显式的真实运行时验证，不被根 node --test 自动发现。
// node scripts/electron-smoke.mjs <electron-binary> [--napi | rust-packager-binary]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildElectron } from '../dist/index.js'

const electron = process.argv[2]
const packager = process.argv[3]
if (!electron) throw new Error('Usage: node scripts/electron-smoke.mjs <electron-binary> [--napi | rust-packager-binary]')
const execFileAsync = promisify(execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-electron-smoke-'))
const write = (name, content) => fs.writeFileSync(path.join(root, name), content)

try {
  write('package.json', JSON.stringify({ name: 'nasti-electron-smoke', version: '1.0.0', type: 'module' }))
  write('index.html', '<html><div id="smoke">renderer-ready</div><script type="module" src="./renderer.js"></script></html>')
  write('renderer.js', 'globalThis.rendererReady = true')
  write('legacy.cts', 'module.exports = require("node:path").basename("/smoke/cjs")')
  write('helper.mts', 'export const value: string = "esm-tla"')
  write('preload.ts', `
    import { contextBridge } from 'electron'
    contextBridge.exposeInMainWorld('smokeValue', 'sandboxed-preload')
  `)
  write('main.mts', `
    import assert from 'node:assert/strict'
    import path from 'node:path'
    import { fileURLToPath } from 'node:url'
    import { app, BrowserWindow } from 'electron'
    import legacy from './legacy.cjs'
    const { value } = await import('./helper.mjs')
    assert.equal(value, 'esm-tla')
    assert.equal(legacy, 'cjs')
    const dir = path.dirname(fileURLToPath(import.meta.url))
    async function run() {
      try {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.join(dir, 'preload.cjs'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
          },
        })
        window.webContents.on('preload-error', (_event, _file, error) => {
          console.error(error); app.exit(1)
        })
        await window.loadFile(path.join(dir, 'renderer/index.html'))
        const observed = await window.webContents.executeJavaScript(
          '[window.smokeValue, document.getElementById("smoke").textContent, window.rendererReady, typeof require]'
        )
        assert.deepEqual(observed, ['sandboxed-preload', 'renderer-ready', true, 'undefined'])
        console.log('NASTI_SMOKE:' + JSON.stringify({
          electron: process.versions.electron, esm: true, sandboxedPreload: true, renderer: true,
        }))
        window.destroy()
        app.exit(0)
      } catch (error) {
        console.error(error); app.exit(1)
      }
    }
    void app.whenReady().then(run).catch((error) => {
      console.error(error); app.exit(1)
    })
  `)
  const result = await buildElectron({
    root, framework: 'vue', logLevel: 'silent',
    electron: { main: 'main.mts', preload: 'preload.ts', mainFormat: 'esm' },
    build: { minify: false },
  })
  let entry = result.mainFile
  if (packager) {
    write('dist/package.json', JSON.stringify({
      name: 'nasti-electron-smoke', version: '1.0.0', type: 'module', main: 'main.mjs',
    }))
    entry = path.join(root, 'app.asar')
    if (packager === '--napi') {
      const { pack } = await import('../packages/electron-packager/index.mjs')
      await pack({ input: path.join(root, 'dist'), output: entry })
    } else {
      await execFileAsync(packager, ['pack', path.join(root, 'dist'), entry], { timeout: 30000 })
    }
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await execFileAsync(electron, [entry], { timeout: 30000, env })
  const match = stdout.match(/NASTI_SMOKE:(.*)/)
  assert.ok(match, `Electron did not report success: ${stdout}`)
  console.log(JSON.stringify({ ...JSON.parse(match[1]), asar: !!packager }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
