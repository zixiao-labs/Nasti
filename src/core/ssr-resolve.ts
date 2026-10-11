import path from 'node:path'
import type { ResolveConfig } from '../types.js'

export function getSsrConditions(conditions: string[]): string[] {
  return [...new Set([
    ...conditions.filter((condition) => condition !== 'require'),
    'node',
    'import',
  ])]
}

/** Use the same native package resolver and high-level options as SSR builds. */
export async function resolveSsrDependency(
  root: string,
  resolve: Required<ResolveConfig>,
  source: string,
  importer?: string,
): Promise<string | null> {
  const { ResolverFactory } = await import('rolldown/experimental')
  // A short-lived resolver cannot retain a missing-file/package result across
  // watcher events or require unsafe clearCache() during concurrent resolution.
  const resolver = new ResolverFactory({
    conditionNames: getSsrConditions(resolve.conditions),
    mainFields: resolve.mainFields,
    extensions: resolve.extensions,
    // Match Rolldown's NodeNext source convention for packages exporting .js
    // paths while shipping TypeScript sources, preferring an exact JS file.
    extensionAlias: {
      '.js': ['.js', '.ts', '.tsx'],
      '.jsx': ['.jsx', '.tsx'],
      '.mjs': ['.mjs', '.mts'],
      '.cjs': ['.cjs', '.cts'],
    },
  })
  const directory = importer && path.isAbsolute(importer)
    ? path.dirname(importer.split('?')[0])
    : root
  const result = await resolver.async(directory, source)
  return result.path ?? null
}
