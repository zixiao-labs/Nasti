import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { importProjectPackage } from '../core/project-import.js'
import { transformSync } from 'oxc-transform'
import { solidStartRefreshBindings } from './solid-start-refresh.js'

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
      // Granular Refresh extracts JSX into component boundaries. SSR must use
      // the same boundaries or its hydration IDs diverge from the hot client.
      // The emitted import.meta.hot guard keeps refresh execution client-only.
      const refreshEnabled = config.mode === 'development' && config.server.hmr !== false &&
        ((!server && config.command === 'serve') ||
          config.plugins.some((plugin) => plugin.name === 'nasti:tanstack-start')) &&
        !/[\\/](?:node_modules|\.nasti)[\\/]/.test(filename)
      const refresh = refreshEnabled ? await importProjectPackage(config.root, 'solid-refresh/babel') : undefined
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
          // Refresh can recreate a server-only element outside hydration.
          ...(refreshEnabled && !server ? { omitServerOnlyTemplates: false } : {}),
        }]],
        // "vite" selects import.meta.hot in solid-refresh; no Vite is imported.
        plugins: refreshEnabled ? [
          [refresh.default, { bundler: 'vite' }],
          ...(!server && this.environment?.mode === 'dev' &&
              config.plugins.some((plugin) => plugin.name === 'nasti:tanstack-start')
            ? [solidStartRefreshBindings] : []),
        ] : [],
      })
      return result ? { code: result.code, map: result.map } : null
    } },
  }
}
