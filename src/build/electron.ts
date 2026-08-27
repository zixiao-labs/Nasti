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
import { createRequire } from 'node:module'
import { rolldown } from 'rolldown'
import pc from 'picocolors'
import type { NastiConfig, ResolvedConfig } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { electronPlugin } from '../plugins/electron.js'
import { transformCode, transformReactCode, shouldTransform } from '../core/transformer.js'
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
  await build(createElectronRendererConfig(config, inlineConfig, {
    build: {
      ...inlineConfig.build,
      outDir: rendererOutDir,
      emptyOutDir: false,
    },
  }))

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
    async transform(code: string, id: string) {
      const result = config.framework === 'react'
        ? await transformReactCode(id, code, {
            react: config.react,
            consumer: 'server',
            development: config.mode === 'development',
            sourcemap: !!config.build.sourcemap,
            target: config.electron.nodeTarget,
            onWarning: (message) => config.logger.warn(`[nasti:react] ${message}`),
          })
        : shouldTransform(id)
          ? transformCode(id, code, {
              sourcemap: !!config.build.sourcemap,
              jsxRuntime: 'automatic',
              jsxImportSource: 'vue',
              target: config.electron.nodeTarget,
            })
          : null
      if (!result) return null
      return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
    },
  }

  // 从 build.rolldownOptions 拆出 output（合并进 bundle.write()）与 transform
  // （需与 envDefine 合并），其余 input 选项（treeshake 等）随 restInputOptions 透传。
  // Nasti 自管的 input / platform / transform / plugins 放在 spread 之后确保覆盖。
  const { output: userOutput, transform: userTransform, ...restInputOptions } =
    config.build.rolldownOptions
  // 合并用户的 transform.define 和 envDefine，确保 envDefine 优先级更高
  const mergedDefine = { ...(userTransform?.define ?? {}), ...envDefine }
  const bundle = await rolldown({
    ...restInputOptions,
    input: entry,
    platform: 'node',
    transform: {
      ...userTransform,
      target: config.electron.nodeTarget,
      define: mergedDefine,
    },
    plugins: [oxcTransformPlugin, electronPlugin(config), resolvePlugin(config)] as any,
  })

  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true })

  await bundle.write({
    sourcemap: !!config.build.sourcemap,
    minify: !!config.build.minify,
    // 允许用户微调 output；但主进程 / preload 的单文件约束由下方键强制保证
    ...userOutput,
    file: opts.outFile,
    format: opts.format === 'cjs' ? 'cjs' : 'esm',
    codeSplitting: false,
  })

  await bundle.close()

  console.log(pc.dim(`  ✓ ${opts.label} → ${path.relative(config.root, opts.outFile)}`))
  return opts.outFile
}

/**
 * 从 Electron 配置派生 renderer 的普通 Web 构建配置。
 *
 * renderer 使用指定 HTML 入口；本地文件加载场景默认把 `/` base 收敛为
 * `./`，避免产物中的 `/assets/*` 被解析到文件系统根目录。
 */
export function createElectronRendererConfig(
  config: ResolvedConfig,
  inlineConfig: NastiConfig = {},
  overrides: Pick<NastiConfig, 'build'> = {},
): NastiConfig {
  const inlineClient = inlineConfig.environments?.client ?? {}
  return {
    ...inlineConfig,
    ...overrides,
    root: config.root,
    mode: config.mode,
    target: 'web',
    framework: config.framework,
    base: config.base === '/' ? './' : config.base,
    environments: {
      ...(inlineConfig.environments ?? {}),
      client: {
        ...inlineClient,
        html: config.electron.renderer,
      },
    },
  }
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
export function normalizePreload(preload: string | string[] | undefined, root: string): string[] {
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
 * @param root - Project root directory used to locate electron via Node resolution
 * @returns The major Electron version as a number, or `null` if Electron is not installed or the version cannot be determined
 */
export function detectInstalledElectron(root: string): number | null {
  try {
    // Node resolution handles pnpm/yarn symlink layouts; plain path join is a
    // fallback for installers that still flatten electron under node_modules.
    const require = createRequire(path.resolve(root, 'package.json'))
    const pkgPath = require.resolve('electron/package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const major = parseInt(String(pkg.version).split('.')[0], 10)
    return Number.isFinite(major) ? major : null
  } catch {
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
}
