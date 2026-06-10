// 构建产物体积报告
// 优先使用 rolldown/experimental 的原生 viteReporterPlugin（Vite 8 同款表格），
// 实验 API 无 semver 保护 —— 守卫导入，失败时回退到 JS 实现。
// 大 chunk 警告始终走 JS 路径（logger.warn），保证 logLevel=warn 时不被吞。
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import pc from 'picocolors'
import type { ResolvedConfig } from '../types.js'
import type { Logger } from '../core/logger.js'
import { createDebugger } from '../core/debug.js'

const debug = createDebugger('nasti:reporter')

export interface OutputFileInfo {
  fileName: string
  type: string
  code?: string
  source?: Uint8Array | string
}

/**
 * 尝试创建原生体积报告插件（Rust 实现，gzip 并行计算）。
 * 返回 null 表示当前 rolldown 版本不提供该实验导出，调用方应改用
 * {@link reportBuildOutput} 的 JS 表格。
 */
export async function tryNativeReporterPlugin(
  config: ResolvedConfig,
  logger: Logger,
): Promise<unknown | null> {
  try {
    const { viteReporterPlugin } = await import('rolldown/experimental')
    if (typeof viteReporterPlugin !== 'function') return null
    return viteReporterPlugin({
      root: config.root,
      isTty: process.stdout.isTTY ?? false,
      isLib: false,
      assetsDir: config.build.assetsDir,
      chunkLimit: config.build.chunkSizeWarningLimit,
      // 大 chunk 警告由 JS 侧 warnLargeChunks() 经 logger.warn 输出，
      // 原生侧只产 info 级表格，避免警告被 logLevel 过滤吞掉
      warnLargeChunks: false,
      reportCompressedSize: config.build.reportCompressedSize,
      logInfo: (msg: string) => logger.info(msg),
    })
  } catch (err) {
    debug?.(`native viteReporterPlugin unavailable, falling back to JS table: ${err}`)
    return null
  }
}

const numberFormatter = new Intl.NumberFormat('en', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

export function displaySize(bytes: number): string {
  return `${numberFormatter.format(bytes / 1000)} kB`
}

function byteLength(content: string | Uint8Array | undefined): number {
  if (content == null) return 0
  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength
}

/** JS fallback：打印 Vite 形态的产物体积表（gzip 可经 reportCompressedSize 关闭） */
export function reportBuildOutput(
  output: OutputFileInfo[],
  config: ResolvedConfig,
  logger: Logger,
): void {
  type Entry = { name: string; size: number; gzip: number | null; group: 'assets' | 'css' | 'js' }
  const entries: Entry[] = []
  const compressed = config.build.reportCompressedSize

  for (const file of output) {
    const content = file.type === 'chunk' ? file.code : file.source
    const size = byteLength(content)
    let gzip: number | null = null
    if (compressed && content != null) {
      gzip = gzipSync(typeof content === 'string' ? Buffer.from(content) : content).byteLength
    }
    const ext = path.extname(file.fileName)
    const group: Entry['group'] =
      file.type === 'chunk' ? 'js' : ext === '.css' ? 'css' : 'assets'
    entries.push({ name: file.fileName, size, gzip, group })
  }

  // 同 Vite：assets → css → js，组内按体积升序
  const groupOrder = { assets: 0, css: 1, js: 2 } as const
  entries.sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || a.size - b.size)

  const outDirPrefix = `${config.build.outDir.replace(/\/$/, '')}/`
  const maxNameLen = Math.max(...entries.map((e) => (outDirPrefix + e.name).length), 0)
  const maxSizeLen = Math.max(...entries.map((e) => displaySize(e.size).length), 0)

  const groupColor = { assets: pc.green, css: pc.magenta, js: pc.cyan } as const
  for (const e of entries) {
    const color = groupColor[e.group]
    const namePart = pc.dim(outDirPrefix) + color(e.name.padEnd(maxNameLen - outDirPrefix.length))
    const sizePart = pc.dim(pc.bold(displaySize(e.size).padStart(maxSizeLen)))
    const gzipPart = e.gzip != null ? pc.dim(` │ gzip: ${displaySize(e.gzip)}`) : ''
    logger.info(`${namePart} ${sizePart}${gzipPart}`)
  }
}

/** 大 chunk 警告（独立于表格渲染路径，始终经 logger.warn 输出） */
export function warnLargeChunks(
  output: OutputFileInfo[],
  config: ResolvedConfig,
  logger: Logger,
): void {
  const limit = config.build.chunkSizeWarningLimit
  const large = output.filter(
    (f) => f.type === 'chunk' && byteLength(f.code) / 1000 > limit,
  )
  if (large.length === 0) return
  logger.warn(
    pc.yellow(
      `\n(!) Some chunks are larger than ${limit} kB after minification. Consider:\n` +
        `- Using dynamic import() to code-split the application\n` +
        `- Configuring build.rolldownOptions.output.advancedChunks to isolate large dependencies\n` +
        `- Adjusting build.chunkSizeWarningLimit to silence this warning`,
    ),
  )
}
