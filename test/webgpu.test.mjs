import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite'

import { build, createServer, webgpuPlugin } from '../dist/index.js'

const plainShader = `// Quotes: "double", 'single', backslash: \\
// import 'not-a-js-module'
@compute @workgroup_size(1) fn main() {}
`
const colorModule = (value) => `export fn shade() -> f32 { return ${value}; }\n`
const shaderEntry = (dependency) => `import { shade } from "${dependency}";
@compute @workgroup_size(1) fn main() { let value = shade(); }
`

function fixture(t) {
  const monorepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-gpu-')))
  const root = path.join(monorepo, 'apps/web')
  const shaders = path.join(monorepo, 'packages/shaders')
  const servers = []
  const write = (file, source) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
  }
  write(path.join(root, 'package.json'), '{"private":true,"type":"module"}')
  write(path.join(root, 'index.html'), '<script type="module" src="/src/main.js"></script>')
  write(path.join(root, 'src/shader.wgsl'), plainShader)
  write(path.join(shaders, 'package.json'), JSON.stringify({
    name: '@fixture/shaders', type: 'module', exports: './index.js',
  }))
  write(path.join(shaders, 'index.js'), 'export { default } from "./shader.wgsl";')
  write(path.join(shaders, 'shader.wgsl'), plainShader)
  fs.mkdirSync(path.join(root, 'node_modules/@fixture'), { recursive: true })
  fs.symlinkSync(shaders, path.join(root, 'node_modules/@fixture/shaders'),
    process.platform === 'win32' ? 'junction' : 'dir')
  t.after(async () => {
    for (const server of servers) await server.close()
    fs.rmSync(monorepo, { recursive: true, force: true })
  })
  const config = (plugins) => ({
    root, configFile: false, framework: 'vue', logLevel: 'silent', plugins,
    resolve: { alias: { '@shaders': shaders } },
    server: { port: 0, host: '127.0.0.1' },
    build: { minify: false },
  })
  return {
    monorepo, root, shaders, write, config,
    async serve(plugins) {
      const server = await createServer(config(plugins))
      servers.push(server)
      await server.listen(0)
      return server
    },
  }
}

async function evaluate(code) {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.config.server.port}`
}

function fsUrl(file) {
  return '/@fs/' + file.replace(/\\/g, '/').replace(/^\//, '')
}

async function update(server, file, mutate, event = 'change') {
  const sent = server.environments.client.hot.send
  let timer
  const payload = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Missing HMR update for ${file}`)), 5000)
    server.environments.client.hot.send = (message) => {
      sent.call(server.environments.client.hot, message)
      if (['update', 'full-reload', 'error'].includes(message.type)) resolve(message)
    }
  })
  try {
    mutate()
    if (event) server.watcher.emit(event, file)
    return await payload
  } finally {
    clearTimeout(timer)
    server.environments.client.hot.send = sent
  }
}

test('WebGPU imports preserve WGSL bytes in dev, including comments that resemble JS imports', async (t) => {
  const f = fixture(t)
  const server = await f.serve([webgpuPlugin()])
  const response = await fetch(baseUrl(server) + '/src/shader.wgsl', {
    headers: { 'sec-fetch-dest': 'script' },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /javascript/)
  assert.equal((await evaluate(await response.text())).default, plainShader)

  for (const url of ['/src/shader.wgsl?raw', '/src/shader.wgsl?t=123']) {
    const transformed = await server.transformRequest(url)
    assert.equal((await evaluate(transformed.code)).default, plainShader)
  }
  const linked = await server.transformRequest(fsUrl(path.join(f.shaders, 'shader.wgsl')))
  assert.equal((await evaluate(linked.code)).default, plainShader)
  const pkg = await server.transformRequest('/@modules/@fixture/shaders')
  assert.equal((await evaluate(pkg.code)).default, plainShader)

  // The import wrapper and the URL it exports must remain different resources.
  for (const url of ['/src/shader.wgsl?url', fsUrl(path.join(f.shaders, 'shader.wgsl')) + '?url']) {
    const transformed = await server.transformRequest(url)
    const shaderUrl = (await evaluate(transformed.code)).default
    const resource = await fetch(baseUrl(server) + shaderUrl)
    assert.equal(resource.status, 200)
    assert.equal(await resource.text(), plainShader)
  }
  const privateShader = path.join(f.monorepo, 'private.wgsl')
  f.write(privateShader, 'not a linked workspace input')
  assert.equal(await server.transformRequest(fsUrl(privateShader)), null)
  assert.equal((await fetch(baseUrl(server) + fsUrl(privateShader))).status, 404)
})

test('WebGPU build supports linked packages, aliases, raw imports, and base-prefixed shader URLs', async (t) => {
  const f = fixture(t)
  f.write(path.join(f.root, 'src/main.js'), `
import shader from './shader.wgsl';
import workspaceShader from '@fixture/shaders';
import raw from '@shaders/shader.wgsl?raw';
import url from '@shaders/shader.wgsl?url';
globalThis.__nastiGpuBuild = { shader, workspaceShader, raw, url };
`)
  const result = await build({ ...f.config([webgpuPlugin()]), base: '/demo/' })
  const entry = result.output.find((item) => item.type === 'chunk' && item.isEntry)
  await evaluate(entry.code)
  t.after(() => { delete globalThis.__nastiGpuBuild })
  const { shader, workspaceShader, raw, url } = globalThis.__nastiGpuBuild
  assert.equal(shader, plainShader)
  assert.equal(workspaceShader, plainShader)
  assert.equal(raw, plainShader)
  assert.match(url, /^\/demo\/assets\/shader\.[a-f0-9]{8}\.wgsl$/)
  const asset = result.output.find((item) => item.fileName === url.slice('/demo/'.length))
  assert.ok(asset)
  assert.equal(Buffer.from(asset.source).toString(), plainShader)
})

test('official vgpu plugin compiles transitive WGSL imports in dev and build without a GPU', async (t) => {
  const f = fixture(t)
  f.write(path.join(f.root, 'src/shader.wgsl'), shaderEntry('./color.wgsl'))
  f.write(path.join(f.root, 'src/color.wgsl'), colorModule('0.25'))
  f.write(path.join(f.shaders, 'shader.wgsl'), shaderEntry('./color.wgsl'))
  f.write(path.join(f.shaders, 'color.wgsl'), colorModule('0.75'))
  f.write(path.join(f.root, 'src/main.js'), `
import shader from './shader.wgsl';
import workspaceShader from '@fixture/shaders';
globalThis.__nastiVgpuBuild = { shader, workspaceShader };
`)
  const server = await f.serve([wgslVitePlugin()])
  const response = await fetch(baseUrl(server) + '/src/shader.wgsl', {
    headers: { 'sec-fetch-dest': 'script' },
  })
  assert.equal(response.status, 200)
  const shader = (await evaluate(await response.text())).default
  assert.match(shader.wgsl, /return 0\.25/)
  assert.doesNotMatch(shader.wgsl, /import\s*\{/)
  assert.equal(shader.version, 2)
  assert.equal(shader.reflection.entryPoints[0].stage, 'compute')
  const pkg = await server.transformRequest('/@modules/@fixture/shaders')
  assert.match((await evaluate(pkg.code)).default.wgsl, /return 0\.75/)

  const result = await build(f.config([wgslVitePlugin({ minify: true })]))
  await evaluate(result.output.find((item) => item.isEntry).code)
  t.after(() => { delete globalThis.__nastiVgpuBuild })
  assert.match(globalThis.__nastiVgpuBuild.shader.wgsl, /0\.25/)
  assert.match(globalThis.__nastiVgpuBuild.workspaceShader.wgsl, /0\.75/)
  assert.equal(globalThis.__nastiVgpuBuild.shader.reflection.entryPoints[0].name, 'main')
})

test('vgpu transitive inputs invalidate local shader entries and remove stale dependencies', async (t) => {
  const f = fixture(t)
  const color = path.join(f.shaders, 'color.wgsl')
  const entry = path.join(f.root, 'src/shader.wgsl')
  f.write(color, colorModule('0.25'))
  f.write(entry, shaderEntry('../../../packages/shaders/color.wgsl'))
  f.write(path.join(f.root, 'src/main.js'), `
import shader from './shader.wgsl';
if (import.meta.hot) import.meta.hot.accept('./shader.wgsl', () => {});
`)
  const server = await f.serve([wgslVitePlugin()])
  await server.transformRequest('/src/main.js')
  await server.transformRequest('/src/shader.wgsl')
  await server.watcher.unwatch(f.monorepo)
  const payload = await update(server, color, () => f.write(color, colorModule('0.5')))
  assert.equal(payload.type, 'update')
  assert.equal(payload.updates[0].acceptedPath, '/src/shader.wgsl')
  assert.match((await evaluate((await server.transformRequest('/src/shader.wgsl')).code)).default.wgsl,
    /return 0\.5/)

  // A shader without imports no longer owns color.wgsl.
  const removed = await update(server, entry, () => f.write(entry, '@compute @workgroup_size(1) fn main() {}'))
  assert.equal(removed.type, 'update')
  assert.equal(server.environments.client.pluginContainer.getModulesByWatchFile(color).size, 0)
})

test('vgpu watch inputs cross package boundaries in prebundled workspace dependencies', async (t) => {
  const f = fixture(t)
  // Shared WGSL is not in the linked package: package-root fallback is insufficient.
  const shared = path.join(f.monorepo, 'shared/color.wgsl')
  f.write(shared, colorModule('0.125'))
  f.write(path.join(f.shaders, 'shader.wgsl'), shaderEntry('../../shared/color.wgsl'))
  f.write(path.join(f.root, 'src/main.js'), `
import shader from '@fixture/shaders';
if (import.meta.hot) import.meta.hot.accept('@fixture/shaders', () => {});
`)
  const server = await f.serve([wgslVitePlugin()])
  await server.transformRequest('/src/main.js')
  await server.transformRequest('/@modules/@fixture/shaders')
  await server.watcher.unwatch(f.monorepo)
  const payload = await update(server, shared, () => f.write(shared, colorModule('0.875')))
  assert.equal(payload.type, 'update')
  assert.equal(payload.updates[0].acceptedPath, '/@modules/@fixture/shaders')
  const result = await server.transformRequest('/@modules/@fixture/shaders')
  assert.match((await evaluate(result.code)).default.wgsl, /return 0\.875/)
})

test('vgpu WGSL resolution errors are surfaced, not silently treated as raw strings', async (t) => {
  const f = fixture(t)
  f.write(path.join(f.root, 'src/shader.wgsl'), shaderEntry('./missing.wgsl'))
  const server = await f.serve([wgslVitePlugin()])
  const response = await fetch(baseUrl(server) + '/src/shader.wgsl', {
    headers: { 'sec-fetch-dest': 'script' },
  })
  assert.equal(response.status, 500)
  assert.match(await response.text(), /missing\.wgsl/)
})

test('vgpu dependency deletion reports an HMR error and recreation recovers', async (t) => {
  const f = fixture(t)
  const color = path.join(f.root, 'src/color.wgsl')
  f.write(color, colorModule('0.25'))
  f.write(path.join(f.root, 'src/shader.wgsl'), shaderEntry('./color.wgsl'))
  const server = await f.serve([wgslVitePlugin()])
  await server.transformRequest('/src/shader.wgsl')
  await server.watcher.unwatch(f.monorepo)
  const removed = await update(server, color, () => fs.unlinkSync(color), 'unlink')
  assert.equal(removed.type, 'error')
  assert.match(removed.err.message, /color\.wgsl/)
  const restored = await update(server, color, () => f.write(color, colorModule('0.75')), 'add')
  assert.equal(restored.type, 'full-reload')
  const shader = (await evaluate((await server.transformRequest('/src/shader.wgsl')).code)).default
  assert.match(shader.wgsl, /return 0\.75/)
})

test('vgpu concurrent transforms keep watch dependencies attached to their own entries', async (t) => {
  const f = fixture(t)
  for (const [name, value] of [['a', '0.25'], ['b', '0.75']]) {
    f.write(path.join(f.root, `src/${name}.wgsl`), shaderEntry(`./${name}-color.wgsl`))
    f.write(path.join(f.root, `src/${name}-color.wgsl`), colorModule(value))
  }
  const server = await f.serve([wgslVitePlugin()])
  await Promise.all(['a', 'b'].map((name) => server.transformRequest(`/src/${name}.wgsl`)))
  for (const name of ['a', 'b']) {
    const owners = server.environments.client.pluginContainer.getModulesByWatchFile(
      path.join(f.root, `src/${name}-color.wgsl`),
    )
    assert.deepEqual([...owners].map((mod) => mod.url), [`/src/${name}.wgsl`])
  }
})

test('vgpu addWatchFile observes real edits outside app and linked package roots', { timeout: 10000 }, async (t) => {
  const f = fixture(t)
  const shared = path.join(f.monorepo, 'shared/color.wgsl')
  f.write(shared, colorModule('0.25'))
  f.write(path.join(f.root, 'src/shader.wgsl'), shaderEntry('../../../shared/color.wgsl'))
  const server = await f.serve([wgslVitePlugin()])
  await server.transformRequest('/src/shader.wgsl')

  // Chokidar.add() scans asynchronously. Wait for this specific file to be
  // watched, rather than racing a write against the additional-input scan.
  const deadline = Date.now() + 5000
  while (!server.watcher.getWatched()[path.dirname(shared)]?.includes(path.basename(shared))) {
    assert.ok(Date.now() < deadline, 'addWatchFile must register an outside-root input')
    await delay(10)
  }
  const payload = await update(server, shared, () => f.write(shared, colorModule('0.875')), null)
  assert.equal(payload.type, 'full-reload')
  const shader = (await evaluate((await server.transformRequest('/src/shader.wgsl')).code)).default
  assert.match(shader.wgsl, /return 0\.875/)
})

test('WebGPU opt-in type entry declares plain, raw and URL shader imports as strings', (t) => {
  const f = fixture(t)
  const repo = fileURLToPath(new URL('../', import.meta.url))
  fs.mkdirSync(path.join(f.root, 'node_modules/@nasti-toolchain'), { recursive: true })
  fs.symlinkSync(repo, path.join(f.root, 'node_modules/@nasti-toolchain/nasti'),
    process.platform === 'win32' ? 'junction' : 'dir')
  f.write(path.join(f.root, 'src/types.ts'), `
/// <reference types="@nasti-toolchain/nasti/webgpu" />
import shader from './shader.wgsl';
import raw from './shader.wgsl?raw';
import url from './shader.wgsl?url';
const sources: string[] = [shader, raw, url];
// @ts-expect-error shader imports must not be typed as any
const invalid: number = shader;
`)
  const require = createRequire(import.meta.url)
  execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--target', 'ES2022',
    '--types', '@nasti-toolchain/nasti/webgpu', path.join(f.root, 'src/types.ts'),
  ], { cwd: f.root, stdio: 'pipe' })
})
