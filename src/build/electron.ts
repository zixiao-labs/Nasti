// Electron 构建入口
//
// 流水线：
//   1. 渲染进程（Web）构建 —— 复用现有 build() 流水线，输出到 outDir/renderer
//   2. 主进程构建 —— 独立 Rolldown，target=node22，external=electron+内建模块
//   3. Preload 构建 —— 独立 Rolldown，默认 cjs，contextIsolation 友好
//
// 产物目录结构（默认）:
//   dist/
//   ├── renderer/    Web 渲染层，与 nasti build 一致
//   ├── main.{cjs,mjs}
//   └── preload.{cjs,mjs}
import path from 'node:path'
import fs from 'node:fs'
import { rolldown } from 'rolldown'
import pc from 'picocolors'
import type { NastiConfig, ResolvedConfig } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { electronPlugin } from '../plugins/electron.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine } from '../core/env.js'

export interface ElectronBuildResult {
  rendererOutDir: string
  mainFile: string
  preloadFiles: string[]
}

export async function buildElectron(inlineConfig: NastiConfig = {}): Promise<ElectronBuildResult> {
  const config = await resolveConfig({ ...inlineConfig, target: 'electron' }, 'build')
  const startTime = performance.now()

  assertElectronVersion(config)

  console.log(pc.cyan('\n⚡ nasti build (electron)') + pc.dim(` v${__NASTI_VERSION__}`))
  console.log(pc.dim(`  root: ${config.root}`))
  console.log(pc.dim(`  mode: ${config.mode}`))
  console.log(pc.dim(`  target: electron (≥ ${config.electron.minVersion})`))

  const outDir = path.resolve(config.root, config.build.outDir)
  if (config.build.emptyOutDir && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  // ---- 1. 渲染进程（复用 Web 构建）----
  const rendererOutDir = path.join(outDir, 'renderer')
  const { build } = await import('./index.js')
  await build({
    ...inlineConfig,
    target: 'web',
    build: {
      ...inlineConfig.build,
      outDir: rendererOutDir,
      emptyOutDir: false,
    },
  })

  // ---- 2. 主进程 ----
  const mainEntry = path.resolve(config.root, config.electron.main)
  if (!fs.existsSync(mainEntry)) {
    throw new Error(
      `Electron main entry not found: ${config.electron.main}\n` +
        `在 nasti.config.ts 的 electron.main 指定主进程入口文件。`,
    )
  }
  const mainFile = await bundleNode(config, mainEntry, {
    outFile: outFileName(outDir, 'main', config.electron.mainFormat),
    format: config.electron.mainFormat,
    label: 'main',
  })

  // ---- 3. Preload ----
  const preloadEntries = normalizePreload(config.electron.preload, config.root)
  const preloadFiles: string[] = []
  for (const entry of preloadEntries) {
    if (!fs.existsSync(entry)) {
      console.warn(pc.yellow(`  ⚠ preload entry not found, skipped: ${entry}`))
      continue
    }
    const base = path.basename(entry).replace(/\.[^.]+$/, '')
    const out = outFileName(outDir, base, config.electron.preloadFormat)
    await bundleNode(config, entry, {
      outFile: out,
      format: config.electron.preloadFormat,
      label: `preload (${base})`,
    })
    preloadFiles.push(out)
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
  console.log(pc.green(`\n✓ Electron build complete in ${elapsed}s`))
  console.log(pc.dim(`  renderer: ${path.relative(config.root, rendererOutDir)}/`))
  console.log(pc.dim(`  main:     ${path.relative(config.root, mainFile)}`))
  for (const pf of preloadFiles) {
    console.log(pc.dim(`  preload:  ${path.relative(config.root, pf)}`))
  }
  console.log()

  return { rendererOutDir, mainFile, preloadFiles }
}

interface BundleNodeOptions {
  outFile: string
  format: 'cjs' | 'esm'
  label: string
}

async function bundleNode(
  config: ResolvedConfig,
  entry: string,
  opts: BundleNodeOptions,
): Promise<string> {
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = {
    ...buildEnvDefine(env, config.mode),
    __ELECTRON__: 'true',
    __NASTI_TARGET__: JSON.stringify('electron'),
  }

  const oxcTransformPlugin = {
    name: 'nasti:oxc-transform',
    transform(code: string, id: string) {
      if (!shouldTransform(id)) return null
      const result = transformCode(id, code, {
        sourcemap: !!config.build.sourcemap,
        jsxRuntime: 'automatic',
        jsxImportSource: config.framework === 'vue' ? 'vue' : 'react',
      })
      return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
    },
  }

  const bundle = await rolldown({
    input: entry,
    define: envDefine,
    platform: 'node',
    plugins: [
      oxcTransformPlugin,
      electronPlugin(config),
      resolvePlugin(config),
    ].map((p) => ({
      name: p.name,
      resolveId: (p as any).resolveId,
      load: (p as any).load,
      transform: (p as any).transform,
    })),
    ...(config.build.rolldownOptions as any),
  } as any)

  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true })

  await bundle.write({
    file: opts.outFile,
    format: opts.format === 'cjs' ? 'cjs' : 'esm',
    sourcemap: !!config.build.sourcemap,
    minify: !!config.build.minify,
    inlineDynamicImports: true,
  } as any)

  await bundle.close()

  console.log(pc.dim(`  ✓ ${opts.label} → ${path.relative(config.root, opts.outFile)}`))
  return opts.outFile
}

function outFileName(outDir: string, base: string, format: 'cjs' | 'esm'): string {
  const ext = format === 'cjs' ? '.cjs' : '.mjs'
  return path.join(outDir, base + ext)
}

export function normalizePreload(preload: string | string[], root: string): string[] {
  const list = Array.isArray(preload) ? preload : preload ? [preload] : []
  return list.map((p) => path.resolve(root, p))
}

function assertElectronVersion(config: ResolvedConfig): void {
  const min = config.electron.minVersion
  const installed = detectInstalledElectron(config.root)
  if (installed && installed < min) {
    console.warn(
      pc.yellow(
        `  ⚠ 检测到 Electron ${installed}，Nasti 要求 ≥ ${min}。旧版本可能缺少 ESM 主进程支持。`,
      ),
    )
  }
}

export function detectInstalledElectron(root: string): number | null {
  try {
    const pkgPath = path.resolve(root, 'node_modules/electron/package.json')
    if (!fs.existsSync(pkgPath)) return null
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const major = parseInt(String(pkg.version).split('.')[0], 10)
    return Number.isFinite(major) ? major : null
  } catch {
    return null
  }
}
