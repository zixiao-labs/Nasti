import fs from 'node:fs'
import path from 'node:path'
import type {
  AppBuildOutput,
  BuildAppContext,
  EnvironmentBuildOutput,
  EnvironmentBuildResult,
  ResolvedConfig,
} from '../types.js'

export function createBuildAppContext(
  config: ResolvedConfig,
  results: Record<string, EnvironmentBuildResult>,
): BuildAppContext {
  const output: AppBuildOutput[] = []
  const emitted = new Set<string>()
  const outDir = path.resolve(config.root, config.build.outDir)
  let environmentArtifacts: Set<string> | undefined

  return {
    config,
    results,
    get output() {
      return Object.freeze([...output])
    },

    getResult(environmentName) {
      return results[environmentName]
    },

    getArtifact(environmentName, fileName) {
      const normalized = normalizeEnvironmentFileName(fileName)
      return results[environmentName]?.output.find(
        (artifact) => normalizeEnvironmentFileName(artifact.fileName) === normalized,
      )
    },

    getEntry(environmentName, entryName) {
      const result = results[environmentName]
      const fileName = result?.entries?.[entryName]
      if (!fileName) return undefined
      return result.output.find(
        (artifact) =>
          normalizeEnvironmentFileName(artifact.fileName) ===
          normalizeEnvironmentFileName(fileName),
      )
    },

    getManifest<T = unknown>(environmentName: string): T | undefined {
      return results[environmentName]?.manifest as T | undefined
    },

    getChunk(environmentName, fileName) {
      const normalized = normalizeEnvironmentFileName(fileName)
      return results[environmentName]?.chunks?.[normalized]
    },

    getCss(environmentName) {
      return results[environmentName]?.css
    },

    getSourceMap(environmentName, fileName) {
      const normalized = normalizeEnvironmentFileName(fileName)
      return results[environmentName]?.sourceMaps?.[normalized]
    },

    resolvePublicPath(environmentName, fileName) {
      const result = results[environmentName]
      if (!result) return undefined
      const normalized = normalizeEnvironmentFileName(fileName)
      const base = result.publicPath ?? config.base
      return joinPublicPath(base, normalized)
    },

    emitFile(file) {
      const fileName = normalizeAppFileName(file.fileName)
      const collisionKey = artifactCollisionKey(fileName)
      if (emitted.has(collisionKey)) {
        throw new Error(`[nasti] app artifact already emitted: ${fileName}`)
      }
      environmentArtifacts ??= collectEnvironmentArtifacts(config, results, outDir)
      if (environmentArtifacts.has(collisionKey)) {
        throw new Error(`[nasti] app artifact conflicts with environment output: ${fileName}`)
      }

      const target = path.resolve(outDir, ...fileName.split('/'))
      const relative = path.relative(outDir, target)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`[nasti] app artifact must stay inside build.outDir: ${file.fileName}`)
      }
      assertNoSymlinkComponents(outDir, fileName)

      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.source)

      const artifact: AppBuildOutput = {
        ...file,
        fileName,
        type: 'asset',
      }
      emitted.add(collisionKey)
      output.push(artifact)
      return fileName
    },
  }
}

export function joinPublicPath(base: string, fileName: string): string {
  return `${base.endsWith('/') ? base : `${base}/`}${fileName.replace(/^\//, '')}`
}

export function normalizeEnvironmentFileName(fileName: string): string {
  return path.posix.normalize(fileName.replace(/\\/g, '/').replace(/^\.\//, ''))
}

export function isInvalidEnvironmentFileName(fileName: string): boolean {
  return (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.startsWith('../') ||
    path.posix.isAbsolute(fileName) ||
    /^[A-Za-z]:\//.test(fileName)
  )
}

function normalizeAppFileName(fileName: string): string {
  const normalized = normalizeEnvironmentFileName(fileName)
  if (isInvalidEnvironmentFileName(normalized)) {
    throw new Error(`[nasti] invalid app artifact fileName: ${fileName}`)
  }
  return normalized
}

function artifactCollisionKey(fileName: string): string {
  // 在大小写敏感文件系统上也采取保守策略，避免产物发布到 macOS/Windows 后冲突。
  return normalizeEnvironmentFileName(fileName).toLowerCase()
}

function collectEnvironmentArtifacts(
  config: ResolvedConfig,
  results: Record<string, EnvironmentBuildResult>,
  appOutDir: string,
): Set<string> {
  const occupied = new Set<string>()
  for (const [environmentName, result] of Object.entries(results)) {
    const environment = config.environments[environmentName]
    if (!environment) continue
    const environmentOutDir = path.resolve(config.root, environment.build.outDir)
    for (const artifact of result.output) {
      const artifactPath = path.resolve(
        environmentOutDir,
        ...normalizeEnvironmentFileName(artifact.fileName).split('/'),
      )
      const relative = path.relative(appOutDir, artifactPath)
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        occupied.add(artifactCollisionKey(relative))
      }
    }
  }
  return occupied
}

function assertNoSymlinkComponents(outDir: string, fileName: string): void {
  let current = outDir
  for (const segment of fileName.split('/')) {
    current = path.join(current, segment)
    let stats: ReturnType<typeof fs.lstatSync>
    try {
      // lstat sees dangling symlinks while existsSync does not.
      stats = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`[nasti] app artifact path cannot traverse a symlink: ${fileName}`)
    }
  }
}

export function inferEnvironmentEntries(
  output: EnvironmentBuildOutput[],
): Record<string, string> | undefined {
  const entries: Record<string, string> = {}
  for (const artifact of output as Array<EnvironmentBuildOutput & { isEntry?: boolean; name?: string }>) {
    if (artifact.type !== 'chunk' || !artifact.isEntry || !artifact.name) continue
    entries[artifact.name] = normalizeEnvironmentFileName(artifact.fileName)
  }
  return Object.keys(entries).length > 0 ? entries : undefined
}
