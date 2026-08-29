// build.minify 的细粒度选项 —— 类名 / 函数名 / 属性名最小化。
//
// Nasti 早期把 minify 收敛成 `boolean | 'oxc'`，且各调用点一律 `!!` 强转，
// 传对象会被压成 `true`。这些用例锁住放开后的行为：对象能穿过配置解析
// 抵达 Rolldown，且 OXC 的 mangle 语义确实生效。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build, resolveConfig } from '../dist/index.js'

const execFileAsync = promisify(execFile)
const NASTI_BIN = fileURLToPath(new URL('../bin/nasti.js', import.meta.url))

// 顶层类 + 顶层函数 + 一个下划线私有属性。
// 刻意不 export：export 名字必须原样出现在 `export {}` 子句里（那是公开
// API，压缩器不能改），会掩盖标识符本身是否被最小化。挂到 globalThis 上
// 则既能防止被 tree-shaking 掉，又让局部标识符成为唯一的观察点。
const SOURCE = [
  'class WidgetRegistryImpl {',
  '  constructor() { this._internalSlot = 1 }',
  '  read() { return this._internalSlot }',
  '}',
  'function createWidgetRegistry() { return new WidgetRegistryImpl() }',
  'globalThis.__registry = createWidgetRegistry()',
  'globalThis.__ctor = WidgetRegistryImpl',
  'globalThis.__factory = createWidgetRegistry',
].join('\n')

test('minify mangles class and function names by default', async (t) => {
  const code = await buildCode(t, { minify: true })

  assert.doesNotMatch(code, /WidgetRegistryImpl/, 'class name should be mangled away')
  assert.doesNotMatch(code, /createWidgetRegistry/, 'function name should be mangled away')
})

test('mangle.keepNames.class preserves class names while still mangling functions', async (t) => {
  const code = await buildCode(t, {
    minify: { mangle: { keepNames: { class: true, function: false } } },
  })

  assert.match(code, /WidgetRegistryImpl/, 'class name should survive keepNames.class')
  assert.doesNotMatch(code, /createWidgetRegistry/, 'function name should still be mangled')
})

test('mangle.keepNames preserves both class and function names', async (t) => {
  const code = await buildCode(t, { minify: { mangle: { keepNames: true } } })

  assert.match(code, /WidgetRegistryImpl/)
  assert.match(code, /createWidgetRegistry/)
  // 仍然是压缩过的产物：keepNames 只保名，不关闭压缩。
  assert.doesNotMatch(code, /\n\t/, 'output should still be minified')
})

test('mangleProps minifies matching property names', async (t) => {
  const baseline = await buildCode(t, { minify: true })
  assert.match(baseline, /_internalSlot/, 'baseline: 普通压缩不动属性名')

  const code = await buildCode(t, { minify: { mangleProps: { include: /^_/ } } })
  assert.doesNotMatch(code, /_internalSlot/, 'underscore property should be mangled')
})

test('mangleProps.exclude protects properties owned by host objects', async (t) => {
  // mangleProps 只按名字匹配、不做类型分析，globalThis 上的属性同样会被改名。
  // exclude 是把宿主 / 全局属性摘出去的正确姿势。
  const code = await buildCode(t, {
    minify: { mangleProps: { include: /^_/, exclude: /^__/ } },
  })

  assert.doesNotMatch(code, /_internalSlot/, 'own property should still be mangled')
  assert.match(code, /globalThis\.__registry/, 'globalThis property should be excluded')
  assert.match(code, /globalThis\.__ctor/)
})

test('mangleProps.reserved exempts exact names from property minification', async (t) => {
  const code = await buildCode(t, {
    minify: { mangleProps: { include: /^_/, reserved: ['_internalSlot'] } },
  })

  assert.match(code, /_internalSlot/)
})

test('dce-only skips renaming entirely', async (t) => {
  const code = await buildCode(t, { minify: 'dce-only' })

  assert.match(code, /WidgetRegistryImpl/)
  assert.match(code, /createWidgetRegistry/)
})

test("legacy minify: 'oxc' still minifies", async (t) => {
  const code = await buildCode(t, { minify: 'oxc' })

  assert.doesNotMatch(code, /WidgetRegistryImpl/)
})

test('minify: false leaves names and formatting intact', async (t) => {
  const code = await buildCode(t, { minify: false })

  assert.match(code, /var WidgetRegistryImpl = class/)
  assert.match(code, /function createWidgetRegistry\(\)/)
  assert.match(code, /_internalSlot/)
})

test('resolveConfig carries a minify object through untouched', async (t) => {
  const root = fixture(t)
  const include = /^_/
  const minify = {
    mangle: { keepNames: { class: true, function: false } },
    mangleProps: { include },
  }

  const config = await resolveConfig({ root, logLevel: 'silent', build: { minify } }, 'build')

  assert.deepEqual(config.build.minify, minify)
  // RegExp 必须按引用存活 —— deepMerge 只对 plain object 递归，
  // 若哪天改成无差别递归，正则会被拆成 {} 而静默失效。
  assert.equal(config.build.minify.mangleProps.include, include)
  // 对象形式的 minify 同样算「开启压缩」，cssMinify 应跟随为 true。
  assert.equal(config.build.cssMinify, true)
})

test('server consumer keeps its unminified default while client honours the object', async (t) => {
  const root = fixture(t)
  const minify = { mangle: { keepNames: { class: true, function: false } } }

  const config = await resolveConfig(
    { root, logLevel: 'silent', build: { minify }, environments: { ssr: { entry: 'src/main.ts' } } },
    'build',
  )

  assert.deepEqual(config.environments.client.build.minify, minify)
  assert.equal(config.environments.ssr.build.minify, false, 'SSR 产物默认不压缩')
})

// ── CLI 优先级 ───────────────────────────────────────────────────────────
// cac 会给否定式选项（`--no-minify`）自动补 `default: true`，因此「未传 flag」
// 与「显式 --minify」在 options 对象里长得一模一样。若照单全收地塞进 inline
// config，就会静默盖掉 nasti.config.ts 里的 build.minify —— 这几个用例把
// 三种情形钉死。

test('CLI without minify flags defers to the config file', async (t) => {
  const root = cliFixture(t)
  const code = await runCliBuild(root)

  assert.match(code, /WidgetRegistryImpl/, '配置文件的 keepNames.class 应当生效')
  assert.doesNotMatch(code, /createWidgetRegistry/, '函数名仍应被压缩')
})

test('CLI --no-minify overrides the config file', async (t) => {
  const root = cliFixture(t)
  const code = await runCliBuild(root, ['--no-minify'])

  assert.match(code, /var WidgetRegistryImpl = class/)
  assert.match(code, /function createWidgetRegistry\(\)/)
})

test('CLI --minify overrides the config file', async (t) => {
  const root = cliFixture(t)
  const code = await runCliBuild(root, ['--minify'])

  assert.doesNotMatch(code, /WidgetRegistryImpl/, '显式 --minify 应压过配置对象')
})

test('CLI --keep-names and --mangle-props build a minify object', async (t) => {
  const root = cliFixture(t)
  const code = await runCliBuild(root, ['--keep-names', '--mangle-props', '^_'])

  assert.match(code, /WidgetRegistryImpl/)
  assert.match(code, /createWidgetRegistry/)
  assert.doesNotMatch(code, /_internalSlot/, '属性名应按正则被压缩')
})

async function runCliBuild(root, args = []) {
  await execFileAsync(process.execPath, [NASTI_BIN, 'build', '--logLevel', 'silent', ...args], {
    cwd: root,
  })
  const assets = path.join(root, 'dist', 'assets')
  return fs
    .readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(assets, file), 'utf8'))
    .join('\n')
}

/** 带 nasti.config.ts 的 fixture —— 配置里只保类名，不保函数名。 */
function cliFixture(t) {
  const root = fixture(t)
  fs.writeFileSync(
    path.join(root, 'nasti.config.ts'),
    'export default { build: { minify: { mangle: { keepNames: { class: true, function: false } } } } }\n',
  )
  return root
}

async function buildCode(t, buildOptions) {  const root = fixture(t)
  const result = await build({
    root,
    logLevel: 'silent',
    build: { outDir: 'dist-build', ...buildOptions },
  })
  // BuildResult.output 即 client 环境产物（1.x 形态，2.0 仍保留）
  return result.output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n')
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-minify-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>',
  )
  fs.writeFileSync(path.join(root, 'src/main.ts'), SOURCE)
  return root
}
