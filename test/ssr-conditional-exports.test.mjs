import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createServer } from '../dist/index.js'

test('SSR external imports select ESM through nested conditional exports', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-conditions-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const packageDir = path.join(root, 'node_modules', 'nested-conditional-package')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  )
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'nested-conditional-package',
      type: 'module',
      exports: {
        '.': {
          node: {
            require: './index.cjs',
            import: './index.js',
          },
          default: './index.js',
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(packageDir, 'index.js'),
    'export default { format: "esm", url: import.meta.url }\n',
  )
  // The regression is intentionally observable as a parse error: this file is
  // only valid as ESM, but the `.cjs` extension makes the wrong branch invalid.
  fs.writeFileSync(
    path.join(packageDir, 'index.cjs'),
    'module.exports = { format: "cjs", url: import.meta.url }\n',
  )
  fs.writeFileSync(
    path.join(root, 'src', 'entry.js'),
    [
      'import implementation from "nested-conditional-package";',
      'export const format = implementation.format;',
      'export const packageUrl = implementation.url;',
      '',
    ].join('\n'),
  )

  const server = await createServer({ root, logLevel: 'silent' })
  t.after(() => server.close())

  const loaded = await server.ssrLoadModule('/src/entry.js')
  assert.equal(loaded.format, 'esm')
  assert.equal(
    loaded.packageUrl,
    pathToFileURL(fs.realpathSync(path.join(packageDir, 'index.js'))).href,
  )
})

for (const [layout, rootDependency] of [
  ['nested', false], ['nested', true],
  ['symlinked', false], ['symlinked', true],
]) {
  test(`SSR transformed package resolves its own external dependency (${layout}, ${rootDependency ? 'conflicting root version' : 'not hoisted'})`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-transitive-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const writePackage = (directory, name, source) => {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name, type: 'module', exports: { '.': { import: './index.js', require: './wrong.cjs' } },
      }))
      fs.writeFileSync(path.join(directory, 'index.js'), source)
      fs.writeFileSync(path.join(directory, 'wrong.cjs'), 'throw new Error("wrong require branch")')
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    const link = path.join(root, 'node_modules', 'server-runtime')
    const parent = layout === 'symlinked'
      ? path.join(root, 'node_modules', '.pnpm', 'server-runtime@1', 'node_modules', 'server-runtime')
      : link
    writePackage(parent, 'server-runtime', [
      'import { version } from "nested-runtime";',
      'export const selected = version;',
      'export const load = async () => (await import("nested-runtime")).version;',
    ].join('\n'))
    writePackage(path.join(parent, 'node_modules', 'nested-runtime'), 'nested-runtime',
      'export const version = "nested";')
    if (layout === 'symlinked') {
      fs.symlinkSync(parent, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    if (rootDependency) {
      writePackage(path.join(root, 'node_modules', 'nested-runtime'), 'nested-runtime',
        'export const version = "root";')
    }
    fs.writeFileSync(path.join(root, 'entry.js'),
      'export { selected, load } from "server-runtime";')
    let parentTransforms = 0
    const server = await createServer({
      root, logLevel: 'silent', resolve: { noExternal: ['server-runtime'] },
      plugins: [{
        name: 'assert-transformed-parent',
        transform(code, id) {
          const file = id.split('?')[0]
          if (path.isAbsolute(file) && fs.existsSync(file) &&
              fs.realpathSync(file) === fs.realpathSync(path.join(parent, 'index.js'))) {
            parentTransforms++
          }
        },
      }],
    })
    t.after(() => server.close())
    const loaded = await server.ssrLoadModule('/entry.js')
    assert.equal(loaded.selected, 'nested')
    assert.equal(await loaded.load(), 'nested')
    assert.equal(parentTransforms, 1, 'parent must execute through the SSR transform pipeline')
  })
}

test('SSR virtual entry external imports retain the project root fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-virtual-external-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageDir = path.join(root, 'node_modules', 'virtual-runtime')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(packageDir, 'package.json'),
    '{"name":"virtual-runtime","type":"module","exports":"./index.js"}')
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export const value = "root";')
  const server = await createServer({
    root, logLevel: 'silent',
    plugins: [{
      name: 'virtual-server-entry',
      resolveId(id) {
        if (id === 'virtual:server-entry') return '\0virtual:server-entry'
      },
      load(id) {
        if (id === '\0virtual:server-entry') return 'export { value } from "virtual-runtime";'
      },
    }],
  })
  t.after(() => server.close())
  assert.equal((await server.ssrLoadModule('virtual:server-entry')).value, 'root')
})
