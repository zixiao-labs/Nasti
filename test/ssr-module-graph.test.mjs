import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

import { createServer } from '../dist/index.js'

/**
 * Create a temporary SSR import chain and server with automatic test cleanup.
 * Disable native watcher subscriptions so tests can emit deterministic events.
 * @returns The server, SSR graph, fixture paths, and a helper for writing modules.
 */
async function fixture(t, create, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-ssr-graph-'))
  let server
  t.after(async () => {
    try {
      await server?.close()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  const write = (name, code) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, code)
    return file
  }
  write('package.json', '{"private":true,"type":"module"}')
  write('entry.js', "export { value } from './middle.js';")
  write('middle.js', "import { value as dep } from './dep.js'; export const value = `middle:${dep}`;")
  const dep = write('dep.js', 'export const value = "old";')
  server = await create({ root, logLevel: 'silent', ...options })
  // Unwatch every native subscription, not just the root directory, so real
  // queued file events cannot race the deterministic manual watcher emissions.
  const watched = Object.entries(server.watcher.getWatched())
    .flatMap(([directory, files]) => [directory, ...files.map((file) => path.join(directory, file))])
  await server.watcher.unwatch(watched)
  return { root, server, write, dep, graph: server.environments.ssr.moduleGraph }
}

/** Return an SSR node after asserting its canonical ID and graph file indexes. */
function node(graph, url, root) {
  const mod = graph.getModuleByUrl(url)
  assert.ok(mod, `missing graph node ${url}`)
  assert.equal(mod.environment, 'ssr')
  assert.equal(mod.id, path.join(root, url.slice(1)))
  assert.equal(mod.file, mod.id)
  assert.equal(graph.getModuleById(mod.id), mod)
  assert.ok(graph.getModulesByFile(mod.file).has(mod))
  return mod
}

/** Assert that a dependency edge is recorded in both directions. */
function edge(importer, dependency) {
  assert.ok(importer.importedModules.has(dependency), `${importer.url} must import ${dependency.url}`)
  assert.ok(dependency.importers.has(importer), `${dependency.url} must retain its importer`)
}

/** Assert cached transforms and edges for the fixture chain, then return its nodes. */
function chain(graph, root) {
  const entry = node(graph, '/entry.js', root)
  const middle = node(graph, '/middle.js', root)
  const dep = node(graph, '/dep.js', root)
  edge(entry, middle)
  edge(middle, dep)
  for (const mod of [entry, middle, dep]) assert.ok(mod.transformResult?.code)
  return { entry, middle, dep }
}

for (const [format, create] of [
  ['ESM', createServer],
  ['CJS', (config) => createRequire(import.meta.url)('../dist/index.cjs').createServer(config)],
]) {
  const check = (name, fn) => test(`${format} SSR module graph: ${name}`, { timeout: 10000 }, fn)

  check('static cyclic bodies share TLA completion and failure for every public caller', async (t) => {
    const { server, write } = await fixture(t, create)
    const key = `__nasti_cycle_${format}`
    let release
    t.after(() => { release?.(); delete globalThis[key] })
    for (const fail of [false, true]) {
      let started
      const entered = new Promise((resolve) => { started = resolve })
      globalThis[key] = { gate: new Promise((resolve) => { release = resolve }), started }
      write(`a${fail}.js`, `import './b${fail}.js'; globalThis.${key}.started(); await globalThis.${key}.gate; ${fail ? 'throw new Error("cycle failure");' : 'export const value = "a";'}`)
      write(`b${fail}.js`, `import './a${fail}.js'; export const value = "b";`)
      const first = server.ssrLoadModule(`/a${fail}.js`)
      await entered // b's body has completed, but its static group has not.
      const calls = [first, ...['a', 'b', 'b'].map((name) => server.ssrLoadModule(`/${name}${fail}.js`))]
      const results = Promise.allSettled(calls)
      let settled = false
      for (const call of calls) call.then(() => { settled = true }, () => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(settled, false, 'b must not expose its completed body before a finishes')
      release()
      const outcomes = await results
      assert.deepEqual(outcomes.map((result) => result.status), Array(4).fill(fail ? 'rejected' : 'fulfilled'))
      if (fail) {
        for (const result of outcomes) assert.match(result.reason.message, /cycle failure/)
        await assert.rejects(server.ssrLoadModule('/btrue.js'), /cycle failure/)
      }
    }
  })

  check('dynamic imports never receive partial exports through a static backedge', async (t) => {
    const { server, write } = await fixture(t, create)
    const key = `__nasti_dynamic_${format}`
    let release
    let started
    const entered = new Promise((resolve) => { started = resolve })
    globalThis[key] = { events: [], started, gate: new Promise((resolve) => { release = resolve }) }
    t.after(() => { delete globalThis[key] })
    write('a.js', `globalThis.${key}.pending = import('./b.js').then(() => globalThis.${key}.events.push('dynamic')); globalThis.${key}.started(); await globalThis.${key}.gate; globalThis.${key}.events.push('a'); export const value = 'a';`)
    write('b.js', `import './a.js'; globalThis.${key}.events.push('b'); export const value = 'b';`)
    const load = server.ssrLoadModule('/a.js')
    await entered
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(globalThis[key].events, [])
    release()
    await load
    await globalThis[key].pending
    assert.deepEqual(globalThis[key].events, ['a', 'b', 'dynamic'])
    write('await-a.js', "await import('./await-b.js'); export const value = 'a';")
    write('await-b.js', "import './await-a.js'; export const value = 'b';")
    const pending = server.ssrLoadModule('/await-a.js')
    const outcome = await Promise.race([
      pending.then(() => 'fulfilled', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])
    assert.equal(outcome, 'pending', 'awaited dynamic cycles must not falsely succeed')
  })

  check('concurrent cyclic roots wait after either individual TLA body finishes', async (t) => {
    const key = `__nasti_concurrent_tla_${format}`
    const releases = {}
    const starts = {}
    const entered = {}
    const gates = {}
    for (const name of ['a', 'b']) {
      entered[name] = new Promise((resolve) => { starts[name] = () => resolve(name) })
      gates[name] = new Promise((resolve) => { releases[name] = resolve })
    }
    globalThis[key] = { starts, gates }
    t.after(() => { releases.a(); releases.b(); delete globalThis[key] })
    let arrivals = 0
    let releaseTransforms
    const barrier = new Promise((resolve) => { releaseTransforms = resolve })
    const { server, root, write } = await fixture(t, create, {
      plugins: [{
        name: 'fixture:concurrent-tla',
        async transform(code, id) {
          if (['a', 'b'].some((name) => id === path.join(root, `${name}.js`))) {
            if (++arrivals === 2) releaseTransforms()
            await barrier
          }
          return code
        },
      }],
    })
    for (const [name, dependency] of [['a', 'b'], ['b', 'a']]) {
      write(`${name}.js`, `import './${dependency}.js'; globalThis.${key}.starts.${name}(); await globalThis.${key}.gates.${name}; export const value = '${name}';`)
    }
    let settled = 0
    const calls = ['a', 'b', 'a', 'b'].map((name) =>
      server.ssrLoadModule(`/${name}.js`).then((exports) => { settled++; return exports }))
    const first = await Promise.race(Object.values(entered))
    releases[first]()
    await entered[first === 'a' ? 'b' : 'a']
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(settled, 0, 'completed body must remain pending until its SCC finishes')
    releases.a()
    releases.b()
    const results = await Promise.all(calls)
    assert.equal(results[0], results[2])
    assert.equal(results[1], results[3])
    assert.deepEqual(results.map((result) => result.value), ['a', 'b', 'a', 'b'])
  })

  check('evaluation alone populates canonical transitive graph and transforms', async (t) => {
    const { server, root, graph } = await fixture(t, create)
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'middle:old')
    chain(graph, root)
    assert.equal(server.environments.client.moduleGraph.getModuleByUrl('/entry.js'), undefined)
  })

  check('direct transforms share evaluation cache and watcher invalidates the chain', async (t) => {
    let transforms = 0
    const { server, root, graph, write, dep } = await fixture(t, create, {
      plugins: [{
        name: 'fixture:count',
        transform(code, id) {
          if (id.startsWith(root)) transforms++
          return code
        },
      }],
    })
    for (const url of ['/entry.js', '/middle.js', '/dep.js']) {
      const result = await server.transformEnvironmentRequest('ssr', url)
      assert.deepEqual(graph.getModuleByUrl(url).transformResult, result)
      assert.doesNotMatch(result.code, /\/@nasti\/client|\/@react-refresh|createHotContext|\/@fs\//)
    }
    const nodes = chain(graph, root)
    assert.equal(transforms, 3)
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'middle:old')
    assert.equal(transforms, 3, 'evaluation must consume the already cached runner transform')
    write('dep.js', 'export const value = "new";')
    server.watcher.emit('change', dep)
    for (const mod of Object.values(nodes)) assert.equal(mod.transformResult, null)
    await server.transformEnvironmentRequest('ssr', '/dep.js')
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'middle:new')
    chain(graph, root)
  })

  check('server environments isolate plugin filters, defines, and graph caches', async (t) => {
    const { server, write } = await fixture(t, create, {
      environments: {
        ssr: { consumer: 'server' },
        worker: { consumer: 'server' },
      },
      plugins: [{
        name: 'fixture:ssr-only',
        applyToEnvironment: (environment) => environment.name === 'ssr',
        transform: (code) => code.replace('PLUGIN_VALUE', 'ssr-plugin'),
      }, {
        name: 'fixture:worker-only',
        applyToEnvironment: (environment) => environment.name === 'worker',
        transform: (code) => code.replace('PLUGIN_VALUE', 'worker-plugin'),
      }],
    })
    write('isolated.js', 'export const value = [import.meta.env.SSR, "PLUGIN_VALUE"];')
    const ssr = await server.transformEnvironmentRequest('ssr', '/isolated.js')
    const worker = await server.transformEnvironmentRequest('worker', '/isolated.js')
    assert.match(ssr.code, /ssr-plugin/)
    assert.match(worker.code, /worker-plugin/)
    assert.doesNotMatch(worker.code, /ssr-plugin|import\.meta\.env\.SSR/)
    assert.deepEqual((await server.ssrLoadModule('/isolated.js')).value, [true, 'ssr-plugin'])
    const a = server.environments.ssr.moduleGraph.getModuleByUrl('/isolated.js')
    const b = server.environments.worker.moduleGraph.getModuleByUrl('/isolated.js')
    assert.notEqual(a, b)
    assert.deepEqual(a.transformResult, ssr)
    assert.deepEqual(b.transformResult, worker)
  })

  check('aliases, virtual queries, timestamps and dynamic imports retain graph identity', async (t) => {
    const { server, root, graph, write } = await fixture(t, create, {
      resolve: { alias: { 'fixture-alias': './dep.js' } },
      plugins: [{
        name: 'fixture:virtual',
        resolveId(id) {
          if (id.startsWith('virtual:query?')) return '\0' + id
        },
        load(id) {
          if (id.startsWith('\0virtual:query?')) return `export const value = ${JSON.stringify(id.split('?')[1])};`
        },
      }],
    })
    write('entry.js', [
      'export { value } from "fixture-alias";',
      'import "./dep.js?t=123";',
      'import "virtual:query?one"; import "virtual:query?two";',
      'export const literal = () => import("./literal.js");',
      'export const runtime = (name) => import(name);',
    ].join('\n'))
    write('literal.js', 'export const value = "literal";')
    write('runtime.js', 'export const value = "runtime";')
    await server.transformEnvironmentRequest('ssr', '/entry.js?t=123')
    const entry = node(graph, '/entry.js', root)
    const dep = node(graph, '/dep.js', root)
    edge(entry, dep)
    edge(entry, node(graph, '/literal.js', root))
    const one = graph.getModuleById('\0virtual:query?one')
    const two = graph.getModuleById('\0virtual:query?two')
    assert.ok(one)
    assert.ok(two)
    assert.notEqual(one, two)
    assert.equal(one.file, null)
    edge(entry, one)
    edge(entry, two)
    assert.equal(graph.getModuleByUrl('/entry.js?t=456'), entry)
    await server.transformEnvironmentRequest('ssr', 'fixture-alias')
    assert.equal(graph.getModuleByUrl('fixture-alias'), dep)
    await server.transformEnvironmentRequest('ssr', 'virtual:query?one')
    assert.equal(graph.getModuleByUrl('virtual:query?one'), one)
    const exports = await server.ssrLoadModule('/entry.js')
    assert.equal(exports.value, 'old')
    assert.equal(graph.getModuleByUrl('/dep.js?t=123'), dep)
    assert.equal(graph.getModuleById(path.join(root, 'dep.js')), dep)
    assert.equal((await exports.literal()).value, 'literal')
    assert.equal((await exports.runtime('./runtime.js')).value, 'runtime')
    edge(entry, node(graph, '/runtime.js', root))
  })

  check('source edits replace both edge directions and exclude external imports', async (t) => {
    const { server, graph, root, write } = await fixture(t, create)
    write('node_modules/fixture-native/package.json', '{"name":"fixture-native","type":"module","exports":"./index.js"}')
    write('node_modules/fixture-native/index.js', 'export const value = "native";')
    write('entry.js', 'import "fixture-native"; import "node:path"; export { value } from "./dep.js";')
    await server.transformEnvironmentRequest('ssr', '/entry.js')
    const entry = node(graph, '/entry.js', root)
    const old = node(graph, '/dep.js', root)
    assert.deepEqual([...entry.importedModules], [old])
    assert.equal(graph.getModuleById('node:path'), undefined)
    assert.equal(graph.getModuleById('fixture-native'), undefined)
    write('next.js', 'export const value = "next";')
    const file = write('entry.js', 'export { value } from "./next.js";')
    server.watcher.emit('change', file)
    await server.transformEnvironmentRequest('ssr', '/entry.js')
    const next = node(graph, '/next.js', root)
    assert.deepEqual([...entry.importedModules], [next])
    assert.equal(old.importers.has(entry), false)
    edge(entry, next)
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'next')
  })

  check('evaluation preserves importer-specific external decisions', async (t) => {
    const { server, root, graph, write } = await fixture(t, create, {
      environments: {
        ssr: {
          consumer: 'server',
          build: {
            rolldownOptions: {
              external: (id, importer, isResolved) =>
                isResolved && id === path.join(root, 'dep.js') && importer === undefined,
            },
          },
        },
      },
      plugins: [{
        name: 'fixture:compile-dependency',
        transform(code, id) {
          if (id === path.join(root, 'dep.js')) return code.replace('RAW', 'TRANSFORMED')
        },
      }],
    })
    write('entry.js', 'export { value } from "./dep.js";')
    write('dep.js', 'export const value = "RAW";')
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'TRANSFORMED')
    const entry = node(graph, '/entry.js', root)
    const dep = node(graph, '/dep.js', root)
    assert.match(dep.transformResult.code, /TRANSFORMED/)
    edge(entry, dep)
  })

  check('manual graph invalidation also discards evaluated exports', async (t) => {
    const { server, graph, write } = await fixture(t, create)
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'middle:old')
    write('dep.js', 'export const value = "manual";')
    graph.invalidateModuleAndImporters(graph.getModuleByUrl('/dep.js'))
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'middle:manual')
  })

  check('retained runtime dynamic imports observe graph and watcher invalidation', async (t) => {
    const { server, graph, root, write, dep } = await fixture(t, create)
    write('entry.js', 'export const load = (name) => import(name);')
    const exports = await server.ssrLoadModule('/entry.js')
    assert.equal((await exports.load('./dep.js')).value, 'old')
    edge(node(graph, '/entry.js', root), node(graph, '/dep.js', root))
    write('dep.js', 'export const value = "manual";')
    graph.invalidateModule(graph.getModuleByUrl('/dep.js'))
    assert.equal((await exports.load('./dep.js')).value, 'manual')
    write('dep.js', 'export const value = "watched";')
    server.watcher.emit('change', dep)
    assert.equal((await exports.load('./dep.js')).value, 'watched')
  })

  check('concurrent initial loads transform each canonical module only once', async (t) => {
    const counts = new Map()
    const { server, root } = await fixture(t, create, {
      plugins: [{
        name: 'fixture:concurrent',
        async transform(code, id) {
          if (id.startsWith(root)) {
            counts.set(id, (counts.get(id) ?? 0) + 1)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          return code
        },
      }],
    })
    const results = await Promise.all(Array.from({ length: 6 }, () => server.ssrLoadModule('/entry.js')))
    for (const result of results) assert.equal(result, results[0])
    assert.equal(counts.size, 3)
    for (const count of counts.values()) assert.equal(count, 1)
  })

  check('direct cyclic imports support deferred reads of live exports', async (t) => {
    const { server, write } = await fixture(t, create)
    write('a.js', 'import { b } from "./b.js"; export function a() { return "a"; } export const value = () => b();')
    write('b.js', 'import { a } from "./a.js"; export function b() { return a() + "b"; }')
    const a = await server.ssrLoadModule('/a.js')
    assert.equal(a.value(), 'ab')
    assert.equal(await server.ssrLoadModule('/a.js'), a)
    assert.equal((await server.ssrLoadModule('/b.js')).b(), 'ab')
  })

  check('cycles between concurrent roots are detected across evaluation stacks', async (t) => {
    let arrivals = 0
    let release
    const barrier = new Promise((resolve) => { release = resolve })
    const { server, root, write } = await fixture(t, create, {
      plugins: [{
        name: 'fixture:concurrent-cycle',
        async transform(code, id) {
          if ([path.join(root, 'a.js'), path.join(root, 'b.js')].includes(id)) {
            if (++arrivals === 2) release()
            await barrier
          }
          return code
        },
      }],
    })
    write('a.js', 'import { b } from "./b.js"; export function a() { return "a"; } export const value = () => b();')
    write('b.js', 'import { a } from "./a.js"; export function b() { return a() + "b"; }')
    const [a, b, again] = await Promise.all([
      server.ssrLoadModule('/a.js'),
      server.ssrLoadModule('/b.js'),
      server.ssrLoadModule('/a.js'),
    ])
    assert.equal(arrivals, 2)
    assert.equal(a, again)
    assert.equal(a.value(), 'ab')
    assert.equal(b.b(), 'ab')
  })

  check('noncyclic concurrent imports wait for TLA and deduplicate evaluation', async (t) => {
    let started
    let release
    const loading = new Promise((resolve) => { started = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const key = `__nasti_tla_${format}`
    globalThis[key] = { started, gate, evaluations: 0 }
    t.after(() => { release(); delete globalThis[key] })
    const { server, write } = await fixture(t, create)
    write('slow.js', `
      const state = globalThis[${JSON.stringify(key)}];
      state.evaluations++;
      state.started();
      await state.gate;
      export const value = "ready";
    `)
    write('left.js', 'export { value } from "./slow.js";')
    write('right.js', 'export { value } from "./slow.js";')
    let settled = 0
    const imports = ['/slow.js', '/slow.js', '/left.js', '/right.js'].map((url) =>
      server.ssrLoadModule(url).then((exports) => { settled++; return exports }))
    await loading
    // Let the other roots reach the pending dependency before opening the gate.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(settled, 0, 'acyclic callers must not observe partial exports')
    assert.equal(globalThis[key].evaluations, 1)
    release()
    const results = await Promise.all(imports)
    assert.equal(results[0], results[1])
    for (const result of results) assert.equal(result.value, 'ready')
    assert.equal(globalThis[key].evaluations, 1)
  })

  check('invalidated in-flight waits do not create cycles in replacement evaluations', async (t) => {
    let oldStarted
    let newStarted
    let releaseOld
    let releaseNew
    const oldLoading = new Promise((resolve) => { oldStarted = resolve })
    const newLoading = new Promise((resolve) => { newStarted = resolve })
    const key = `__nasti_wait_generation_${format}`
    globalThis[key] = {
      oldStarted,
      newStarted,
      oldGate: new Promise((resolve) => { releaseOld = resolve }),
      newGate: new Promise((resolve) => { releaseNew = resolve }),
    }
    t.after(() => { releaseOld(); releaseNew(); delete globalThis[key] })
    const { server, graph, write } = await fixture(t, create)
    write('a.js', 'export { value } from "./b.js";')
    write('b.js', `
      const state = globalThis[${JSON.stringify(key)}];
      state.oldStarted();
      await state.oldGate;
      throw new Error("old evaluation failed");
      export const value = "old";
    `)
    const old = assert.rejects(server.ssrLoadModule('/a.js'), /old evaluation failed/)
    await oldLoading // The old a -> b wait is still active.
    write('a.js', `
      const state = globalThis[${JSON.stringify(key)}];
      state.newStarted();
      await state.newGate;
      export const value = "replacement";
    `)
    write('b.js', 'import { value } from "./a.js"; export const result = value;')
    graph.invalidateModuleAndImporters(graph.getModuleByUrl('/b.js'))
    let settled = false
    const replacement = server.ssrLoadModule('/b.js').then((exports) => {
      settled = true
      return exports
    })
    await newLoading
    assert.equal(settled, false, 'new b -> a is not a cycle with old a -> b')
    releaseNew()
    const exports = await replacement
    assert.equal(exports.result, 'replacement')
    releaseOld()
    await old
    assert.equal(await server.ssrLoadModule('/b.js'), exports)
  })

  check('failed runner initialization is shared and can be retried', async (t) => {
    let attempts = 0
    const plugin = {
      name: 'fixture:retry-init',
      applyToEnvironment(environment) {
        if (environment.name === 'ssr') attempts++
        return true
      },
    }
    const dependency = { name: 'fixture:retry-dependency', pre: [plugin.name] }
    const { server } = await fixture(t, create, { plugins: [plugin, dependency] })
    // Introduce a container ordering failure after config resolution, before
    // the lazy server environment initializes.
    plugin.pre = [dependency.name]
    const results = await Promise.allSettled([
      server.transformEnvironmentRequest('ssr', '/entry.js'),
      server.ssrLoadModule('/entry.js'),
    ])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.match(result.reason.message, /circular plugin setup dependency/)
      assert.equal(result.reason, results[0].reason)
    }
    assert.equal(attempts, 1)

    delete plugin.pre
    const [transformed, exports] = await Promise.all([
      server.transformEnvironmentRequest('ssr', '/entry.js'),
      server.ssrLoadModule('/entry.js'),
    ])
    assert.ok(transformed.code)
    assert.equal(exports.value, 'middle:old')
    assert.equal(attempts, 2)
    assert.equal(await server.ssrLoadModule('/entry.js'), exports)
    assert.equal(attempts, 2, 'successful initialization must remain cached')
  })

  check('stale in-flight transforms cannot overwrite newer cache or edges', async (t) => {
    let started
    let release
    const loading = new Promise((resolve) => { started = resolve })
    let first = true
    t.after(() => release?.())
    const { server, graph, root, write } = await fixture(t, create, {
      plugins: [{
        name: 'fixture:delayed-transform',
        async transform(code, id) {
          if (id === path.join(root, 'entry.js') && first) {
            first = false
            started()
            await new Promise((resolve) => { release = resolve })
          }
          return code
        },
      }],
    })
    const old = server.transformEnvironmentRequest('ssr', '/entry.js')
    await loading
    write('next.js', 'export const value = "replacement";')
    const entryFile = write('entry.js', 'export { value } from "./next.js";')
    server.watcher.emit('change', entryFile)
    const replacement = await server.transformEnvironmentRequest('ssr', '/entry.js')
    const entry = node(graph, '/entry.js', root)
    const next = node(graph, '/next.js', root)
    release()
    await old
    assert.deepEqual(entry.transformResult, replacement)
    assert.deepEqual([...entry.importedModules], [next])
    edge(entry, next)
    const middle = graph.getModuleByUrl('/middle.js')
    if (middle) assert.equal(middle.importers.has(entry), false)
    assert.equal((await server.ssrLoadModule('/entry.js')).value, 'replacement')
  })
}
