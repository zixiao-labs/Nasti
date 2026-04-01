// 内置 React 插件 - JSX/TSX 转译 + React Fast Refresh HMR
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { transformCode } from '../core/transformer.js'

const REACT_FILE_RE = /\.[jt]sx$/

const FAST_REFRESH_PREAMBLE = `
import RefreshRuntime from '/@react-refresh';
if (!window.$RefreshReg$) {
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
}
`

const FAST_REFRESH_FOOTER = `
if (import.meta.hot) {
  import.meta.hot.accept();
  if (!window.__nasti_hmr_timeout) {
    window.__nasti_hmr_timeout = setTimeout(() => {
      window.__nasti_hmr_timeout = 0;
      if (window.$RefreshRuntime$) {
        window.$RefreshRuntime$.performReactRefresh();
      }
    }, 30);
  }
}
`

export function reactPlugin(config: ResolvedConfig): NastiPlugin {
  const isDev = config.command === 'serve'

  return {
    name: 'nasti:react',
    enforce: 'pre',

    resolveId(source) {
      if (source === '/@react-refresh') {
        return source
      }
      return null
    },

    load(id) {
      if (id === '/@react-refresh') {
        // 返回一个轻量的 React Refresh Runtime shim
        return `
export function createSignatureFunctionForTransform() {
  let savedType;
  let hasCustomHooks;
  let didCollectHooks = false;
  return function(type, key, forceReset, getCustomHooks) {
    savedType = type;
    hasCustomHooks = typeof getCustomHooks === 'function';
    return type;
  };
}
export function register(type, id) {
  // React Fast Refresh 注册
}
export function performReactRefresh() {
  // 触发 React 重新渲染
}
export default { createSignatureFunctionForTransform, register, performReactRefresh };
`
      }
      return null
    },

    transform(code, id) {
      if (!REACT_FILE_RE.test(id)) return null

      // 使用 oxc-transform 转译 JSX
      const result = transformCode(id, code, {
        jsx: true,
        jsxRuntime: 'automatic',
        jsxImportSource: 'react',
        typescript: /\.tsx$/.test(id),
        sourcemap: true,
        reactRefresh: isDev,
      })

      let transformedCode = result.code

      // Dev 模式注入 Fast Refresh
      if (isDev && hasJSXElement(code)) {
        transformedCode = FAST_REFRESH_PREAMBLE + transformedCode + FAST_REFRESH_FOOTER
      }

      return {
        code: transformedCode,
        map: result.map ? JSON.parse(result.map) : undefined,
      }
    },

    // React 组件 HMR: 自动标记为 self-accepting
    handleHotUpdate(ctx) {
      const { modules } = ctx
      for (const mod of modules) {
        if (REACT_FILE_RE.test(mod.url)) {
          mod.isSelfAccepting = true
        }
      }
      return modules
    },
  }
}

/** 简单检测代码是否包含 JSX 元素 */
function hasJSXElement(code: string): boolean {
  // 检测 JSX 语法: <Component 或 <div 等
  return /<[A-Za-z][A-Za-z0-9.]*[\s/>]/.test(code)
}
