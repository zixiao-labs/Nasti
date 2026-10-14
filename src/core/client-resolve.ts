import path from 'node:path'
import type { ResolveConfig } from '../types.js'

/** Native browser resolution, shared by dependency entries and external edges. */
export async function resolveClientDependency(
  root: string,
  resolve: Required<ResolveConfig>,
  source: string,
  importer?: string,
): Promise<string | null> {
  const { ResolverFactory } = await import('rolldown/experimental')
  const resolver = new ResolverFactory({
    conditionNames: resolve.conditions,
    mainFields: resolve.mainFields,
    extensions: resolve.extensions,
    aliasFields: ['browser'],
  })
  const directory = importer && path.isAbsolute(importer)
    ? path.dirname(importer.split('?')[0]) : root
  const result = await resolver.async(directory, source)
  return result.path ?? null
}
