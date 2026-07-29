// 模块解析插件 - 处理 bare imports、路径 alias、文件扩展名
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { NastiPlugin, ResolvedConfig } from '../types.js'

export function resolvePlugin(config: ResolvedConfig): NastiPlugin {
  const { alias, extensions } = config.resolve
  const require = createRequire(path.resolve(config.root, 'package.json'))

  // 长 key 优先，避免 `@` 抢在 `@/utils` 之前
  const aliasEntries = Object.entries(alias).sort(
    ([a], [b]) => b.length - a.length,
  )

  // Vue：require.resolve('vue') 走 CJS 解析，命中 `main` 指向的「含编译器全量构建」。
  // 预编译 SFC 的应用只需 runtime，应指向 `module` 字段的 runtime-only esm-bundler 构建，
  // 否则整套模板编译器（~500kB）会被打进生产包。仅在 framework==='vue' 时启用，且只对
  // **精确** 的 `vue` specifier 生效（不影响 `vue/xxx` 子路径）。启动时解析一次并缓存。
  let vueRuntimeEntry: string | null = null
  if (config.framework === 'vue') {
    try {
      const vuePkgJson = require.resolve('vue/package.json', { paths: [config.root] })
      const vueDir = path.dirname(vuePkgJson)
      const mod = JSON.parse(fs.readFileSync(vuePkgJson, 'utf-8')).module as string | undefined
      const entry = path.join(vueDir, mod ?? 'dist/vue.runtime.esm-bundler.js')
      if (fs.existsSync(entry)) vueRuntimeEntry = entry
    } catch {
      /* vue 尚未安装（如 configResolved 阶段）：忽略，回落到默认解析 */
    }
  }

  return {
    name: 'nasti:resolve',
    enforce: 'pre',

    resolveId(source, importer) {
      // 1. alias —— 优先：直接解析到磁盘上的目标文件
      for (const [key, value] of aliasEntries) {
        if (source === key || source.startsWith(key + '/')) {
          const aliasBase = resolveAliasTarget(value, config.root)
          const sub = source.slice(key.length).replace(/^\//, '')
          const target = sub ? path.join(aliasBase, sub) : aliasBase
          const resolved = tryResolveFile(target, extensions)
          if (resolved) return resolved
          // alias 未命中实际文件：跳出循环走下游分支，避免把 `@/x` 误当作 bare import
          break
        }
      }

      // 2. 项目根相对路径（Vite 约定）：`/src/...` 指向 <root>/src/...
      //    chen-the-dawnstreak 的虚拟路由模块会生成这种 import。
      //    必须排在「真正绝对路径」分支前 —— Unix 下二者无法靠 path.isAbsolute 区分。
      if (source.startsWith('/') && !source.startsWith('//')) {
        const rootRelative = path.join(config.root, source.slice(1))
        const resolved = tryResolveFile(rootRelative, extensions)
        if (resolved) return resolved
      }

      // 3. 真正的文件系统绝对路径（Windows `C:\…` 或已被其它插件解析过的 Unix 路径）
      if (path.isAbsolute(source) && fs.existsSync(source)) {
        const resolved = tryResolveFile(source, extensions)
        if (resolved) return resolved
      }

      // 4. 相对路径
      if (source.startsWith('.')) {
        const dir = importer ? path.dirname(importer) : config.root
        const absolute = path.resolve(dir, source)
        const resolved = tryResolveFile(absolute, extensions)
        if (resolved) return resolved
      }

      // 5. bare import (node_modules)
      if (!source.startsWith('/') && !source.startsWith('.')) {
        // Vue runtime-only 重定向（见上方说明）
        if (vueRuntimeEntry && source === 'vue') return vueRuntimeEntry

        // build 必须交给 Rolldown 原生 resolver：它会使用当前 environment 的
        // conditionNames/mainFields。若在这里用 require.resolve 抢先解析，Lynx
        // BG/MT 等双 client-consumer 环境会错误命中同一套 Node 条件导出。
        if (config.command === 'build') return null

        try {
          const resolved = require.resolve(source, {
            paths: [importer ? path.dirname(importer) : config.root],
          })
          return resolved
        } catch {
          return null
        }
      }

      return null
    },

    load(id) {
      // 虚拟模块（Vite 约定的 `\0` 前缀）交给提供它的插件处理
      if (id.startsWith('\0')) return null
      if (!fs.existsSync(id)) return null
      // JSON 文件包装为 ES 模块
      if (id.endsWith('.json')) {
        const content = fs.readFileSync(id, 'utf-8')
        return `export default ${content}`
      }
      return fs.readFileSync(id, 'utf-8')
    },
  }
}

/**
 * 把 alias 值统一成磁盘绝对路径，匹配 dev server 的语义：
 *   - `/Users/.../src` 真正的绝对路径 → 直接用
 *   - `/src` 用户写的项目根相对 → 按 `<root>/src` 处理
 *   - 其余字符串相对 root 解析
 */
function resolveAliasTarget(value: string, root: string): string {
  if (path.isAbsolute(value) && fs.existsSync(value)) return value
  if (value.startsWith('/')) return path.join(root, value.slice(1))
  return path.resolve(root, value)
}

/** 尝试解析文件，带扩展名补全和 index 文件查找 */
function tryResolveFile(file: string, extensions: string[]): string | null {
  // 精确路径
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return file
  }

  // 尝试加扩展名
  for (const ext of extensions) {
    const withExt = file + ext
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt
    }
  }

  // 尝试作为目录查找 index 文件
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    for (const ext of extensions) {
      const indexFile = path.join(file, 'index' + ext)
      if (fs.existsSync(indexFile)) {
        return indexFile
      }
    }
  }

  return null
}
