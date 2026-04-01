// 模块依赖图 - 用于 HMR 追踪模块关系

import type { ModuleNode, TransformResult } from '../types.js'

export class ModuleGraph {
  private urlToModuleMap = new Map<string, ModuleNode>()
  private idToModuleMap = new Map<string, ModuleNode>()
  private fileToModulesMap = new Map<string, Set<ModuleNode>>()

  getModuleByUrl(url: string): ModuleNode | undefined {
    return this.urlToModuleMap.get(url)
  }

  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(id)
  }

  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  async ensureEntryFromUrl(url: string): Promise<ModuleNode> {
    let mod = this.urlToModuleMap.get(url)
    if (mod) return mod

    mod = this.createModule(url)
    this.urlToModuleMap.set(url, mod)
    return mod
  }

  createModule(url: string, id?: string): ModuleNode {
    const mod: ModuleNode = {
      id: id ?? url,
      file: null,
      url,
      type: url.endsWith('.css') ? 'css' : 'js',
      importers: new Set(),
      importedModules: new Set(),
      acceptedHmrDeps: new Set(),
      transformResult: null,
      lastHMRTimestamp: 0,
      isSelfAccepting: false,
    }
    this.idToModuleMap.set(mod.id, mod)
    return mod
  }

  /** 注册文件路径到模块的映射 */
  registerModule(mod: ModuleNode, file: string): void {
    mod.file = file
    let mods = this.fileToModulesMap.get(file)
    if (!mods) {
      mods = new Set()
      this.fileToModulesMap.set(file, mods)
    }
    mods.add(mod)
  }

  /** 更新模块依赖关系 */
  updateModuleImports(mod: ModuleNode, importedIds: Set<string>): void {
    // 清除旧的导入关系
    for (const imported of mod.importedModules) {
      imported.importers.delete(mod)
    }
    mod.importedModules.clear()

    // 建立新的导入关系
    for (const id of importedIds) {
      const importedMod = this.idToModuleMap.get(id)
      if (importedMod) {
        mod.importedModules.add(importedMod)
        importedMod.importers.add(mod)
      }
    }
  }

  /** 使模块的转换缓存失效 */
  invalidateModule(mod: ModuleNode): void {
    mod.transformResult = null
    mod.lastHMRTimestamp = Date.now()
  }

  /** 使所有模块缓存失效 */
  invalidateAll(): void {
    for (const mod of this.idToModuleMap.values()) {
      this.invalidateModule(mod)
    }
  }

  /** 获取 HMR 传播边界 - 从变更模块向上遍历找到接受更新的边界 */
  getHmrBoundaries(mod: ModuleNode): { boundary: ModuleNode; acceptedVia: ModuleNode }[] {
    const boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[] = []
    const visited = new Set<ModuleNode>()

    const propagate = (node: ModuleNode, via: ModuleNode): boolean => {
      if (visited.has(node)) return true
      visited.add(node)

      // 如果模块自身接受热更新
      if (node.isSelfAccepting) {
        boundaries.push({ boundary: node, acceptedVia: via })
        return true
      }

      // 如果模块被其他模块作为 HMR 依赖接受
      if (node.acceptedHmrDeps.has(via)) {
        boundaries.push({ boundary: node, acceptedVia: via })
        return true
      }

      // 没有 importer 意味着到达了入口，需要 full reload
      if (node.importers.size === 0) return false

      // 向上传播
      for (const importer of node.importers) {
        if (!propagate(importer, node)) return false
      }
      return true
    }

    // 从自身开始，如果自身接受就直接返回
    if (mod.isSelfAccepting) {
      boundaries.push({ boundary: mod, acceptedVia: mod })
      return boundaries
    }

    // 否则向 importer 传播
    for (const importer of mod.importers) {
      if (!propagate(importer, mod)) {
        // 传播到了根模块，需要 full reload
        return []
      }
    }

    return boundaries
  }
}
