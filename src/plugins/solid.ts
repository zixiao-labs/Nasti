import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { importProjectPackage } from '../core/project-import.js'
import { transformSync } from 'oxc-transform'

/**
 * Create a plugin that compiles JSX/TSX for Solid DOM or server rendering.
 * Uses config.solid.hydratable and enables Refresh for client dev transforms
 * unless HMR is disabled. Compiler tools are loaded from config.root on demand;
 * their loading errors and OXC/Babel compilation errors propagate from transforms.
 */
export function solidPlugin(config: ResolvedConfig): NastiPlugin {
  let tools: Promise<any[]> | undefined
  return {
    name: 'nasti:solid',
    // Start macros and route generation must see the original JSX.
    pre: ['nasti:tanstack-start', 'nasti:tanstack-router'],
    transform: { order: 'pre', async handler(code, id) {
      const filename = id.split(/[?#]/, 1)[0]
      if (!/\.[jt]sx$/.test(filename)) return null
      tools ??= Promise.all([
        importProjectPackage(config.root, '@babel/core'),
        importProjectPackage(config.root, 'babel-preset-solid'),
      ])
      const [babel, preset] = await tools
      const server = this.environment?.consumer === 'server'
      const hot = !server && config.command === 'serve' && config.server.hmr !== false
      const refresh = hot ? await importProjectPackage(config.root, 'solid-refresh/babel') : undefined
      // Strip TS without consuming JSX before handing the source to Solid.
      const stripped = transformSync(filename, code, {
        jsx: 'preserve',
        typescript: {},
        sourcemap: true,
      })
      if (stripped.errors.length) {
        throw new Error(stripped.errors.map((error) => error.message).join('\n'))
      }
      const result = await babel.transformAsync(stripped.code, {
        filename,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        inputSourceMap: stripped.map ?? undefined,
        presets: [[preset.default, {
          generate: server ? 'ssr' : 'dom',
          hydratable: config.solid.hydratable,
          dev: config.mode === 'development',
        }]],
        // "vite" selects import.meta.hot in solid-refresh; no Vite is imported.
        plugins: hot ? [[refresh.default, { bundler: 'vite' }]] : [],
      })
      return result ? { code: result.code, map: result.map } : null
    } },
  }
}
