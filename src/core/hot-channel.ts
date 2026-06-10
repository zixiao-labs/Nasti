// HotChannel - per-environment 热更通道（Environment API）
//
// 接口契约定义在 types.ts（含 invoke：fetchModule/getBuiltins/_skipFsCheck）。
// Phase 1 实现面：client = 包装现有 ws 服务器；非 client = noop。
// Phase 2 的 SSR module runner 经 setInvokeHandler 注册 RPC，不需要再改接口。
import type {
  HotChannel,
  HotChannelInvokeHandlers,
  HotChannelListener,
  HmrPayload,
  WebSocketServer,
} from '../types.js'

/** 非 client 环境的占位通道（SSR/edge 在 Phase 2 接上真实 transport） */
export function createNoopHotChannel(): HotChannel {
  return {
    send() {},
    on() {},
    off() {},
    listen() {},
    close() {},
    setInvokeHandler() {},
  }
}

/**
 * client 环境的 ws 通道：包装 server/ws.ts 的 WebSocketServer。
 * 事件监听与 invoke 在现有 ws 协议上预留（custom event 协议 Phase 2 扩展）。
 */
export function createWsHotChannel(ws: WebSocketServer): HotChannel {
  const listeners = new Map<string, Set<HotChannelListener>>()
  let invokeHandlers: HotChannelInvokeHandlers | undefined

  return {
    send(payload: HmrPayload) {
      ws.send(payload)
    },
    on(event, listener) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(listener)
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    listen() {},
    close() {
      ws.close()
    },
    setInvokeHandler(handlers) {
      invokeHandlers = handlers
      void invokeHandlers
    },
  }
}
