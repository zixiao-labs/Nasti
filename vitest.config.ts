import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __NASTI_VERSION__: JSON.stringify('1.4.1'),
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
