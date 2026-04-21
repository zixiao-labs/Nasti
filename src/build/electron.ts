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

/**
 * Performs a full Electron build pipeline producing renderer, main, and preload artifacts.
 *
 * Resolves an Electron-targeted config, validates the installed Electron version, prepares the output directory, builds the renderer (via the web build), bundles the main process, bundles configured preload scripts, and logs a summary.
 *
 * @param inlineConfig - Optional config overrides merged into the resolved build configuration
 * @returns An object with `rendererOutDir` (renderer output directory), `mainFile` (bundled main process file path), and `preloadFiles` (array of bundled preload file paths)
 * @throws Error if the configured Electron main entry file does not exist
 */
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

/**
 * Bundles a Node-targeted entry for Electron into a single output file using Rolldown and the OXC transform.
 *
 * @param config - Fully resolved build configuration used to drive transforms, defines, plugins, and output options
 * @param entry - Absolute path to the entry file to bundle
 * @param opts - Bundle options; expects `outFile` (destination path), `format` (`'cjs'` or `'esm'`), and `label` (human-readable name for logging)
 * @returns The path to the written bundle file (`opts.outFile`)
 */
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

/**
 * Compute an output file path for a given base name and module format.
 *
 * @param outDir - Directory where the output file will be placed
 * @param base - Base filename without extension
 * @param format - Module format; `cjs` yields a `.cjs` extension, `esm` yields a `.mjs` extension
 * @returns The resolved file path combining `outDir` and `base` with the appropriate extension
 */
function outFileName(outDir: string, base: string, format: 'cjs' | 'esm'): string {
  const ext = format === 'cjs' ? '.cjs' : '.mjs'
  return path.join(outDir, base + ext)
}

/**
 * Normalize Electron preload entries into absolute file paths.
 *
 * @param preload - A single preload path or an array of preload paths; a falsy value produces an empty list
 * @param root - Root directory used to resolve relative preload entries
 * @returns An array of absolute file paths for each preload entry
 */
export function normalizePreload(preload: string | string[], root: string): string[] {
  const list = Array.isArray(preload) ? preload : preload ? [preload] : []
  return list.map((p) => path.resolve(root, p))
}

/**
 * Warns when the detected Electron major version is lower than the configured minimum.
 *
 * Checks the project for an installed Electron package and, if its major version
 * is less than `config.electron.minVersion`, logs a yellow warning describing the mismatch.
 *
 * @param config - Resolved build configuration that contains `electron.minVersion` and project `root`
 */
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

/**
 * Detects the installed Electron major version in the given project root.
 *
 * @param root - Project root directory used to locate `node_modules/electron/package.json`
 * @returns The major Electron version as a number, or `null` if Electron is not installed or the version cannot be determined
 */
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
