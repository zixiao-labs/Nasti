import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import { createServer } from '../dist/index.js'

const VAPOR_BETA_WARNING =
  'Vapor is currently a beta feature in Vue and may contain bugs; the current beta version is v3.6.0-rc.15.'

function createFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }))
  fs.mkdirSync(path.join(root, 'src'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function createCapturingLogger() {
  const warnings = []
  const warningOptions = []
  return {
    warnings,
    warningOptions,
    logger: {
      hasWarned: false,
      info() {},
      warn(msg) {
        this.hasWarned = true
        warnings.push(msg)
      },
      warnOnce(msg, options) {
        if (warnings.includes(msg)) return
        this.hasWarned = true
        warnings.push(msg)
        warningOptions.push(options)
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

  const { logger, warnings, warningOptions } = createCapturingLogger()
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
  assert.deepEqual(warningOptions, [{ stream: 'stdout' }])
})

test('Vue Vapor beta notice is printed once on stdout, not stderr', (t) => {
  const root = createFixture(t, 'nasti-vapor-stdout-')
  fs.writeFileSync(path.join(root, 'src/App.vue'), '<template vapor><p>Beta</p></template>')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const server = await createServer({ root: ${JSON.stringify(root)}, framework: 'vue', logLevel: 'warn' });
    try {
      await server.transformRequest('/src/App.vue');
      await server.transformRequest('/src/App.vue?t=2');
    } finally { await server.close(); }
  `], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.split(VAPOR_BETA_WARNING).length - 1, 1)
  assert.ok(!result.stderr.includes(VAPOR_BETA_WARNING))
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
  // rc.15 infers fragment roots at runtime; the compiler no longer emits multiRoot.
  assert.match(only.code, /return \[n0, n1\]/)
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
