import { statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { FSWatcher, type ChokidarOptions, type FSWatcherEventMap } from 'chokidar'

function sameFile(left: Stats, right: Stats): boolean {
  return left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
}

type FileSnapshot = { file: string; stats: Stats }
type WatchOptions = ChokidarOptions & {
  ignored: (file: string, stats?: Stats) => boolean
}

function isUnwatched(file: string, unwatched: Set<string>): boolean {
  const key = path.resolve(file)
  for (const target of unwatched) {
    if (key === target || key.startsWith(target + path.sep)) return true
  }
  return false
}

/**
 * Chokidar 5 can discard the last native notification in its watch/change
 * throttle windows. In particular, a read's metadata notification can mask an
 * immediate write. Recheck only files signaled by the native backend, after the
 * burst, and share metadata with normal events to avoid duplicate changes.
 */
class DevWatcher extends FSWatcher {
  private files: Map<string, FileSnapshot>
  private unwatched: Set<string>
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  private suppressedAtomicUnlinks = new Set<string>()

  constructor(options: WatchOptions) {
    const files = new Map<string, FileSnapshot>()
    const unwatched = new Set<string>()
    // The public ignored callback receives Chokidar's scan metadata even when
    // ignoreInitial suppresses add events. Capture accepted files here so both
    // startup and later watcher.add() retain normal ignoreInitial semantics,
    // without traversing/statting the tree twice. Readdirp supplies BigIntStats
    // on Windows; wait for Chokidar's own Number Stats before arming each file.
    // They match native events/rechecks and retain fractional mtime precision.
    super({
      ...options,
      ignoreInitial: true,
      alwaysStat: true,
      ignored(file, stats) {
        if (isUnwatched(file, unwatched)) return true
        if (options.ignored(file, stats)) return true
        if (stats?.isFile() && typeof stats.mtimeMs === 'number') {
          const key = path.resolve(file)
          if (!files.has(key)) files.set(key, { file: path.normalize(file), stats })
        }
        return false
      },
    })
    this.files = files
    this.unwatched = unwatched
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

  override emit<E extends keyof FSWatcherEventMap>(
    event: E,
    ...args: E extends keyof FSWatcherEventMap ? FSWatcherEventMap[E] : never
  ): boolean {
    if (event === 'unlink' && typeof args[0] === 'string') {
      const file = path.normalize(args[0])
      if (this._pendingUnlinks.has(file)) {
        if (isUnwatched(file, this.unwatched)) {
          this.suppressedAtomicUnlinks.add(file)
          return false
        }
        let current: Stats | undefined
        try {
          current = statSync(file)
        } catch {
          // A missing or inaccessible file retains Chokidar's unlink behavior.
        }
        if (current?.isFile()) {
          // Native add/change can arrive after the atomic timer. Validate at
          // publication time so it cannot delete an extant file's snapshot
          // before the trailing check. This is one stat per delayed unlink,
          // not a timer/polling loop. Chokidar emits its paired "all" next.
          this.suppressedAtomicUnlinks.add(file)
          this.emitWithAll('change', [file, current])
          return false
        }
      }
    }
    if (event === 'all' && args[0] === 'unlink' && typeof args[1] === 'string') {
      if (this.suppressedAtomicUnlinks.delete(path.normalize(args[1]))) return false
    }
    return super.emit(event, ...args)
  }

  override emitWithAll(...[event, args]: Parameters<FSWatcher['emitWithAll']>): void {
    const [file, stats] = args
    // An old native callback can finish after unwatch; it must neither publish
    // an event nor repopulate the metadata removed by unwatch.
    if (typeof file === 'string' && isUnwatched(file, this.unwatched)) return
    if ((event === 'add' || event === 'change') && stats?.isFile()) {
      // Chokidar's ignored callback uses forward slashes on Windows, but its
      // public events and atomic-state keys use platform-normalized paths.
      const key = path.resolve(file)
      const previous = this.files.get(key)
      // add() re-enables events before its asynchronous scan arms the snapshot.
      // A late native change from the old watch must not publish or seed state
      // in that gap. Only the scan or a genuine add can arm a new file.
      if (event === 'change' && !previous) return
      // Any stat-confirmed change (native or recovered) satisfies the atomic
      // save pair. A delayed old unlink must not follow it. This adapter is
      // deliberately pinned to Chokidar 5.0.0's pending-unlink state.
      if (event === 'change') this._pendingUnlinks.delete(path.normalize(file))
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
    if (this.closed) return this
    for (const target of Array.isArray(paths) ? paths : [paths]) {
      const absolute = path.resolve(target)
      this.unwatched.add(absolute)
      for (const file of this.files.keys()) {
        if (file !== absolute && !file.startsWith(absolute + path.sep)) continue
        this.files.delete(file)
        clearTimeout(this.pending.get(file))
        this.pending.delete(file)
        this.suppressedAtomicUnlinks.delete(file)
      }
      // Pending atomic events belong to the old watch generation. They must
      // not cross an immediate unwatch -> add lifecycle.
      for (const file of this._pendingUnlinks.keys()) {
        if (isUnwatched(file, this.unwatched)) this._pendingUnlinks.delete(file)
      }
      // Chokidar 5 unwatch uses slash-normalized paths, but Windows closer keys
      // created while scanning directories are platform-normalized. Close both
      // spellings so unwatch also releases the underlying native file handle.
      if (process.platform === 'win32') this._closePath(absolute)
    }
    super.unwatch(paths)
    return this
  }

  override add(paths: string | string[], originalAdd?: string, internal?: boolean): this {
    if (this.closed) return this
    if (!originalAdd && !internal) {
      for (const target of Array.isArray(paths) ? paths : [paths]) {
        this.unwatched.delete(path.resolve(target))
      }
    }
    super.add(paths, originalAdd, internal)
    return this
  }

  override close(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.files.clear()
    this.unwatched.clear()
    this.suppressedAtomicUnlinks.clear()
    return super.close()
  }
}

export function watchFiles(paths: string[], options: WatchOptions): FSWatcher {
  return new DevWatcher(options).add(paths)
}
