import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import * as asar from '@electron/asar';
import { pack } from '../index.mjs';

// Build separately: compilation is intentionally excluded from every timed run.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nasti-asar-bench-'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
 for (const scenario of ['assets', 'dependencies']) {
  const input = path.join(temp, scenario);
  await fs.mkdir(path.join(input, 'native'), { recursive: true });
  await fs.mkdir(path.join(input, 'modules'));
  await fs.writeFile(path.join(input, 'package.json'), '{"main":"index.js"}');
  await fs.writeFile(path.join(input, 'index.js'), 'console.log("benchmark")');
  for (let i = 0; i < 1000; i++) await fs.writeFile(path.join(input, 'modules', `${i}.js`), Buffer.alloc(8192, i % 256));
  await fs.writeFile(path.join(input, 'large.bin'), Buffer.alloc(32 * 1024 * 1024, 42));
  await fs.writeFile(path.join(input, 'native', 'addon.node'), Buffer.alloc(1024 * 1024, 17));
  if (scenario === 'dependencies') {
    // Materialized manifests: 200 root packages, each requiring 20 hoisted
    // dependencies, plus a nested dependency overriding one hoisted package.
    const dependencies = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`pkg${i}`, '1']));
    await fs.writeFile(path.join(input, 'package.json'), JSON.stringify({ main: 'index.js', dependencies }));
    for (let i = 0; i < 200; i++) {
      const dir = path.join(input, 'node_modules', `pkg${i}`);
      await fs.mkdir(dir, { recursive: true });
      const dependencies = Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`dep${j}`, '1']));
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies }));
      await fs.writeFile(path.join(dir, 'index.js'), Buffer.alloc(8192, i % 256));
    }
    for (let i = 0; i < 20; i++) {
      const dir = path.join(input, 'node_modules', `dep${i}`);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'package.json'), '{}');
    }
    const nested = path.join(input, 'node_modules/pkg0/node_modules/dep0');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'package.json'), '{}');
  }
  const results = { rust: [], official: [] };
  // One unrecorded warmup per implementation; alternate order to reduce cache bias.
  for (let round = -1; round < 5; round++) {
    for (const backend of round % 2 ? ['rust', 'official'] : ['official', 'rust']) {
      const output = path.join(temp, `${backend}-${round}.asar`);
      const start = performance.now();
      if (backend === 'rust') {
        await pack({ input, output, unpack: ['native'] });
      } else {
        await asar.createPackageWithOptions(input, output, { unpackDir: 'native' });
      }
      const elapsed = performance.now() - start;
      if (round >= 0) results[backend].push(elapsed);
      // Each implementation hashes every file with SHA256 and 4 MiB blocks.
      if (asar.statFile(output, 'large.bin').integrity.blockSize !== 4 * 1024 * 1024) throw new Error('hash config mismatch');
      asar.uncache(output);
      await fs.rm(output);
      await fs.rm(`${output}.unpacked`, { recursive: true });
    }
  }
  console.log(JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version,
    scenario,
    fixture: '1000 x 8KiB + 32MiB packed + 1MiB unpacked; SHA256/4MiB; 5 runs after warmup',
    rustMedianMs: median(results.rust), officialMedianMs: median(results.official),
    samplesMs: results,
    note: 'ASAR stage only; direct napi AsyncTask vs official API; compilation excluded; no speedup guarantee',
  }, null, 2));
 }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
