// 模块依赖图 - 用于 HMR 追踪模块关系

import type { ModuleNode, TransformResult } from '../types.js'
import { removeTimestampQuery } from './url.js'

export class ModuleGraph {
  readonly environmentName: string
  private urlToModuleMap = new Map<string, ModuleNode>()
  private idToModuleMap = new Map<string, ModuleNode>()
  private fileToModulesMap = new Map<string, Set<ModuleNode>>()

  constructor(environmentName = 'client') {
    this.environmentName = environmentName
  }

  getModuleByUrl(url: string): ModuleNode | undefined {
    return this.urlToModuleMap.get(removeTimestampQuery(url))
  }

  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(id)
  }

  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  /**
   * Modules whose registered entry file lives under `dir` (inclusive).
   * Used when a non-entry source inside a prebundled workspace package changes:
   * only the package entry was registered, so getModulesByFile(changedFile)
   * misses — we invalidate every /@modules entry rooted in that package.
   */
  getModulesWithFileUnder(dir: string): Set<ModuleNode> {
    const result = new Set<ModuleNode>()
    // Normalize separators so Windows-stored paths still match.
    const normDir = dir.replace(/\\/g, '/')
    const normPrefix = normDir.endsWith('/') ? normDir : normDir + '/'
    for (const [file, mods] of this.fileToModulesMap) {
      const normFile = file.replace(/\\/g, '/')
      if (normFile === normDir || normFile.startsWith(normPrefix)) {
        for (const m of mods) result.add(m)
      }
    }
    return result
  }

  async ensureEntryFromUrl(url: string): Promise<ModuleNode> {
    const normalizedUrl = removeTimestampQuery(url)
    let mod = this.urlToModuleMap.get(normalizedUrl)
    if (mod) return mod

    mod = this.createModule(normalizedUrl)
    this.urlToModuleMap.set(normalizedUrl, mod)
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
      invalidationVersion: 0,
      isSelfAccepting: false,
      environment: this.environmentName,
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

  /**
   * Reindex a module under a plugin-provided canonical id (e.g. a `\0virtual:foo`
   * id returned from `resolveId`). Plugins look up their own virtual modules via
   * `getModuleById(RESOLVED_ID)` to invalidate them on watcher events; without
   * this remap they'd never find the node because `ensureEntryFromUrl` keys by
   * the public URL only.
   */
  setModuleId(mod: ModuleNode, id: string): void {
    if (mod.id === id) return
    this.idToModuleMap.delete(mod.id)
    mod.id = id
    this.idToModuleMap.set(id, mod)
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

  /**
   * 用一次转换得到的信息原子更新 import 与 HMR accept 关系。
   * 依赖节点会在真正被浏览器请求前预先创建，这样入口模块先转换时也能建立完整图。
   */
  async updateModuleInfo(
    mod: ModuleNode,
    importedUrls: Set<string>,
    acceptedUrls: Set<string>,
    isSelfAccepting: boolean,
    expectedInvalidationVersion?: number,
  ): Promise<Set<ModuleNode> | null> {
    const importedModules = await Promise.all(
      [...importedUrls].map((url) => this.ensureEntryFromUrl(url)),
    )
    const acceptedModules = await Promise.all(
      [...acceptedUrls].map((url) => this.ensureEntryFromUrl(url)),
    )

    // 异步插件转换期间若又发生文件变更，旧结果不能覆盖新模块图或转换缓存。
    if (
      expectedInvalidationVersion !== undefined &&
      mod.invalidationVersion !== expectedInvalidationVersion
    ) {
      return null
    }

    const previousImports = new Set(mod.importedModules)
    for (const imported of previousImports) {
      imported.importers.delete(mod)
    }
    mod.importedModules.clear()
    mod.acceptedHmrDeps.clear()

    for (const imported of importedModules) {
      mod.importedModules.add(imported)
      imported.importers.add(mod)
    }
    for (const accepted of acceptedModules) {
      mod.acceptedHmrDeps.add(accepted)
    }
    mod.isSelfAccepting = isSelfAccepting

    const pruned = new Set<ModuleNode>()
    for (const imported of previousImports) {
      if (!mod.importedModules.has(imported) && imported.importers.size === 0) {
        pruned.add(imported)
      }
    }
    return pruned
  }

  /** 使模块的转换缓存失效 */
  invalidateModule(mod: ModuleNode, timestamp = Date.now()): void {
    mod.transformResult = null
    mod.lastHMRTimestamp = timestamp
    mod.invalidationVersion++
  }

  /**
   * 仅失效到 HMR 边界：显式接受依赖的模块本身不会重执行；自接受模块需要失效，
   * 但不再继续影响其 importer。这样既能传播依赖时间戳，也不会隐式重复副作用。
   */
  invalidateModuleAndImporters(
    mod: ModuleNode,
    timestamp = Date.now(),
    seen = new Set<ModuleNode>(),
  ): void {
    if (seen.has(mod)) return
    seen.add(mod)
    this.invalidateModule(mod, timestamp)
    for (const importer of mod.importers) {
      if (importer.acceptedHmrDeps.has(mod)) continue
      if (importer.isSelfAccepting) {
        this.invalidateModule(importer, timestamp)
        continue
      }
      this.invalidateModuleAndImporters(importer, timestamp, seen)
    }
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
    const traversed = new Set<ModuleNode>()

    const addBoundary = (boundary: ModuleNode, acceptedVia: ModuleNode): void => {
      if (!boundaries.some((item) =>
        item.boundary === boundary && item.acceptedVia === acceptedVia
      )) {
        boundaries.push({ boundary, acceptedVia })
      }
    }

    const propagate = (node: ModuleNode): boolean => {
      if (traversed.has(node)) return true
      traversed.add(node)

      // 自接受边界重新导入自身，而不是触发它的下游依赖。
      if (node.isSelfAccepting) {
        addBoundary(node, node)
        return true
      }
      if (node.importers.size === 0) return false

      for (const importer of node.importers) {
        // 显式 accept 在进入 importer 前判断，所以被接受的分支不会污染 traversed；
        // 菱形图中的其他未接受分支仍会继续传播并正确发现死路。
        if (importer.acceptedHmrDeps.has(node)) {
          addBoundary(importer, node)
          continue
        }
        if (!propagate(importer)) return false
      }
      return true
    }

    return propagate(mod) ? boundaries : []
  }
}
