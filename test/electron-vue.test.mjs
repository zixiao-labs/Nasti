import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildElectron,
  detectFramework,
  electronRendererDevPath,
  resolveConfig,
} from '../dist/index.js'

const fixtureRoot = path.resolve('playground/electron-vue')

test('Electron Vue config resolves framework and nested renderer HTML', async () => {
  assert.equal(detectFramework(fixtureRoot), 'vue')
  assert.equal(electronRendererDevPath('src/renderer/index.html'), '/src/renderer/index.html')

  const config = await resolveConfig({ root: fixtureRoot, target: 'electron' }, 'build')
  assert.equal(config.framework, 'vue')
  assert.equal(
    config.environments.client.html,
    path.join(fixtureRoot, 'src/renderer/index.html'),
  )
})

test('Electron Vue production build emits file-relative renderer assets', async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-electron-vue-'))
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }))

  const result = await buildElectron({
    root: fixtureRoot,
    logLevel: 'silent',
    build: {
      outDir,
      minify: false,
      emptyOutDir: true,
    },
  })

  const html = fs.readFileSync(path.join(result.rendererOutDir, 'index.html'), 'utf-8')
  assert.match(html, /(?:src|href)="\.\/assets\//)
  assert.doesNotMatch(html, /(?:src|href)="\/assets\//)
  assert.ok(fs.existsSync(result.mainFile))
  assert.equal(result.preloadFiles.length, 1)
  assert.ok(result.preloadFiles.every(fs.existsSync))
  assert.ok(
    fs.readdirSync(path.join(result.rendererOutDir, 'assets')).some((file) => file.endsWith('.js')),
  )
})
