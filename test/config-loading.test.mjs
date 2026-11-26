import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../dist/index.js'

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-config-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('concurrent TypeScript config loads in the same millisecond evaluate independently', async (t) => {
  const root = createFixture(t)
  fs.writeFileSync(path.join(root, 'config-values.mjs'), 'let calls = 0; export const next = () => ++calls')
  fs.writeFileSync(
    path.join(root, 'nasti.config.ts'),
    `import { next } from './config-values.mjs'
const id: number = next()
export default { base: '/fixture-' + id + '/' }
`,
  )
  t.mock.method(Date, 'now', () => 123456789)

  const loads = await Promise.allSettled(
    Array.from({ length: 3 }, () => resolveConfig({ root }, 'serve')),
  )
  const bases = loads.map((load) => {
    if (load.status === 'rejected') throw load.reason
    return load.value.base
  })
  assert.deepEqual(bases.sort(), ['/fixture-1/', '/fixture-2/', '/fixture-3/'])
  assert.deepEqual(fs.readdirSync(root).sort(), ['config-values.mjs', 'nasti.config.ts'])
})

test('a failing TypeScript config preserves its error and removes the temporary module', async (t) => {
  const root = createFixture(t)
  fs.writeFileSync(path.join(root, 'nasti.config.mts'), 'throw new Error("config evaluation failed")')

  await assert.rejects(resolveConfig({ root }, 'serve'), { message: 'config evaluation failed' })
  assert.deepEqual(fs.readdirSync(root), ['nasti.config.mts'])
})
