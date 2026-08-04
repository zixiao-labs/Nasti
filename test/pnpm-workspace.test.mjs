import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createServer } from '../dist/index.js'

/**
 * Layout (mirrors a typical pnpm workspace):
 *
 *   <monorepo>/
 *     apps/web/          ← nasti root (only depends on @repro/a)
 *     packages/a/        ← workspace pkg, depends on @repro/b
 *     packages/b/        ← transitive workspace pkg (NOT linked at apps/web)
 */
function createWorkspaceFixture() {
  const monorepo = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ws-'))
  const web = path.join(monorepo, 'apps', 'web')
  const pkgA = path.join(monorepo, 'packages', 'a')
  const pkgB = path.join(monorepo, 'packages', 'b')

  fs.mkdirSync(web, { recursive: true })
  fs.mkdirSync(pkgA, { recursive: true })
  fs.mkdirSync(pkgB, { recursive: true })

  fs.writeFileSync(
    path.join(pkgB, 'package.json'),
    JSON.stringify({ name: '@repro/b', version: '1.0.0', type: 'module', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(pkgB, 'index.js'), 'export const fromB = "b"\n')

  fs.writeFileSync(
    path.join(pkgA, 'package.json'),
    JSON.stringify({
      name: '@repro/a',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      dependencies: { '@repro/b': 'workspace:*' },
    }),
  )
  fs.writeFileSync(
    path.join(pkgA, 'index.js'),
    'export { fromB } from "@repro/b"\nexport const fromA = "a"\n',
  )

  fs.writeFileSync(
    path.join(web, 'package.json'),
    JSON.stringify({
      name: 'web',
      private: true,
      type: 'module',
      dependencies: { '@repro/a': 'workspace:*' },
    }),
  )
  fs.writeFileSync(
    path.join(web, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>',
  )
  fs.mkdirSync(path.join(web, 'src'))
  fs.writeFileSync(
    path.join(web, 'src/main.js'),
    'import { fromA, fromB } from "@repro/a"\nglobalThis.__vals = { fromA, fromB }\n',
  )

  // Symlink layout pnpm would create for workspace:* deps
  fs.mkdirSync(path.join(web, 'node_modules', '@repro'), { recursive: true })
  fs.symlinkSync(pkgA, path.join(web, 'node_modules', '@repro', 'a'))
  fs.mkdirSync(path.join(pkgA, 'node_modules', '@repro'), { recursive: true })
  fs.symlinkSync(pkgB, path.join(pkgA, 'node_modules', '@repro', 'b'))

  return { monorepo, web, pkgA, pkgB }
}

test('dev server serves transitive workspace deps via /@modules/?id=', async (t) => {
  const { web, pkgB, monorepo } = createWorkspaceFixture()
  const server = await createServer({
    root: web,
    logLevel: 'silent',
    server: { port: 0 },
  })
  await server.listen(0)
  t.after(async () => {
    await server.close()
    fs.rmSync(monorepo, { recursive: true, force: true })
  })

  const aResult = await server.transformRequest('/@modules/@repro/a')
  assert.ok(aResult?.code, 'direct workspace package @repro/a should bundle')
  assert.match(
    aResult.code,
    /@repro\/b/,
    'A bundle should externalize B as /@modules/@repro/b',
  )

  // The externalized URL for B must use ?id= because B is not linked at apps/web
  const idMatch = aResult.code.match(/\/@modules\/@repro\/b\?id=([^"']+)/)
  assert.ok(idMatch, 'transitive workspace dep should be rewritten with ?id=')
  const bUrl = `/@modules/@repro/b?id=${idMatch[1]}`
  const bResult = await server.transformRequest(bUrl)
  assert.ok(bResult?.code, 'transitive workspace package must serve via ?id=')
  assert.match(bResult.code, /fromB|"b"/)

  // Security: forged absolute paths outside linked packages / node_modules stay rejected
  const forged = await server.transformRequest(
    `/@modules/evil?id=${encodeURIComponent('/etc/passwd')}`,
  )
  assert.equal(forged, null, 'arbitrary absolute paths must not be served')

  // Sanity: the real B path is under packages/b (outside web root, no node_modules segment)
  const bReal = fs.realpathSync(path.join(pkgB, 'index.js'))
  assert.ok(!bReal.includes(`${path.sep}node_modules${path.sep}`))
  assert.ok(path.relative(web, bReal).startsWith('..'))
})

test('dev server watches linked workspace package roots', async (t) => {
  const { web, pkgA, pkgB, monorepo } = createWorkspaceFixture()
  const server = await createServer({
    root: web,
    logLevel: 'silent',
    server: { port: 0 },
  })
  await server.listen(0)
  t.after(async () => {
    await server.close()
    fs.rmSync(monorepo, { recursive: true, force: true })
  })

  const watched = server.watcher.getWatched()
  const watchedRoots = Object.keys(watched).map((p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  })
  const aReal = fs.realpathSync(pkgA)
  const bReal = fs.realpathSync(pkgB)
  assert.ok(
    watchedRoots.some((r) => r === aReal || r.startsWith(aReal + path.sep)),
    `expected watcher to cover package A ${aReal}, got: ${watchedRoots.join(', ')}`,
  )
  assert.ok(
    watchedRoots.some((r) => r === bReal || r.startsWith(bReal + path.sep)),
    `expected watcher to cover transitive package B ${bReal}, got: ${watchedRoots.join(', ')}`,
  )
})
