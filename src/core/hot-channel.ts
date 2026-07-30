// HotChannel - per-environment 热更通道（Environment API）
//
// 接口契约定义在 types.ts（含 invoke：fetchModule/getBuiltins/_skipFsCheck）。
// client-consumer 环境使用带环境名的共享 ws transport；非 client = noop。
// SSR module runner 可经 setInvokeHandler 注册 RPC，不需要再改接口。
import type {
  HotChannel,
  HotChannelInvokeHandlers,
  HotChannelListener,
  HmrPayload,
  WebSocketServer,
} from '../types.js'

/** 非 client 环境的占位通道（SSR/edge 可由 runner/driver 接上真实 transport） */
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
 * client-consumer 环境的 ws 通道：包装 server/ws.ts 的 WebSocketServer。
 * 事件监听与 invoke 在现有 ws 协议上预留，payload 以 environment 字段分流。
 */
export function createWsHotChannel(
  ws: WebSocketServer,
  environmentName = 'client',
): HotChannel {
  const listeners = new Map<string, Set<HotChannelListener>>()
  let invokeHandlers: HotChannelInvokeHandlers | undefined

  return {
    send(payload: HmrPayload) {
      ws.send({ ...payload, environment: payload.environment ?? environmentName })
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
    // 多个 environment 共享底层 WebSocket server；它由 DevServer.close() 统一关闭。
    close() {},
    setInvokeHandler(handlers) {
      invokeHandlers = handlers
      void invokeHandlers
    },
  }
}
