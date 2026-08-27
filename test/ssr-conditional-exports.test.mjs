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
