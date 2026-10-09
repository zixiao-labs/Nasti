import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let binding;
try {
  binding = require('./nasti-electron-packager.node');
} catch (cause) {
  throw new Error(
    '无法加载本地 Nasti ASAR binding；请在 packages/electron-packager 运行 npm run build:binding（需要 Rust/Cargo）。不会自动编译或下载。',
    { cause },
  );
}

// Keep argument/conversion errors on the same Promise rejection channel as I/O.
export async function pack(options) {
  await binding.pack(options);
}
