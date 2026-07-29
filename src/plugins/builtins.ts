// 内置插件拼装 - server 与 build 共用的 per-env 函数（NASTI_2.0_PLAN.md §1.2）
//
// 1.x 在 server/index.ts 与 build/index.ts 各拼一份，容易漂移；统一后
// 环境插件列表 = pre 内置 + 用户插件 + post 内置，再经 applyToEnvironment
// 过滤（core/environment.ts 的 resolveEnvironmentPlugins）。
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import type { CssEngine } from '../core/css-engine.js'
import { resolvePlugin } from './resolve.js'
import { cssPlugin } from './css.js'
import { cssPostPlugin } from './css-post.js'
import { assetsPlugin } from './assets.js'
import { vuePlugin } from './vue.js'
import { htmlPlugin } from './html.js'

export interface BuiltinPluginOptions {
  /** build 期 CSS 抽取引擎（serve 不传，dev 走 <style> 注入路径） */
  cssEngine?: CssEngine
  /** 当前环境名；内置插件据此读取 per-env resolve/build 配置。 */
  environmentName?: string
  /** 环境 consumer：server 时 css 插件返回无 DOM 的纯 stub（SSR/main/preload） */
  consumer?: 'client' | 'server'
}

/**
 * 拼装某一环境的完整插件列表（顺序与 1.x 完全一致）：
 *   [vue?] → resolve → css → assets → [html(serve)] → 用户插件 → [css-post(build)]
 */
export function resolvePluginList(
  config: ResolvedConfig,
  userPlugins: NastiPlugin[],
  opts: BuiltinPluginOptions = {},
): NastiPlugin[] {
  const isServe = config.command === 'serve'
  let environmentOptions
  if (opts.environmentName) {
    environmentOptions = config.environments[opts.environmentName]
    if (!environmentOptions) {
      throw new Error(
        `[nasti] unknown environment "${opts.environmentName}" — declare it in config.environments`,
      )
    }
  }
  const pluginConfig = environmentOptions
    ? { ...config, resolve: environmentOptions.resolve, build: environmentOptions.build }
    : config
  const consumer = opts.consumer ?? environmentOptions?.consumer

  return [
    // vuePlugin 排最前（enforce: 'pre' 语义）：.vue 先编译成 JS 再走后续管道
    ...(config.framework === 'vue' ? [vuePlugin(pluginConfig)] : []),
    resolvePlugin(pluginConfig),
    cssPlugin(pluginConfig, opts.cssEngine, consumer),
    assetsPlugin(pluginConfig),
    ...(isServe ? [htmlPlugin(pluginConfig)] : []),
    ...userPlugins,
    // cssPostPlugin 最后（enforce: 'post' 语义）：renderChunk 聚合抽取
    ...(!isServe && opts.cssEngine ? [cssPostPlugin(pluginConfig, opts.cssEngine)] : []),
  ]
}
