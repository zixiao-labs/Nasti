// 静态资源处理插件 - 图片、字体等
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { NastiPlugin, ResolvedConfig } from '../types.js'

const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.mp4', '.webm', '.ogg', '.mp3', '.wav', '.flac', '.aac',
  '.woff', '.woff2', '.eot', '.ttf', '.otf',
  '.pdf', '.txt',
])

export function assetsPlugin(config: ResolvedConfig): NastiPlugin {
  const emittedAssets = new Set<string>()

  return {
    name: 'nasti:assets',

    resolveId(source) {
      // 处理 ?url 和 ?raw 后缀
      if (source.endsWith('?url') || source.endsWith('?raw')) {
        return source
      }
      return null
    },

    load(id) {
      const ext = path.extname(id.replace(/\?.*$/, ''))

      // ?raw 查询: 返回文件原始内容
      if (id.endsWith('?raw')) {
        const file = id.slice(0, -4)
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf-8')
          return `export default ${JSON.stringify(content)}`
        }
      }

      // ?url 查询或静态资源扩展名: 返回 URL
      if (id.endsWith('?url') || ASSET_EXTENSIONS.has(ext)) {
        const file = id.replace(/\?.*$/, '')
        if (!fs.existsSync(file)) return null

        if (config.command === 'serve') {
          // Dev 模式: 返回相对于 root 的路径
          const url = '/' + path.relative(config.root, file)
          return `export default ${JSON.stringify(url)}`
        }

        // Build 模式: 计算内容哈希用于文件名
        const content = fs.readFileSync(file)
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8)
        const basename = path.basename(file, ext)
        const hashedName = `${config.build.assetsDir}/${basename}.${hash}${ext}`
        const environment = this.environment
        if (!environment) {
          throw new Error('[nasti:assets] build environment is not initialized')
        }
        if (!emittedAssets.has(hashedName)) {
          this.emitFile({
            type: 'asset',
            fileName: hashedName,
            source: content,
          })
          emittedAssets.add(hashedName)
        }
        environment.setAssetModule(file, hashedName)
        return `export default ${JSON.stringify(config.base + hashedName)}`
      }

      return null
    },
  }
}

export function isAssetFile(id: string): boolean {
  const ext = path.extname(id.replace(/\?.*$/, ''))
  return ASSET_EXTENSIONS.has(ext)
}
