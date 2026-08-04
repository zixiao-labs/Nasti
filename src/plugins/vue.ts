// 内置 Vue 插件 - SFC 编译 + Vue HMR（含 Vue 3.6 Vapor Mode 测试版）
import crypto from 'node:crypto'
import type {
  NastiPlugin,
  ResolvedConfig,
  VueEnvironmentOptions,
  VueSfcSourceTransform,
  VueSfcTransformContext,
} from '../types.js'
import {
  SourceMapConsumer,
  SourceMapGenerator,
  SourceNode,
  type RawSourceMap,
} from 'source-map-js'
import { transformCode } from '../core/transformer.js'
import { createDebugger } from '../core/debug.js'

const VUE_FILE_RE = /\.vue$/
// 同时接受 2.0 的 `&lang.css`（Vite 约定，id 以 .css 结尾可被 css 插件接管）
// 与 1.x 的 `&lang=css`（向后兼容已缓存的 URL）
const VUE_QUERY_RE = /\.vue\?vue&type=(script|template|style)(&index=\d+)?(&lang[.=]\w+)?/
const debug = createDebugger('nasti:vue')

/** Vapor Mode 测试版免责声明：终端与浏览器控制台共用同一文案 */
export const VAPOR_BETA_WARNING =
  'Vapor Mode is a beta feature; Zixiao Labs and the Vue team do not provide guarantees against crashes in production environments, and it is not suitable for server-side rendering environments.'

interface VueCompilerSfc {
  parse: (source: string, options?: any) => any
  compileScript: (sfc: any, options: any) => any
  compileTemplate: (options: any) => any
  compileStyleAsync: (options: any) => Promise<any>
  version?: string
}

let compiler: VueCompilerSfc | null = null

async function loadVueCompiler(): Promise<VueCompilerSfc | null> {
  if (compiler) return compiler
  try {
    compiler = await import('@vue/compiler-sfc')
    return compiler
  } catch {
    return null
  }
}

export function vuePlugin(
  config: ResolvedConfig,
  environmentName = 'client',
): NastiPlugin {
  const isDev = config.command === 'serve'
  const descriptorCache = new Map<
    string,
    { descriptor: any; sourceMap?: unknown }
  >()
  const vueOptions = config.environments[environmentName]?.vue ?? {}

  return {
    name: 'nasti:vue',
    enforce: 'pre',

    async resolveId(source) {
      // 处理 .vue 虚拟模块请求 (?vue&type=...)
      if (VUE_QUERY_RE.test(source)) {
        return source
      }
      return null
    },

    // 虚拟子模块必须有 load 钩子：build 下 Rolldown 否则会按字面路径读盘，
    // 抛 UNLOADABLE_DEPENDENCY（1.x Vue 生产构建因此直接失败）。
    // style 子块在这里编译成 CSS 字符串，交给 css 插件统一处理
    // （dev = <style> 注入 + HMR；build = CssEngine 抽取成 hashed .css）。
    async load(id) {
      const match = id.match(/(.+\.vue)\?vue&type=style(?:&index=(\d+))?/)
      if (!match) return null

      const sfc = await loadVueCompiler()
      if (!sfc) return null

      const [, filePath, indexStr] = match
      let cached = descriptorCache.get(filePath)
      if (!cached) {
        // 直接请求子模块（如 dev 冷启动 / 缓存失效）时按需重新解析父 SFC
        try {
          const fs = await import('node:fs')
          const rawSource = fs.readFileSync(filePath, 'utf-8')
          const transformedSfc = await applySourceTransform(
            vueOptions.transformSfc,
            rawSource,
            { filename: filePath, environmentName, type: 'sfc' },
          )
          const parsed = sfc.parse(transformedSfc.code, {
            ...vueOptions.parse,
            filename: filePath,
            sourceMap: true,
          })
          if (parsed.errors.length) return null
          cached = {
            descriptor: parsed.descriptor,
            sourceMap: transformedSfc.map,
          }
          descriptorCache.set(filePath, cached)
        } catch {
          return null
        }
      }

      const { descriptor, sourceMap: sfcSourceMap } = cached
      const index = parseInt(indexStr ?? '0', 10)
      const style = descriptor.styles[index]
      if (!style) return null

      const scopeId = hashId(filePath)
      const transformedStyle = await applySourceTransform(
        vueOptions.transformStyle,
        style.content,
        { filename: filePath, environmentName, type: 'style', index },
      )
      const wantsStyleSourceMap =
        !!config.build.sourcemap ||
        transformedStyle.map != null ||
        sfcSourceMap != null
      const styleInputMap = wantsStyleSourceMap
        ? composeSourceMapChain(
            [transformedStyle.map, style.map, sfcSourceMap],
            { filename: filePath, environmentName, type: 'style', index },
          )
        : undefined
      const result = await sfc.compileStyleAsync({
        ...vueOptions.style,
        source: transformedStyle.code,
        filename: filePath,
        id: `data-v-${scopeId}`,
        scoped: style.scoped ?? false,
        inMap: styleInputMap,
        // <style lang="scss|less|stylus"> 需经对应预处理器（缺省 undefined = 纯 CSS）
        preprocessLang: style.lang,
      })
      if (transformedStyle.map != null && result.map == null) {
        warnUnchainableMap(
          { filename: filePath, environmentName, type: 'style', index },
          'compiler-sfc did not return a style map',
        )
      }
      return wantsStyleSourceMap
        ? { code: result.code as string, map: result.map }
        : result.code as string
    },

    async transform(code, id) {
      // 处理 .vue 文件
      if (!VUE_FILE_RE.test(id) && !VUE_QUERY_RE.test(id)) return null

      const sfc = await loadVueCompiler()
      if (!sfc) {
        console.warn('[nasti:vue] @vue/compiler-sfc not found. Install it: npm install @vue/compiler-sfc')
        return null
      }

      // 处理虚拟模块请求（子块）。style 子块的内容由上方 load 钩子产出 CSS，
      // 后续交给 css 插件（dev 注入 / build 抽取），这里不再拦截。
      if (VUE_QUERY_RE.test(id)) {
        return null
      }

      // 解析 SFC
      const transformedSfc = await applySourceTransform(
        vueOptions.transformSfc,
        code,
        { filename: id, environmentName, type: 'sfc' },
      )
      code = transformedSfc.code
      const { descriptor, errors } = sfc.parse(code, {
        ...vueOptions.parse,
        filename: id,
        sourceMap: true,
      })
      if (errors.length) {
        const firstError = errors[0]
        console.error(
          `[nasti:vue] Parse error in ${id}:`,
          typeof firstError === 'string' ? firstError : firstError.message,
        )
        return null
      }

      descriptorCache.set(id, {
        descriptor,
        sourceMap: transformedSfc.map,
      })
      const scopeId = hashId(id)
      const wantsSourceMap =
        !!config.build.sourcemap || transformedSfc.map != null
      const vapor = resolveVaporMode(descriptor, vueOptions, sfc, config)

      // 编译 script
      let scriptCode = ''
      let scriptMap: unknown
      let scriptBindings: Record<string, unknown> | undefined
      if (descriptor.script || descriptor.scriptSetup) {
        const inlineTemplate = vueOptions.script?.inlineTemplate !== false
        const compiled = sfc.compileScript(descriptor, {
          ...vueOptions.script,
          id: scopeId,
          isProd: !isDev,
          inlineTemplate,
          sourceMap: wantsSourceMap,
          // 让 compileScript 产出 `const __sfc__ = ...`（而非默认的 `export default {...}`）。
          // 否则下方追加的 `__sfc__.render` / `__sfc__.__scopeId` / HMR 记录会引用一个
          // 不存在的 `__sfc__`，并与 compileScript 自带的 `export default` 形成双重默认导出。
          genDefaultAs: '__sfc__',
          vapor,
        })
        scriptCode = compiled.content
        scriptBindings = compiled.bindings
        scriptMap = composeSourceMapChain(
          [compiled.map, transformedSfc.map],
          { filename: id, environmentName, type: 'sfc' },
        )
        if (transformedSfc.map != null && scriptMap == null) {
          warnUnchainableMap(
            { filename: id, environmentName, type: 'sfc' },
            'compiler-sfc did not return a script map',
          )
        }
      }

      // 编译 template（如果没有 inline）
      let templateCode = ''
      let templateMap: unknown
      let templateMultiRoot: boolean | undefined
      const scriptSetupIsInline =
        !!descriptor.scriptSetup && vueOptions.script?.inlineTemplate !== false
      const isTemplateOnlyVapor =
        vapor && !descriptor.script && !descriptor.scriptSetup
      if (descriptor.template && !scriptSetupIsInline) {
        const transformedTemplate = await applySourceTransform(
          vueOptions.transformTemplate,
          descriptor.template.content,
          { filename: id, environmentName, type: 'template' },
        )
        const templateInputMap = composeSourceMapChain(
          [
            transformedTemplate.map,
            descriptor.template.map,
            transformedSfc.map,
          ],
          { filename: id, environmentName, type: 'template' },
        )
        const customCompilerOptions =
          vueOptions.template?.compilerOptions ?? {}
        const compiled = sfc.compileTemplate({
          ...vueOptions.template,
          source: transformedTemplate.code,
          filename: id,
          id: scopeId,
          inMap: templateInputMap,
          vapor,
          compilerOptions: {
            ...customCompilerOptions,
            // Vapor 在 bindingMetadata 缺失时需要空对象（与 Vite / compiler-sfc 一致）
            bindingMetadata:
              customCompilerOptions.bindingMetadata ??
              scriptBindings ??
              (vapor ? {} : undefined),
            scopeId: `data-v-${scopeId}`,
          },
        })
        templateCode = compiled.code
        templateMultiRoot = compiled.multiRoot
        if (
          wantsSourceMap ||
          transformedTemplate.map != null
        ) {
          templateMap = compiled.map
        }
        if (transformedTemplate.map != null && templateMap == null) {
          warnUnchainableMap(
            { filename: id, environmentName, type: 'template' },
            'compiler-sfc did not return a template map',
          )
        }
      }

      // 组装输出。若 SFC 只有 <template> 而无任何 <script>，scriptCode 为空，
      // 兜底一个空组件对象，保证后续 `__sfc__.render` / `__scopeId` 赋值成立。
      // Vapor 纯 template SFC 必须带 `__vapor: true`，否则运行时按 VDOM 组件处理。
      const outputNode = new SourceNode()
      let hasMappedOutput = false
      const append = (fragment: string, map?: unknown) => {
        const normalizedMap = normalizeSourceMap(
          map,
          { filename: id, environmentName, type: 'sfc' },
        )
        if (!normalizedMap) {
          outputNode.add(fragment)
          return
        }
        try {
          // source-map-js accepts nested SourceNodes at runtime, but its bundled
          // declaration incorrectly narrows SourceNode#add to string only.
          outputNode.add(
            SourceNode.fromStringWithSourceMap(
              fragment,
              new SourceMapConsumer(normalizedMap),
            ) as unknown as string,
          )
          hasMappedOutput = true
        } catch (error) {
          warnUnchainableMap(
            { filename: id, environmentName, type: 'sfc' },
            `source-map assembly failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          outputNode.add(fragment)
        }
      }

      append(
        scriptCode ||
          (vapor ? 'const __sfc__ = { __vapor: true }' : 'const __sfc__ = {}'),
        scriptMap,
      )

      if (templateCode) {
        append('\n')
        append(templateCode, templateMap)
        append('\n')
        append('\n__sfc__.render = render\n')
        if (isTemplateOnlyVapor && templateMultiRoot !== undefined) {
          append(`\n__sfc__.__multiRoot = ${JSON.stringify(templateMultiRoot)}\n`)
        }
      }

      // style 导入（&lang.css 结尾 —— css 插件按 .css 后缀接管该虚拟模块）
      if (descriptor.styles.length > 0) {
        for (let i = 0; i < descriptor.styles.length; i++) {
          append(`\nimport "${id}?vue&type=style&index=${i}&lang.css"\n`)
        }
      }

      // Vapor 测试版免责声明：必须放在所有 import 之后，避免破坏 ESM 语法
      if (vapor) {
        append(`\nconsole.warn(${JSON.stringify(VAPOR_BETA_WARNING)})\n`)
      }

      // scoped 标记
      append(`\n__sfc__.__scopeId = "data-v-${scopeId}"\n`)

      // HMR
      if (isDev) {
        append(`
__sfc__.__hmrId = ${JSON.stringify(scopeId)}
if (typeof __VUE_HMR_RUNTIME__ !== 'undefined') {
  __VUE_HMR_RUNTIME__.createRecord(__sfc__.__hmrId, __sfc__)
}
if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    if (!mod) return
    const { default: updated } = mod
    if (typeof __VUE_HMR_RUNTIME__ !== 'undefined') {
      __VUE_HMR_RUNTIME__.rerender(updated.__hmrId, updated.render)
    }
  })
}
`)
      }

      append('\nexport default __sfc__\n')
      const renderedOutput = outputNode.toStringWithSourceMap({ file: id })
      const output = renderedOutput.code
      const outputMap = hasMappedOutput
        ? renderedOutput.map.toJSON()
        : undefined
      if (transformedSfc.map != null && outputMap == null) {
        warnUnchainableMap(
          { filename: id, environmentName, type: 'sfc' },
          'the compiled SFC output contained no chainable mappings',
        )
      }

      // compileScript 对 lang="ts" 的 SFC 会在产物里保留 TS 注解 —— 不仅是用户脚本，
      // 连内联 render 也带（如 `(_ctx: any, _cache: any) =>`、`($event: any) => ...`）。
      // Nasti 的 oxc 转译按扩展名只处理 .ts/.tsx，不碰 .vue，所以这里显式把组装后的
      // 产物按 TS 走一遍 oxc 剥离类型，产出纯 JS —— dev（浏览器原生 ESM）与 build
      // （Rolldown 解析）都需要这一步，否则裸 TS 会直接触发解析错误。
      const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang
      if (lang === 'ts') {
        const transpiled = transformCode(`${id}.ts`, output, {
          sourcemap: wantsSourceMap,
          target: config.build.target,
        })
        const transpiledMap = transpiled.map
          ? JSON.parse(transpiled.map)
          : undefined
        return {
          code: transpiled.code,
          map: composeSourceMapChain(
            [transpiledMap, outputMap],
            { filename: id, environmentName, type: 'sfc' },
          ),
        }
      }

      return { code: output, map: outputMap }
    },

    handleHotUpdate(ctx) {
      const { file, modules } = ctx
      if (VUE_FILE_RE.test(file)) {
        // Vue 文件更新: 标记为自接受
        for (const mod of modules) {
          mod.isSelfAccepting = true
        }
        // 清除缓存
        descriptorCache.delete(file)
      }
      return modules
    },
  }
}

/**
 * 解析当前 SFC 是否启用 Vapor Mode。
 * - 单文件 opt-in：`descriptor.vapor`（`<script setup vapor>` / `<template vapor>`）
 * - 环境级强制：`vue.features.vapor`（仅对可强制的 SFC 生效）
 * 首次启用时在终端打印测试版免责声明。
 */
function resolveVaporMode(
  descriptor: any,
  vueOptions: VueEnvironmentOptions,
  sfc: VueCompilerSfc,
  config: ResolvedConfig,
): boolean {
  const requested =
    !!descriptor.vapor ||
    (!!vueOptions.features?.vapor && canForceVaporMode(descriptor))
  if (!requested) return false

  if (!supportsVaporCompiler(sfc)) {
    config.logger.warnOnce(
      '[nasti:vue] Vapor Mode requires @vue/compiler-sfc >= 3.6. ' +
        'Install it: npm install @vue/compiler-sfc@^3.6.0-0',
    )
    return false
  }

  config.logger.warnOnce(VAPOR_BETA_WARNING)
  return true
}

/**
 * `features.vapor` 可强制：纯 template SFC、`<script setup>` SFC。
 * 不可强制仅含普通 `<script>`（无 setup）的 `.vue`，因为 Vapor 不支持 Options API。
 */
function canForceVaporMode(descriptor: any): boolean {
  if (typeof descriptor.filename === 'string' && descriptor.filename.endsWith('.vue')) {
    if (descriptor.scriptSetup) return true
    if (descriptor.script) return false
  }
  return true
}

/** `@vue/compiler-sfc` 主版本 ≥ 3.6 才具备 Vapor 编译器。 */
function supportsVaporCompiler(sfc: VueCompilerSfc): boolean {
  const version = sfc.version
  if (!version) return false
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > 3 || (major === 3 && minor >= 6)
}

async function applySourceTransform(
  transform: VueSfcSourceTransform | undefined,
  source: string,
  context: VueSfcTransformContext,
): Promise<{ code: string; map?: unknown }> {
  if (!transform) return { code: source }
  const result = await transform(source, context)
  return typeof result === 'string' ? { code: result } : result
}

function normalizeSourceMap(
  map: unknown,
  context: VueSfcTransformContext,
): RawSourceMap | undefined {
  if (map == null) return undefined
  try {
    const value = typeof map === 'string' ? JSON.parse(map) : map
    if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as RawSourceMap).sources) &&
      Array.isArray((value as RawSourceMap).names) &&
      typeof (value as RawSourceMap).mappings === 'string'
    ) {
      return value as RawSourceMap
    }
  } catch {
    // Report through the debug channel below.
  }
  warnUnchainableMap(context, 'the provided map is not a valid source map')
  return undefined
}

function composeSourceMapChain(
  maps: unknown[],
  context: VueSfcTransformContext,
): RawSourceMap | undefined {
  const pending = maps.filter((map) => map != null)
  if (pending.length === 0) return undefined
  let composed = normalizeSourceMap(pending.shift(), context)
  for (const map of pending) {
    const input = normalizeSourceMap(map, context)
    if (!input) continue
    if (!composed) {
      composed = input
      continue
    }
    try {
      const consumer = new SourceMapConsumer(composed)
      if (consumer.sources.length !== 1) {
        warnUnchainableMap(
          context,
          'a generated map has multiple sources and cannot be chained safely',
        )
        continue
      }
      const generator = SourceMapGenerator.fromSourceMap(consumer)
      generator.applySourceMap(
        new SourceMapConsumer(input),
        consumer.sources[0],
      )
      composed = generator.toJSON()
    } catch (error) {
      warnUnchainableMap(
        context,
        `source-map composition failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return composed
}

function warnUnchainableMap(
  context: VueSfcTransformContext,
  reason: string,
): void {
  debug?.(
    `source map warning for ${context.filename} (${context.type}, ${context.environmentName}): ${reason}`,
  )
}

function hashId(filename: string): string {
  return crypto.createHash('sha256').update(filename).digest('hex').slice(0, 8)
}
