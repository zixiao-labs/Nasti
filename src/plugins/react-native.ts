import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { NastiPlugin, ResolvedConfig } from '../types.js'

const RN_ASSET_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ttf|otf|woff|woff2|mp4|mp3|wav|aac)(\?.*)?$/

// React Native 生态中始终需要外部化的包前缀
const RN_EXTERNAL_PREFIXES = [
  'react-native/',
  '@react-native/',
  '@react-native-community/',
  '@react-navigation/',
  'expo-',
]
const RN_ALWAYS_EXTERNAL = new Set(['react', 'react-native', 'expo'])

// JSX/TS 扩展名，平台变体查找顺序
const CODE_EXTS = ['.tsx', '.ts', '.jsx', '.js']

/**
 * Provides a plugin that adapts module resolution and asset handling for React Native projects.
 *
 * @param config - Resolved configuration whose `reactNative` field supplies:
 *   - `platform`: platform name used when probing platform-specific file variants (e.g., "ios", "android")
 *   - `external`: an array of package ids/prefixes the user requests to be treated as external
 * @returns A NastiPlugin that externalizes React Native/Expo core and prefixed ecosystem packages, resolves relative and absolute code imports by preferring `.<platform>` then `.native` variants (including index files) across common JS/TS extensions, and returns lightweight stub modules for static assets (images/fonts/media) exporting `{ uri, width: 0, height: 0 }`.
 */
export function reactNativePlugin(config: ResolvedConfig): NastiPlugin {
  const platform = config.reactNative.platform
  const userExternal = new Set(config.reactNative.external)
  const { alias } = config.resolve
  const require = createRequire(path.resolve(config.root, 'package.json'))

  return {
    name: 'nasti:react-native',
    enforce: 'pre',

    resolveId(source, importer) {
      // 外部化 react、react-native 及其生态包
      if (RN_ALWAYS_EXTERNAL.has(source) || userExternal.has(source)) {
        return { id: source, external: true }
      }
      for (const prefix of RN_EXTERNAL_PREFIXES) {
        if (source.startsWith(prefix)) {
          return { id: source, external: true }
        }
      }
      // Check userExternal for prefix matches
      for (const entry of userExternal) {
        if (source === entry || source.startsWith(entry)) {
          return { id: source, external: true }
        }
      }

      // 平台扩展名解析：.ios.tsx > .native.tsx > .tsx
      if (importer) {
        let abs: string | null = null

        // Handle relative or absolute paths
        if (source.startsWith('.') || path.isAbsolute(source)) {
          const dir = path.isAbsolute(source) ? path.dirname(source) : path.dirname(importer)
          abs = path.isAbsolute(source) ? source : path.resolve(dir, source)
        } else {
          // Handle aliased or bare imports - resolve to absolute path first
          let resolvedSource = source

          // Apply alias resolution
          for (const [key, value] of Object.entries(alias)) {
            if (resolvedSource === key || resolvedSource.startsWith(key + '/')) {
              resolvedSource = resolvedSource.replace(key, value)
              if (!path.isAbsolute(resolvedSource)) {
                resolvedSource = path.resolve(config.root, resolvedSource)
              }
              break
            }
          }

          // If still not absolute, try require.resolve
          if (!path.isAbsolute(resolvedSource)) {
            try {
              abs = require.resolve(resolvedSource, {
                paths: [path.dirname(importer)],
              })
            } catch {
              // Resolution failed, skip platform probing
              abs = null
            }
          } else {
            abs = resolvedSource
          }
        }

        if (abs) {
          // 去掉已有扩展名，得到 stem
          let stem = abs
          for (const ext of CODE_EXTS) {
            if (abs.endsWith(ext)) {
              stem = abs.slice(0, -ext.length)
              break
            }
          }

          for (const ext of CODE_EXTS) {
            const platformFile = `${stem}.${platform}${ext}`
            if (fs.existsSync(platformFile)) return platformFile
            const nativeFile = `${stem}.native${ext}`
            if (fs.existsSync(nativeFile)) return nativeFile
            const platformIndexFile = `${stem}/index.${platform}${ext}`
            if (fs.existsSync(platformIndexFile)) return platformIndexFile
            const nativeIndexFile = `${stem}/index.native${ext}`
            if (fs.existsSync(nativeIndexFile)) return nativeIndexFile
          }
        }
      }

      return null
    },

    load(id) {
      // 图片/字体等静态资源返回 stub，与 Metro 的 require() 数字 ID 行为兼容
      if (RN_ASSET_RE.test(id)) {
        const name = path.basename(id.split('?')[0])
        return `export default { uri: ${JSON.stringify(name)}, width: 0, height: 0 };`
      }
      return null
    },
  }
}