import { defineConfig, tanstackStart, redact } from '@nasti-toolchain/nasti'

export default defineConfig({
  framework: 'react',
  plugins: [
    tanstackStart(),
    ...(process.env.NASTI_REDACT === '1' ? [redact()] : []),
  ],
})
