// 模块解析插件 - 处理 bare imports、路径 alias、文件扩展名
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { NastiPlugin, ResolvedConfig } from '../types.js'

export function resolvePlugin(config: ResolvedConfig): NastiPlugin {
  const { alias, extensions } = config.resolve
  const require = createRequire(path.resolve(config.root, 'package.json'))

  return {
    name: 'nasti:resolve',
    enforce: 'pre',

    resolveId(source, importer) {
      // 1. 处理 alias
      for (const [key, value] of Object.entries(alias)) {
        if (source === key || source.startsWith(key + '/')) {
          source = source.replace(key, value)
          // 如果 alias 值是绝对路径就直接用，否则相对于 root 解析
          if (!path.isAbsolute(source)) {
            source = path.resolve(config.root, source)
          }
          break
        }
      }

      // 2. 绝对路径
      if (path.isAbsolute(source)) {
        const resolved = tryResolveFile(source, extensions)
        if (resolved) return resolved
      }

      // 3. 相对路径
      if (source.startsWith('.')) {
        const dir = importer ? path.dirname(importer) : config.root
        const absolute = path.resolve(dir, source)
        const resolved = tryResolveFile(absolute, extensions)
        if (resolved) return resolved
      }

      // 4. bare import (node_modules)
      if (!source.startsWith('/') && !source.startsWith('.')) {
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
      // 读取文件内容
      if (fs.existsSync(id)) {
        return fs.readFileSync(id, 'utf-8')
      }
      return null
    },
  }
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
