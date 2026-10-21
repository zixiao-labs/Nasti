import { effect, init, surface } from 'vgpu'
import gradientSource from './gradient.wgsl'

const status = document.querySelector<HTMLParagraphElement>('#status')!

async function render() {
  if (!navigator.gpu) {
    status.textContent = 'WebGPU is unavailable. Use a supported browser on HTTPS or localhost.'
    return
  }
  const gpu = await init()
  try {
    const output = surface(gpu, document.querySelector<HTMLCanvasElement>('canvas')!)
    const gradient = effect(gpu, gradientSource)
    gradient.draw(output)
  } catch (error) {
    gpu.dispose()
    throw error
  }
  status.textContent = 'Rendered with vgpu. Edit color.wgsl to reload the shader.'
  window.addEventListener('pagehide', () => gpu.dispose(), { once: true })
}

render().catch((error: unknown) => {
  status.textContent = error instanceof Error ? error.message : String(error)
})
