import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const binary = fileURLToPath(new URL(
  `../target/release/nasti-electron-packager${process.platform === 'win32' ? '.exe' : ''}`,
  import.meta.url,
));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(binary, ['pack', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) {
    console.error(`无法执行本地 Rust binary；请先运行 npm run build。\n${result.error.message}`);
  }
  process.exitCode = result.status ?? 1;
}
