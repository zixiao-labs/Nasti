import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as asar from '@electron/asar';
import { binary } from '../scripts/pack.mjs';
import { pack } from '../index.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blockSize = 4 * 1024 * 1024;
const invoke = (input, output, ...args) => spawnSync(binary, ['pack', input, output, ...args], { encoding: 'utf8', timeout: 10_000 });
// @electron/asar splits lookup directories on path.sep; normalize at its API boundary.
const oracleStatFile = (archive, name) => asar.statFile(archive, path.normalize(name));
const oracleExtractFile = (archive, name) => asar.extractFile(archive, path.normalize(name));

for (const backend of ['cli', 'binding']) {
test(`${backend} official oracle: list, extraction, integrity, executable, sidecar, deterministic bytes`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-asar-'));
  try {
    const input = path.join(temp, 'app');
    await fs.mkdir(path.join(input, '嵌套', 'empty-dir'), { recursive: true });
    await fs.mkdir(path.join(input, '嵌套', '更深', 'empty-dir'), { recursive: true });
    await fs.mkdir(path.join(input, 'native', 'empty-dir'), { recursive: true });
    const files = {
      'package.json': Buffer.from('{"main":"index.js"}'),
      'index.js': Buffer.from('console.log("staged")'),
      '.hidden': Buffer.from('dot file'),
      '.pnpm': Buffer.from('ordinary dot file, not a dependency directory'),
      '嵌套/空.txt': Buffer.alloc(0),
      '嵌套/更深/文件.txt': Buffer.from('nested file'),
      '嵌套/跨块.bin': Buffer.alloc(blockSize + 17, 42),
      '嵌套/整块.bin': Buffer.alloc(blockSize, 91),
      'native/run': Buffer.from('#!/bin/sh\nexit 0\n'),
      'native/空': Buffer.alloc(0),
    };
    for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(input, name), bytes);
    if (process.platform !== 'win32') await fs.chmod(path.join(input, 'native/run'), 0o755);
    const output = path.join(temp, 'rust.asar');
    const output2 = path.join(temp, 'rust2.asar');
    for (const target of [output, output2]) {
      if (backend === 'binding') {
        await pack({ input, output: target, unpack: ['native', '.hidden'] });
      } else {
        const result = invoke(input, target, '--unpack', 'native', '--unpack', '.hidden');
        assert.equal(result.status, 0, result.stderr);
      }
    }
    assert.deepEqual(await fs.readFile(output), await fs.readFile(output2));
    const official = path.join(temp, 'official.asar');
    await asar.createPackageWithOptions(input, official, { unpackDir: 'native', unpack: '.hidden' });
    assert.deepEqual(asar.listPackage(output).sort(), asar.listPackage(official).sort());
    for (const [name, bytes] of Object.entries(files)) {
      assert.deepEqual(oracleExtractFile(output, name), bytes);
      const stat = oracleStatFile(output, name);
      assert.equal(stat.size, bytes.length);
      assert.deepEqual(stat.integrity, oracleStatFile(official, name).integrity);
      assert.equal(stat.integrity.hash, hash(bytes));
      assert.equal(stat.integrity.blockSize, blockSize);
      const blocks = [];
      for (let i = 0; i < bytes.length; i += blockSize) blocks.push(hash(bytes.subarray(i, i + blockSize)));
      if (bytes.length % blockSize === 0) blocks.push(hash(Buffer.alloc(0)));
      assert.deepEqual(stat.integrity.blocks, blocks);
      assert.equal(Boolean(stat.unpacked), name.startsWith('native/') || name === '.hidden');
      if (stat.unpacked) assert.deepEqual(await fs.readFile(`${output}.unpacked/${name}`), bytes);
    }
    assert.equal(Boolean(oracleStatFile(output, 'native/run').executable), process.platform !== 'win32');
    assert.equal(oracleStatFile(output, 'native/empty-dir').unpacked, true);
    const extracted = path.join(temp, 'extracted');
    asar.extractAll(output, extracted);
    for (const [name, bytes] of Object.entries(files)) assert.deepEqual(await fs.readFile(path.join(extracted, name)), bytes);
    assert.equal((await fs.stat(path.join(extracted, '嵌套/empty-dir'))).isDirectory(), true);
    assert.equal((await fs.stat(path.join(extracted, '嵌套/更深/empty-dir'))).isDirectory(), true);
    if (process.platform !== 'win32') assert.ok((await fs.stat(path.join(extracted, 'native/run'))).mode & 0o100);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test(`${backend} invalid staged inputs and destinations fail without archive/sidecar`, { timeout: 10_000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-asar-invalid-'));
  try {
    const input = path.join(temp, 'app');
    await fs.mkdir(input);
    const output = path.join(temp, 'app.asar');
    const reject = async (...args) => {
      if (backend === 'binding') {
        await assert.rejects(pack({ input, output, unpack: args.filter((_, i) => i % 2) }));
      } else {
        assert.notEqual(invoke(input, output, ...args).status, 0);
      }
      await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(`${output}.unpacked`), { code: 'ENOENT' });
    };
    await reject();
    await fs.writeFile(path.join(input, 'package.json'), '{"main":"missing.js"}');
    await reject();
    await fs.writeFile(path.join(input, 'index.js'), '');
    await fs.writeFile(path.join(input, 'package.json'), '{"main":"../outside"}');
    await reject();
    await fs.writeFile(path.join(input, 'package.json'), '{"main":"index.js","dependencies":{"absent":"1"}}');
    await reject();
    await fs.writeFile(path.join(input, 'package.json'), '{"main":"index.js"}');
    await reject('--unpack', '../outside');
    await reject('--unpack', 'missing');
    await reject('--unpack', '*');
    await fs.mkdir(path.join(input, 'node_modules', '.pnpm'), { recursive: true });
    await reject();
    await fs.rm(path.join(input, 'node_modules'), { recursive: true });
    if (process.platform !== 'win32') {
      // 输入目录本身带尾随 / 或 /. 仍不能跟随 symlink。
      const linkedInput = path.join(temp, 'linked-app');
      await fs.symlink(input, linkedInput, 'dir');
      for (const source of [linkedInput, `${linkedInput}/`, `${linkedInput}/.`]) {
        if (backend === 'binding') {
          await assert.rejects(pack({ input: source, output }), /input symlink rejected/);
        } else {
          const result = invoke(source, output);
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /input symlink rejected/);
        }
      }
      await fs.unlink(linkedInput);
      await fs.symlink('index.js', path.join(input, 'link'));
      await reject();
      await fs.unlink(path.join(input, 'link'));
      const fifo = spawnSync('mkfifo', [path.join(input, 'fifo')]);
      assert.equal(fifo.status, 0);
      await reject();
      await fs.unlink(path.join(input, 'fifo'));
      const large = path.join(input, 'large.bin');
      await fs.writeFile(large, '');
      await fs.truncate(large, 2 ** 32);
      for (const options of [[], ['--unpack', 'large.bin']]) {
        if (backend === 'binding') {
          await assert.rejects(pack({ input, output, unpack: options.length ? ['large.bin'] : [] }), /file too large/);
        } else {
          const result = invoke(input, output, ...options);
          assert.equal(result.error, undefined, 'sparse 4GiB must fail during scan, not time out');
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /file too large/);
        }
        await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
        await assert.rejects(fs.lstat(`${output}.unpacked`), { code: 'ENOENT' });
      }
      await fs.unlink(large);
    }
    if (backend === 'binding') await assert.rejects(pack({ input, output: path.join(input, 'nested.asar') }));
    else assert.notEqual(invoke(input, path.join(input, 'nested.asar')).status, 0);
    await fs.writeFile(output, 'keep');
    if (backend === 'binding') await assert.rejects(pack({ input, output }));
    else assert.notEqual(invoke(input, output).status, 0);
    assert.equal(await fs.readFile(output, 'utf8'), 'keep');
    await fs.unlink(output);
    await fs.mkdir(`${output}.unpacked`);
    await fs.writeFile(`${output}.unpacked/keep`, 'keep');
    if (backend === 'binding') await assert.rejects(pack({ input, output, unpack: ['index.js'] }));
    else assert.notEqual(invoke(input, output, '--unpack', 'index.js').status, 0);
    assert.equal(await fs.readFile(`${output}.unpacked/keep`, 'utf8'), 'keep');
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
}

test('binding is Promise-based, no top-level await, and allows event-loop progress', async () => {
  // Synchronous require of the ESM wrapper fails if its module graph uses TLA.
  const { createRequire } = await import('node:module');
  const api = createRequire(import.meta.url)('../index.mjs');
  assert.equal(typeof api.pack, 'function');
  const invalid = api.pack({});
  assert.ok(invalid instanceof Promise);
  await assert.rejects(invalid);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-asar-async-'));
  try {
    const input = path.join(temp, 'app');
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'package.json'), '{"main":"index.js"}');
    await fs.writeFile(path.join(input, 'index.js'), Buffer.alloc(32 * 1024 * 1024, 17));
    // Test native AsyncTask itself as well as the public wrapper.
    const native = createRequire(import.meta.url)('../nasti-electron-packager.node');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const result = native.pack({ input, output: path.join(temp, 'app.asar') });
      assert.ok(result instanceof Promise);
      assert.equal(await result, undefined);
      assert.ok(ticks > 0, 'event loop must run while native packing is pending');
    } finally {
      clearInterval(timer);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('binding validates transitive, hoisted, nested and optional dependency manifests', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-asar-deps-'));
  try {
    const input = path.join(temp, 'app');
    await fs.mkdir(path.join(input, 'node_modules/a'), { recursive: true });
    await fs.writeFile(path.join(input, 'index.js'), '');
    await fs.writeFile(path.join(input, 'package.json'), '{"dependencies":{"a":"1"}}');
    await fs.writeFile(path.join(input, 'node_modules/a/package.json'),
      '{"dependencies":{"b":"1","optional":"1"},"optionalDependencies":{"optional":"1"}}');
    const output = path.join(temp, 'app.asar');
    await assert.rejects(pack({ input, output }), /missing staged runtime dependency: b/);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    // Node 不搜索 node_modules/node_modules；这个布局不能掩盖缺失依赖。
    await fs.mkdir(path.join(input, 'node_modules/node_modules/b'), { recursive: true });
    await fs.writeFile(path.join(input, 'node_modules/node_modules/b/package.json'), '{}');
    await assert.rejects(pack({ input, output }), /missing staged runtime dependency: b/);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    await fs.mkdir(path.join(input, 'node_modules/b'));
    await fs.writeFile(path.join(input, 'node_modules/b/package.json'), '{}');
    await pack({ input, output });
    assert.equal(oracleStatFile(output, 'node_modules/b/package.json').size, 2);
    assert.deepEqual(oracleExtractFile(output, 'node_modules/b/package.json'), Buffer.from('{}'));
    await fs.rm(path.join(input, 'node_modules/b'), { recursive: true });
    await fs.mkdir(path.join(input, 'node_modules/a/node_modules/b'), { recursive: true });
    await fs.writeFile(path.join(input, 'node_modules/a/node_modules/b/package.json'), '{}');
    const nestedOutput = path.join(temp, 'nested.asar');
    await pack({ input, output: nestedOutput });
    assert.equal(oracleStatFile(nestedOutput, 'node_modules/a/node_modules/b/package.json').size, 2);
    assert.deepEqual(oracleExtractFile(nestedOutput, 'node_modules/a/node_modules/b/package.json'), Buffer.from('{}'));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('missing local binding gives explicit build guidance without installing', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-asar-missing-'));
  try {
    const wrapper = path.join(temp, 'index.mjs');
    await fs.copyFile(new URL('../index.mjs', import.meta.url), wrapper);
    const { pathToFileURL } = await import('node:url');
    await assert.rejects(import(pathToFileURL(wrapper).href), /npm run build:binding/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
