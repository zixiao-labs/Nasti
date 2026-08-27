// OXC Transform 封装 - 高性能 TS/JSX/TSX 转译
import { transformSync } from 'oxc-transform'
import type { ReactFileFilter, ResolvedReactOptions } from '../types.js'

export interface TransformOptions {
  jsx?: boolean
  jsxRuntime?: 'automatic' | 'classic'
  jsxImportSource?: string
  typescript?: boolean
  sourcemap?: boolean
  reactRefresh?: boolean
  target?: string | string[]
}

export interface TransformOutput {
  code: string
  map: string | null
}

export interface ReactTransformOptions {
  react: ResolvedReactOptions
  consumer: 'client' | 'server'
  development: boolean
  reactRefresh?: boolean
  sourcemap?: boolean
  target?: string | string[]
  onWarning?: (message: string) => void
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
    target: options.target,
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

/** 与 @vitejs/plugin-react 一致的线性预筛选，宁可误报也不漏掉组件或 Hook。 */
export const defaultReactCompilerCodeFilter = /forwardRef|memo|\b(?:[A-Z]|use[A-Z0-9])/

let reactCompilerImplementation:
  | typeof import('oxc-transform-react')
  | undefined

/**
 * React 专用转换入口。默认仍走既有同步 OXC 管线；仅在显式开启 Compiler 时
 * 加载可选的原生编译器，并且只对 client consumer 启用 memo 编译。
 */
export async function transformReactCode(
  filename: string,
  code: string,
  options: ReactTransformOptions,
): Promise<TransformOutput | null> {
  if (!matchesReactFilter(filename, options.react.include, options.react.exclude)) {
    return null
  }

  if (!options.react.compiler) {
    if (!shouldTransform(filename)) return null
    return transformCode(filename, code, {
      sourcemap: options.sourcemap,
      jsxRuntime: options.react.jsxRuntime,
      jsxImportSource: options.react.jsxImportSource,
      reactRefresh: options.reactRefresh,
      target: options.target,
    })
  }

  const compiler = await loadReactCompiler()
  const compilerOptions = options.react.compiler
  const shouldCompile =
    options.consumer === 'client' &&
    (compilerOptions.compilationMode === 'annotation'
      ? /['"]use memo['"]/.test(code)
      : defaultReactCompilerCodeFilter.test(code))
  const result = await compiler.transform(cleanTransformId(filename), code, {
    jsx: {
      runtime: options.react.jsxRuntime,
      development: options.development,
      importSource: options.react.jsxImportSource,
      refresh: options.consumer === 'client' && !!options.reactRefresh,
    },
    reactCompiler: shouldCompile
      ? compilerOptions as import('oxc-transform-react').ReactCompilerOptions
      : false,
    sourcemap: options.sourcemap ?? true,
  })
  const diagnostics = result.errors.map(
    (error) => `${error.message}${error.codeframe ? `\n${error.codeframe}` : ''}`,
  )
  if (result.fatal) {
    throw new Error(
      diagnostics.join('\n\n') || `React Compiler transform failed for ${filename}`,
    )
  }
  for (const diagnostic of diagnostics) options.onWarning?.(diagnostic)
  return {
    code: result.code,
    map: result.map ? JSON.stringify(result.map) : null,
  }
}

export function matchesReactFilter(
  id: string,
  include: ReactFileFilter,
  exclude: ReactFileFilter,
): boolean {
  const cleanId = cleanTransformId(id)
  return matchesFilter(cleanId, include) && !matchesFilter(cleanId, exclude)
}

function matchesFilter(id: string, filter: ReactFileFilter): boolean {
  const patterns = Array.isArray(filter) ? filter : [filter]
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0
      return pattern.test(id)
    }
    if (!pattern.includes('*')) return id.includes(pattern)
    const expression = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\0')
      .replace(/\*/g, '[^/]*')
      .replace(/\0/g, '.*')
    return new RegExp(`^${expression}$`).test(id)
  })
}

function cleanTransformId(id: string): string {
  return id.split(/[?#]/, 1)[0]
}

async function loadReactCompiler(): Promise<typeof import('oxc-transform-react')> {
  if (reactCompilerImplementation) return reactCompilerImplementation
  try {
    reactCompilerImplementation = await import('oxc-transform-react')
    return reactCompilerImplementation
  } catch (error) {
    throw new Error(
      '[nasti] React Compiler requires the optional "oxc-transform-react" package. ' +
        'Install it before setting react.compiler.' +
        (error instanceof Error ? `\n${error.message}` : ''),
    )
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
