import path from 'node:path'
import { builtinModules } from 'node:module'
import type { InputOptions } from 'rolldown'
import type { ResolveConfig } from '../types.js'

export const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])

export function isBareImport(id: string): boolean {
  return !id.startsWith('.') && !path.isAbsolute(id) &&
    !id.startsWith('\0') && !id.startsWith('virtual:') && !id.startsWith('#')
}

function matchesNoExternal(id: string, noExternal: ResolveConfig['noExternal']): boolean {
  if (noExternal === true) return true
  return (noExternal ?? []).some((pattern) => {
    if (typeof pattern !== 'string') {
      // Do not let stateful /g or /y expressions change the next resolution.
      return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(id)
    }
    if (!pattern.includes('*')) return id === pattern || id.startsWith(pattern + '/')
    const source = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^(?:${source})(?:/.*)?$`).test(id)
  })
}

/** One externalization policy for both the SSR runner and Rolldown builds. */
export function createSsrExternal(
  resolve: ResolveConfig,
  external?: InputOptions['external'],
): (id: string, importer: string | undefined, isResolved: boolean) => boolean {
  return (id, importer, isResolved) => {
    if (NODE_BUILTINS.has(id) || id.startsWith('node:')) return true
    // Preserve the existing low-level override: when supplied, external replaces
    // the default bare-import policy, rather than merely adding to it.
    if (typeof external === 'function') return !!external(id, importer, isResolved)
    if (external != null) {
      const patterns = Array.isArray(external) ? external : [external]
      return patterns.some((pattern) => typeof pattern === 'string'
        ? pattern === id
        : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(id))
    }
    // Aliases must reach the resolver before a bare name is handed to Node.
    if (Object.keys(resolve.alias ?? {}).some((key) => id === key || id.startsWith(key + '/'))) {
      return false
    }
    return isBareImport(id) && !matchesNoExternal(id, resolve.noExternal)
  }
}
