import type { NastiPlugin } from '../types.js'

/**
 * Import plain WGSL as a string for GPUDevice.createShaderModule({ code }).
 * For vgpu's ShaderSource modules, use @vgpu/wgsl/loader-vite instead.
 */
export function webgpuPlugin(): NastiPlugin {
  return {
    name: 'nasti:webgpu',
    transform(source, id) {
      // Explicit ?raw / ?url requests belong to the asset loader.
      if (!id.endsWith('.wgsl')) return null
      return {
        code: `export default ${JSON.stringify(source)};`,
        map: null,
        moduleType: 'js',
      }
    },
  }
}
