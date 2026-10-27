import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Streaming Node ↔ Fetch bridge, shared by native Start dev and preview hosts. */
export async function dispatchFetch(
  fetch: (request: Request) => Response | Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  res.once('close', abort)
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
      else if (value !== undefined) headers.set(name, value)
    }
    const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
      method: req.method,
      headers,
      signal: controller.signal,
      ...(!['GET', 'HEAD'].includes(req.method ?? 'GET')
        ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
        : {}),
    })
    const response = await fetch(request)
    res.statusCode = response.status
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') res.setHeader(name, value)
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) res.setHeader('set-cookie', cookies)
    if (response.body && req.method !== 'HEAD') {
      await pipeline(Readable.fromWeb(response.body as any), res)
    } else {
      await response.body?.cancel()
      res.end()
    }
  } finally {
    res.off('close', abort)
  }
}
