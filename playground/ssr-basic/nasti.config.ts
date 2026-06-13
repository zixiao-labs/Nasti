import { defineConfig } from '../../dist/index.js'

export default defineConfig({
  environments: {
    ssr: {
      entry: 'src/entry-server.ts',
    },
  },
})
