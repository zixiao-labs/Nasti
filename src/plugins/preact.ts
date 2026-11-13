import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { transformCode } from '../core/transformer.js'
import { resolveProjectImport } from '../core/project-import.js'

/**
 * Compile JSX with Preact's automatic runtime and OXC's Refresh registration.
 * Prefresh implements the same registration/signature protocol; React's runtime
 * and HTML preamble must never be injected into a Preact environment.
 */
export function preactPlugin(config: ResolvedConfig): NastiPlugin {
  let refreshDependenciesChecked = false
  return {
    name: 'nasti:preact',
    transform: { order: 'post', handler(code, id) {
      const filename = id.split(/[?#]/, 1)[0]
      if (!/\.[cm]?[jt]sx?$/.test(filename)) return null
      const refresh = this.environment?.consumer !== 'server' &&
        config.command === 'serve' && config.mode === 'development' &&
        config.server.hmr !== false && !/[\\/]node_modules[\\/]/.test(filename)
      const result = transformCode(filename, code, {
        jsx: true,
        jsxRuntime: 'automatic',
        jsxImportSource: 'preact',
        reactRefresh: refresh,
        sourcemap: config.command === 'serve' || !!config.build.sourcemap,
        target: config.build.target,
      })
      const hasRegistration = /\$RefreshReg\$\(/.test(result.code)
      const hasSignature = /\$RefreshSig\$\(/.test(result.code)
      if (!refresh || (!hasRegistration && !hasSignature)) {
        return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
      }
      if (!refreshDependenciesChecked) {
        resolveProjectImport(config.root, '@prefresh/core')
        resolveProjectImport(config.root, '@prefresh/utils')
        refreshDependenciesChecked = true
      }
      const prelude = `import "@prefresh/core";
import { flush as __nasti_flush } from "@prefresh/utils";
const __nasti_previousReg = self.$RefreshReg$;
const __nasti_previousSig = self.$RefreshSig$;
self.$RefreshReg$ = (type, name) => self.__PREFRESH__.register(type, ${JSON.stringify(filename)} + " " + name);
self.$RefreshSig$ = () => {
  let savedType, hasCustomHooks = false, didCollectHooks = false;
  return (type, key, forceReset, getCustomHooks) => {
    if (typeof key === "string") {
      if (!savedType) {
        savedType = type;
        hasCustomHooks = typeof getCustomHooks === "function";
      }
      if (type != null) self.__PREFRESH__.sign(type, key, forceReset, getCustomHooks, "begin");
    } else if (!didCollectHooks && hasCustomHooks) {
      didCollectHooks = true;
      self.__PREFRESH__.sign(savedType, undefined, undefined, undefined, "needsHooks");
    }
    return type;
  };
};
`
      const suffix = `
self.$RefreshReg$ = __nasti_previousReg;
self.$RefreshSig$ = __nasti_previousSig;
${hasRegistration ? `if (import.meta.hot) {
  import.meta.hot.accept(() => {
    try { __nasti_flush(); }
    catch { import.meta.hot.invalidate(); }
  });
}` : ''}
`
      // Preserve OXC's original mappings after inserting the registration prelude.
      const map = result.map ? JSON.parse(result.map) : undefined
      if (map) map.mappings = ';'.repeat(prelude.split('\n').length - 1) + map.mappings
      return { code: prelude + result.code + suffix, map }
    } },
  }
}
