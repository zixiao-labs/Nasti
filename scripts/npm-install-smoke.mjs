// Explicit registry-backed check; kept outside the offline node --test suite.
// Run pnpm test:install, or build first and run node scripts/npm-install-smoke.mjs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-npm-install-'))
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
const write = (dir, name, content) => fs.writeFileSync(path.join(dir, name), content)

function npm(args, cwd) {
  return execFileSync('npm', [...args, '--loglevel=error'], {
    cwd, encoding: 'utf8', timeout: 180000,
    shell: process.platform === 'win32',
  })
}

try {
  // A tarball, not a file:directory link, prevents workspace dependencies from
  // hiding missing peers or selecting the root's development compiler.
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], repo))
  const tarball = path.join(root, packed.filename)
  console.log(`Checking ${pkg.name}@${pkg.version} with npm ${npm(['--version'], root).trim()}`)

  for (const compiler of [null, '0.152.0', '0.153.0']) {
    const name = compiler ? `compiler-${compiler}` : 'plain-react'
    const app = path.join(root, name)
    fs.mkdirSync(app)
    write(app, 'package.json', JSON.stringify({
      name, private: true, type: 'module',
      dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
      devDependencies: {
        [pkg.name]: `file:${tarball}`,
        ...(compiler ? { 'oxc-transform-react': compiler } : {}),
      },
    }))

    // Explicitly defeat inherited workaround settings and retain native optional
    // bindings. Strict peer checks must succeed without --force or legacy mode.
    npm([
      'install', '--no-audit', '--no-fund',
      '--legacy-peer-deps=false', '--force=false', '--strict-peer-deps',
      '--include=dev', '--include=optional', '--include=peer', '--ignore-scripts=false',
    ], app)

    const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'))
    assert.equal(lock.packages[`node_modules/${pkg.name}`].version, pkg.version)
    for (const peer of Object.keys(pkg.peerDependencies)) {
      if (compiler && peer === 'oxc-transform-react') continue
      assert.ok(!lock.packages[`node_modules/${peer}`], `${name}: ${peer} must stay opt-in`)
    }
    for (const peer of ['vite', 'vinext', '@vitejs/plugin-react']) {
      assert.ok(!lock.packages[`node_modules/${peer}`], `${name}: no unrelated Vite tooling`)
    }
    if (compiler) {
      assert.equal(lock.packages['node_modules/oxc-transform-react'].version, compiler)
    }

    write(app, 'index.html', '<div id="app"></div><script type="module" src="/main.tsx"></script>\n')
    write(app, 'main.tsx', [
      'import { createRoot } from "react-dom/client";',
      'import { App } from "./App";',
      'createRoot(document.getElementById("app")!).render(<App name="npm smoke" />);',
      '',
    ].join('\n'))
    write(app, 'App.tsx', 'export function App({ name }: { name: string }) { return <h1>{name}</h1> }\n')
    write(app, 'smoke.mjs', `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { build, createServer } from '${pkg.name}'
      const options = {
        root: process.cwd(), framework: 'react', logLevel: 'silent',
        react: { compiler: ${!!compiler} },
        build: { minify: false },
      }
      const result = await build(options)
      assert.ok(result.output.some((item) => item.type === 'chunk'))
      assert.ok(fs.existsSync('dist/index.html'))
      const server = await createServer(options)
      try {
        const transformed = await server.transformRequest('/App.tsx')
        assert.ok(transformed?.code)
        assert.match(transformed.code, /react\\/jsx-dev-runtime|react\\/jsx-runtime/)
        assert.doesNotMatch(transformed.code, /: \\{ name: string \\}/)
        if (${!!compiler}) assert.match(transformed.code, /react\\/compiler-runtime/)
        else assert.doesNotMatch(transformed.code, /react\\/compiler-runtime/)
      } finally {
        await server.close()
      }
    `)
    // A separate process imports the packed package and its own compiler version,
    // never the repository's already-cached compiler module.
    execFileSync(process.execPath, ['smoke.mjs'], { cwd: app, stdio: 'inherit', timeout: 60000 })
    console.log(`PASS ${name}: strict npm install, production build and dev transform`)
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
