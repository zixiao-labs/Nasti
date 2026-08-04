import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createServer } from '../dist/index.js'

const VAPOR_BETA_WARNING =
  'Vapor Mode is a beta feature; Zixiao Labs and the Vue team do not provide guarantees against crashes in production environments, and it is not suitable for server-side rendering environments.'

function createFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'src'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function createCapturingLogger() {
  const warnings = []
  return {
    warnings,
    logger: {
      hasWarned: false,
      info() {},
      warn(msg) {
        this.hasWarned = true
        warnings.push(msg)
      },
      warnOnce(msg) {
        if (warnings.includes(msg)) return
        this.hasWarned = true
        warnings.push(msg)
      },
      error() {},
      clearScreen() {},
      hasErrorLogged() {
        return false
      },
    },
  }
}

test('Vue Vapor Mode compiles script setup vapor SFCs and emits beta warnings', async (t) => {
  const root = createFixture(t, 'nasti-vue-vapor-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<div id="app"></div><script type="module" src="/src/App.vue"></script>',
  )
  fs.writeFileSync(
    path.join(root, 'src/App.vue'),
    [
      '<script setup vapor>',
      "import { ref } from 'vue'",
      'const count = ref(0)',
      '</script>',
      '<template><button @click="count++">{{ count }}</button></template>',
    ].join('\n'),
  )

  const { logger, warnings } = createCapturingLogger()
  const server = await createServer({
    root,
    framework: 'vue',
    logLevel: 'silent',
    customLogger: logger,
  })
  await server.listen(0)
  t.after(() => server.close())

  const result = await server.transformRequest('/src/App.vue')
  assert.ok(result?.code)
  assert.match(result.code, /__vapor:\s*true/)
  assert.match(result.code, /\/@modules\/vue|from ['"]vue['"]/)
  assert.match(result.code, /_template\(/)
  assert.match(
    result.code,
    new RegExp(`console\\.warn\\(${JSON.stringify(VAPOR_BETA_WARNING)}\\)`),
  )
  assert.equal(warnings.filter((msg) => msg === VAPOR_BETA_WARNING).length, 1)

  // 同一会话再次转换不应重复终端警告
  await server.transformRequest('/src/App.vue?t=2')
  assert.equal(warnings.filter((msg) => msg === VAPOR_BETA_WARNING).length, 1)
})

test('Vue Vapor Mode supports template-only vapor SFCs and features.vapor force', async (t) => {
  const root = createFixture(t, 'nasti-vue-vapor-force-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<div id="app"></div><script type="module" src="/src/App.vue"></script>',
  )
  fs.writeFileSync(
    path.join(root, 'src/Only.vue'),
    '<template vapor><div>hi</div><p>there</p></template>',
  )
  fs.writeFileSync(
    path.join(root, 'src/Forced.vue'),
    [
      '<script setup>',
      "import { ref } from 'vue'",
      'const n = ref(1)',
      '</script>',
      '<template><p>{{ n }}</p></template>',
    ].join('\n'),
  )

  const { logger, warnings } = createCapturingLogger()
  const server = await createServer({
    root,
    framework: 'vue',
    logLevel: 'silent',
    customLogger: logger,
    environments: {
      client: {
        vue: {
          features: { vapor: true },
        },
      },
    },
  })
  await server.listen(0)
  t.after(() => server.close())

  const only = await server.transformRequest('/src/Only.vue')
  assert.ok(only?.code)
  assert.match(only.code, /__vapor:\s*true/)
  assert.match(only.code, /__sfc__\.__multiRoot = true/)
  assert.match(only.code, /console\.warn\(/)

  const forced = await server.transformRequest('/src/Forced.vue')
  assert.ok(forced?.code)
  assert.match(forced.code, /__vapor:\s*true/)
  assert.match(forced.code, /console\.warn\(/)

  assert.ok(warnings.includes(VAPOR_BETA_WARNING))
})

test('non-vapor Vue SFCs do not emit Vapor beta warnings', async (t) => {
  const root = createFixture(t, 'nasti-vue-no-vapor-')
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<div id="app"></div><script type="module" src="/src/App.vue"></script>',
  )
  fs.writeFileSync(
    path.join(root, 'src/App.vue'),
    [
      '<script setup>',
      "import { ref } from 'vue'",
      'const count = ref(0)',
      '</script>',
      '<template><button>{{ count }}</button></template>',
    ].join('\n'),
  )

  const { logger, warnings } = createCapturingLogger()
  const server = await createServer({
    root,
    framework: 'vue',
    logLevel: 'silent',
    customLogger: logger,
  })
  await server.listen(0)
  t.after(() => server.close())

  const result = await server.transformRequest('/src/App.vue')
  assert.ok(result?.code)
  assert.doesNotMatch(result.code, /__vapor:\s*true/)
  assert.doesNotMatch(result.code, /console\.warn\(/)
  assert.equal(warnings.includes(VAPOR_BETA_WARNING), false)
})
