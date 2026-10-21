// Opt in only for webgpuPlugin(). vgpu users should reference @vgpu/wgsl/wgsl-types instead.
declare module '*.wgsl' {
  const source: string
  export default source
}

declare module '*.wgsl?raw' {
  const source: string
  export default source
}

declare module '*.wgsl?url' {
  const url: string
  export default url
}
