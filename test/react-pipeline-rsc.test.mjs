import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { build, createServer, rsc } from '../dist/index.js'

const REACT_EXTERNAL = [/^react(?:\/|$)/, /^react-compiler-runtime$/, /^react-server-dom-webpack\//]

test('React pipeline keeps legacy plugin transform ordering', async (t) => {
  const root = fixture(t)
  write(root, 'index.html', '<div id="app"></div><script type="module" src="/src/main.tsx"></script>\n')
  write(
    root,
    'src/main.tsx',
    'export function App({ name }: { name: string }) { return <h1>{name}</h1> }\n',
  )

  let buildInput = ''
  await build({
    root,
    framework: 'react',
    logLevel: 'silent',
    plugins: [{
      name: 'legacy-source-observer',
      transform(code, id) {
        if (id.endsWith('/src/main.tsx')) buildInput = code
      },
    }],
    build: {
      outDir: 'dist-build',
      minify: false,
      rolldownOptions: { external: REACT_EXTERNAL },
    },
  })
  assert.match(buildInput, /react\/jsx-runtime/)
  assert.doesNotMatch(buildInput, /: \{ name: string \}/)

  let devInput = ''
  const server = await createServer({
    root,
    framework: 'react',
    logLevel: 'silent',
    plugins: [{
      name: 'legacy-source-observer',
      transform(code, id) {
        if (id.endsWith('/src/main.tsx')) devInput = code
      },
    }],
  })
  t.after(() => server.close())
  const transformed = await server.transformRequest('/src/main.tsx')
  assert.match(devInput, /: \{ name: string \}/)
  assert.match(devInput, /<h1>/)
  assert.match(transformed.code, /react\/jsx-dev-runtime|react\/jsx-runtime/)
  assert.match(transformed.code, /RefreshRuntime/)
})

test('native React Compiler only optimizes client consumers', async (t) => {
  const root = fixture(t)
  write(root, 'index.html', '<script type="module" src="/src/client.tsx"></script>\n')
  write(
    root,
    'src/client.tsx',
    'export function App({ name }: { name: string }) { return <h1>{name}</h1> }\n',
  )
  write(
    root,
    'src/server.tsx',
    'export function ServerApp({ name }: { name: string }) { return <h1>{name}</h1> }\n',
  )

  const result = await build({
    root,
    framework: 'react',
    react: { compiler: true },
    logLevel: 'silent',
    environments: {
      rsc: { consumer: 'server', entry: 'src/server.tsx' },
    },
    build: {
      outDir: 'dist',
      minify: false,
      sourcemap: true,
      rolldownOptions: { external: REACT_EXTERNAL },
    },
  })

  const clientCode = chunks(result.environments.client)
  const serverCode = chunks(result.environments.rsc)
  assert.match(clientCode, /react\/compiler-runtime/)
  assert.match(clientCode, /\bc\(/)
  assert.doesNotMatch(serverCode, /compiler-runtime/)
  assert.match(serverCode, /react\/jsx-runtime/)
})

test('RSC generator emits client/server proxies and an inspectable manifest', async (t) => {
  const root = fixture(t)
  write(root, 'src/main.tsx', [
    'import Button, { label } from "./Button";',
    'import { save } from "./actions";',
    'export { Button, label, save };',
    '',
  ].join('\n'))
  write(root, 'src/Button.tsx', [
    '"use client";',
    'export const label = "interactive";',
    'export default function Button() { return <button>{label}</button> }',
    '',
  ].join('\n'))
  write(root, 'src/actions.ts', [
    '"use server";',
    'const serverSecret = "SERVER_ONLY";',
    'export async function save(value: string) { return serverSecret + value }',
    '',
  ].join('\n'))
  write(root, 'src/rsc.tsx', [
    'import Button from "./Button";',
    'import { save } from "./actions";',
    'export function Page() { return <Button action={save} /> }',
    '',
  ].join('\n'))

  const result = await build({
    root,
    framework: 'react',
    logLevel: 'silent',
    plugins: [rsc({ entries: { client: 'src/main.tsx', rsc: 'src/rsc.tsx' } })],
    build: {
      outDir: 'dist',
      minify: false,
      rolldownOptions: { external: REACT_EXTERNAL },
    },
  })

  const clientCode = chunks(result.environments.client)
  const rscCode = chunks(result.environments.rsc)
  assert.match(clientCode, /interactive/)
  assert.match(clientCode, /createServerReference/)
  assert.doesNotMatch(clientCode, /SERVER_ONLY/)
  assert.match(rscCode, /registerClientReference/)
  assert.match(rscCode, /registerServerReference/)
  assert.match(rscCode, /SERVER_ONLY/)
  assert.doesNotMatch(rscCode, /interactive/)

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/rsc-manifest.json'), 'utf-8'))
  assert.equal(manifest.version, 1)
  assert.deepEqual(manifest.environments, { client: 'client', ssr: 'ssr', rsc: 'rsc' })
  assert.ok(manifest.clientReferences['/src/Button.tsx#default'].chunks.length > 0)
  assert.ok(manifest.clientReferences['/src/Button.tsx#label'].chunks.length > 0)
  assert.ok(manifest.serverReferences['/src/actions.ts#save'].chunks.length > 0)
  assert.ok(result.appOutput.some((item) => item.fileName === 'rsc-manifest.json'))
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-react-pipeline-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies: { react: '^19.0.0' } }),
  )
  return root
}

function write(root, file, contents) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function chunks(output) {
  return output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n')
}
