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
import type {
  AppBuildOutput,
  EnvironmentBuildOutput,
  EnvironmentBuildResult,
  NastiConfig,
  HtmlTagDescriptor,
  ResolvedConfig,
  NastiPlugin,
} from '../types.js'
import { resolveConfig } from '../config/index.js'
import { resolvePluginList } from '../plugins/builtins.js'
import { NastiEnvironment } from '../core/environment.js'
import {
  createCssEngine,
  getCssMetadata,
  type CssEngine,
} from '../core/css-engine.js'
import { htmlPlugin, readHtmlFile, processHtml } from '../plugins/html.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine, ssrDefineOverrides } from '../core/env.js'
import { tryNativeReporterPlugin, reportBuildOutput, warnLargeChunks, displaySize } from './reporter.js'
import { createDebugger } from '../core/debug.js'
import { getPluginApi } from '../core/plugin-api.js'
import {
  createBuildAppContext,
  inferEnvironmentEntries,
  isInvalidEnvironmentFileName,
  joinPublicPath,
  normalizeEnvironmentFileName,
} from '../core/build-app-context.js'
import pc from 'picocolors'

const debug = createDebugger('nasti:build')

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

export interface BuildResult {
  /** client 环境的产物（back-compat：1.x 的 BuildResult 形态） */
  output: EnvironmentBuildOutput[]
  /** 全部已构建环境的产物（2.0 多环境 builder） */
  environments?: Record<string, BuildResult['output']>
  /** 全部环境的完整结果（entries / manifest / stats 等） */
  environmentResults?: Record<string, EnvironmentBuildResult>
  /** app 级 finalizer 聚合写出的产物（如 `.lynx.bundle`） */
  appOutput?: AppBuildOutput[]
}

interface BuiltEnvironment {
  environment: NastiEnvironment
  result: EnvironmentBuildResult
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
  // 产物子目录前缀跟随 build.assetsDir（默认 'assets'）—— 与 assets 插件、
  // 体积报告器使用同一来源，避免 JS/资源散落到不同目录
  const assetsDir = envOptions.build.assetsDir

  // Rolldown 1.x 把 `define` 从顶层 InputOptions 移到了 `transform.define`，
  // 顶层传入会触发 "Invalid key" 警告并静默丢弃。
  const {
    output: userOutput,
    transform: userTransform,
    resolve: userResolve,
    ...restInputOptions
  } = envOptions.build.rolldownOptions

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
    transform: {
      ...userTransform,
      target: userTransform?.target ?? envOptions.build.target,
      define: mergedDefine,
    },
    plugins: rolldownPlugins as InputOptions['plugins'],
    // client/server consumer 都必须使用当前环境的 conditions/mainFields；Lynx
    // BG/MT 通常同为 client consumer，但仍可能声明不同的运行时条件。
    resolve: {
      ...(userResolve ?? {}),
      // Environment API 是条件解析的唯一高层入口，优先于继承来的底层选项。
      conditionNames: envOptions.resolve.conditions,
      mainFields: envOptions.resolve.mainFields,
    },
    ...(isServer
      ? {
          platform: (restInputOptions as InputOptions).platform ?? 'node',
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
        sourcemap: envOptions.build.sourcemap,
        minify: !!envOptions.build.minify,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: `${assetsDir}/[name].[hash][extname]`,
        ...userOutput,
        dir: outDir,
      }
    : {
        format: 'esm',
        sourcemap: envOptions.build.sourcemap,
        minify: !!envOptions.build.minify,
        entryFileNames: `${assetsDir}/[name].[hash].js`,
        chunkFileNames: `${assetsDir}/[name].[hash].js`,
        assetFileNames: `${assetsDir}/[name].[hash][extname]`,
        // 用户可覆盖默认输出：代码拆分（advancedChunks / codeSplitting）、chunk 命名等
        ...userOutput,
        // dir 始终由 Nasti 掌管 —— HTML 改写依赖固定的产物目录，故放在最后强制生效
        dir: outDir,
      }

  return { inputOptions, outputOptions, outDir }
}

/**
 * Nasti 插件 → Rolldown 插件转发表。包装器保留 Rolldown 的真实插件上下文，
 * 同时注入当前 Nasti environment，供同为 client consumer 的 BG/MT 管线区分彼此。
 */
export function toRolldownPlugins(
  plugins: NastiPlugin[],
  environment: NastiEnvironment,
): unknown[] {
  const wrap = (hook: ((this: any, ...args: any[]) => any) | undefined) => {
    if (!hook) return hook
    return function (this: any, ...args: any[]) {
      return hook.apply(attachEnvironment(this, environment), args)
    }
  }

  return plugins.map((p) => ({
    name: p.name,
    resolveId: wrap(p.resolveId as any),
    load: wrap(p.load as any),
    transform: wrap(p.transform as any),
    buildStart: wrap(p.buildStart as any),
    buildEnd: wrap(p.buildEnd as any),
    // closeBundle 在 bundle.close() 时触发 —— PWA manifest/SW 等终态产物依赖
    closeBundle: wrap(p.closeBundle as any),
    renderChunk: wrap(p.renderChunk as any),
    augmentChunkHash: wrap(p.augmentChunkHash as any),
    generateBundle: wrap(p.generateBundle as any),
  }))
}

function attachEnvironment(context: any, environment: NastiEnvironment): any {
  if (context?.environment === environment) return context
  try {
    Object.defineProperty(context, 'environment', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: environment,
    })
    return context
  } catch {
    // 极少数 host context 可能不可扩展；Proxy 保持方法 receiver 指向原上下文。
    return new Proxy(context, {
      get(target, property) {
        if (property === 'environment') return environment
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target)
      },
    })
  }
}

function finalizeEnvironmentResult(
  environment: NastiEnvironment,
  result: EnvironmentBuildResult,
): EnvironmentBuildResult {
  const metadata = environment.getBuildMetadata()
  const inferredEntries = inferEnvironmentEntries(result.output)
  const entries = {
    ...inferredEntries,
    ...metadata.entries,
    ...result.entries,
  }
  const normalizedEntries = Object.fromEntries(
    Object.entries(entries).map(([name, fileName]) => {
      const normalized = normalizeEnvironmentFileName(fileName)
      if (isInvalidEnvironmentFileName(normalized)) {
        throw new Error(
          `[nasti] environment "${environment.name}" returned invalid entry ` +
            `"${name}": ${fileName}`,
        )
      }
      return [name, normalized]
    }),
  )
  const inferredMetadata = inferOutputMetadata(environment, result.output)
  return {
    publicPath: environment.config.base,
    ...inferredMetadata,
    ...metadata,
    ...result,
    output: result.output,
    chunks: {
      ...inferredMetadata.chunks,
      ...metadata.chunks,
      ...result.chunks,
    },
    assets: {
      ...inferredMetadata.assets,
      ...metadata.assets,
      ...result.assets,
    },
    sourceMaps: {
      ...inferredMetadata.sourceMaps,
      ...metadata.sourceMaps,
      ...result.sourceMaps,
    },
    ...(Object.keys(normalizedEntries).length > 0 ? { entries: normalizedEntries } : {}),
  }
}

function inferOutputMetadata(
  environment: NastiEnvironment,
  output: EnvironmentBuildOutput[],
): Pick<EnvironmentBuildResult, 'chunks' | 'assets' | 'sourceMaps'> {
  const chunks: NonNullable<EnvironmentBuildResult['chunks']> = {}
  const assets: NonNullable<EnvironmentBuildResult['assets']> = {}
  const sourceMaps: NonNullable<EnvironmentBuildResult['sourceMaps']> = {}
  const cssChunks = environment.getBuildMetadata().css?.chunks ?? {}
  const assetModules = environment.getAssetModules()
  const publicPath = environment.config.base

  for (const artifact of output) {
    const fileName = normalizeEnvironmentFileName(artifact.fileName)
    if (artifact.map != null) sourceMaps[fileName] = artifact.map
    if (artifact.type === 'chunk') {
      const moduleIds = [...(artifact.moduleIds ?? [])]
      chunks[fileName] = {
        fileName,
        name: artifact.name ?? fileName,
        isEntry: !!artifact.isEntry,
        isDynamicEntry: !!artifact.isDynamicEntry,
        imports: [...(artifact.imports ?? [])],
        dynamicImports: [...(artifact.dynamicImports ?? [])],
        moduleIds,
        css: [...(cssChunks[fileName]?.cssFileNames ?? [])],
        assets: [
          ...new Set(
            moduleIds
              .map((id) => assetModules[id])
              .filter((asset): asset is string => !!asset),
          ),
        ],
      }
    } else if (artifact.type === 'asset') {
      assets[fileName] = {
        fileName,
        names: [...(artifact.names ?? (artifact.name ? [artifact.name] : []))],
        publicPath: joinPublicPath(publicPath, fileName),
      }
    }
  }
  return { chunks, assets, sourceMaps }
}

function prepareBuildOutputDirectories(
  config: ResolvedConfig,
  buildableNames: string[],
): void {
  const directories = new Set<string>()
  const protectedPaths = new Set<string>()
  const clientIsBuilt = buildableNames.includes('client')

  // 没有 Web client 时，app finalizer 仍写入 top-level outDir；必须清理旧聚合产物。
  if (!clientIsBuilt && config.build.emptyOutDir) {
    directories.add(path.resolve(config.root, config.build.outDir))
  }

  for (const name of buildableNames) {
    const environment = config.environments[name]
    const outDir = path.resolve(config.root, environment.build.outDir)
    if (!environment.build.emptyOutDir) {
      protectedPaths.add(outDir)
      continue
    }
    if (!environment.driver) directories.add(outDir)
  }

  const containsPath = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  // 父目录清理一次即可覆盖其子环境目录，防止后构建环境删除前一环境产物。
  const roots = [...directories]
    // 显式 emptyOutDir:false 的环境目录及其内容必须避开祖先目录清理。
    .filter((directory) =>
      ![...protectedPaths].some((protectedPath) => containsPath(directory, protectedPath)),
    )
    .sort((a, b) => a.length - b.length)
    .filter((directory, index, all) =>
      !all.slice(0, index).some((parent) => containsPath(parent, directory)),
    )

  for (const directory of roots) {
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true })
  }
}

function assertDriverBuildResult(
  environment: NastiEnvironment,
  result: unknown,
): asserts result is EnvironmentBuildResult {
  const output = result != null && typeof result === 'object'
    ? (result as { output?: unknown }).output
    : undefined
  const hasValidOutput =
    Array.isArray(output) &&
    output.every(
      (artifact) =>
        artifact != null &&
        typeof artifact === 'object' &&
        typeof artifact.fileName === 'string' &&
        typeof artifact.type === 'string',
    )
  if (!hasValidOutput) {
    throw new Error(
      `[nasti] environment "${environment.name}" driver "${environment.driver?.name}" ` +
        'returned an invalid build result; expected { output: EnvironmentBuildOutput[] }',
    )
  }
}

/** 从 index.html 提取 client 入口（含常见路径回退） */
export function resolveClientEntries(config: ResolvedConfig, html: string | null): string[] {
  const configuredEntries = config.environments.client?.entry ?? []
  if (configuredEntries.length > 0) return configuredEntries

  const entryPoints: string[] = []
  const htmlFile = config.environments.client?.html
  const htmlDir = htmlFile ? path.dirname(htmlFile) : config.root
  if (html) {
    const scriptMatches = html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)
    for (const match of scriptMatches) {
      const src = match[1]
      if (src && !src.startsWith('http')) {
        const cleanSrc = src.split(/[?#]/, 1)[0]
        entryPoints.push(
          cleanSrc.startsWith('/')
            ? path.resolve(config.root, cleanSrc.replace(/^\//, ''))
            : path.resolve(htmlDir, cleanSrc),
        )
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
        target: environment.options.build.target,
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

  // 待构建环境：显式禁用的环境跳过；client 默认构建，非 client 需声明 entry/driver。
  // `client.buildEnabled:false` 允许 Lynx 等纯多环境应用不提供 index.html。
  const buildableNames = Object.keys(config.environments).filter((name) => {
    const environment = config.environments[name]
    if (!environment.buildEnabled) return false
    return name === 'client' || environment.entry.length > 0 || !!environment.driver
  })
  // client 先行（主产物 / HTML），其余按声明顺序串行（同 Vite buildApp 默认）
  buildableNames.sort((a, b) => (a === 'client' ? -1 : b === 'client' ? 1 : 0))
  prepareBuildOutputDirectories(config, buildableNames)

  const environments: Record<string, BuildResult['output']> = {}
  const environmentResults: Record<string, EnvironmentBuildResult> = {}
  const initializedEnvironments: NastiEnvironment[] = []
  const buildAppContext = createBuildAppContext(config, environmentResults)
  let clientOutput: BuildResult['output'] = []
  let buildFailed = false

  try {
    for (const name of buildableNames) {
      const built =
        name === 'client'
          ? await buildClientEnvironment(config)
          : await buildServerEnvironment(config, name)
      initializedEnvironments.push(built.environment)
      environments[name] = built.result.output
      environmentResults[name] = built.result
      if (name === 'client') clientOutput = built.result.output
      if (buildableNames.length > 1) {
        debug?.(`environment "${name}" built (${built.result.output.length} files)`)
      }
    }

    const pluginApi = getPluginApi(config)
    for (const plugin of config.plugins) {
      await plugin.afterBuildApp?.(environmentResults, pluginApi, buildAppContext)
    }
  } catch (error) {
    buildFailed = true
    throw error
  } finally {
    let closeFailed = false
    let firstCloseError: unknown
    for (const environment of [...initializedEnvironments].reverse()) {
      try {
        await environment.close()
      } catch (error) {
        if (!closeFailed) {
          closeFailed = true
          firstCloseError = error
        }
        const closeError = error instanceof Error ? error : new Error(String(error))
        logger.error(`[nasti] failed to close environment "${environment.name}"`, {
          error: closeError,
        })
      }
    }
    if (closeFailed && !buildFailed) {
      throw firstCloseError
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
  const allOutput = [...Object.values(environments).flat(), ...buildAppContext.output]
  const totalSize = allOutput.reduce((sum, chunk) => {
    const content = chunk.type === 'chunk' ? chunk.code : (chunk as any).source
    if (content == null) return sum
    return sum + (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength)
  }, 0)
  const fileCount = allOutput.length
  const envSuffix =
    buildableNames.length > 1 ? ` (${buildableNames.join(' + ')})` : ''

  logger.info(pc.green(`✓ built in ${elapsed}s`) + pc.dim(envSuffix))
  logger.info(pc.dim(`  ${fileCount} files, ${displaySize(totalSize)} total → ${config.build.outDir}/`))

  return {
    output: clientOutput,
    environments,
    environmentResults,
    appOutput: [...buildAppContext.output],
  }
}

/** client 环境构建：HTML 入口 + CSS 抽取 + 体积表 + index.html 改写 */
async function buildClientEnvironment(config: ResolvedConfig): Promise<BuiltEnvironment> {
  const logger = config.logger
  const outDir = path.resolve(config.root, config.build.outDir)

  // per-env 插件列表 + applyToEnvironment 过滤。外部 driver 在任何 Nasti
  // HTML/CSS/Rolldown 副作用前接管环境。
  const cssEngine = createCssEngine()
  const pluginList = resolvePluginList(config, config.plugins, {
    cssEngine,
    environmentName: 'client',
  })
  const clientEnv = new NastiEnvironment('client', config, {
    mode: 'build',
    plugins: pluginList,
    pluginApi: getPluginApi(config),
  })
  await clientEnv.init()

  try {
    if (clientEnv.driver) {
      if (!clientEnv.driver.build) {
        throw new Error(
          `[nasti] environment "client" driver "${clientEnv.driver.name}" does not implement build()`,
        )
      }
      const result = await clientEnv.driver.build(clientEnv.getDriverContext())
      assertDriverBuildResult(clientEnv, result)
      return { environment: clientEnv, result: finalizeEnvironmentResult(clientEnv, result) }
    }

    fs.mkdirSync(outDir, { recursive: true })

    const htmlFile = config.environments.client.html ?? path.resolve(config.root, 'index.html')
    const html = await readHtmlFile(config.root, htmlFile)
    const entryPoints = resolveClientEntries(config, html)
    if (entryPoints.length === 0) {
      throw new Error('No entry point found. Add a <script> tag to index.html or create src/main.ts')
    }

    const allPlugins = clientEnv.plugins

    // 原生体积报告插件（守卫导入；不可用时走 JS 表格 fallback）
    const nativeReporter = config.logLevel === 'silent'
      ? null
      : await tryNativeReporterPlugin(config, logger)

    const rolldownPlugins = [
      createOxcTransformPlugin(config, clientEnv),
      ...toRolldownPlugins(allPlugins, clientEnv),
      ...(nativeReporter ? [nativeReporter as any] : []),
    ]
    const { inputOptions, outputOptions } = getRolldownOptions(
      clientEnv,
      entryPoints,
      rolldownPlugins,
    )

    const bundle = await rolldown(inputOptions)
    const { output } = await bundle.write(outputOptions)
    await bundle.close()
    clientEnv.setBuildMetadata({ css: getCssMetadata(cssEngine) })

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
      if (clientEnv.options.build.css.inject !== false) {
        processedHtml = injectCssLinks(processedHtml, cssEngine, config)
      }

      // 替换 script src 为打包后的路径（支持多入口）
      for (const chunk of output) {
        if (chunk.type === 'chunk' && chunk.isEntry && chunk.facadeModuleId) {
          processedHtml = replaceEntryScript(
            processedHtml,
            chunk.facadeModuleId,
            chunk.fileName,
            config,
            htmlFile,
            config.base,
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

    return {
      environment: clientEnv,
      result: finalizeEnvironmentResult(clientEnv, { output: output as any }),
    }
  } catch (error) {
    try {
      await clientEnv.close()
    } catch (closeError) {
      const normalized = closeError instanceof Error
        ? closeError
        : new Error(String(closeError))
      logger.error('[nasti] failed to close client environment after build failure', {
        error: normalized,
      })
    }
    throw error
  }
}

/** 非 client 环境构建（SSR / worker / main / preload …）：entry 显式声明 */
async function buildServerEnvironment(
  config: ResolvedConfig,
  name: string,
): Promise<BuiltEnvironment> {
  const envOptions = config.environments[name]
  const logger = config.logger

  const cssEngine = envOptions.consumer === 'client' ? createCssEngine() : undefined
  const pluginList = resolvePluginList(config, config.plugins, {
    consumer: envOptions.consumer,
    environmentName: name,
    cssEngine,
  })
  const environment = new NastiEnvironment(name, config, {
    mode: 'build',
    plugins: pluginList,
    pluginApi: getPluginApi(config),
  })
  await environment.init()
  if (environment.driver) {
    if (!environment.driver.build) {
      await environment.close()
      throw new Error(
        `[nasti] environment "${name}" driver "${environment.driver.name}" does not implement build()`,
      )
    }
    try {
      const result = await environment.driver.build(environment.getDriverContext())
      assertDriverBuildResult(environment, result)
      return { environment, result: finalizeEnvironmentResult(environment, result) }
    } catch (error) {
      await environment.close()
      throw error
    }
  }

  for (const entry of envOptions.entry) {
    if (!fs.existsSync(entry)) {
      await environment.close()
      throw new Error(`[nasti] environment "${name}" entry not found: ${entry}`)
    }
  }

  const rolldownPlugins = [
    createOxcTransformPlugin(config, environment),
    ...toRolldownPlugins(environment.plugins, environment),
  ]
  const { inputOptions, outputOptions, outDir } = getRolldownOptions(
    environment,
    envOptions.entry,
    rolldownPlugins,
  )

  fs.mkdirSync(outDir, { recursive: true })

  const bundle = await rolldown(inputOptions)
  const { output } = await bundle.write(outputOptions)
  await bundle.close()
  if (cssEngine) environment.setBuildMetadata({ css: getCssMetadata(cssEngine) })

  logger.info(
    pc.dim(`  [${name}] `) +
      output.map((o) => path.join(envOptions.build.outDir, o.fileName)).join(pc.dim(', ')),
  )
  return {
    environment,
    result: finalizeEnvironmentResult(environment, { output: output as any }),
  }
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

export function replaceEntryScript(
  html: string,
  facadeModuleId: string,
  fileName: string,
  config: ResolvedConfig,
  htmlFile: string,
  urlPrefix: string,
): string {
  const rootRelative = path.relative(config.root, facadeModuleId).split(path.sep).join('/')
  const resolvedHtmlFile = path.resolve(config.root, htmlFile)
  const htmlRelative = path
    .relative(path.dirname(resolvedHtmlFile), facadeModuleId)
    .split(path.sep)
    .join('/')
  const candidates = new Set([
    rootRelative,
    `/${rootRelative}`,
    htmlRelative,
    `./${htmlRelative}`,
  ])
  let processed = html
  for (const candidate of candidates) {
    processed = processed.replace(
      new RegExp(`(src=["'])${escapeRegExp(candidate)}([?#][^"']*)?(["'])`, 'g'),
      `$1${urlPrefix}${fileName}$3`,
    )
  }
  return processed
}
