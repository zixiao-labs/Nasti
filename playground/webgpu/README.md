# Nasti + vgpu + WebGPU

Browser-only workspace example using Vercel Labs `vgpu` 0.6 and its official
`@vgpu/wgsl/loader-vite` plugin. `gradient.wgsl` imports `color.wgsl`; editing the
shared module reloads the page because this example has no JS HMR accept boundary.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter playground-webgpu typecheck
pnpm --filter playground-webgpu dev
pnpm --filter playground-webgpu build
```

Open the printed localhost URL in a WebGPU-capable browser. The page reports
unsupported environments and initialization failures instead of assuming that an
adapter is available. Deployment requires HTTPS.

Dependencies live in this workspace's manifest, including the direct
`@vgpu/wgsl` development dependency used by the config. Do not rely on hoisting
from the monorepo root. The workspace explicitly disables the install scripts
for vgpu's headless Node backend (`@vgpu/adapter-node` and `webgpu`); this example
does not use that backend or install a native GPU runtime.

The imported shader is vgpu's `ShaderSource`, with reflection and resolved WGSL
modules. For plain WebGPU string imports, use Nasti's `webgpuPlugin()` **instead**
of `wgslVitePlugin()` and reference `@nasti-toolchain/nasti/webgpu` for types.
Do not enable both shader plugins or both `.wgsl` type declarations together.

Root regression tests run without a GPU:

```sh
node --test test/webgpu.test.mjs
```

These verify bundling and dependency updates, not actual GPU rendering.
