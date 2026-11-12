import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { astro, build, createAstroPreview, createServer, detectFramework, resolveConfig } from '../dist/index.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const browserTests = process.env.NASTI_BROWSER_TESTS === '1'
const [major, minor, patch] = process.versions.node.split('.').map(Number)
const astroSupported = major > 22 || major === 22 && (minor > 23 || minor === 23 && patch >= 4)
process.env.ASTRO_TELEMETRY_DISABLED = '1'

function fixture(t, framework) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `nasti-${framework}-`)))
  const app = path.join(repo, 'playground', `${framework}-basic`)
  fs.cpSync(path.join(app, 'src'), path.join(root, 'src'), { recursive: true })
  for (const file of ['index.html', 'tsconfig.json', 'package.json', 'astro.config.mjs']) {
    if (fs.existsSync(path.join(app, file))) fs.copyFileSync(path.join(app, file), path.join(root, file))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const link = path.join(root, 'node_modules', name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(name === '@nasti-toolchain/nasti' ? repo : fs.realpathSync(path.join(app, 'node_modules', name)),
      link, 'junction')
  }
  if (framework === 'astro') {
    // This fixture deliberately links installed dependencies from another tree.
    // Real app installs use Astro/Vite's normal workspace allowlist; grant only
    // the two test roots rather than weakening the production driver's fs guard.
    const configFile = path.join(root, 'astro.config.mjs')
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(
      'integrations: [preact()],',
      `integrations: [preact()], vite: { server: { fs: { allow: ${JSON.stringify([root, repo])} } } },`,
    ))
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

async function serveStatic(t, root) {
  const require = createRequire(import.meta.url)
  const sirv = require('sirv')
  const server = http.createServer(sirv(root))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

async function browser(t, url, check) {
  const require = createRequire(path.join(repo, 'playground/tanstack-react/package.json'))
  const { chromium } = require('playwright')
  const instance = await chromium.launch({
    headless: true,
    executablePath: process.env.NASTI_CHROME_PATH || undefined,
  })
  const errors = []
  try {
    const page = await instance.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text())
    })
    await page.goto(url)
    await page.waitForFunction(() => [...document.querySelectorAll('astro-island')]
      .every((island) => !island.hasAttribute('ssr')), undefined, { timeout: 10000 })
    await page.locator('#counter').click()
    await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count 1')
    await check?.(page)
    assert.deepEqual(errors, [])
    t.diagnostic('Chromium: rendered counter, event handling and runtime identity passed')
  } catch (error) {
    t.diagnostic(`Browser errors: ${JSON.stringify(errors)}`)
    throw error
  } finally {
    await instance.close()
  }
}

test('framework detection recognizes new sources/dependencies and preserves explicit overrides', async (t) => {
  for (const framework of ['preact', 'svelte', 'astro']) {
    const root = fixture(t, framework)
    assert.equal(detectFramework(root), framework)
    const config = await resolveConfig({ root, logLevel: 'silent' }, 'build')
    assert.equal(config.framework, framework)
    assert.equal((await resolveConfig({ root, framework: 'react', logLevel: 'silent' }, 'build')).framework, 'react')
  }
  const root = fixture(t, 'preact')
  fs.writeFileSync(path.join(root, 'src/Island.astro'), '<h1>Astro wins over UI dependencies</h1>')
  assert.equal(detectFramework(root), 'astro')
})

for (const framework of ['preact', 'svelte']) {
  test(`${framework}: native production JS, CSS and SSR`, async (t) => {
    const root = fixture(t, framework)
    const component = framework === 'preact' ? '{ App }' : 'App'
    const componentFile = framework === 'preact' ? './App.tsx' : './App.svelte'
    const renderModule = framework === 'preact' ? 'preact-render-to-string' : 'svelte/server'
    fs.writeFileSync(path.join(root, 'src/entry-server.ts'), `
      import ${component} from '${componentFile}';
      import { render } from '${renderModule}';
      ${framework === 'preact' ? "import { h } from 'preact';" : ''}
      export function html() { return render(${framework === 'preact' ? 'h(App, {})' : 'App'}); }
    `)
    const result = await build({
      root, logLevel: 'silent',
      build: { sourcemap: true },
      environments: { ssr: { entry: 'src/entry-server.ts' } },
    })
    const code = result.output.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n')
    assert.doesNotMatch(code, /\breact\/jsx|RefreshRuntime|\/@modules\/|from ["']vite["']/)
    if (framework === 'svelte') {
      assert.ok(result.output.some((item) => item.fileName.endsWith('.css') && /button/.test(String(item.source))))
      assert.doesNotMatch(code, /<script lang="ts">/)
    }
    const entry = result.environments.ssr.find((item) => item.isEntry)
    const module = await import(pathToFileURL(path.join(root, 'dist/ssr', entry.fileName)).href)
    const html = await module.html()
    assert.match(typeof html === 'string' ? html : html.body, /Count 0/)
    if (browserTests) await browser(t, await serveStatic(t, path.join(root, 'dist')))
  })

  test(`${framework}: native development, SSR transform and real source edits`, async (t) => {
    const root = fixture(t, framework)
    const server = await createServer({ root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } })
    t.after(() => server.close())
    await server.listen(0)
    const url = `http://127.0.0.1:${server.config.server.port}`
    const file = framework === 'preact' ? 'src/App.tsx' : 'src/App.svelte'
    const transformed = await server.transformEnvironmentRequest('ssr', '/' + file)
    assert.doesNotMatch(transformed.code, /\breact\/jsx|RefreshRuntime|import\.meta\.hot/)
    if (browserTests) {
      await browser(t, url, async (page) => {
        fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(root, file), 'utf8')
          .replace(`Nasti + ${framework === 'preact' ? 'Preact' : 'Svelte'}`, 'Updated component'))
        await page.getByRole('heading', { name: 'Updated component', exact: true }).waitFor()
        if (framework === 'svelte') {
          assert.equal(await page.locator('#counter').evaluate((button) => getComputedStyle(button).color), 'rgb(220, 70, 20)')
        }
      })
    } else {
      assert.equal((await fetch(url)).status, 200)
    }
  })
}

test('Preact bundled development uses the Preact JSX runtime without a tsconfig', async (t) => {
  const root = fixture(t, 'preact')
  fs.unlinkSync(path.join(root, 'tsconfig.json'))
  const server = await createServer({
    root, logLevel: 'silent', experimental: { bundledDev: true }, server: { port: 0, host: '127.0.0.1' },
  })
  t.after(() => server.close())
  await server.listen(0)
  const url = `http://127.0.0.1:${server.config.server.port}`
  assert.equal((await fetch(url)).status, 200)
  if (browserTests) await browser(t, url)
})

test('Svelte rune modules, preprocess inputs and virtual CSS use the native pipeline', async (t) => {
  const root = fixture(t, 'svelte')
  fs.writeFileSync(path.join(root, 'src/state.svelte.ts'), 'let count: number = $state(0); export function next() { return ++count }')
  fs.writeFileSync(path.join(root, 'src/color.txt'), 'rgb(20, 40, 60)')
  const server = await createServer({
    root, logLevel: 'silent',
    svelte: { preprocess: {
      style({ content, filename }) {
        const dependency = path.join(path.dirname(filename), 'color.txt')
        return { code: content.replace('rgb(220, 70, 20)', fs.readFileSync(dependency, 'utf8')), dependencies: [dependency] }
      },
    } },
  })
  t.after(() => server.close())
  const module = await server.ssrLoadModule('/src/state.svelte.ts')
  assert.equal(module.next(), 1)
  assert.equal(module.next(), 2)
  const compiled = await server.transformEnvironmentRequest('ssr', '/src/App.svelte')
  assert.doesNotMatch(compiled.code, /<script|count: number/)
  assert.ok(server.environments.ssr.moduleGraph.getModuleByUrl('/src/App.svelte'))
  const styles = await server.transformEnvironmentRequest('ssr', '/src/App.svelte?svelte&type=style&lang.css')
  assert.match(styles.code, /20, 40, 60/)
  assert.doesNotMatch(styles.code, /document\./)
})

test('Astro uses its official driver for static routes, scripts, assets and preview', { skip: !astroSupported }, async (t) => {
  const root = fixture(t, 'astro')
  // Astro's process-wide defaults must stay in its app-local child, not affect
  // other framework pipelines owned by this Node process.
  const nodeEnv = process.env.NODE_ENV
  const result = await build({ root, logLevel: 'silent', base: '/docs/' })
  assert.equal(process.env.NODE_ENV, nodeEnv)
  const index = result.output.find((item) => item.fileName === 'index.html')
  assert.ok(index)
  assert.match(String(index.source), /astro-island/)
  assert.ok(result.output.some((item) => item.fileName === 'about/index.html'))
  assert.equal(result.environmentResults.client.manifest.engine, 'astro')
  const preview = await createAstroPreview(root, path.join(root, 'dist'), { port: 0, host: '127.0.0.1' })
  t.after(() => preview.stop())
  const url = `http://127.0.0.1:${preview.port}`
  assert.match(await (await fetch(url + '/docs/')).text(), /Nasti \+ Astro/)
  assert.match(await (await fetch(url + '/docs/about')).text(), /Astro file routing works/)
  assert.equal((await fetch(url + '/docs/missing')).status, 404)
  if (browserTests) await browser(t, url + '/docs/')
})

test('Astro development redirects to the owning server and closes its watcher/socket', { skip: !astroSupported }, async (t) => {
  const root = fixture(t, 'astro')
  const server = await createServer({ root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } })
  t.after(() => server.close())
  await server.listen(0)
  const url = `http://127.0.0.1:${server.config.server.port}`
  const response = await fetch(url + '/about', { redirect: 'manual' })
  assert.equal(response.status, 307)
  const location = response.headers.get('location')
  assert.match(await (await fetch(location)).text(), /Astro file routing works/)
  const service = server.environmentServices.client.localUrls[0]
  if (browserTests) {
    await browser(t, url, async (page) => {
      fs.writeFileSync(path.join(root, 'src/pages/index.astro'),
        fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8').replace('Nasti + Astro', 'Updated Astro page'))
      await page.getByRole('heading', { name: 'Updated Astro page', exact: true }).waitFor()
    })
  }
  await server.close()
  await assert.rejects(fetch(service))
})

test('Astro configuration rejects conflicting pipelines before starting tools', async (t) => {
  const root = fixture(t, 'astro')
  await assert.rejects(resolveConfig({ root, framework: 'react', plugins: [astro()] }, 'build'), /requires framework/)
  await assert.rejects(resolveConfig({ root, target: 'electron' }, 'build'), /Electron and bundledDev/)
  await assert.rejects(resolveConfig({ root, experimental: { bundledDev: true } }, 'serve'), /Electron and bundledDev/)
})

test('Vapor beta notice goes to stdout once and is embedded for the browser', (t) => {
  const root = fixture(t, 'preact')
  fs.writeFileSync(path.join(root, 'src/Notice.vue'), '<script setup vapor>const label = "Notice"</script><template><p>{{ label }}</p></template>')
  const code = `
    import { createServer } from ${JSON.stringify(pathToFileURL(path.join(repo, 'dist/index.js')).href)};
    const server = await createServer({ root: ${JSON.stringify(root)}, framework: 'vue' });
    try {
      const result = await server.transformRequest('/src/Notice.vue');
      if (!result.code.includes('console.warn("Currently, Vapor is still a Vue beta feature.")')) throw new Error('browser notice missing');
      await server.transformRequest('/src/Notice.vue?t=2');
    } finally { await server.close(); }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.split('Currently, Vapor is still a Vue beta feature.').length - 1, 1)
  assert.doesNotMatch(result.stderr, /Currently, Vapor is still a Vue beta feature./)
  assert.doesNotMatch(result.stdout + result.stderr, /do not provide guarantees/)
})

test('Vapor browser console emits the exact notice once across multiple components', { skip: !browserTests }, async (t) => {
  const root = fixture(t, 'preact')
  fs.symlinkSync(fs.realpathSync(path.join(repo, 'node_modules/vue')), path.join(root, 'node_modules/vue'), 'junction')
  fs.writeFileSync(path.join(root, 'src/main.tsx'), `
    import { createVaporApp } from 'vue';
    import App from './App.vue';
    createVaporApp(App).mount('#app');
  `)
  fs.writeFileSync(path.join(root, 'src/Child.vue'), '<template vapor><p>Child component</p></template>')
  fs.writeFileSync(path.join(root, 'src/App.vue'), `
    <script setup vapor>
      import { ref } from 'vue';
      import Child from './Child.vue';
      const count = ref(0);
    </script>
    <template><Child /><button id="counter" @click="count++">Count {{ count }}</button></template>
  `)
  const server = await createServer({ root, framework: 'vue', logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } })
  t.after(() => server.close())
  await server.listen(0)
  const require = createRequire(path.join(repo, 'playground/tanstack-react/package.json'))
  const { chromium } = require('playwright')
  const instance = await chromium.launch({ headless: true, executablePath: process.env.NASTI_CHROME_PATH || undefined })
  try {
    const page = await instance.newPage()
    const notices = []
    const errors = []
    page.on('console', (message) => { if (message.type() === 'warning') notices.push(message.text()) })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.config.server.port}`)
    await page.locator('#counter').click()
    await page.waitForFunction(() => document.querySelector('#counter')?.textContent === 'Count 1')
    assert.equal(notices.filter((message) => message === 'Currently, Vapor is still a Vue beta feature.').length, 1)
    assert.deepEqual(errors, [])
  } finally {
    await instance.close()
  }
})
