---
name: nasti
description: Set up, configure, and troubleshoot Nasti (@nasti-toolchain/nasti), the Rolldown and OXC web bundler. Use for nasti.config.*, Nasti dev/build/preview commands, framework integration, or migrating a Vite app to Nasti.
---

# Use Nasti

## Start with the app

1. Check the app's `package.json`, installed Nasti version, scripts, config, and entry files before suggesting changes. Nasti 2.x currently requires Node.js `^20.19.0 || >=22.12.0`; check `engines.node` for the installed version.
2. Use the project's existing package manager. Add Nasti and any framework-specific dependencies to the app that uses them, not just the monorepo root.
3. Identify the target: a regular web app uses an HTML entry, native TanStack Start supplies its own entries, and Electron uses separate main, preload, and renderer entries. Don't apply the web quick start unchanged to the other targets.
4. Run the app's dev and production commands after changing config or plugins. Working in dev alone does not verify production bundling.

## Minimal web app

Install `@nasti-toolchain/nasti` as a dev dependency. With pnpm, run these commands from the app directory (or use `pnpm --filter <app> …` from the workspace root). Run the server commands separately or stop each server when you're done checking it.

```sh
pnpm add -D @nasti-toolchain/nasti
pnpm exec nasti dev
pnpm exec nasti build
pnpm exec nasti preview
```

For a new app, add `index.html` in the app root and point it to a real module:

```html
<!doctype html>
<meta charset="utf-8">
<title>Nasti app</title>
<div id="app"></div>
<script type="module" src="/src/main.ts"></script>
```

```ts
// src/main.ts
document.querySelector('#app')!.textContent = 'Hello from Nasti'
```

Dev serves the source app. Build writes to `dist/` by default. Preview serves the built output, so rebuild before checking a change with preview. If you change `build.outDir`, pass the same directory to `nasti preview --outDir <dir>`.

## Configure or migrate

Nasti loads `nasti.config.ts`, `.js`, `.mjs`, or `.mts` from the app root. A minimal app doesn't need a config. To set options, create `nasti.config.ts`:

```ts
import { defineConfig } from '@nasti-toolchain/nasti'

export default defineConfig({
  server: { port: 3000 },
  build: { outDir: 'dist', sourcemap: true },
})
```

- When migrating, keep the existing HTML, source entry, and static assets. Move supported options such as `resolve.alias`, `base`, `server` and `build.outDir` into the Nasti config; don't assume a `vite.config.*` is loaded or that every Vite option has a counterpart.
- Use Nasti's built-in framework transforms instead of adding a duplicate Vite framework plugin. Common `resolveId`, `load`, and `transform` hooks are supported, but check Vite-specific hooks and verify the plugin in both dev and build.
- Use `build.rolldownOptions` for Rolldown input options such as `external` and `treeshake`. Use `build.rolldownOptions.output.codeSplitting` for chunk rules, not Vite's `build.rollupOptions` or Rolldown's old `advancedChunks`. `build.outDir` controls the output location.
- For programmatic use, import `build` or `createServer` from `@nasti-toolchain/nasti`. Call `server.listen()` to serve requests and close the server when its owner exits or a test finishes.

## Choose framework support

Set `framework` explicitly when multiple runtimes are present or automatic detection picks the wrong one.

| `framework` | What the app needs |
| --- | --- |
| `react` | `react` and `react-dom`. JSX and Fast Refresh are built in. Install `oxc-transform-react` and set `react.compiler` only to opt into the experimental React Compiler. |
| `vue` | `vue` and a compatible `@vue/compiler-sfc`. Check the tested Vue/compiler versions before enabling experimental Vapor Mode. |
| `solid` | `solid-js`, `@babel/core`, `babel-preset-solid`, and `solid-refresh` for development refresh. |
| `svelte` | Svelte 5 provides `svelte/compiler`. Nasti supports Svelte components, not SvelteKit routing or adapters. |
| `preact` | `preact` and, for HMR, `@prefresh/core` and `@prefresh/utils`. For TSX, set `jsx: "react-jsx"` and `jsxImportSource: "preact"` in `tsconfig.json`. Nasti doesn't alias React to Preact automatically. |

Use `tanstackRouter()` for a Router SPA and keep its `index.html`. For native Start, use `tanstackStart()` instead, check the tested compiler versions for your release, and verify the server build as well as the client. For Electron, configure the `electron` entries and use `nasti electron` for dev and `nasti electron-build` for production.

## Diagnose and verify

- **Wrong project or missing entry:** Check which directory the command runs in and whether `index.html` references the correct source module. For Start or Electron, check that target's entry conventions instead.
- **Missing compiler or runtime:** Check the app's direct dependencies and the installed Nasti version's peer requirements before adding aliases, hoisting packages, or disabling strict dependency checks.
- **Works in dev, fails after build:** Run `nasti build` and `nasti preview` against fresh output. Check `base`, output directory, asset URLs, and whether plugins behave differently in dev and production.
- **Syntax or option uncertainty:** Run `pnpm exec nasti --help` or `pnpm exec nasti build --help`. Check the README shipped with the installed package before relying on a newer online example.

## References

- [Nasti documentation](https://nasti.zixiaolabs.com)
- [Nasti README and integration examples](https://github.com/zixiao-labs/Nasti#readme)
