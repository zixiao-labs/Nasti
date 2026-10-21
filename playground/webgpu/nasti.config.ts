import { defineConfig } from '@nasti-toolchain/nasti'
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite'

export default defineConfig({
  plugins: [wgslVitePlugin()],
})
