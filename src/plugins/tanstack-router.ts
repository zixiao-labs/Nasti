import path from 'node:path'
import type { DevServer, NastiPlugin, ResolvedConfig } from '../types.js'
import { importProjectPackage } from '../core/project-import.js'

export interface TanStackRouterOptions {
  framework?: 'react' | 'solid'
  routesDirectory?: string
  generatedRouteTree?: string
  /** Additional official router-generator options (including virtual routes). */
  generator?: Record<string, unknown>
}

/** Official route generator, hosted by Nasti's native watcher and builder. */
export function tanstackRouter(options: TanStackRouterOptions = {}): NastiPlugin {
  let config: ResolvedConfig
  let generator: any
  let pending = Promise.resolve()
  let server: DevServer | undefined
  let routesDirectory: string
  const generate = (event?: { path: string; type: 'create' | 'update' | 'delete' }) => {
    // Recover after a failed generation; callers still receive the original error.
    pending = pending.catch(() => {}).then(() => generator.run(event))
    return pending
  }
  const changed = (file: string, type: 'create' | 'update' | 'delete') => {
    const relative = path.relative(routesDirectory, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return
    void generate({ path: file, type }).then(() => {
      server?.ws.send({ type: 'full-reload' })
    }).catch((error) => config.logger.error('[nasti:router] Route generation failed', { error }))
  }
  const added = (file: string) => changed(file, 'create')
  const updated = (file: string) => changed(file, 'update')
  const removed = (file: string) => changed(file, 'delete')
  return {
    name: 'nasti:tanstack-router',
    enforce: 'pre',
    async configResolved(resolved) {
      config = resolved
      const framework = options.framework ?? config.framework
      if (framework !== 'react' && framework !== 'solid') {
        throw new Error('[nasti:router] TanStack Router requires React or Solid.')
      }
      if (framework !== config.framework) {
        throw new Error('[nasti:router] Router target and Nasti framework must match.')
      }
      const { Generator, getConfig } = await importProjectPackage(config.root, '@tanstack/router-generator')
      const generatorConfig = getConfig({
        tmpDir: '.nasti/router',
        ...options.generator,
        target: framework,
        routesDirectory: options.routesDirectory ?? './src/routes',
        generatedRouteTree: options.generatedRouteTree ?? './src/routeTree.gen.ts',
      }, config.root)
      routesDirectory = path.resolve(config.root, generatorConfig.routesDirectory)
      generator = new Generator({ config: generatorConfig, root: config.root })
      await generate()
    },
    async buildStart() {
      if (this.environment?.name === 'client') await generate()
    },
    configureServer(devServer) {
      server = devServer
      // Re-adding an already scanned root races immediate saves with Chokidar's
      // ignoreInitial scan. Native root/linked-workspace watches already cover it.
      const relative = path.relative(config.root, routesDirectory)
      if (relative.startsWith('..') || path.isAbsolute(relative)) server.watcher.add(routesDirectory)
      server.watcher.on('add', added).on('change', updated).on('unlink', removed)
    },
    async closeServer() {
      server?.watcher.off('add', added).off('change', updated).off('unlink', removed)
      await pending.catch(() => {})
    },
  }
}
