import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  build, createServer, createTanStackStartPreview, detectFramework,
  tanstackStart, tanstackRouter, redact,
  resolveConfig,
} from '../dist/index.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const supported = Number(process.versions.node.split('.')[0]) >= 22
const browsers = process.env.NASTI_BROWSER_TESTS === '1'

function fixture(t, framework) {
  const monorepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-tanstack-')))
  const root = path.join(monorepo, 'apps/web')
  const app = path.join(repo, 'playground', `tanstack-${framework}`)
  fs.mkdirSync(root, { recursive: true })
  fs.cpSync(path.join(app, 'src'), path.join(root, 'src'), { recursive: true })
  const index = path.join(root, 'src/routes/index.tsx')
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(
    "'POST_OK'", "'POST_OK' + 'INLINE_SERVER_SECRET'.slice(0, 0)",
  ))
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  const shared = path.join(monorepo, 'packages/shared')
  fs.cpSync(path.join(repo, 'packages/tanstack-shared'), shared, { recursive: true })
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (dependency === '@nasti-toolchain/nasti') continue
    const link = path.join(root, 'node_modules', dependency)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(dependency === '@nasti-toolchain/tanstack-shared' ? shared :
      fs.realpathSync(path.join(app, 'node_modules', dependency)), link, 'junction')
  }
  t.after(() => fs.rmSync(monorepo, { recursive: true, force: true }))
  return root
}

function config(root, framework, useRedact = false) {
  return {
    root, framework, logLevel: 'silent',
    plugins: [tanstackStart({ framework }), ...(useRedact ? [redact()] : [])],
  }
}

async function listen(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  }
}

for (const [framework, useRedact] of [['react', false], ['react', true], ['solid', false]]) {
  const name = framework + (useRedact ? ' + Redact' : '')
  test(`native Start ${name}: production SSR, RPC, assets and client isolation`, { skip: !supported }, async (t) => {
    const root = fixture(t, framework)
    const settings = config(root, framework, useRedact)
    settings.build = { ...settings.build, sourcemap: true }
    const result = await build(settings)
    const client = result.output.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n')
    assert.doesNotMatch(client, /NASTI_SERVER_SECRET_SENTINEL|INLINE_SERVER_SECRET|node:async_hooks|tss-serverfn-split/)
    assert.doesNotMatch(client, /from\s*["'](?:vite|@vitejs)\b/)
    const maps = result.output.filter((item) => item.fileName.endsWith('.map'))
    for (const map of maps) assert.doesNotMatch(String(map.source), /NASTI_SERVER_SECRET_SENTINEL|INLINE_SERVER_SECRET/)
    const { default: handler } = await import(pathToFileURL(path.join(root, 'dist/server/server.mjs')).href)
    const response = await handler.fetch(new Request('http://localhost/'))
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /SSR_OK/)
    assert.match(html, /Native Nasti \+ TanStack/)
    assert.match(html, /assets\/client\.[\w-]+\.js/)
    assert.match(html, /stylesheet/)
    assert.equal((await handler.fetch(new Request('http://localhost/about'))).status, 200)
    assert.equal((await handler.fetch(new Request('http://localhost/does-not-exist'))).status, 404)
    const preview = await listen(await createTanStackStartPreview(path.join(root, 'dist')))
    t.after(() => preview.close())
    assert.equal((await fetch(preview.url + '/')).status, 200)
    const assetUrl = html.match(/src="([^"]+\.js)"/)[1]
    const asset = await fetch(preview.url + assetUrl)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type'), /javascript/)
    const serverSource = await fetch(preview.url + '/server/server.mjs')
    assert.equal(serverSource.status, 404)
    assert.doesNotMatch(await serverSource.text(), /NASTI_SERVER_SECRET_SENTINEL/)
    assert.ok((await fetch(preview.url + '/_serverFn/not-registered')).status >= 400)
    if (browsers) await checkBrowser(t, preview.url)
  })

  test(`native Start ${name}: dev HTTP and linked workspace invalidation`, { skip: !supported }, async (t) => {
    const root = fixture(t, framework)
    const server = await createServer({ ...config(root, framework, useRedact), server: { port: 0, host: '127.0.0.1' } })
    t.after(() => server.close())
    await server.listen(0)
    const url = `http://127.0.0.1:${server.config.server.port}`
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /SSR_OK/)
    const clientRoute = await fetch(url + '/src/routes/index.tsx')
    assert.equal(clientRoute.status, 200, 'client-reachable routes are compiled for HMR')
    assert.doesNotMatch(await clientRoute.text(), /INLINE_SERVER_SECRET|NASTI_SERVER_SECRET_SENTINEL|serverValue\(\)/)
    assert.equal((await fetch(url + '/.nasti/start/server.ts')).status, 404, 'generated server entry is private')
    for (const suffix of ['?raw', '?tss-serverfn-split', '?x=tss-serverfn-split']) {
      const privateSource = await fetch(url + '/src/routes/index.tsx' + suffix)
      assert.equal(privateSource.status, 404, 'unrequested source/provider queries stay private')
      assert.doesNotMatch(await privateSource.text(), /INLINE_SERVER_SECRET|NASTI_SERVER_SECRET_SENTINEL/)
    }
    const rootRoute = await (await fetch(url + '/src/routes/__root.tsx')).text()
    assert.match(rootRoute, /handleRouteUpdate/, 'routes without server functions keep Router HMR')
    if (browsers) {
      await checkBrowser(t, url)
      await checkStartRefresh(t, url, root, server)
    }
    const file = path.join(root, 'src/routes/about.lazy.tsx')
    const changed = new Promise((resolve) => server.watcher.once('change', resolve))
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('About Nasti', 'Updated Nasti'))
    await changed
    const updated = await fetch(url + '/about')
    assert.match(await updated.text(), /Updated Nasti/)
    const shared = fs.realpathSync(path.join(root, 'node_modules/@nasti-toolchain/tanstack-shared'))
    const serverFile = path.join(shared, 'src/secret.server.ts')
    const linkedChange = new Promise((resolve) => {
      const onChange = (file) => { if (file === serverFile) { server.watcher.off('change', onChange); resolve() } }
      server.watcher.on('change', onChange)
    })
    fs.writeFileSync(serverFile, fs.readFileSync(serverFile, 'utf8').replace('SSR_OK', 'WORKSPACE_UPDATED'))
    await linkedChange
    assert.match(await (await fetch(url)).text(), /WORKSPACE_UPDATED/)
  })
}

test('Start filters only known non-RSC client directives', () => {
  const plugin = tanstackStart()
  const warning = (id, directive = 'use client') => ({
    code: 'MODULE_LEVEL_DIRECTIVE', id,
    message: `The semantics of the module level directive "${directive}" may not be preserved`,
  })
  const known = '/app/node_modules/.pnpm/router/node_modules/@tanstack/react-router/dist/esm/index.js'
  assert.equal(plugin.onLog('warn', warning(known)), false)
  assert.notEqual(plugin.onLog('warn', warning(known, 'use server')), false)
  assert.notEqual(plugin.onLog('warn', warning('/app/src/component.tsx')), false)
  assert.notEqual(plugin.onLog('warn', warning('/app/node_modules/other/index.js')), false)
  assert.notEqual(plugin.onLog('warn', { code: 'OTHER_WARNING', id: known, message: 'use client' }), false)
})

test('Start dev uses a concise report and ignores unrelated file changes', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  const messages = []
  const logger = {
    info: (message) => messages.push(['info', message]),
    warn: (message) => messages.push(['warn', message]),
    warnOnce: (message) => messages.push(['warn', message]),
    error: (message) => messages.push(['error', message]),
    clearScreen() {}, hasErrorLogged: () => false, hasWarned: false,
  }
  const server = await createServer({
    ...config(root, 'react'), logLevel: 'info', customLogger: logger,
    build: { chunkSizeWarningLimit: 0.001 },
    server: { port: 0, host: '127.0.0.1' },
  })
  t.after(() => server.close())
  await server.listen(0)
  const url = `http://127.0.0.1:${server.config.server.port}`
  assert.equal((await fetch(url)).status, 200)
  const reports = () => messages.filter(([, message]) => message.includes('[nasti] built client + ssr'))
  assert.equal(reports().length, 1)
  assert.equal(messages.some(([, message]) => /MODULE_LEVEL_DIRECTIVE|gzip:|computing gzip|after minification|server\.mjs/.test(message)), false)
  const readme = path.join(root, 'README.md')
  const added = new Promise((resolve) => server.watcher.once('add', resolve))
  fs.writeFileSync(readme, 'Unrelated documentation')
  assert.equal(await added, readme)
  await fetch(url)
  assert.equal(reports().length, 1, 'documentation does not invalidate the build')
  const route = path.join(root, 'src/routes/index.tsx')
  await writeWatchedFile(server, route, fs.readFileSync(route, 'utf8').replace('Count ', 'Tracked '))
  assert.match(await (await fetch(url)).text(), /Tracked/)
  assert.equal(reports().length, 2, 'tracked source still invalidates the server build')
})

async function writeWatchedFile(server, file, code) {
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.watcher.off('change', onChange)
      reject(new Error(`Watcher did not report ${file}`))
    }, 10000)
    const onChange = (changed) => {
      if (changed !== file) return
      clearTimeout(timeout)
      server.watcher.off('change', onChange)
      resolve()
    }
    server.watcher.on('change', onChange)
  })
  fs.writeFileSync(file, code)
  await changed
}

async function checkStartRefresh(t, url, root, server) {
  const require = createRequire(path.join(repo, 'playground/tanstack-react/package.json'))
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ executablePath: process.env.NASTI_CHROME_PATH || undefined })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    const logs = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      t.diagnostic(`Refresh browser error: ${error.stack}`)
    })
    page.on('console', (message) => logs.push(message.text()))
    const refreshed = () => page.waitForEvent('console', {
      predicate: (message) => /^\[Fast Refresh\] done in \d+ms$/.test(message.text()),
      timeout: 15000,
    })
    await page.goto(url)
    await page.locator('#counter').click()
    await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count 1')
    await page.evaluate(() => { window.__sameStartPage = true })
    const route = path.join(root, 'src/routes/index.tsx')
    let done = refreshed()
    fs.writeFileSync(route, fs.readFileSync(route, 'utf8').replace('Count ', 'Updated '))
    await done
    assert.equal(await page.locator('#counter').textContent(), 'Updated 1', 'Start retains component state')
    assert.equal(await page.evaluate(() => window.__sameStartPage), true, 'Start component edits do not reload')
    assert.ok(logs.some((log) => log === '[nasti] connected.'))
    assert.ok(logs.some((log) => log === '[Fast Refresh] rebuilding'))
    done = refreshed()
    fs.writeFileSync(route, fs.readFileSync(route, 'utf8').replace("'POST_OK'", "'POST_UPDATED'"))
    await done
    await page.locator('#rpc').click()
    await page.waitForFunction(() => document.querySelector('#rpc-result')?.textContent === 'POST_UPDATED')
    assert.equal(await page.locator('#counter').textContent(), 'Updated 1', 'RPC implementation edits retain client state')
    assert.equal(await page.evaluate(() => window.__sameStartPage), true)
    done = refreshed()
    fs.writeFileSync(route, fs.readFileSync(route, 'utf8').replace("'POST_UPDATED'", 'serverValue()'))
    await done
    const serverFile = fs.realpathSync(path.join(root, 'node_modules/@nasti-toolchain/tanstack-shared/src/secret.server.ts'))
    const originalServer = fs.readFileSync(serverFile, 'utf8')
    await writeWatchedFile(server, serverFile, originalServer.replace('SSR_OK', 'RPC_SERVER_UPDATED'))
    const rpcUpdated = page.waitForResponse((response) => response.url().includes('_serverFn'))
    await page.locator('#rpc').click()
    await rpcUpdated
    await page.waitForFunction(() => document.querySelector('#rpc-result')?.textContent === 'RPC_SERVER_UPDATED')
    await page.waitForFunction(() => document.querySelector('#server-value')?.textContent === 'RPC_SERVER_UPDATED')
    assert.equal(await page.locator('#counter').textContent(), 'Updated 1', 'server-only edits retain client state')
    assert.equal(await page.evaluate(() => window.__sameStartPage), true)
    await writeWatchedFile(server, serverFile, originalServer)
    await fetch(url)
    await page.getByRole('link', { name: 'About', exact: true }).click()
    await page.getByRole('heading', { name: 'About Nasti', exact: true }).waitFor()
    done = refreshed()
    const lazy = path.join(root, 'src/routes/about.lazy.tsx')
    fs.writeFileSync(lazy, fs.readFileSync(lazy, 'utf8').replace('About Nasti', 'Hot About Nasti'))
    await done
    await page.getByRole('heading', { name: 'Hot About Nasti', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__sameStartPage), true, 'lazy routes use HMR too')
    const navigation = page.waitForEvent('load')
    const added = path.join(root, 'src/routes/added.tsx')
    const framework = server.config.framework
    fs.writeFileSync(added, `
      import {createFileRoute} from '@tanstack/${framework}-router';
      export const Route = createFileRoute('/added')({component: () => <p id="added-route">Added route</p>});
    `)
    await navigation
    await page.getByRole('link', { name: 'Home', exact: true }).click()
    await page.locator('#counter').waitFor()
    await page.locator('#counter').click()
    await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Updated 1')
    assert.notEqual(await page.evaluate(() => window.__sameStartPage), true, 'route additions intentionally reload')
    await page.evaluate(() => window.__TSR_ROUTER__.navigate({ to: '/added' }))
    await page.locator('#added-route').waitFor()
    assert.deepEqual(errors, [])
    t.diagnostic('Chromium: Start state, createServerFn replacement, connected and timed refresh logs passed')
  } finally {
    await browser.close()
  }
}

async function checkBrowser(t, url) {
  const require = createRequire(path.join(repo, 'playground/tanstack-react/package.json'))
  const { chromium } = require('playwright')
  const browser = await chromium.launch({
    executablePath: process.env.NASTI_CHROME_PATH || undefined,
    headless: true,
  })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      t.diagnostic(`Browser error: ${error.message}`)
    })
    page.on('response', (response) => {
      if (response.status() >= 400 && response.request().resourceType() === 'script') {
        t.diagnostic(`Script HTTP ${response.status()}: ${response.url()}`)
      }
    })
    await page.goto(url)
    await page.locator('#counter').click()
    await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count 1')
    await page.locator('#rpc').click()
    await page.waitForFunction(() => document.querySelector('#rpc-result')?.textContent === 'POST_OK')
    await page.getByRole('link', { name: 'About', exact: true }).click()
    await page.getByRole('heading', { name: 'About Nasti', exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: 'About Nasti', exact: true }).waitFor()
    assert.deepEqual(errors, [])
    t.diagnostic('Chromium: hydration, counter click, POST RPC, navigation and deep-link reload passed')
  } finally {
    await browser.close()
  }
}

test('Solid detection, JSX DOM/SSR compilation and HMR do not use React', async (t) => {
  const root = fixture(t, 'solid')
  fs.writeFileSync(path.join(root, 'src/main.tsx'), `
    import { createSignal } from 'solid-js';
    export function Counter() { const [count, setCount] = createSignal(0);
      return <button onClick={() => setCount(count() + 1)}>{count()}</button> }
  `)
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/src/main.tsx"></script>')
  assert.equal(detectFramework(root), 'solid')
  const server = await createServer({ root, framework: 'solid', logLevel: 'silent' })
  t.after(() => server.close())
  const client = await server.transformRequest('/src/main.tsx')
  assert.doesNotMatch(client.code, /react\/|RefreshRuntime|jsx-runtime/)
  assert.match(client.code, /solid-refresh/)
  assert.match(client.code, /__nasti_hot__/)
  const ssr = await server.transformEnvironmentRequest('ssr', '/src/main.tsx')
  assert.doesNotMatch(ssr.code, /solid-refresh|react\//)
  assert.match(ssr.code, /\bssr\b/)
})

for (const framework of ['react', 'solid']) {
  test(`Router ${framework}: temporary files stay in the project root and respect overrides`, { skip: !supported }, async (t) => {
    const root = fixture(t, framework)
    assert.notEqual(root, process.cwd(), 'fixture must exercise a project outside the working directory')
    const customTmpDir = path.join(root, '.nasti/custom-router')
    for (const tmpDir of [undefined, customTmpDir]) {
      // Force an atomic write even if the playground already has a generated tree.
      fs.rmSync(path.join(root, 'src/routeTree.gen.ts'), { force: true })
      await resolveConfig({
        root, framework, logLevel: 'silent',
        plugins: [tanstackRouter(tmpDir ? { generator: { tmpDir } } : {})],
      }, 'build')
      assert.ok(fs.existsSync(tmpDir ?? path.join(root, '.nasti/router')),
        `route generation must use ${tmpDir ?? 'the project-local default temporary directory'}`)
      assert.match(fs.readFileSync(path.join(root, 'src/routeTree.gen.ts'), 'utf8'), /\/about/)
    }
  })
}

test('Router regenerates on route add/unlink and isolates generators per workspace', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  const other = fixture(t, 'solid')
  const servers = await Promise.all([root, other].map((root, index) => createServer({
    root, framework: index ? 'solid' : 'react', logLevel: 'silent',
    plugins: [tanstackRouter({ routesDirectory: 'src/routes' })],
  })))
  t.after(() => Promise.all(servers.map((server) => server.close())))
  const file = path.join(root, 'src/routes/added.tsx')
  const waitForTree = async (predicate) => {
    for (let attempts = 0; attempts < 100; attempts++) {
      if (predicate(fs.readFileSync(path.join(root, 'src/routeTree.gen.ts'), 'utf8'))) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error('Route tree update timeout')
  }
  fs.writeFileSync(file, `import {createFileRoute} from '@tanstack/react-router'; export const Route=createFileRoute('/added')({})`)
  await waitForTree((code) => code.includes('/added'))
  assert.doesNotMatch(fs.readFileSync(path.join(other, 'src/routeTree.gen.ts'), 'utf8'), /\/added/)
  fs.unlinkSync(file)
  await waitForTree((code) => !code.includes('/added'))
})

for (const framework of ['react', 'solid']) {
  test(`standalone ${framework === 'react' ? 'Redact' : 'Solid'} mounts in native dev`, async (t) => {
    const root = fixture(t, framework)
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body><div id="app"></div><script type="module" src="/src/main.tsx"></script></body></html>')
    fs.writeFileSync(path.join(root, 'src/main.tsx'), framework === 'react' ? `
      import {useState} from 'react'; import {createRoot} from 'react-dom/client';
      function App() {const [count,setCount]=useState(0); return <button id="counter" onClick={()=>setCount(count+1)}>Count {count}</button>}
      createRoot(document.getElementById('app')!).render(<App />);
    ` : `
      import {createSignal} from 'solid-js'; import {render} from 'solid-js/web';
      function App() {const [count,setCount]=createSignal(0); return <button id="counter" onClick={()=>setCount(count()+1)}>Count {count()}</button>}
      render(() => <App />, document.getElementById('app')!);
    `)
    const server = await createServer({
      root, framework, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' },
      plugins: framework === 'react' ? [redact()] : [],
    })
    t.after(() => server.close())
    await server.listen(0)
    const url = `http://127.0.0.1:${server.config.server.port}`
    assert.equal((await fetch(url)).status, 200)
    if (!browsers) return
    const require = createRequire(path.join(repo, 'playground/tanstack-react/package.json'))
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ executablePath: process.env.NASTI_CHROME_PATH || undefined })
    try {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(url)
      await page.locator('#counter').click()
      await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count 1')
      if (framework === 'solid') {
        await page.evaluate(() => { window.__nastiSamePage = true })
        const file = path.join(root, 'src/main.tsx')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Count ', 'Updated '))
        await page.waitForFunction(() => document.querySelector('#counter')?.textContent.startsWith('Updated '))
        assert.equal(await page.evaluate(() => window.__nastiSamePage), true, 'Solid update uses HMR, not page reload')
      }
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test('native Start base paths, API routes and compiler isolation', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  fs.writeFileSync(path.join(root, 'src/routes/api.ts'), `
    import {createFileRoute} from '@tanstack/react-router';
    export const Route = createFileRoute('/api')({
      server: {handlers: {GET: () => new Response('API_OK' + 'API_SERVER_SECRET'.slice(0, 0))}}
    });
  `)
  const settings = { ...config(root, 'react'), base: '/app/' }
  const result = await build(settings)
  const client = result.output.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n')
  assert.doesNotMatch(client, /API_SERVER_SECRET/)
  const preview = await listen(await createTanStackStartPreview(path.join(root, 'dist')))
  t.after(() => preview.close())
  assert.match(await (await fetch(preview.url + '/app/')).text(), /SSR_OK/)
  assert.equal(await (await fetch(preview.url + '/app/api')).text(), 'API_OK')
  if (browsers) {
    // checkBrowser's relative navigation is produced by Router's own basepath.
    await checkBrowser(t, preview.url + '/app/')
  }
})

test('Start requires Redact context, hydration and class component features', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  const resolve = (options) => resolveConfig({
    ...config(root, 'react'), plugins: [tanstackStart(), redact(options)],
  }, 'serve')
  for (const options of [
    { features: { context: false } },
    { preset: 'full', features: { context: false } },
    { preset: 'nano', features: { hydration: true } },
    { preset: 'nano', features: { hydration: true, context: false } },
  ]) await assert.rejects(resolve(options), /TanStack Start requires the Redact context feature/)
  for (const options of [
    { features: { hydration: false } },
    { preset: 'nano' },
    { preset: 'nano', features: { context: true } },
  ]) await assert.rejects(resolve(options), /TanStack Start requires the Redact hydration feature/)
  for (const options of [
    { features: { context: true, hydration: true, classComponents: false } },
    { preset: 'full', features: { classComponents: false } },
    { preset: 'nano', features: { context: true, hydration: true } },
    { preset: 'nano', features: { context: true, hydration: true, classComponents: false } },
  ]) await assert.rejects(resolve(options), /TanStack Start requires the Redact classComponents feature/)
  for (const options of [
    {},
    { preset: 'full' },
    { features: { context: true } },
    { preset: 'nano', features: { context: true, hydration: true, classComponents: true } },
  ]) await resolve(options)
})

for (const framework of ['react', 'solid']) {
  test(`Start ${framework} keeps the client consumer after user configuration`, { skip: !supported }, async (t) => {
    const root = fixture(t, framework)
    const resolved = await resolveConfig({
      ...config(root, framework),
      environments: { client: { consumer: 'server' } },
    }, 'build')
    assert.equal(resolved.environments.client.consumer, 'client')
    assert.equal(resolved.environments.ssr.consumer, 'server')
  })
}

test('Start dev prunes old assets while retaining previous and active generations', { skip: !supported, timeout: 60000 }, async (t) => {
  const root = fixture(t, 'react')
  const gate = Symbol.for(root)
  let release
  globalThis[gate] = new Promise((resolve) => { release = resolve })
  const client = path.join(root, 'src/cache-client.ts')
  fs.writeFileSync(client, 'console.log("GEN_0")')
  fs.writeFileSync(path.join(root, 'src/cache-late.ts'), 'export const value = "LATE_OK"')
  fs.writeFileSync(path.join(root, 'src/cache-server.ts'), `
    import fs from 'node:fs';
    export default {fetch(request) {
      const asset = '/assets/' + fs.readdirSync(new URL('../client/assets/', import.meta.url))
        .find(name => name.endsWith('.js'));
      if (new URL(request.url).pathname === '/stream') {
        return new Response(new ReadableStream({async start(controller) {
          controller.enqueue(new TextEncoder().encode('STREAM_READY\\n'));
          await globalThis[Symbol.for(${JSON.stringify(root)})];
          const {value} = await import('./cache-late');
          controller.enqueue(new TextEncoder().encode(asset + value));
          controller.close();
        }}));
      }
      return new URL(request.url).pathname === '/'
        ? new Response(asset) : new Response('Not Found', {status: 404});
    }};
  `)
  const server = await createServer({
    ...config(root, 'react'),
    plugins: [tanstackStart({ entries: { client: 'src/cache-client.ts', server: 'src/cache-server.ts' } })],
    server: { port: 0, host: '127.0.0.1' },
  })
  let sessionDir
  t.after(async () => {
    release()
    delete globalThis[gate]
    await server.close()
    if (sessionDir) assert.equal(fs.existsSync(sessionDir), false, 'close removes the final generations')
  })
  await server.listen(0)
  const url = `http://127.0.0.1:${server.config.server.port}`
  const currentAsset = async () => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    return response.text()
  }
  const assetUrls = [await currentAsset()]
  const devDir = path.join(root, '.nasti/start/dev')
  sessionDir = path.join(devDir, fs.readdirSync(devDir)[0])
  const retained = () => fs.readdirSync(sessionDir)
  const stream = await fetch(url + '/stream')
  assert.equal(stream.status, 200)
  const updateClient = async (code) => {
    const changed = new Promise((resolve) => {
      const onChange = (file) => {
        if (file === client) { server.watcher.off('change', onChange); resolve() }
      }
      server.watcher.on('change', onChange)
    })
    fs.writeFileSync(client, code)
    await changed
  }
  for (let version = 1; version <= 3; version++) {
    await updateClient(`console.log("GEN_${version}")`)
    assetUrls.push(await currentAsset())
    assert.equal(new Set(assetUrls).size, assetUrls.length)
    assert.equal(retained().length, Math.min(version + 1, 3))
    for (const asset of [assetUrls[0], assetUrls[version - 1], assetUrls[version]]) {
      assert.equal((await fetch(url + asset)).status, 200, 'active, previous and current assets remain available')
    }
  }
  assert.equal((await fetch(url + assetUrls[1])).status, 404, 'inactive older assets are evicted')
  release()
  assert.equal(await stream.text(), 'STREAM_READY\n' + assetUrls[0] + 'LATE_OK')
  await currentAsset()
  assert.equal(retained().length, 2, 'completed requests release old generations')
  assert.equal((await fetch(url + assetUrls[0])).status, 404)
  for (const asset of assetUrls.slice(-2)) assert.equal((await fetch(url + asset)).status, 200)
  const beforeFailure = retained().sort()
  await updateClient('export const =')
  const failed = await fetch(url)
  assert.equal(failed.status, 500)
  await failed.text()
  assert.deepEqual(retained().sort(), beforeFailure, 'failed builds neither publish assets nor leave partial files')
  await updateClient('console.log("GEN_4")')
  const recovered = await currentAsset()
  assert.notEqual(recovered, assetUrls[3])
  assert.equal(retained().length, 2)
  assert.equal((await fetch(url + assetUrls[3])).status, 200, 'the previous successful build survives a failed generation')
  assert.equal((await fetch(url + assetUrls[2])).status, 404)
})

test('standalone Redact SSR shares its runtime across bare packages in dev and build', async (t) => {
  const root = fixture(t, 'react')
  for (const [name, code] of [
    ['fixture-react-wrapper', "export {createElement} from 'fixture-react-leaf'"],
    ['fixture-react-leaf', "export {createElement} from 'react'"],
  ]) {
    const directory = path.join(root, 'node_modules', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name, type: 'module', exports: './index.js',
    }))
    fs.writeFileSync(path.join(directory, 'index.js'), code)
  }
  fs.writeFileSync(path.join(root, 'src/main.ts'), 'export {}')
  fs.writeFileSync(path.join(root, 'src/ssr.js'), `
    import {createElement, useSyncExternalStore as reactStore} from 'react';
    import {jsx} from 'react/jsx-runtime';
    import {renderToString} from 'react-dom/server';
    import {unstable_now} from 'scheduler';
    import {useSyncExternalStore} from 'use-sync-external-store/shim';
    import * as redact from '@tanstack/redact';
    import * as redactJsx from '@tanstack/redact/jsx-runtime';
    import * as redactServer from '@tanstack/redact/server';
    import * as redactScheduler from '@tanstack/redact/scheduler';
    import {createElement as dependencyElement} from 'fixture-react-wrapper';
    import {useRouter} from '@tanstack/react-router';
    export const sameRuntime = [
      createElement === redact.createElement, jsx === redactJsx.jsx,
      renderToString === redactServer.renderToString, unstable_now === redactScheduler.unstable_now,
      useSyncExternalStore === redact.useSyncExternalStore, reactStore === useSyncExternalStore,
      dependencyElement === redact.createElement,
    ];
    export const html = renderToString(createElement('p', null, 'REDACT_SSR_OK'));
    function RouterProbe() {
      return createElement('p', null, useRouter({warn: false}) === null ? 'ROUTER_SSR_OK' : 'WRONG_CONTEXT');
    }
    export const routerHtml = renderToString(createElement(RouterProbe));
  `)
  const settings = {
    root, framework: 'react', logLevel: 'silent', plugins: [redact()],
    resolve: { noExternal: ['existing-inline'] },
    environments: { client: { buildEnabled: false }, ssr: { entry: 'src/ssr.js' } },
  }
  const server = await createServer(settings)
  t.after(() => server.close())
  assert.equal(server.config.environments.ssr.resolve.noExternal, true)
  const check = (module) => {
    assert.deepEqual([...module.sameRuntime], Array(7).fill(true))
    assert.equal(module.html, '<p>REDACT_SSR_OK</p>')
    assert.equal(module.routerHtml, '<p>ROUTER_SSR_OK</p>')
  }
  check(await server.ssrLoadModule('/src/ssr.js'))
  const result = await build(settings)
  const entry = result.environments.ssr.find((item) => item.type === 'chunk' && item.isEntry)
  check(await import(pathToFileURL(path.join(root, 'dist/ssr', entry.fileName)).href))
})

test('Redact inlines SSR dependencies and excludes RSC environments', async (t) => {
  const root = fixture(t, 'react')
  const resolved = await resolveConfig({
    root, framework: 'react', logLevel: 'silent', plugins: [redact({ preset: 'nano' })],
    environments: {
      ssr: { resolve: { noExternal: ['existing-inline'], conditions: ['node', 'import'] } },
      worker: { consumer: 'server', resolve: { noExternal: true } },
      rsc: { consumer: 'server', resolve: { noExternal: ['rsc-inline'] } },
      flight: { consumer: 'server', resolve: { conditions: ['react-server'] } },
    },
  }, 'build')
  const { ssr, worker, rsc, flight } = resolved.environments
  assert.equal(ssr.resolve.noExternal, true)
  assert.deepEqual(resolved.environments.client.resolve.noExternal, [])
  assert.deepEqual(ssr.resolve.conditions, ['node', 'import'])
  assert.equal(worker.resolve.noExternal, true)
  assert.deepEqual(rsc.resolve.noExternal, ['rsc-inline'])
  assert.deepEqual(flight.resolve.noExternal, [])
})

test('native integration configuration fails explicitly instead of falling back to Vite', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  for (const override of [
    { base: './' },
    { target: 'electron' },
    { experimental: { bundledDev: true } },
    { plugins: [tanstackStart(), tanstackRouter()] },
    { plugins: [tanstackStart(), redact({ preset: 'nano' })] },
  ]) {
    await assert.rejects(resolveConfig({ ...config(root, 'react'), ...override }, 'serve'), /\[nasti:/)
  }
  fs.writeFileSync(path.join(root, 'nasti.config.mjs'), `
    import {tanstackStart} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    export default {framework: 'react', plugins: [tanstackStart()]};
  `)
  const composed = await resolveConfig({ root, logLevel: 'silent', plugins: [redact()] }, 'serve')
  assert.equal(composed.experimental.bundledDev, false, 'inline Redact recognizes file-config Start')
  await assert.rejects(resolveConfig({ root, logLevel: 'silent', plugins: [redact({ features: { context: false } })] }, 'serve'), /Redact context feature/)
  const solid = fixture(t, 'solid')
  await assert.rejects(resolveConfig({
    root: solid, framework: 'solid', logLevel: 'silent', plugins: [redact()],
  }, 'build'), /Redact requires/)
})

test('CommonJS entry builds the same native Start application', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  const require = createRequire(import.meta.url)
  const nasti = require('../dist/index.cjs')
  const result = await nasti.build({
    root, framework: 'react', logLevel: 'silent',
    plugins: [nasti.tanstackStart()],
  })
  assert.ok(result.environmentResults.ssr.entries.server)
})

test('Start rejects incompatible compiler versions and live server imports', { skip: !supported }, async (t) => {
  const root = fixture(t, 'react')
  const filename = path.join(root, 'src/routes/about.tsx')
  fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(
    "import { createFileRoute }",
    "import fs from 'node:fs'; console.log(fs); import { createFileRoute }",
  ))
  await assert.rejects(build(config(root, 'react')), /Server-only import/)
  const compiler = path.join(root, 'node_modules/@tanstack/start-plugin-core')
  fs.unlinkSync(compiler)
  fs.mkdirSync(compiler)
  fs.writeFileSync(path.join(compiler, 'package.json'), JSON.stringify({
    name: '@tanstack/start-plugin-core', version: '0.0.0',
    exports: { './package.json': './package.json' },
  }))
  await assert.rejects(resolveConfig(config(root, 'react'), 'build'), /Expected @tanstack\/start-plugin-core@1.171.55/)
})
