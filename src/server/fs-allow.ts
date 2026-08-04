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

const linkedRootsCache = new Map<string, { roots: string[]; mtimeMs: number }>()

/** Cached discoverLinkedPackageRoots; invalidated when root/node_modules mtime changes. */
export function getLinkedPackageRoots(projectRoot: string): string[] {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(path.join(projectRoot, 'node_modules')).mtimeMs
  } catch {
    mtimeMs = 0
  }
  const cached = linkedRootsCache.get(projectRoot)
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.roots
  }
  const roots = discoverLinkedPackageRoots(projectRoot)
  linkedRootsCache.set(projectRoot, { roots, mtimeMs })
  return roots
}

/**
 * Clear the linked-roots cache. Call from the file watcher when any
 * `node_modules` tree changes (including nested ones under linked packages).
 */
export function clearLinkedPackageRootsCache(): void {
  linkedRootsCache.clear()
}

/**
 * Whether a realpath'd absolute file may be served via `/@modules/...?id=`.
 *
 * Allowed:
 *   1. under the project root (includes the app's own `node_modules`)
 *   2. under a `node_modules` directory on the walk up from the project root
 *      (monorepo-hoisted stores such as `<repo>/node_modules/.pnpm/...`)
 *   3. under a workspace / file: package linked from the project's
 *      node_modules tree (realpath leaves node_modules)
 *
 * A forged path that merely contains a `node_modules` segment under an
 * unrelated directory (e.g. `/tmp/other/node_modules/x`) is rejected.
 */
export function isAllowedDevModulePath(realId: string, projectRoot: string): boolean {
  if (realId === projectRoot || isUnderRoot(realId, projectRoot)) return true
  for (const pkgRoot of getLinkedPackageRoots(projectRoot)) {
    if (realId === pkgRoot || realId.startsWith(pkgRoot + path.sep)) return true
  }
  // Monorepo hoist: allow `<ancestor>/node_modules/...` while walking up from root.
  let dir = projectRoot
  for (;;) {
    const nm = path.join(dir, 'node_modules')
    if (realId === nm || realId.startsWith(nm + path.sep)) return true
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
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
