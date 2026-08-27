// 内置 React 转换阶段。
//
// 保留 `nasti:oxc-transform` 插件名与生产构建中的原有位置，避免依赖旧顺序的
// Nasti/Vite 兼容插件发生行为变化；真正的配置与可选 Compiler 选择集中在这里。
import type { EnvironmentInstance, NastiPlugin, ResolvedConfig } from '../types.js'
import { matchesReactFilter, transformReactCode } from '../core/transformer.js'

const REACT_FILE_RE = /\.[jt]sx(?:[?#].*)?$/

export function reactPlugin(
  config: ResolvedConfig,
  environment: EnvironmentInstance,
): NastiPlugin {
  return {
    name: 'nasti:oxc-transform',

    async transform(code, id) {
      const result = await transformReactCode(id, code, {
        react: config.react,
        consumer: environment.consumer,
        development: config.mode === 'development',
        sourcemap: !!environment.options.build.sourcemap,
        target: environment.options.build.target,
        onWarning: (message) => config.logger.warn(`[nasti:react] ${message}`),
      })
      if (!result) return null
      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : undefined,
      }
    },

    handleHotUpdate(ctx) {
      for (const mod of ctx.modules) {
        if (
          REACT_FILE_RE.test(mod.url) &&
          matchesReactFilter(mod.url, config.react.include, config.react.exclude)
        ) {
          mod.isSelfAccepting = true
        }
      }
      return ctx.modules
    },
  }
}
