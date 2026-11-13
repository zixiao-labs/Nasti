import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { build, resolveConfig } from '../dist/index.js'

const sharedModule = /[\\/]shared\.ts$/

for (const callbacks of [false, true]) {
  test(`codeSplitting forwards ${callbacks ? 'callbacks' : 'RegExp groups'} to client and SSR builds`, async (t) => {
    const root = fixture(t)
    const group = {
      name: callbacks ? (id, context) => {
        assert.ok(context.getModuleInfo(id), 'name callback receives the module graph')
        return 'shared'
      } : 'shared',
      test: callbacks ? (id) => sharedModule.test(id) : sharedModule,
      priority: 20,
    }
    const config = {
      root, logLevel: 'silent',
      build: {
        minify: false,
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                { name: 'fallback', test: sharedModule, priority: 10 },
                group,
              ],
            },
            chunkFileNames: 'assets/chunks/[name].js',
          },
        },
      },
      environments: { ssr: { entry: 'src/main.ts' } },
    }
    const resolved = await resolveConfig(config, 'build')
    for (const environment of ['client', 'ssr']) {
      const groups = resolved.environments[environment].build.rolldownOptions.output.codeSplitting.groups
      assert.equal(groups[1].test, group.test, 'test must survive config merging')
      assert.equal(groups[1].name, group.name, 'name must survive config merging')
    }

    const result = await build(config)
    for (const environment of ['client', 'ssr']) {
      const chunks = result.environments[environment].filter((item) => item.type === 'chunk')
      const shared = chunks.find((chunk) => chunk.fileName === 'assets/chunks/shared.js')
      assert.ok(shared, `${environment} must emit the higher-priority manual chunk`)
      assert.ok(shared.moduleIds.some((id) => sharedModule.test(id)))
      assert.ok(chunks.some((chunk) => chunk.isEntry && chunk.imports.includes(shared.fileName)))
      assert.ok(!chunks.some((chunk) => chunk.fileName.includes('fallback')))
    }
  })
}

test('ESM and CommonJS declarations export the current Rolldown code-splitting types', (t) => {
  const root = fixture(t)
  const repo = fileURLToPath(new URL('../', import.meta.url))
  fs.mkdirSync(path.join(root, 'node_modules/@nasti-toolchain'), { recursive: true })
  fs.symlinkSync(repo, path.join(root, 'node_modules/@nasti-toolchain/nasti'),
    process.platform === 'win32' ? 'junction' : 'dir')
  const source = `
import { defineConfig } from '@nasti-toolchain/nasti'
import type {
  CodeSplittingOptions, CodeSplittingGroup, CodeSplittingNameFunction,
  ChunkingContext, NastiRolldownOptions,
} from '@nasti-toolchain/nasti'

const name: CodeSplittingNameFunction = (id, context: ChunkingContext) =>
  context.getModuleInfo(id)?.isEntry ? null : 'shared'
const group: CodeSplittingGroup = {
  name, test: /shared/, priority: 20, entriesAware: true,
}
const options: CodeSplittingOptions = { groups: [group], minSize: 0 }
const output: NastiRolldownOptions['output'] = { codeSplitting: options }
defineConfig({ build: { rolldownOptions: { output } } })
defineConfig({ build: { rolldownOptions: { output: { codeSplitting: true } } } })
defineConfig({ build: { rolldownOptions: { output: { codeSplitting: false } } } })
// @ts-expect-error size thresholds must not be typed as any
const invalid: CodeSplittingOptions = { minSize: 'large' }
// @ts-expect-error name callbacks must return a chunk name or nullish value
const invalidName: CodeSplittingNameFunction = () => 42
`
  const files = ['types.mts', 'types.cts'].map((name) => path.join(root, name))
  for (const file of files) fs.writeFileSync(file, source)
  const require = createRequire(import.meta.url)
  execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
    ...files,
  ], { cwd: root, stdio: 'pipe' })
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-code-splitting-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true,"type":"module"}')
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>')
  fs.writeFileSync(path.join(root, 'src/shared.ts'), 'export const value = { answer: 42 }')
  fs.writeFileSync(path.join(root, 'src/main.ts'),
    'import { value } from "./shared.ts"; globalThis.__read = () => value.answer; globalThis.__lazy = () => import("./lazy.ts")')
  fs.writeFileSync(path.join(root, 'src/lazy.ts'),
    'import { value } from "./shared.ts"; export const read = () => value.answer')
  return root
}
