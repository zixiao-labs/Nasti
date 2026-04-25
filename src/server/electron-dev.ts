// Electron 开发模式
//
// 启动流程：
//   1. 启动 Nasti dev server（渲染进程由 Chromium 加载 http://localhost:PORT/）
//   2. 编译主进程与 preload 到 .nasti/ 临时目录（watch 模式）
//   3. spawn Electron 可执行文件，传入主进程入口
//   4. 监听主/preload 变化 -> 重编译 -> kill & respawn
//
// 渲染进程的 HMR 由标准 Nasti dev server 提供，无需额外处理
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import chokidar from 'chokidar'
import pc from 'picocolors'
import type { NastiConfig, ResolvedConfig } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { rolldown } from 'rolldown'
import { electronPlugin } from '../plugins/electron.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine } from '../core/env.js'
import { detectInstalledElectron, normalizePreload } from '../build/electron.js'

export interface ElectronDevOptions extends NastiConfig {
  /** 不启动 Electron 进程，只编译主/preload（CI 场景） */
  noSpawn?: boolean
}

/**
 * Start an Electron-focused development workflow: run the renderer dev server, build the main and preload bundles into .nasti/, and optionally spawn Electron with automatic restarts.
 *
 * @param inlineConfig - Development options; when `inlineConfig.noSpawn` is `true`, only compiles main/preload into `.nasti/` and does not start the Electron process.
 */
export async function startElectronDev(inlineConfig: ElectronDevOptions = {}): Promise<void> {
  const { noSpawn, ...rest } = inlineConfig
  const config = await resolveConfig({ ...rest, target: 'electron' }, 'serve')

  warnElectronVersion(config)

  console.log(pc.cyan('\n⚡ nasti electron dev') + pc.dim(` v${__NASTI_VERSION__}`))

  // 1. 启动 dev server（渲染进程）
  const { createServer } = await import('./index.js')
  const server = await createServer({ ...rest, target: 'electron' })
  await server.listen()

  const devUrl = `http://localhost:${server.config.server.port}/`
  console.log(pc.dim(`  renderer: ${devUrl}`))

  // 2. 编译主进程 + preload 到 .nasti/
  const stageDir = path.resolve(config.root, '.nasti')
  fs.mkdirSync(stageDir, { recursive: true })

  const mainEntry = path.resolve(config.root, config.electron.main)
  const preloadEntries = normalizePreload(config.electron.preload, config.root)

  const builtMainFile = path.join(stageDir, 'main' + extFor(config.electron.mainFormat))
  const builtPreloadFiles: string[] = []

  const compileAll = async () => {
    await compileNode(config, mainEntry, {
      outFile: builtMainFile,
      format: config.electron.mainFormat,
      devUrl,
    })
    builtPreloadFiles.length = 0
    for (const entry of preloadEntries) {
      if (!fs.existsSync(entry)) continue
      const base = path.basename(entry).replace(/\.[^.]+$/, '')
      const out = path.join(stageDir, base + extFor(config.electron.preloadFormat))
      await compileNode(config, entry, {
        outFile: out,
        format: config.electron.preloadFormat,
        devUrl,
      })
      builtPreloadFiles.push(out)
    }
  }

  await compileAll()

  if (noSpawn) {
    console.log(pc.dim('  (noSpawn) 已编译主/preload，跳过启动 Electron。'))
    return
  }

  // 3. 启动 Electron
  const electronBin = resolveElectronBinary(config)
  if (!electronBin) {
    console.warn(
      pc.yellow(
        '  ⚠ 未找到 Electron 可执行文件，请先安装：npm install -D electron\n    已编译主/preload 至 .nasti/，可手动运行。',
      ),
    )
    return
  }

  let child: ChildProcess | null = null
  const spawnElectron = () => {
    const args = [builtMainFile, ...config.electron.electronArgs]
    child = spawn(electronBin, args, {
      stdio: 'inherit',
      env: { ...process.env, NASTI_DEV_SERVER_URL: devUrl, NASTI_TARGET: 'electron' },
    })
    child.on('exit', (code) => {
      if (code !== null && child && (child as any).__nastiKilled !== true) {
        console.log(pc.dim(`  Electron exited (${code}).`))
        process.exit(code ?? 0)
      }
    })
  }
  spawnElectron()

  // 4. 监听主/preload 变化并重启
  if (config.electron.autoRestart) {
    const watchTargets = [mainEntry, ...preloadEntries].filter(fs.existsSync)
    const watcher = chokidar.watch(watchTargets, { ignoreInitial: true })
    // 旧实现：重启进行中就 return，丢弃变更。场景：改主进程后立刻改 preload
    //        会漏掉第二次。现在用 pending 标记 coalesce：等本轮完成后若 pending
    //        为真再跑一次，保证最后一次编辑必被编进去。
    let restarting: Promise<void> | null = null
    let pending = false
    const restart = async (): Promise<void> => {
      if (restarting) {
        pending = true
        return
      }
      restarting = (async () => {
        do {
          pending = false
          console.log(pc.cyan('\n  ♻ 主/preload 变更，重启 Electron...'))
          if (child && !child.killed) {
            ;(child as any).__nastiKilled = true
            const dying = child
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => resolve(), 3000)
              dying.once('exit', () => {
                clearTimeout(timer)
                resolve()
              })
              dying.kill()
            })
          }
          try {
            await compileAll()
            spawnElectron()
          } catch (e: any) {
            console.warn(pc.yellow(`  ⚠ 重启编译失败，保留上一次进程: ${e.message}`))
          }
          // 若 pending 在本轮期间被再次置位，立即再跑一轮
        } while (pending)
        restarting = null
      })()
      return restarting
    }
    // chokidar 会对一次保存触发多次事件；小窗口去抖避免过早发起重启
    let debounceTimer: NodeJS.Timeout | null = null
    watcher.on('all', () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void restart()
      }, 80)
    })
  }
}

/**
 * Map a module format identifier to its corresponding output file extension.
 *
 * @param format - 'cjs' for CommonJS or 'esm' for ECMAScript modules
 * @returns The file extension to use: '.cjs' for `cjs`, '.mjs' for `esm`
 */
function extFor(format: 'cjs' | 'esm'): string {
  return format === 'cjs' ? '.cjs' : '.mjs'
}

interface CompileNodeOpts {
  outFile: string
  format: 'cjs' | 'esm'
  devUrl: string
}

/**
 * Compile a Node-target entry (Electron main or preload) into a single output file for development.
 *
 * Injects environment defines (including `__ELECTRON__`, `__NASTI_TARGET__`, and `__NASTI_DEV_SERVER_URL__`), applies source transforms, and writes a bundled file using rolldown.
 *
 * @param config - Resolved Nasti configuration used for transforms and plugin resolution
 * @param entry - Path to the entry file to bundle
 * @param opts - Compilation options
 * @param opts.outFile - Destination path for the bundled output
 * @param opts.format - Output module format, either `'cjs'` or `'esm'`
 * @param opts.devUrl - Dev server URL injected into the bundle as `__NASTI_DEV_SERVER_URL__`
 */
async function compileNode(config: ResolvedConfig, entry: string, opts: CompileNodeOpts): Promise<void> {
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = {
    ...buildEnvDefine(env, config.mode),
    __ELECTRON__: 'true',
    __NASTI_TARGET__: JSON.stringify('electron'),
    __NASTI_DEV_SERVER_URL__: JSON.stringify(opts.devUrl),
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
    transform: { define: envDefine },
    platform: 'node',
    plugins: [oxcTransformPlugin, electronPlugin(config), resolvePlugin(config)] as any,
  })
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true })
  await bundle.write({
    file: opts.outFile,
    format: opts.format === 'cjs' ? 'cjs' : 'esm',
    sourcemap: false,
    minify: false,
    // rolldown 已弃用 inlineDynamicImports，改用 codeSplitting:false 表达
    // 同样语义（单 chunk、内联 dynamic import）
    codeSplitting: false,
  })
  await bundle.close()
}

/**
 * Locate the Electron executable for the given project configuration.
 *
 * Checks `config.electron.electronPath` first (returns it if the file exists), otherwise attempts to resolve the `electron` package export from the project's dependencies and returns that path if it exists.
 *
 * @param config - Resolved project configuration used to determine project root and configured Electron path
 * @returns The file system path to the Electron executable if found, `null` otherwise
 */
function resolveElectronBinary(config: ResolvedConfig): string | null {
  if (config.electron.electronPath && fs.existsSync(config.electron.electronPath)) {
    return config.electron.electronPath
  }
  try {
    const require = createRequire(path.resolve(config.root, 'package.json'))
    // electron 包导出其可执行文件路径
    const pathFile = require.resolve('electron')
    const electronModule = require(pathFile)
    if (typeof electronModule === 'string' && fs.existsSync(electronModule)) {
      return electronModule
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Emit console warnings when Electron is missing or its installed version is lower than configured.
 *
 * @param config - Resolved configuration containing the project root and `electron.minVersion` to check against
 */
function warnElectronVersion(config: ResolvedConfig): void {
  const installed = detectInstalledElectron(config.root)
  if (installed === null) {
    console.warn(
      pc.yellow(
        `  ⚠ 未检测到 Electron，请安装：npm install -D electron@^${config.electron.minVersion}`,
      ),
    )
    return
  }
  if (installed < config.electron.minVersion) {
    console.warn(
      pc.yellow(
        `  ⚠ Electron ${installed} 低于 Nasti 要求的 ${config.electron.minVersion}，某些特性（如 ESM 主进程）不可用。`,
      ),
    )
  }
}
