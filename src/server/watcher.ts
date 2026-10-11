import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { FSWatcher, type ChokidarOptions } from 'chokidar'

function sameFile(left: Stats, right: Stats): boolean {
  return left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
}

type FileSnapshot = { file: string; stats: Stats }
type WatchOptions = ChokidarOptions & {
  ignored: (file: string, stats?: Stats) => boolean
}

/**
 * Chokidar 5 can discard the last native notification in its watch/change
 * throttle windows. In particular, a read's metadata notification can mask an
 * immediate write. Recheck only files signaled by the native backend, after the
 * burst, and share metadata with normal events to avoid duplicate changes.
 */
class DevWatcher extends FSWatcher {
  private files: Map<string, FileSnapshot>
  private pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: WatchOptions) {
    const files = new Map<string, FileSnapshot>()
    // The public ignored callback receives Chokidar's scan metadata even when
    // ignoreInitial suppresses add events. Capture accepted files here so both
    // startup and later watcher.add() retain normal ignoreInitial semantics,
    // without traversing/statting the tree twice.
    super({
      ...options,
      ignoreInitial: true,
      alwaysStat: true,
      ignored(file, stats) {
        if (options.ignored(file, stats)) return true
        if (stats?.isFile()) {
          const key = path.resolve(file)
          if (!files.has(key)) files.set(key, { file: path.normalize(file), stats })
        }
        return false
      },
    })
    this.files = files
    this.on('unlink', (file) => { this.files.delete(path.resolve(file)) })
    this.on('raw', (_event, name, details) => {
      const watchedPath = (details as { watchedPath?: unknown })?.watchedPath
      if (this.closed || typeof watchedPath !== 'string') return
      // Native backends report either the file itself or its parent directory.
      const watched = path.resolve(watchedPath)
      this.schedule(watched)
      if (typeof name === 'string') this.schedule(path.resolve(watched, name))
    })
  }

  override emitWithAll(...[event, args]: Parameters<FSWatcher['emitWithAll']>): void {
    const [file, stats] = args
    if ((event === 'add' || event === 'change') && stats?.isFile()) {
      // Any stat-confirmed change (native or recovered) satisfies the atomic
      // save pair. A delayed old unlink must not follow it. This adapter is
      // deliberately pinned to Chokidar 5.0.0's pending-unlink state.
      if (event === 'change') this._pendingUnlinks.delete(path.normalize(file))
      // Chokidar's ignored callback uses forward slashes on Windows, but its
      // public events and atomic-state keys use platform-normalized paths.
      const key = path.resolve(file)
      const previous = this.files.get(key)
      // Native and trailing events use the same snapshot. Access-time-only
      // notifications must not invalidate SSR or cause a read/reload loop.
      if (event === 'change' && previous && sameFile(previous.stats, stats)) return
      this.files.set(key, { file: path.normalize(file), stats })
    }
    super.emitWithAll(event, args)
  }

  private schedule(file: string): void {
    if (!this.files.has(file)) return
    clearTimeout(this.pending.get(file))
    this.pending.set(file, setTimeout(() => {
      this.pending.delete(file)
      void this.recheck(file)
    }, 50))
  }

  private async recheck(file: string): Promise<void> {
    const previous = this.files.get(file)
    if (this.closed || !previous) return
    let current: Stats
    try {
      current = await stat(file)
    } catch (error) {
      // Add/unlink and atomic-save normalization remain Chokidar's job.
      const code = (error as NodeJS.ErrnoException).code
      if (!this.closed && code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.emit('error', error as Error)
      }
      return
    }
    // A normal event, unwatch, unlink, or close may have overtaken this stat.
    if (this.closed || this.files.get(file) !== previous) return
    if (current.isFile() && !sameFile(previous.stats, current)) {
      this.emitWithAll('change', [previous.file, current])
    }
  }

  override unwatch(paths: string | string[]): this {
    for (const target of Array.isArray(paths) ? paths : [paths]) {
      const absolute = path.resolve(target)
      for (const file of this.files.keys()) {
        if (file !== absolute && !file.startsWith(absolute + path.sep)) continue
        this.files.delete(file)
        clearTimeout(this.pending.get(file))
        this.pending.delete(file)
      }
    }
    super.unwatch(paths)
    return this
  }

  override close(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.files.clear()
    return super.close()
  }
}

export function watchFiles(paths: string[], options: WatchOptions): FSWatcher {
  return new DevWatcher(options).add(paths)
}
