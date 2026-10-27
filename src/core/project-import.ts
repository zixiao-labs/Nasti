import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'import-meta-resolve'

/** Resolve optional tools from the consuming workspace, never Nasti's checkout. */
export function resolveProjectImport(root: string, specifier: string): string {
  try {
    return resolve(specifier, pathToFileURL(path.join(root, 'package.json')).href)
  } catch (cause) {
    throw new Error(
      `[nasti] Cannot resolve "${specifier}" from ${root}. Install it in the consuming workspace.`,
      { cause },
    )
  }
}

export async function importProjectPackage(root: string, specifier: string): Promise<any> {
  return import(resolveProjectImport(root, specifier))
}

/** Start's compiler host is not a public export. Deliberately pin its contract. */
export async function importStartCompiler(root: string): Promise<any> {
  const manifest = new URL(resolveProjectImport(root, '@tanstack/start-plugin-core/package.json'))
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (pkg.version !== '1.171.55') {
    throw new Error(
      `[nasti:start] Expected @tanstack/start-plugin-core@1.171.55, received ${pkg.version}. ` +
      'The native compiler host contract must be revalidated before upgrading.',
    )
  }
  const routerManifest = new URL(resolve('@tanstack/router-plugin/package.json', manifest.href))
  const routerPkg = JSON.parse(fs.readFileSync(routerManifest, 'utf8'))
  if (routerPkg.version !== '1.168.48') {
    throw new Error('[nasti:start] Expected @tanstack/router-plugin@1.168.48 for route isolation.')
  }
  const [host, routes] = await Promise.all([
    import(new URL('./dist/esm/start-compiler/host.js', manifest).href),
    import(new URL('./dist/esm/core/code-splitter/compilers.js', routerManifest).href),
  ])
  return { ...host, compileRoute: routes.compileCodeSplitReferenceRoute }
}
