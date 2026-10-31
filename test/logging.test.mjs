import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { build, createLogger } from '../dist/index.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-logging-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}')
  fs.writeFileSync(path.join(root, 'main.js'), 'console.log("logging fixture")')
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/main.js"></script>')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function capture(level) {
  const logs = []
  const logger = createLogger(level, {
    allowClearScreen: false,
    console: {
      log: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
  })
  return { logs, logger }
}

const diagnosticPlugin = {
  name: 'fixture:diagnostics',
  buildStart() {
    this.info('FIXTURE_INFO')
    this.warn({ code: 'FIXTURE_WARNING', message: 'FIXTURE_WARN' })
  },
}

for (const level of ['info', 'warn', 'error', 'silent']) {
  test(`Rolldown default diagnostics respect Nasti logLevel ${level} and customLogger`, async (t) => {
    const { logs, logger } = capture(level)
    const rawWarn = t.mock.method(console, 'warn', () => {})
    await build({
      root: fixture(t), logLevel: level, customLogger: logger,
      build: { minify: false }, plugins: [diagnosticPlugin],
    })
    assert.equal(logs.some(([type, message]) => type === 'warn' && message.includes('FIXTURE_WARN')),
      level === 'info' || level === 'warn')
    assert.equal(logs.some(([type, message]) => type === 'info' && message.includes('FIXTURE_INFO')),
      level === 'info')
    assert.equal(rawWarn.mock.callCount(), 0, 'no bypass through Rolldown console.warn')
  })
}

test('Rolldown preserves user onLog → onwarn fallback order and fatal escalation', async (t) => {
  const root = fixture(t)
  const { logs, logger } = capture('warn')
  const calls = []
  await build({
    root, logLevel: 'warn', customLogger: logger, plugins: [diagnosticPlugin],
    build: { rolldownOptions: {
      onLog(level, log, fallback) {
        if (log.message !== 'FIXTURE_WARN') return
        calls.push('onLog')
        fallback(level, log)
      },
      onwarn(log, fallback) {
        calls.push('onwarn')
        fallback(() => ({ ...log, message: 'FORWARDED_WARNING' }))
      },
    } },
  })
  assert.deepEqual(calls, ['onLog', 'onwarn'])
  assert.ok(logs.some(([type, message]) => type === 'warn' && message.includes('FORWARDED_WARNING')))
  await assert.rejects(build({
    root, logLevel: 'silent', plugins: [diagnosticPlugin],
    build: { rolldownOptions: {
      onLog(_level, log, fallback) {
        if (log.message === 'FIXTURE_WARN') fallback('error', log)
      },
    } },
  }), /FIXTURE_WARN/)
})

test('chunk-size warnings describe minified builds only', async (t) => {
  const root = fixture(t)
  for (const minify of [false, true]) {
    const { logs, logger } = capture('warn')
    await build({
      root, logLevel: 'warn', customLogger: logger,
      build: { minify, chunkSizeWarningLimit: 0.001 },
    })
    assert.equal(logs.some(([, message]) => message.includes('Some chunks are larger')), minify)
  }
})
