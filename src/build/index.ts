// 生产构建 - 调用 Rolldown API 打包
import path from 'node:path'
import fs from 'node:fs'
import { rolldown } from 'rolldown'
import type { NastiConfig } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { cssPlugin } from '../plugins/css.js'
import { assetsPlugin } from '../plugins/assets.js'
import { vuePlugin } from '../plugins/vue.js'
import { htmlPlugin, readHtmlFile, processHtml } from '../plugins/html.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine } from '../core/env.js'
import { PluginContainer } from '../core/plugin-container.js'
import { tryNativeReporterPlugin, reportBuildOutput, warnLargeChunks, displaySize } from './reporter.js'
import { createDebugger } from '../core/debug.js'
import pc from 'picocolors'

const debug = createDebugger('nasti:build')

export interface BuildResult {
  output: Array<{ fileName: string; type: string; code?: string; source?: Uint8Array | string }>
}

export async function build(inlineConfig: NastiConfig = {}): Promise<BuildResult> {
  const config = await resolveConfig(inlineConfig, 'build')
  const logger = config.logger
  const startTime = performance.now()

  logger.info(
    pc.cyan(`\nnasti v${__NASTI_VERSION__} `) + pc.green(`building for ${config.mode}...`),
  )
  debug?.(`root: ${config.root}`)

  const outDir = path.resolve(config.root, config.build.outDir)

  // 清空输出目录
  if (config.build.emptyOutDir && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  // 查找 HTML 入口中的 script 标签作为 entry
  const html = await readHtmlFile(config.root)
  let entryPoints: string[] = []

  if (html) {
    const scriptMatches = html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)
    for (const match of scriptMatches) {
      const src = match[1]
      if (src && !src.startsWith('http')) {
        entryPoints.push(path.resolve(config.root, src.replace(/^\//, '')))
      }
    }
  }

  if (entryPoints.length === 0) {
    // 回退: 尝试常见入口
    const fallbackEntries = ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/index.ts', 'src/index.tsx', 'src/index.js']
    for (const entry of fallbackEntries) {
      const fullPath = path.resolve(config.root, entry)
      if (fs.existsSync(fullPath)) {
        entryPoints.push(fullPath)
        break
      }
    }
  }

  if (entryPoints.length === 0) {
    throw new Error('No entry point found. Add a <script> tag to index.html or create src/main.ts')
  }

  // 构建内置插件 + 用户插件作为 Rolldown 插件
  // vuePlugin 需排在最前（enforce: 'pre' 语义）：先把 .vue 编译成 JS，再交给后续插件。
  const builtinPlugins = [
    ...(config.framework === 'vue' ? [vuePlugin(config)] : []),
    resolvePlugin(config),
    cssPlugin(config),
    assetsPlugin(config),
  ]
  const allPlugins = [...builtinPlugins, ...config.plugins]

  // 运行插件的 buildStart 钩子，并收集 emitFile 输出文件
  const pluginContainer = new PluginContainer(config)
  await pluginContainer.buildStart()

  // oxc-transform 插件（作为 Rolldown 插件）
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

  // 加载环境变量并生成 define 替换表
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = buildEnvDefine(env, config.mode)

  // 调用 Rolldown
  // Rolldown 1.x 把 `define` 从顶层 InputOptions 移到了 `transform.define`，
  // 顶层传入会触发 "Invalid key: Expected never but received 'define'" 警告并
  // 静默丢弃 —— 导致 `import.meta.env.*` 不被替换。
  //
  // 从 build.rolldownOptions 拆出 output（合并进 bundle.write()）与 transform
  // （需与 envDefine 合并），其余 input 选项（treeshake / resolve / external / platform 等）
  // 随 restInputOptions 透传给 rolldown()。Nasti 自管的 input / transform / plugins
  // 显式放在 spread 之后，确保始终覆盖用户传入的同名键。
  const { output: userOutput, transform: userTransform, ...restInputOptions } =
    config.build.rolldownOptions
  // 合并用户的 transform.define 和 envDefine，确保 envDefine 优先级更高
  // Vue（esm-bundler 构建）需要在打包期定义这些编译期常量，否则运行时会告警，
  // 且无法对 options API / devtools 分支做 tree-shaking。放在最低优先级，允许用户覆盖。
  const vueDefine: Record<string, string> = config.framework === 'vue'
    ? {
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      }
    : {}
  const mergedDefine = { ...vueDefine, ...(userTransform?.define ?? {}), ...envDefine }

  // 原生体积报告插件（rolldown/experimental，守卫导入；不可用时走 JS 表格 fallback）
  const nativeReporter = config.logLevel === 'silent'
    ? null
    : await tryNativeReporterPlugin(config, logger)

  const bundle = await rolldown({
    ...restInputOptions,
    input: entryPoints,
    transform: { ...userTransform, define: mergedDefine },
    plugins: [
      oxcTransformPlugin,
      // 转换 Nasti 插件为 Rolldown 插件格式
      ...allPlugins.map((p) => ({
        name: p.name,
        resolveId: p.resolveId as any,
        load: p.load as any,
        transform: p.transform as any,
        buildStart: p.buildStart as any,
        buildEnd: p.buildEnd as any,
        // Forward `closeBundle` to Rolldown — it invokes the hook during
        // `bundle.close()` below. This is the hook Vite plugins (e.g. PWA
        // manifest/SW writers) rely on for final-stage artifact emission.
        closeBundle: p.closeBundle as any,
        // Output 阶段钩子直接转发：Rolldown 会以真实的（Rollup 兼容）插件
        // 上下文调用，this.emitFile / this.getFileName 在 renderChunk 中可用
        // —— CSS per-chunk 抽取（css-post）依赖这一点。
        renderChunk: p.renderChunk as any,
        augmentChunkHash: p.augmentChunkHash as any,
      })),
      ...(nativeReporter ? [nativeReporter as any] : []),
    ],
  })

  const { output } = await bundle.write({
    format: 'esm',
    sourcemap: !!config.build.sourcemap,
    minify: !!config.build.minify,
    entryFileNames: 'assets/[name].[hash].js',
    chunkFileNames: 'assets/[name].[hash].js',
    assetFileNames: 'assets/[name].[hash][extname]',
    // 用户可覆盖默认输出：代码拆分（advancedChunks / codeSplitting）、chunk 命名等
    ...userOutput,
    // dir 始终由 Nasti 掌管 —— 下方 HTML 改写依赖固定的产物目录，故放在最后强制生效
    dir: outDir,
  })

  await bundle.close()
  await pluginContainer.buildEnd()

  // 将 emitFile 产出的文件写入输出目录
  for (const ef of pluginContainer.getEmittedFiles()) {
    const dest = path.resolve(outDir, ef.fileName)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, ef.source)
  }

  // 处理 HTML
  if (html) {
    let processedHtml = html

    // 执行插件的 transformIndexHtml 钩子
    const htmlPlugin_ = htmlPlugin(config)
    if (htmlPlugin_.transformIndexHtml) {
      const result = await htmlPlugin_.transformIndexHtml(processedHtml)
      if (typeof result === 'string') {
        processedHtml = result
      } else if (result && 'html' in result) {
        processedHtml = processHtml(result.html, result.tags)
      } else if (Array.isArray(result)) {
        processedHtml = processHtml(processedHtml, result)
      }
    }

    // 替换 script src 为打包后的路径（支持多入口）
    for (const chunk of output) {
      if (chunk.type === 'chunk' && chunk.isEntry && chunk.facadeModuleId) {
        const originalEntry = path.relative(config.root, chunk.facadeModuleId)
        processedHtml = processedHtml.replace(
          new RegExp(`(src=["'])/?(${escapeRegExp(originalEntry)})(["'])`, 'g'),
          `$1${config.base}${chunk.fileName}$3`,
        )
      }
    }

    fs.writeFileSync(path.resolve(outDir, 'index.html'), processedHtml)
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)

  // 体积表：原生 reporter 已在 write 阶段输出；否则走 JS fallback
  if (!nativeReporter && config.logLevel !== 'silent') {
    reportBuildOutput(output as any, config, logger)
  }
  // 大 chunk 警告始终走 logger.warn（原生 reporter 的 warnLargeChunks 已关闭）
  warnLargeChunks(output as any, config, logger)

  // 体积合计：chunk 按 code、asset 按 source，统一 Buffer.byteLength
  // （旧实现只算 chunk.code.length，漏掉全部 assets 且多字节字符算错）
  const totalSize = output.reduce((sum, chunk) => {
    const content = chunk.type === 'chunk' ? chunk.code : (chunk as any).source
    if (content == null) return sum
    return sum + (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength)
  }, 0)

  logger.info(pc.green(`✓ built in ${elapsed}s`))
  logger.info(pc.dim(`  ${output.length} files, ${displaySize(totalSize)} total → ${config.build.outDir}/`))

  return { output: output as any }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
