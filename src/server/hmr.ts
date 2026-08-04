// HMR 逻辑 - 文件变更 → 模块失效 → 通知客户端
import path from 'node:path'
import fs from 'node:fs'
import pc from 'picocolors'
import type {
  DevServer,
  EnvironmentHotUpdateResult,
  ModuleNode,
  HmrUpdate,
  HmrContext,
} from '../types.js'
import { ModuleGraph } from '../core/module-graph.js'
import { findNearestPackageRoot, getLinkedPackageRoots } from './fs-allow.js'

export async function handleFileChange(
  file: string,
  server: DevServer,
  environmentName = 'client',
  timestamp = Date.now(),
): Promise<EnvironmentHotUpdateResult | null> {
  const { config } = server
  const environment = server.environments[environmentName]
  if (!environment) {
    throw new Error(`[nasti] unknown dev environment "${environmentName}"`)
  }
  const moduleGraph = environment.moduleGraph
  const logger = config.logger
  const relativePath = '/' + path.relative(config.root, file)
  const shortFile = path.relative(config.root, file)

  // 找到受影响的模块。watcher 路径与 registerModule 路径在 macOS（/var →
  // /private/var）或 pnpm workspace realpath 后可能不一致，先精确匹配再试
  // realpath。workspace 包经 /@modules 预打包时只登记入口，包内其它文件变更
  // 再回退到同一 package root 下已登记的模块。
  let mods = moduleGraph.getModulesByFile(file)
  if (!mods || mods.size === 0) {
    try {
      const real = fs.realpathSync(file)
      if (real !== file) mods = moduleGraph.getModulesByFile(real)
      if (mods && mods.size > 0) file = real
    } catch {
      /* deleted / dangling */
    }
  }
  if (!mods || mods.size === 0) {
    const packageRoot = findNearestPackageRoot(file)
    if (
      packageRoot &&
      getLinkedPackageRoots(config.root).some(
        (r) => packageRoot === r || packageRoot.startsWith(r + path.sep),
      )
    ) {
      const under = (moduleGraph as ModuleGraph).getModulesWithFileUnder(packageRoot)
      if (under.size > 0) mods = under
    }
  }
  if (!mods || mods.size === 0) {
    return null
  }

  const updates: HmrUpdate[] = []
  const graph = moduleGraph as ModuleGraph
  const invalidatedModules = new Set<ModuleNode>()
  const affectedSet = new Set<ModuleNode>()
  let fullReload = false

  for (const mod of mods) {
    // importer 也要失效，边界重新导入时才能把变更时间戳传播到依赖 URL。
    graph.invalidateModuleAndImporters(mod, timestamp, invalidatedModules)

    // 执行插件的 handleHotUpdate 钩子
    const ctx: HmrContext = {
      file,
      timestamp,
      modules: [mod],
      read: () => fs.readFileSync(file, 'utf-8'),
      server,
      environment,
    }

    let affectedModules: ModuleNode[] = [mod]
    for (const plugin of environment.plugins) {
      if (plugin.handleHotUpdate) {
        const result = await plugin.handleHotUpdate(ctx)
        if (result) {
          affectedModules = result
        }
      }
    }

    // 检查 HMR 边界
    for (const affected of affectedModules) {
      affectedSet.add(affected)
      graph.invalidateModuleAndImporters(affected, timestamp, invalidatedModules)
      const boundaries = graph.getHmrBoundaries(affected)
      if (boundaries.length === 0) {
        fullReload = true
        continue
      }

      for (const { boundary, acceptedVia } of boundaries) {
        const update: HmrUpdate = {
          type: boundary.type === 'css' ? 'css-update' : 'js-update',
          path: boundary.url,
          acceptedPath: acceptedVia.url,
          timestamp,
        }
        if (!updates.some((existing) =>
          existing.type === update.type &&
          existing.path === update.path &&
          existing.acceptedPath === update.acceptedPath
        )) {
          updates.push(update)
        }
      }
    }
  }

  const transformed = await Promise.all(
    [...affectedSet].map(async (module) => ({
      module,
      result: await environment.transformRequest(module.url),
    })),
  )

  const logPrefix = environmentName === 'client' ? '' : `[${environmentName}] `
  if (fullReload) {
    logger.info(pc.green(`${logPrefix}reload `) + pc.dim(shortFile), { timestamp: true })
    environment.hot.send({ type: 'full-reload', path: relativePath })
  } else if (updates.length > 0) {
    logger.info(
      updates
        .map((u) => pc.green(`${logPrefix}hmr update `) + pc.dim(u.path))
        .join('\n'),
      { timestamp: true },
    )
    environment.hot.send({ type: 'update', updates })
  }

  return {
    environment,
    modules: [...affectedSet],
    updates,
    transformed,
    fullReload,
  }
}
