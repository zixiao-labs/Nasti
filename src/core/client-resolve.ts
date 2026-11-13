import path from 'node:path'
import { ResolverFactory } from 'rolldown/experimental'
import type { ResolveConfig } from '../types.js'

function createClientResolver(resolve: Required<ResolveConfig>): ResolverFactory {
  return new ResolverFactory({
    conditionNames: resolve.conditions,
    mainFields: resolve.mainFields,
    extensions: resolve.extensions,
    aliasFields: ['browser'],
  })
}

function importerDirectory(root: string, importer?: string): string {
  return importer && path.isAbsolute(importer) ? path.dirname(importer.split('?')[0]) : root
}

/** Native browser resolution, shared by dependency entries and external edges. */
export async function resolveClientDependency(
  root: string,
  resolve: Required<ResolveConfig>,
  source: string,
  importer?: string,
): Promise<string | null> {
  const result = await createClientResolver(resolve).async(importerDirectory(root, importer), source)
  return result.path ?? null
}

/** Same native rules for the synchronous browser import / HMR URL rewriter. */
export function resolveClientDependencySync(
  root: string,
  resolve: Required<ResolveConfig>,
  source: string,
  importer?: string,
): string | null {
  const result = createClientResolver(resolve).sync(importerDirectory(root, importer), source)
  return result.path ?? null
}
