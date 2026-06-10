// 生产构建 - 多环境 builder（NASTI_2.0_PLAN.md §2.4）
//
// `build()` 串行迭代 config.environments：client（入口从 index.html 提取，
// 含 HTML 改写 / CSS 抽取 / 体积表）+ 所有显式声明 entry 的非 client 环境
// （SSR / worker 等：node conditions、platform node、bare import 外部化、
// `import.meta.env.SSR` 由 consumer 派生）。
// `getRolldownOptions(environment)` 把 per-env 的 rolldown input/output
// 参数化收敛到一处 —— Phase 3 的完整打包模式（DevEngine）复用同一函数。
import path from 'node:path'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import { rolldown } from 'rolldown'
import type { InputOptions, OutputOptions } from 'rolldown'
import type { NastiConfig, HtmlTagDescriptor, ResolvedConfig, NastiPlugin } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { resolvePluginList } from '../plugins/builtins.js'
import { NastiEnvironment } from '../core/environment.js'
import { createCssEngine, type CssEngine } from '../core/css-engine.js'
import { htmlPlugin, readHtmlFile, processHtml } from '../plugins/html.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine, ssrDefineOverrides } from '../core/env.js'
import { PluginContainer } from '../core/plugin-container.js'
import { tryNativeReporterPlugin, reportBuildOutput, warnLargeChunks, displaySize } from './reporter.js'
import { createDebugger } from '../core/debug.js'
import pc from 'picocolors'

const debug = createDebugger('nasti:build')

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

export interface BuildResult {
  /** client 环境的产物（back-compat：1.x 的 BuildResult 形态） */
  output: Array<{ fileName: string; type: string; code?: string; source?: Uint8Array | string }>
  /** 全部已构建环境的产物（2.0 多环境 builder） */
  environments?: Record<string, BuildResult['output']>
}

/**
 * 把单个环境的 rolldown input/output 选项收敛到一处（Phase 3 DevEngine 复用）。
 * - input：user rolldownOptions 透传 + per-env platform/resolve/external/define
 * - output：默认命名 + user output 覆盖 + dir 由 Nasti 强制
 */
export function getRolldownOptions(
  environment: NastiEnvironment,
  entryPoints: string[],
  rolldownPlugins: unknown[],
): { inputOptions: InputOptions; outputOptions: OutputOptions; outDir: string } {
  const config = environment.config
  const envOptions = environment.options
  const isServer = environment.consumer === 'server'
  const outDir = path.resolve(config.root, envOptions.build.outDir)

  // Rolldown 1.x 把 `define` 从顶层 InputOptions 移到了 `transform.define`，
  // 顶层传入会触发 "Invalid key" 警告并静默丢弃。
  const { output: userOutput, transform: userTransform, ...restInputOptions } =
    envOptions.build.rolldownOptions

  // Vue（esm-bundler 构建）的编译期常量：最低优先级，允许用户覆盖
  const vueDefine: Record<string, string> = config.framework === 'vue'
    ? {
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      }
    : {}
  // per-env define 钩子：import.meta.env.SSR 由 consumer 派生
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = buildEnvDefine(env, config.mode, ssrDefineOverrides(environment.consumer))
  const mergedDefine = { ...vueDefine, ...(userTransform?.define ?? {}), ...envDefine }

  const inputOptions: InputOptions = {
    ...restInputOptions,
    input: entryPoints,
    transform: { ...userTransform, define: mergedDefine },
    plugins: rolldownPlugins as InputOptions['plugins'],
    ...(isServer
      ? {
          platform: (restInputOptions as InputOptions).platform ?? 'node',
          resolve: {
            conditionNames: envOptions.resolve.conditions,
            mainFields: envOptions.resolve.mainFields,
            ...(restInputOptions as InputOptions).resolve,
          },
          // server 产物：node 内建恒外部化；bare specifier 默认外部化
          //（同 Vite ssr.external 默认 —— 依赖由 node_modules 运行时解析），
          // 相对/绝对/虚拟模块照常打包。需要内联依赖时经 rolldownOptions.external 覆盖。
          external:
            (restInputOptions as InputOptions).external ??
            ((id: string) => {
              if (NODE_BUILTINS.has(id)) return true
              return !id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('\0')
            }),
        }
      : {}),
  }

  const outputOptions: OutputOptions = isServer
    ? {
        format: 'esm',
        sourcemap: !!envOptions.build.sourcemap,
        minify: !!envOptions.build.minify,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
        ...userOutput,
        dir: outDir,
      }
    : {
        format: 'esm',
        sourcemap: !!envOptions.build.sourcemap,
        minify: !!envOptions.build.minify,
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
        // 用户可覆盖默认输出：代码拆分（advancedChunks / codeSplitting）、chunk 命名等
        ...userOutput,
        // dir 始终由 Nasti 掌管 —— HTML 改写依赖固定的产物目录，故放在最后强制生效
        dir: outDir,
      }

  return { inputOptions, outputOptions, outDir }
}

/** Nasti 插件 → Rolldown 插件的转发表（output 阶段钩子直接转发，
 * this.emitFile / this.getFileName 在 renderChunk 中是真实 Rollup 兼容上下文） */
function toRolldownPlugins(plugins: NastiPlugin[]): unknown[] {
  return plugins.map((p) => ({
    name: p.name,
    resolveId: p.resolveId as any,
    load: p.load as any,
    transform: p.transform as any,
    buildStart: p.buildStart as any,
    buildEnd: p.buildEnd as any,
    // closeBundle 在 bundle.close() 时触发 —— PWA manifest/SW 等终态产物依赖
    closeBundle: p.closeBundle as any,
    renderChunk: p.renderChunk as any,
    augmentChunkHash: p.augmentChunkHash as any,
    generateBundle: p.generateBundle as any,
  }))
}

/** 从 index.html 提取 client 入口（含常见路径回退） */
function resolveClientEntries(config: ResolvedConfig, html: string | null): string[] {
  const entryPoints: string[] = []
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
    const fallbackEntries = ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/index.ts', 'src/index.tsx', 'src/index.js']
    for (const entry of fallbackEntries) {
      const fullPath = path.resolve(config.root, entry)
      if (fs.existsSync(fullPath)) {
        entryPoints.push(fullPath)
        break
      }
    }
  }
  return entryPoints
}

/** 单个环境的 oxc 转译插件（TS/JSX，consumer 无关） */
function createOxcTransformPlugin(config: ResolvedConfig, environment: NastiEnvironment) {
  return {
    name: 'nasti:oxc-transform',
    transform(code: string, id: string) {
      if (!shouldTransform(id)) return null
      const result = transformCode(id, code, {
        sourcemap: !!environment.options.build.sourcemap,
        jsxRuntime: 'automatic',
        jsxImportSource: config.framework === 'vue' ? 'vue' : 'react',
      })
      return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
    },
  }
}

export async function build(inlineConfig: NastiConfig = {}): Promise<BuildResult> {
  const config = await resolveConfig(inlineConfig, 'build')
  const logger = config.logger
  const startTime = performance.now()

  logger.info(
    pc.cyan(`\nnasti v${__NASTI_VERSION__} `) + pc.green(`building for ${config.mode}...`),
  )
  debug?.(`root: ${config.root}`)

  // 待构建环境：client 恒在；非 client 仅当显式声明 entry（默认注入的裸 ssr 不构建）
  const buildableNames = Object.keys(config.environments).filter(
    (name) => name === 'client' || config.environments[name].entry.length > 0,
  )
  // client 先行（主产物 / HTML），其余按声明顺序串行（同 Vite buildApp 默认）
  buildableNames.sort((a, b) => (a === 'client' ? -1 : b === 'client' ? 1 : 0))

  const environments: Record<string, BuildResult['output']> = {}
  let clientOutput: BuildResult['output'] = []

  for (const name of buildableNames) {
    const output =
      name === 'client'
        ? await buildClientEnvironment(config)
        : await buildServerEnvironment(config, name)
    environments[name] = output
    if (name === 'client') clientOutput = output
    if (buildableNames.length > 1) {
      debug?.(`environment "${name}" built (${output.length} files)`)
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
  const totalSize = Object.values(environments)
    .flat()
    .reduce((sum, chunk) => {
      const content = chunk.type === 'chunk' ? chunk.code : (chunk as any).source
      if (content == null) return sum
      return sum + (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength)
    }, 0)
  const fileCount = Object.values(environments).flat().length
  const envSuffix =
    buildableNames.length > 1 ? ` (${buildableNames.join(' + ')})` : ''

  logger.info(pc.green(`✓ built in ${elapsed}s`) + pc.dim(envSuffix))
  logger.info(pc.dim(`  ${fileCount} files, ${displaySize(totalSize)} total → ${config.build.outDir}/`))

  return { output: clientOutput, environments }
}

/** client 环境构建：HTML 入口 + CSS 抽取 + 体积表 + index.html 改写 */
async function buildClientEnvironment(config: ResolvedConfig): Promise<BuildResult['output']> {
  const logger = config.logger
  const outDir = path.resolve(config.root, config.build.outDir)

  // 清空输出目录
  if (config.build.emptyOutDir && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  const html = await readHtmlFile(config.root)
  const entryPoints = resolveClientEntries(config, html)
  if (entryPoints.length === 0) {
    throw new Error('No entry point found. Add a <script> tag to index.html or create src/main.ts')
  }

  // per-env 插件列表 + applyToEnvironment 过滤
  const cssEngine = createCssEngine()
  const pluginList = resolvePluginList(config, config.plugins, { cssEngine })
  const clientEnv = new NastiEnvironment('client', { ...config, plugins: pluginList }, {
    mode: 'build',
    plugins: pluginList,
  })
  await clientEnv.init()
  const allPlugins = clientEnv.plugins

  // 运行插件的 buildStart 钩子，并收集 emitFile 输出文件
  const pluginContainer = new PluginContainer(config)
  await pluginContainer.buildStart()

  // 原生体积报告插件（守卫导入；不可用时走 JS 表格 fallback）
  const nativeReporter = config.logLevel === 'silent'
    ? null
    : await tryNativeReporterPlugin(config, logger)

  const rolldownPlugins = [
    createOxcTransformPlugin(config, clientEnv),
    ...toRolldownPlugins(allPlugins),
    ...(nativeReporter ? [nativeReporter as any] : []),
  ]
  const { inputOptions, outputOptions } = getRolldownOptions(clientEnv, entryPoints, rolldownPlugins)

  const bundle = await rolldown(inputOptions)
  const { output } = await bundle.write(outputOptions)
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

    // 执行 transformIndexHtml 钩子：用户插件 + 内置 htmlPlugin
    const htmlPlugins = [...allPlugins.filter((p) => p.transformIndexHtml), htmlPlugin(config)]
    for (const p of htmlPlugins) {
      const result = await p.transformIndexHtml!(processedHtml)
      if (typeof result === 'string') {
        processedHtml = result
      } else if (result && 'html' in result) {
        processedHtml = processHtml(result.html, result.tags)
      } else if (Array.isArray(result)) {
        processedHtml = processHtml(processedHtml, result)
      }
    }

    // 注入抽取出的 CSS：entry chunk 的 css → 静态 <link rel="stylesheet">
    processedHtml = injectCssLinks(processedHtml, cssEngine, config)

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

  // 体积表：原生 reporter 已在 write 阶段输出；否则走 JS fallback
  if (!nativeReporter && config.logLevel !== 'silent') {
    reportBuildOutput(output as any, config, logger)
  }
  // 大 chunk 警告始终走 logger.warn（原生 reporter 的 warnLargeChunks 已关闭）
  warnLargeChunks(output as any, config, logger)

  return output as any
}

/** 非 client 环境构建（SSR / worker / main / preload …）：entry 显式声明 */
async function buildServerEnvironment(
  config: ResolvedConfig,
  name: string,
): Promise<BuildResult['output']> {
  const envOptions = config.environments[name]
  const logger = config.logger

  for (const entry of envOptions.entry) {
    if (!fs.existsSync(entry)) {
      throw new Error(`[nasti] environment "${name}" entry not found: ${entry}`)
    }
  }

  const pluginList = resolvePluginList(config, config.plugins, { consumer: envOptions.consumer })
  const environment = new NastiEnvironment(name, { ...config, plugins: pluginList }, {
    mode: 'build',
    plugins: pluginList,
  })
  await environment.init()

  const rolldownPlugins = [
    createOxcTransformPlugin(config, environment),
    ...toRolldownPlugins(environment.plugins),
  ]
  const { inputOptions, outputOptions, outDir } = getRolldownOptions(
    environment,
    envOptions.entry,
    rolldownPlugins,
  )

  if (envOptions.build.emptyOutDir && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  const bundle = await rolldown(inputOptions)
  const { output } = await bundle.write(outputOptions)
  await bundle.close()

  logger.info(
    pc.dim(`  [${name}] `) +
      output.map((o) => path.join(envOptions.build.outDir, o.fileName)).join(pc.dim(', ')),
  )
  return output as any
}

/** 注入抽取出的 CSS link 标签（entry css 或单文件模式） */
function injectCssLinks(html: string, cssEngine: CssEngine, config: ResolvedConfig): string {
  const cssLinkTags: HtmlTagDescriptor[] = []
  if (cssEngine.singleFileName) {
    cssLinkTags.push({
      tag: 'link',
      attrs: { rel: 'stylesheet', href: config.base + cssEngine.singleFileName },
      injectTo: 'head',
    })
  } else {
    for (const files of cssEngine.entryCss.values()) {
      for (const file of files) {
        cssLinkTags.push({
          tag: 'link',
          attrs: { rel: 'stylesheet', href: config.base + file },
          injectTo: 'head',
        })
      }
    }
  }
  return cssLinkTags.length > 0 ? processHtml(html, cssLinkTags) : html
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
