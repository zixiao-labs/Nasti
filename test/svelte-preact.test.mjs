import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSync } from 'oxc-parser'
import { build, createServer, detectFramework, resolveConfig } from '../dist/index.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const browsers = process.env.NASTI_BROWSER_TESTS === '1'
const cjs = createRequire(import.meta.url)('../dist/index.cjs')

function fixture(t, framework) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `nasti-${framework}-`)))
  const app = path.join(repo, 'playground', `${framework}-basic`)
  const servers = []
  fs.cpSync(path.join(app, 'src'), path.join(root, 'src'), { recursive: true })
  fs.copyFileSync(path.join(app, 'index.html'), path.join(root, 'index.html'))
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (dependency === '@nasti-toolchain/nasti') continue
    const link = path.join(root, 'node_modules', dependency)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(fs.realpathSync(path.join(app, 'node_modules', dependency)), link, 'junction')
  }
  t.after(async () => {
    for (const server of servers) await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    config: { root, logLevel: 'silent', server: { port: 0, host: '127.0.0.1' } },
    async serve(options = {}, create = createServer) {
      const server = await create({ ...this.config, ...options })
      servers.push(server)
      await server.listen(0)
      return server
    },
  }
}

function url(server) {
  return `http://127.0.0.1:${server.config.server.port}`
}

async function edit(server, filename, mutate) {
  const hot = server.environments.client.hot
  const send = hot.send
  let timer
  const update = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Missing update for ${filename}`)), 10000)
    hot.send = (payload) => {
      send.call(hot, payload)
      if (['update', 'full-reload', 'error'].includes(payload.type)) resolve(payload)
    }
  })
  try {
    fs.writeFileSync(filename, mutate(fs.readFileSync(filename, 'utf8')))
    server.watcher.emit('change', filename)
    return await update
  } finally {
    clearTimeout(timer)
    hot.send = send
  }
}

test('framework auto detection preserves precedence and covers all dependency fields', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-frameworks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const metadata = (pkg) => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const framework of ['svelte', 'preact']) {
      metadata({ [field]: { [framework]: '*' } })
      assert.equal(detectFramework(root), framework)
      assert.equal((await resolveConfig({ root, logLevel: 'silent' }, 'build')).framework, framework)
    }
  }
  metadata({ dependencies: { react: '*', vue: '*', 'solid-js': '*', svelte: '*', preact: '*' } })
  assert.equal(detectFramework(root), 'react')
  assert.equal((await resolveConfig({ root, framework: 'preact' }, 'build')).framework, 'preact')
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/components/App.svelte'), '<p>Hello</p>')
  assert.equal(detectFramework(root), 'svelte')
  fs.writeFileSync(path.join(root, 'src/components/App.vue'), '<template>Hello</template>')
  assert.equal(detectFramework(root), 'vue')
  fs.rmSync(path.join(root, 'src'), { recursive: true })
  metadata({ dependencies: { 'solid-js': '*', svelte: '*', preact: '*' } })
  assert.equal(detectFramework(root), 'solid')
  fs.writeFileSync(path.join(root, 'package.json'), 'invalid JSON')
  assert.equal(detectFramework(root), 'react')
})

for (const [format, create] of [['ESM', createServer], ['CJS', cjs.createServer]]) {
  test(`${format} Svelte builds allow styles from components outside the dev allowlist`, async (t) => {
    const f = fixture(t, 'svelte')
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-svelte-build-')))
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
    const component = path.join(outside, 'External.svelte')
    fs.writeFileSync(component, '<p>External</p><style>p { color: #123456 }</style>')
    fs.unlinkSync(path.join(f.root, 'src/App.svelte'))
    fs.symlinkSync(component, path.join(f.root, 'src/App.svelte'))
    const buildApp = format === 'ESM' ? build : cjs.build
    for (const mode of ['production', 'development']) {
      const result = await buildApp({ ...f.config, mode })
      const css = result.output.find((item) => item.fileName.endsWith('.css'))
      assert.ok(css, 'external component CSS must be extracted')
      assert.match(String(css.source), /#123456/)
    }
  })

  test(`${format} Svelte styles enforce the realpath allowlist before compilation`, async (t) => {
    const f = fixture(t, 'svelte')
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-svelte-outside-')))
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
    const privateFile = path.join(outside, 'private/Secret.svelte')
    const linked = path.join(outside, 'linked')
    for (const file of [privateFile, path.join(linked, 'Allowed.svelte')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '<p>Styled</p><style>p { color: red }</style>')
    }
    fs.symlinkSync(path.dirname(privateFile), path.join(f.root, 'src/escaped'), 'junction')
    fs.symlinkSync(linked, path.join(f.root, 'node_modules/linked'), 'junction')
    const server = await f.serve({}, create)
    const query = '?svelte&type=style&lang.css'
    for (const file of [privateFile, path.join(f.root, 'src/escaped/Secret.svelte')]) {
      assert.ok(fs.statSync(file).isFile())
      await assert.rejects(server.transformRequest(file + query), /outside the allowed filesystem paths/)
    }
    await assert.rejects(server.transformRequest('/src/escaped/Secret.svelte' + query),
      /outside the allowed filesystem paths/)
    for (const file of [
      path.join(f.root, 'src/App.svelte'),
      path.join(linked, 'Allowed.svelte'),
      path.join(f.root, 'node_modules/linked/Allowed.svelte'),
    ]) {
      assert.match((await server.transformRequest(file + query)).code, /document\.createElement\('style'\)/)
    }
  })

  for (const framework of ['svelte', 'preact']) {
    test(`${format} ${framework}: HTTP transforms, HMR boundaries and server consumer isolation`, async (t) => {
      const f = fixture(t, framework)
      const server = await f.serve({}, create)
      assert.equal(server.config.framework, framework)
      const html = await (await fetch(url(server))).text()
      assert.match(html, /@nasti\/client/)
      assert.doesNotMatch(html, /@react-refresh|\$RefreshReg\$/)
      const component = `/src/App.${framework === 'svelte' ? 'svelte' : 'tsx'}`
      const response = await fetch(url(server) + component)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /javascript/)
      const code = await response.text()
      assert.match(code, /__nasti_hot__\.accept/)
      assert.doesNotMatch(code, /@react-refresh|["'/]react\/jsx-runtime|from ['"]react['"]/)
      assert.equal(server.moduleGraph.getModuleByUrl(component).isSelfAccepting, true)
      if (framework === 'svelte') {
        assert.match(code, /svelte\/internal\/client/)
        const cssUrl = code.match(/["']([^"']+\?svelte&type=style&lang\.css)["']/)[1]
        const css = await fetch(url(server) + cssUrl)
        assert.equal(css.status, 200)
        assert.match(await css.text(), /document\.createElement\('style'\)/)
        const runes = await server.transformRequest('/src/counter.svelte.ts')
        assert.match(runes.code, /svelte\/internal\/client/)
        assert.doesNotMatch(runes.code, /\$state\(/)
      } else {
        assert.match(code, /preact\/jsx-runtime/)
        assert.match(code, /__PREFRESH__/)
      }
      const message = await edit(server, path.join(f.root, component.slice(1)),
        (source) => source.replace('Edit App', 'Updated App'))
      assert.equal(message.type, 'update')
      assert.ok(message.updates.some((update) => update.path === component))
      assert.match((await server.transformRequest(component)).code, /Updated App/)

      const ssr = await server.environments.ssr.transformRequest(component)
      assert.doesNotMatch(ssr.code, /__PREFRESH__|import\.meta\.hot|\$RefreshReg\$/)
      assert.match(ssr.code, framework === 'svelte' ? /svelte\/internal\/server/ : /preact\/jsx-runtime/)
    })
  }
}

test('Svelte runtime sources keep canonical private imports and unhoisted dependencies servable', async (t) => {
  const f = fixture(t, 'svelte')
  const server = await f.serve()
  const pending = ['/@modules/svelte', '/@modules/svelte/internal/client']
  const visited = new Set()
  while (pending.length) {
    const current = pending.shift()
    if (visited.has(current)) continue
    visited.add(current)
    assert.ok(visited.size < 500, 'the runtime module graph must be bounded')
    const response = await fetch(url(server) + current)
    const code = await response.text()
    assert.equal(response.status, 200, `${current}: ${code}`)
    const parsed = parseSync(current + '.js', code)
    assert.deepEqual(parsed.errors, [], current)
    for (const node of parsed.program.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) continue
      if (!node.source) continue
      assert.ok(!node.source.value.startsWith('#'), 'private package imports must resolve before serving')
      const target = new URL(node.source.value, url(server) + current)
      assert.equal(target.origin, url(server))
      pending.push(target.pathname + target.search)
    }
  }
  assert.ok([...visited].some((item) => item.includes('esm-env')))
  const effects = [...visited].filter((item) => item.endsWith('/internal/client/reactivity/effects.js'))
  assert.equal(effects.length, 1, 'mount and component helpers must share the effects runtime')
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-unrelated-')))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const forgedFile = path.join(outside, 'node_modules/svelte/src/index-client.js')
  fs.mkdirSync(path.dirname(forgedFile), { recursive: true })
  fs.writeFileSync(forgedFile, 'export default "forged";')
  assert.ok(fs.statSync(forgedFile).isFile())
  const forged = '/@fs/' + forgedFile.replace(/\\/g, '/').replace(/^\//, '')
  assert.equal(await server.transformRequest(forged), null)
})

for (const framework of ['svelte', 'preact']) {
  test(`${framework}: production client, CSS and runnable SSR build`, async (t) => {
    const f = fixture(t, framework)
    const source = framework === 'svelte'
      ? `import App from './App.svelte';
         import { render } from 'svelte/server';
         export const html = () => render(App).body;`
      : `import { App } from './App';
         import { render } from 'preact-render-to-string';
         export const html = () => render(<App />);`
    fs.writeFileSync(path.join(f.root, 'src/entry-server.tsx'), source)
    const server = await f.serve()
    const dev = await server.ssrLoadModule('/src/entry-server.tsx')
    assert.match(dev.html(), /Count:/, 'the SSR dev module runner must execute framework output')
    const result = await build({
      ...f.config, base: '/demo/', build: { sourcemap: true },
      environments: { ssr: { entry: 'src/entry-server.tsx' } },
    })
    const client = result.output.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n')
    assert.doesNotMatch(client, /import\.meta\.hot|__PREFRESH__|\$RefreshReg\$|["'/]react\/jsx-runtime/)
    assert.ok(result.output.some((item) => item.fileName.endsWith('.map')))
    const html = fs.readFileSync(path.join(f.root, 'dist/index.html'), 'utf8')
    assert.match(html, /\/demo\/assets\//)
    if (framework === 'svelte') {
      const css = result.output.find((item) => item.fileName.endsWith('.css'))
      assert.ok(css, 'component CSS must be extracted')
      assert.match(String(css.source), /#ff3e00/)
      assert.match(html, /stylesheet/)
    }
    const entry = await import(pathToFileURL(path.join(f.root, 'dist/ssr/entry-server.js')).href)
    assert.match(entry.html(), new RegExp(`Nasti \\+ ${framework === 'svelte' ? 'Svelte' : 'Preact'}`))
    assert.match(entry.html(), /Count:/)
  })

  test(`${framework}: disabling HMR removes framework refresh`, async (t) => {
    const f = fixture(t, framework)
    const server = await f.serve({ server: { port: 0, host: '127.0.0.1', hmr: false } })
    const component = `/src/App.${framework === 'svelte' ? 'svelte' : 'tsx'}`
    const result = await server.transformRequest(component)
    assert.doesNotMatch(result.code, /__PREFRESH__|import\.meta\.hot\.accept|\$RefreshReg\$/)
  })

  test(`${framework}: browser rendering, interaction and state-preserving HMR`, { skip: !browsers }, async (t) => {
    const f = fixture(t, framework)
    if (framework === 'preact') {
      fs.writeFileSync(path.join(f.root, 'src/useCounter.ts'), `
        import { useState } from 'preact/hooks';
        export function useCounter() {
          const [count, setCount] = useState(0);
          return [count, setCount] as const;
        }
      `)
      const app = path.join(f.root, 'src/App.tsx')
      fs.writeFileSync(app, fs.readFileSync(app, 'utf8')
        .replace("import { useState } from 'preact/hooks'", "import { useCounter } from './useCounter'")
        .replace('useState<number>(0)', 'useCounter()'))
    }
    const server = await f.serve()
    const require = createRequire(path.join(repo, 'playground/tanstack-react/package.json'))
    const { chromium } = require('playwright')
    const browser = await chromium.launch({
      headless: true, executablePath: process.env.NASTI_CHROME_PATH || undefined,
    })
    t.after(() => browser.close())
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`)
    })
    await page.goto(url(server))
    const button = page.getByRole('button')
    await button.waitFor({ timeout: 10000 }).catch((cause) => {
      throw new Error(`Failed to mount ${framework}: ${errors.join('\n')}`, { cause })
    })
    await button.click()
    await button.click()
    assert.equal(await button.textContent(), 'Count: 2')
    let navigations = 0
    page.on('framenavigated', () => navigations++)
    const component = path.join(f.root, `src/App.${framework === 'svelte' ? 'svelte' : 'tsx'}`)
    await edit(server, component, (source) => source.replace('Edit App', 'Updated App'))
    await page.getByText(/Updated App/).waitFor()
    assert.equal(await button.textContent(), 'Count: 2')
    assert.equal(navigations, 0, 'component edits should not reload the page')
    if (framework === 'svelte') {
      await edit(server, component, (source) => source.replace('#ff3e00', '#0080ff'))
      await page.waitForFunction(() => getComputedStyle(document.querySelector('button')).color === 'rgb(0, 128, 255)')
      assert.equal(await button.textContent(), 'Count: 2')
    } else {
      await edit(server, path.join(f.root, 'src/useCounter.ts'),
        (source) => source.replace('return [count,', 'return [count * 10,'))
      await page.waitForFunction(() => document.querySelector('button').textContent === 'Count: 20')
      assert.equal(navigations, 0, 'custom Hook edits should propagate without reloading')
    }
    assert.deepEqual(errors, [])
  })
}

test('Svelte compiler is resolved from the consuming workspace with an actionable error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-no-svelte-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}')
  fs.writeFileSync(path.join(root, 'src/App.svelte'), '<p>Hello</p>')
  const server = await createServer({ root, logLevel: 'silent' })
  t.after(async () => {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await assert.rejects(server.transformRequest('/src/App.svelte'), /svelte\/compiler.*Install it in the consuming workspace/)
})
