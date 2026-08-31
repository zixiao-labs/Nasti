import { defineConfig } from '@nasti-toolchain/nasti'

export default defineConfig({
  environments: {
    ssr: {
      entry: 'src/entry-server.ts',
    },
  },
})
