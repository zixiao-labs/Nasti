// Filesystem allowlist helpers for the unbundled dev server.
//
// pnpm (and yarn/npm) workspaces link packages into node_modules as symlinks
// whose realpath sits *outside* the app root (e.g. apps/web → packages/ui).
// Several paths need to treat those linked roots as first-class:
//   - `/@modules/...?id=` security checks (otherwise transitive workspace
//     deps 404 after realpath leaves node_modules)
//   - chokidar watch targets (otherwise edits in packages/* never HMR)
import fs from 'node:fs'
import path from 'node:path'

/** True when `abs` is a real file/dir strictly inside `root` (not root itself). */
export function isUnderRoot(abs: string, root: string): boolean {
  const rel = path.relative(root, abs)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const NM = `${path.sep}node_modules${path.sep}`

/**
 * Walk `node_modules` from `projectRoot` (and nested package roots) following
 * symlinks. Return real paths of packages that live *outside* the project root
 * and outside any `node_modules` tree — i.e. workspace / `file:` linked
 * packages. Regular pnpm store entries (under `.pnpm/.../node_modules/`) are
 * skipped: they are not user-editable watch targets and already pass the
 * `node_modules` segment check for `?id=`.
 */
export function discoverLinkedPackageRoots(
  projectRoot: string,
  maxDepth = 4,
): string[] {
  const results: string[] = []
  const seenReal = new Set<string>()
  const queued = new Set<string>([projectRoot])
  const queue: string[] = [projectRoot]

  for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
    const levelCount = queue.length
    for (let i = 0; i < levelCount; i++) {
      const dir = queue.shift()!
      const nm = path.join(dir, 'node_modules')
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(nm, { withFileTypes: true })
      } catch {
        continue
      }

      for (const ent of entries) {
        // Skip pnpm / yarn internals and bins — walking `.pnpm` would explode
        // into the whole store without finding additional workspace roots.
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue

        const pkgNames = ent.name.startsWith('@')
          ? listScopedPackages(nm, ent.name)
          : [ent.name]

        for (const pkgName of pkgNames) {
          const pkgPath = path.join(nm, pkgName)
          let real: string
          try {
            real = fs.realpathSync(pkgPath)
          } catch {
            continue
          }
          if (seenReal.has(real)) continue
          seenReal.add(real)

          // Always enqueue so transitive workspace deps (A → B, app only
          // depends on A) are discovered via A's own node_modules.
          if (!queued.has(real)) {
            queued.add(real)
            queue.push(real)
          }

          if (
            real !== projectRoot &&
            !isUnderRoot(real, projectRoot) &&
            !real.includes(NM)
          ) {
            results.push(real)
          }
        }
      }
    }
  }

  return results
}

function listScopedPackages(nm: string, scope: string): string[] {
  try {
    return fs
      .readdirSync(path.join(nm, scope))
      .filter((name) => !name.startsWith('.'))
      .map((name) => path.join(scope, name))
  } catch {
    return []
  }
}

let linkedRootsCache: { root: string; roots: string[]; mtimeMs: number } | null =
  null

/** Cached discoverLinkedPackageRoots; invalidated when root/node_modules mtime changes. */
export function getLinkedPackageRoots(projectRoot: string): string[] {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(path.join(projectRoot, 'node_modules')).mtimeMs
  } catch {
    mtimeMs = 0
  }
  if (
    linkedRootsCache &&
    linkedRootsCache.root === projectRoot &&
    linkedRootsCache.mtimeMs === mtimeMs
  ) {
    return linkedRootsCache.roots
  }
  const roots = discoverLinkedPackageRoots(projectRoot)
  linkedRootsCache = { root: projectRoot, roots, mtimeMs }
  return roots
}

/** Clear the linked-roots cache (tests). */
export function clearLinkedPackageRootsCache(): void {
  linkedRootsCache = null
}

/**
 * Whether a realpath'd absolute file may be served via `/@modules/...?id=`.
 *
 * Allowed:
 *   1. anywhere under a `node_modules` segment (npm / pnpm store)
 *   2. under the project root
 *   3. under a workspace / file: package linked from the project's
 *      node_modules tree (realpath leaves node_modules)
 */
export function isAllowedDevModulePath(realId: string, projectRoot: string): boolean {
  if (realId.includes(NM)) return true
  if (isUnderRoot(realId, projectRoot)) return true
  for (const pkgRoot of getLinkedPackageRoots(projectRoot)) {
    if (realId === pkgRoot || realId.startsWith(pkgRoot + path.sep)) return true
  }
  return false
}

/**
 * Walk up from `file` looking for the nearest directory with a package.json
 * that has a `name` field (a package root).
 */
export function findNearestPackageRoot(file: string): string | null {
  let dir = path.dirname(file)
  for (;;) {
    const pkgJson = path.join(dir, 'package.json')
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'))
        if (typeof pkg?.name === 'string' && pkg.name) return dir
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
