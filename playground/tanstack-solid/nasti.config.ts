import { defineConfig, tanstackStart } from '@nasti-toolchain/nasti'

export default defineConfig({
  framework: 'solid',
  plugins: [tanstackStart({ framework: 'solid' })],
})
