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
import { assertElectronVersion, detectInstalledElectron, normalizePreload } from '../build/electron.js'
import { bundleElectronNode } from '../build/electron-node.js'

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
  const server = await createServer({
    ...rest,
    target: 'electron',
    framework: config.framework,
  })
  await server.listen()

  const devUrl =
    `http://localhost:${server.config.server.port}` +
    electronRendererDevPath(config.electron.renderer)
  console.log(pc.dim(`  renderer: ${devUrl}`))

  // 2. 编译主进程 + preload 到 .nasti/
  const stageDir = path.resolve(config.root, '.nasti')
  fs.mkdirSync(stageDir, { recursive: true })

  const mainEntry = path.resolve(config.root, config.electron.main)
  const preloadEntries = normalizePreload(config.electron.preload, config.root)

  const builtMainFile = path.join(stageDir, 'main' + extFor(config.electron.mainFormat))
  let watchTargets = [mainEntry, ...preloadEntries]

  const compileAll = async () => {
    const files = new Set([mainEntry, ...preloadEntries])
    for (const file of await bundleElectronNode(config, mainEntry, {
      outFile: builtMainFile,
      format: config.electron.mainFormat,
      devUrl,
    })) files.add(file)
    for (const entry of preloadEntries) {
      if (!fs.existsSync(entry)) continue
      const base = path.basename(entry).replace(/\.[^.]+$/, '')
      const out = path.join(stageDir, base + extFor(config.electron.preloadFormat))
      for (const file of await bundleElectronNode(config, entry, {
        outFile: out,
        format: config.electron.preloadFormat,
        devUrl,
      })) files.add(file)
    }
    watchTargets = [...files]
  }

  try {
    await compileAll()
  } catch (error) {
    await server.close()
    throw error
  }

  if (noSpawn) {
    console.log(pc.dim('  (noSpawn) 已编译主/preload，跳过启动 Electron。'))
    await server.close()
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
    await server.close()
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

  // 4. 监听主/preload 变化并重启
  if (config.electron.autoRestart) {
    let watched = new Set(watchTargets)
    let rebuildFailed = false
    const ignoredDirs = [stageDir, path.resolve(config.root, config.build.outDir), path.join(config.root, '.git')]
    // root 只用于失败后的源码恢复；正常编辑仅响应当前主/preload 依赖图，
    // renderer HMR 不会因此触发 Electron 重启。避免扫描依赖树和自生成的输出。
    const watcher = chokidar.watch([config.root, ...watchTargets], {
      ignoreInitial: true,
      ignored(file) {
        const absolute = path.resolve(file)
        return ignoredDirs.some((dir) => absolute === dir || absolute.startsWith(dir + path.sep)) ||
          (absolute.split(path.sep).includes('node_modules') && !watched.has(absolute))
      },
    })
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
          try {
            await compileAll()
            rebuildFailed = false
            // 编译成功后才结束旧进程，失败时继续运行上一次已加载的应用。
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
            const next = new Set(watchTargets)
            const added = [...next].filter((file) => !watched.has(file))
            // root 已覆盖的路径保留目录监听，才能从新 import 缺文件的错误中恢复。
            const removed = [...watched].filter((file) =>
              !next.has(file) && !file.startsWith(config.root + path.sep))
            watched = next
            watcher.add(added)
            await watcher.unwatch(removed)
            spawnElectron()
          } catch (e: any) {
            rebuildFailed = true
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
    watcher.on('all', (_event, file) => {
      const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx|json)$/.test(file)
      if (!watched.has(path.resolve(file)) && !(rebuildFailed && sourceFile)) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void restart()
      }, 80)
    })
    // 先建立监听再启动应用，避免启动后的第一笔导入模块变更落在初始化窗口内。
    try {
      await new Promise<void>((resolve, reject) => {
        watcher.once('ready', resolve)
        watcher.once('error', reject)
      })
    } catch (error) {
      await watcher.close()
      await server.close()
      throw error
    }
  }
  spawnElectron()
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

/** 将 renderer HTML 路径转换为 Electron 开发服务器 URL path。 */
export function electronRendererDevPath(renderer: string): string {
  const normalized = renderer
    .split(path.sep)
    .join('/')
    .replace(/^\.?\//, '')
  return normalized === 'index.html' ? '/' : `/${normalized}`
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
  assertElectronVersion(config)
  const installed = detectInstalledElectron(config.root)
  if (installed === null) {
    console.warn(
      pc.yellow(
        `  ⚠ 未检测到 Electron，请安装：npm install -D electron@^${config.electron.minVersion}`,
      ),
    )
    return
  }
}
