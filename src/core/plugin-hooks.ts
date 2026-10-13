import { code as codeExpression, exprInterpreter, id as idExpression, interpreter } from 'rolldown/filter'
import type { NastiPlugin } from '../types.js'

export type RolldownHookName =
  | 'resolveId'
  | 'load'
  | 'transform'
  | 'buildStart'
  | 'buildEnd'
  | 'closeBundle'
  | 'renderChunk'
  | 'augmentChunkHash'
  | 'generateBundle'

export interface PluginHook {
  handler: (...args: any[]) => any
  order?: 'pre' | 'post' | null
  filter?: unknown
  objectHook?: Record<string, unknown>
}

export interface OrderedPluginHook {
  plugin: NastiPlugin
  hook: PluginHook
}

/**
 * Resolve either Rolldown hook syntax to a callable handler. Object metadata is
 * kept separate so the build adapter can forward it unchanged to Rolldown.
 */
export function getPluginHook(plugin: NastiPlugin, name: RolldownHookName): PluginHook | undefined {
  const value = (plugin as unknown as Record<string, unknown>)[name]
  if (value == null) return undefined

  if (typeof value === 'function') {
    return { handler: value as PluginHook['handler'] }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `[nasti] plugin "${plugin.name}" has an invalid "${name}" hook; expected a function or an object with a handler function`,
    )
  }

  const objectHook = value as Record<string, unknown>
  if (typeof objectHook.handler !== 'function') {
    throw new TypeError(
      `[nasti] plugin "${plugin.name}" has an invalid "${name}" hook; expected a function or an object with a handler function`,
    )
  }
  if (
    objectHook.order !== undefined &&
    objectHook.order !== null &&
    objectHook.order !== 'pre' &&
    objectHook.order !== 'post'
  ) {
    throw new TypeError(
      `[nasti] plugin "${plugin.name}" has an invalid "${name}" hook order "${String(objectHook.order)}"; expected "pre" or "post"`,
    )
  }

  return {
    handler: objectHook.handler as PluginHook['handler'],
    order: objectHook.order as PluginHook['order'],
    filter: objectHook.filter,
    objectHook,
  }
}

/**
 * Per-hook `order` takes precedence over plugin insertion order. Stable sorting
 * preserves the resolved plugin order within each bucket.
 */
export function getOrderedPluginHooks(
  plugins: NastiPlugin[],
  name: RolldownHookName,
): OrderedPluginHook[] {
  return plugins
    .map((plugin, index) => ({ plugin, index, hook: getPluginHook(plugin, name) }))
    .filter((item): item is typeof item & { hook: PluginHook } => item.hook !== undefined)
    .sort((a, b) => hookOrderRank(a.hook.order) - hookOrderRank(b.hook.order) || a.index - b.index)
    .map(({ plugin, hook }) => ({ plugin, hook }))
}

export interface HookFilterContext {
  id?: string
  code?: string
  moduleType?: string
}

/** Match Rolldown's hook filter form in Nasti's custom development pipeline. */
export function pluginHookFilterMatches(
  filter: unknown,
  context: HookFilterContext,
): boolean {
  if (filter == null) return true

  if (Array.isArray(filter)) {
    return interpreter(
      filter as Parameters<typeof interpreter>[0],
      context.code,
      context.id,
      context.moduleType as Parameters<typeof interpreter>[3],
    )
  }
  if (typeof filter !== 'object' || filter instanceof RegExp) {
    throw new TypeError('[nasti] plugin hook filter must be an object or a Rolldown filter expression array')
  }

  const fields = filter as Record<string, unknown>
  return matchesGeneralFilter(fields.id, idExpression, context) &&
    matchesGeneralFilter(fields.code, codeExpression, context) &&
    matchesModuleTypeFilter(fields.moduleType, context.moduleType)
}

function matchesGeneralFilter(
  filter: unknown,
  createExpression: typeof idExpression | typeof codeExpression,
  context: HookFilterContext,
): boolean {
  if (filter === undefined) return true

  const filterObject = isFilterObject(filter) ? filter as Record<string, unknown> : undefined
  const include = filterObject ? filterObject.include : filter
  const exclude = filterObject?.exclude

  const matches = (pattern: unknown) => {
    if (typeof pattern !== 'string' && !(pattern instanceof RegExp)) {
      throw new TypeError('[nasti] plugin hook filter patterns must be strings or regular expressions')
    }
    return exprInterpreter(
      createExpression(pattern) as Parameters<typeof exprInterpreter>[0],
      context.code,
      context.id,
      context.moduleType as Parameters<typeof exprInterpreter>[3],
    )
  }

  const includes = asArray(include)
  const excludes = asArray(exclude)
  return (include === undefined || includes.some(matches)) && !excludes.some(matches)
}

function matchesModuleTypeFilter(filter: unknown, moduleType: string | undefined): boolean {
  if (filter === undefined) return true
  if (Array.isArray(filter)) return filter.includes(moduleType)
  if (typeof filter !== 'object' || filter === null) {
    throw new TypeError('[nasti] plugin hook moduleType filter must be an array or an object with include')
  }

  const include = (filter as { include?: unknown }).include
  if (include === undefined) return true
  if (!Array.isArray(include) || include.some((item) => typeof item !== 'string')) {
    throw new TypeError('[nasti] plugin hook moduleType.include must be an array of strings')
  }
  return include.includes(moduleType)
}

function isFilterObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof RegExp)
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function hookOrderRank(order: PluginHook['order']): number {
  if (order === 'pre') return 0
  if (order === 'post') return 2
  return 1
}
