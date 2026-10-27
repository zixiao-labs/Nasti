import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import connect from 'connect'
import sirv from 'sirv'
import { dispatchFetch } from './fetch-handler.js'

/** Serve only client artifacts, never the sibling server bundle or its maps. */
export async function createTanStackStartPreview(outDir: string): Promise<connect.Server> {
  const directory = path.resolve(outDir)
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'client/nasti-start.json'), 'utf8'))
  if (metadata.version !== 1 || typeof metadata.base !== 'string') {
    throw new Error('[nasti:start] Invalid preview manifest.')
  }
  const { default: handler } = await import(pathToFileURL(path.join(directory, 'server/server.mjs')).href)
  const app = connect()
  app.use(metadata.base, sirv(path.join(directory, 'client'), { etag: true }))
  app.use((req, res) => {
    void dispatchFetch(handler.fetch, req, res).catch((error) => {
      if (!res.headersSent) res.statusCode = 500
      res.end('Internal Server Error')
      console.error('[nasti:start] Preview request failed', error)
    })
  })
  return app
}
