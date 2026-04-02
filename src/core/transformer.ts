// OXC Transform 封装 - 高性能 TS/JSX/TSX 转译
import { transformSync } from 'oxc-transform'

export interface TransformOptions {
  jsx?: boolean
  jsxRuntime?: 'automatic' | 'classic'
  jsxImportSource?: string
  typescript?: boolean
  sourcemap?: boolean
  reactRefresh?: boolean
}

export interface TransformOutput {
  code: string
  map: string | null
}

const JS_EXTENSIONS = /\.(js|mjs|cjs)$/
const TS_EXTENSIONS = /\.(ts|mts|cts)$/
const JSX_EXTENSIONS = /\.(jsx|tsx)$/
const VUE_EXTENSION = /\.vue$/

export function shouldTransform(id: string): boolean {
  return (
    TS_EXTENSIONS.test(id) ||
    JSX_EXTENSIONS.test(id) ||
    (JS_EXTENSIONS.test(id) && false) // JS 文件默认不转译，除非包含 JSX
  )
}

export function transformCode(
  filename: string,
  code: string,
  options: TransformOptions = {},
): TransformOutput {
  const isTS = TS_EXTENSIONS.test(filename) || /\.tsx$/.test(filename)
  const isJSX = JSX_EXTENSIONS.test(filename)

  const result = transformSync(filename, code, {
    typescript: isTS ? {} : undefined,
    jsx: isJSX || /\.tsx$/.test(filename)
      ? {
          runtime: options.jsxRuntime ?? 'automatic',
          importSource: options.jsxImportSource ?? 'react',
          refresh: options.reactRefresh ?? false,
        }
      : undefined,
    sourcemap: options.sourcemap ?? true,
  })

  if (result.errors && result.errors.length > 0) {
    const msg = result.errors.map((e: any) => e.message ?? String(e)).join('\n')
    throw new Error(`OXC transform failed for ${filename}:\n${msg}`)
  }

  return {
    code: result.code,
    map: result.map ? JSON.stringify(result.map) : null,
  }
}

/** 获取文件的模块类型 */
export function getModuleType(id: string): 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'json' | 'vue' | 'asset' {
  if (/\.tsx$/.test(id)) return 'tsx'
  if (/\.ts$/.test(id) || /\.mts$/.test(id)) return 'ts'
  if (/\.jsx$/.test(id)) return 'jsx'
  if (/\.css$/.test(id)) return 'css'
  if (/\.json$/.test(id)) return 'json'
  if (VUE_EXTENSION.test(id)) return 'vue'
  if (JS_EXTENSIONS.test(id)) return 'js'
  return 'asset'
}
