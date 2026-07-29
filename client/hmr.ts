// Nasti HMR 浏览器客户端
// 此文件会被内联到 Dev Server 中间件返回给浏览器

export interface HotModule {
  accept(cb?: (mod: any) => void): void
  accept(dep: string, cb: (mod: any) => void): void
  accept(deps: string[], cb: (mods: any[]) => void): void
  dispose(cb: (data: Record<string, any>) => void | Promise<void>): void
  prune(cb: (data: Record<string, any>) => void | Promise<void>): void
  invalidate(message?: string): void
  data: Record<string, any>
}

declare global {
  interface ImportMeta {
    hot?: HotModule
  }
}

export {}
