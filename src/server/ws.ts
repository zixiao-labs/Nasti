// WebSocket 服务封装 - HMR 通信
import { WebSocketServer as WsServer, type WebSocket } from 'ws'
import type { WebSocketServer as IWebSocketServer, HmrPayload } from '../types.js'

export function createWebSocketServer(server: any): IWebSocketServer {
  const wss = new WsServer({ noServer: true })
  const clients = new Set<WebSocket>()

  // 处理 HTTP server 的 upgrade 请求
  server.on('upgrade', (req: any, socket: any, head: any) => {
    if (req.headers['sec-websocket-protocol'] === 'nasti-hmr') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    }
  })

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify({ type: 'connected' }))

    ws.on('close', () => {
      clients.delete(ws)
    })

    ws.on('error', (err) => {
      console.error('[nasti] WebSocket error:', err)
      clients.delete(ws)
    })
  })

  return {
    send(payload: HmrPayload) {
      const data = JSON.stringify(payload)
      for (const client of clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(data)
        }
      }
    },
    close() {
      clients.clear()
      wss.close()
    },
  }
}
