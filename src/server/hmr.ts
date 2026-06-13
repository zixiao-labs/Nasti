// HMR 逻辑 - 文件变更 → 模块失效 → 通知客户端
import path from 'node:path'
import fs from 'node:fs'
import pc from 'picocolors'
import type { DevServer, ModuleNode, HmrUpdate, HmrContext } from '../types.js'
import { ModuleGraph } from '../core/module-graph.js'

export async function handleFileChange(
  file: string,
  server: DevServer,
): Promise<void> {
  const { moduleGraph, ws, config } = server
  const logger = config.logger
  const relativePath = '/' + path.relative(config.root, file)
  const shortFile = path.relative(config.root, file)

  // 找到受影响的模块
  const mods = moduleGraph.getModulesByFile(file)
  if (!mods || mods.size === 0) {
    // 未跟踪的文件变更，可能需要 full reload
    return
  }

  const updates: HmrUpdate[] = []
  const timestamp = Date.now()

  for (const mod of mods) {
    // 使缓存失效
    moduleGraph.invalidateModule(mod)

    // 执行插件的 handleHotUpdate 钩子
    const ctx: HmrContext = {
      file,
      timestamp,
      modules: [mod],
      read: () => fs.readFileSync(file, 'utf-8'),
      server,
    }

    let affectedModules: ModuleNode[] = [mod]
    for (const plugin of config.plugins) {
      if (plugin.handleHotUpdate) {
        const result = await plugin.handleHotUpdate(ctx)
        if (result) {
          affectedModules = result
        }
      }
    }

    // 检查 HMR 边界
    for (const affected of affectedModules) {
      const boundaries = (moduleGraph as ModuleGraph).getHmrBoundaries(affected)
      if (boundaries.length === 0) {
        // 无法热更新，full reload
        logger.info(pc.green('page reload ') + pc.dim(shortFile), { timestamp: true })
        ws.send({ type: 'full-reload', path: relativePath })
        return
      }

      for (const { boundary } of boundaries) {
        updates.push({
          type: boundary.type === 'css' ? 'css-update' : 'js-update',
          path: boundary.url,
          acceptedPath: affected.url,
          timestamp,
        })
      }
    }
  }

  if (updates.length > 0) {
    logger.info(
      updates
        .map((u) => pc.green('hmr update ') + pc.dim(u.path))
        .join('\n'),
      { timestamp: true },
    )
    ws.send({ type: 'update', updates })
  }
}
