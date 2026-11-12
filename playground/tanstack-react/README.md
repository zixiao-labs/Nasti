# Native TanStack integration

Both this workspace and `../tanstack-solid` use **Nasti → Rolldown**, not Vite.
The shared private package `../../packages/tanstack-shared` exercises strict pnpm
workspace resolution and cross-workspace invalidation. None of these fixtures
are published with Nasti.

## Run

From the repository root, on Node 24:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter playground-tanstack-react dev
pnpm --filter playground-tanstack-react build
pnpm --filter playground-tanstack-react typecheck
pnpm --filter playground-tanstack-react exec nasti preview

# The same React Start app using Redact:
NASTI_REDACT=1 pnpm --filter playground-tanstack-react dev

# Solid Start:
pnpm --filter playground-tanstack-solid dev
pnpm --filter playground-tanstack-solid build
pnpm --filter playground-tanstack-solid typecheck
```

`NASTI_REDACT=1` is POSIX shell syntax. On PowerShell, set
`$env:NASTI_REDACT='1'` before running the pnpm command.

## Add to another workspace

Install dependencies **in the application**, not only at the repository root.
Nasti resolves compiler tools relative to that application's `package.json`.

```sh
pnpm --filter <app> add react@^19 react-dom@^19 @tanstack/react-start@1.169.4 @tanstack/react-router@1.170.46
pnpm --filter <app> add -D @nasti-toolchain/nasti@^2.8.0 @tanstack/start-plugin-core@1.171.55 @tanstack/router-generator@1.167.46
# Optional:
pnpm --filter <app> add @tanstack/redact@0.2.1
```

For Solid, replace the React runtimes with `solid-js@1.9.17`,
`@tanstack/solid-start@1.169.4`, `@tanstack/solid-router@1.170.43`; add
`@babel/core@^7.29.7`, `babel-preset-solid@1.9.16`, `solid-refresh@0.7.8`
as application devDependencies. TypeScript needs `jsx: "preserve"` and
`jsxImportSource: "solid-js"`. The document shell must include
`HydrationScript` from `solid-js/web`.

Start's pinned upstream compiler requires Node **>=22.12**. Ordinary Nasti
applications retain Nasti's existing Node engine support.

```ts
import { defineConfig, tanstackStart } from '@nasti-toolchain/nasti'

export default defineConfig({
  framework: 'solid', // or 'react'
  plugins: [
    tanstackStart({
      framework: 'solid',
      srcDirectory: 'src',
      // Optional root-relative entry overrides:
      // entries: { router: 'src/router.tsx', start: 'src/start.ts' },
      // router: { routesDirectory: 'src/routes', generatedRouteTree: 'src/routeTree.gen.ts' },
      // serverFns: { base: '_serverFn' },
    }),
  ],
})
```

The generated default entries are under `.nasti/start/`; exclude `.nasti/`
and your generated route tree from version control. Start owns the `client`
and `ssr` environments. Do not add a second `tanstackRouter()` plugin, an
external driver, RSC, or extra environments. The adapter rejects these
combinations rather than quietly selecting another bundler.

For **Router without Start**, use `tanstackRouter({ framework: 'react' })`
(or `'solid'`) and your usual SPA `index.html` / router mount. Only
`@tanstack/router-generator` is required for route generation. Manual
`.lazy.tsx` route files and dynamic imports use native Rolldown splitting;
automatic extraction of route components is not implemented in this release.

## Native Start architecture and limits

- Reuse the upstream Start compiler's AST transforms for server functions,
  middleware and environment-only functions, plus the route compiler's AST/DCE
  removal of `server`, `headers` and `ssr` from the client graph.
- Nasti owns entry resolution, ordered React/Solid compilation, client-first
  dual-environment builds, the hydration/CSS manifest, server-function lookup,
  streaming Node ↔ Fetch HTTP, asset serving and source invalidation.
- The compiler host is **not a public TanStack export**. Nasti deliberately
  loads the shipped ESM host by file URL and checks
  `start-plugin-core@1.171.55` / its `router-plugin@1.168.48` dependency.
  Do not broaden these versions without revalidating the contract.
- No Vite package is installed by these workspaces. Redact's `/vite` module
  supplies a self-contained alias/feature resolver with no Vite runtime import;
  Nasti calls that resolver, not its Vite config/optimizer hooks.
  Solid Refresh's `bundler: "vite"` setting similarly selects the
  `import.meta.hot` protocol implemented by Nasti, not a Vite process.
- Development serves the **compiled client module graph** through native HMR,
  including manual lazy routes. Compatible React/Solid updates preserve state.
  The upstream route HMR compiler preserves live route/component identities;
  Solid's granular SSR/client transforms use matching hydration boundaries.
- Server bundles and RPC manifests still rebuild serially as a client/SSR pair.
  `createServerFn` changes update server execution; server-only dependency edits
  also invalidate browser loader data without reloading the document. Route
  additions/removals, env changes, incompatible boundaries and build-error
  recovery can still reload. Unrelated README changes do not rebuild the app.
  This does not use the core unbundled SSR evaluator and is not fully incremental
  server compilation. Generations are session-isolated and removed on close;
  Node's ESM cache still grows with successful server rebuilds.
- Development CSS uses the client module pipeline; production CSS extraction and
  manifests are unchanged. Dev rebuilds print one concise summary rather than
  production gzip tables, absolute chunk lists or unminified chunk-size warnings.
  Browser console logs show connection and timed Refresh completion; reload/error
  fallbacks are not reported as successful Fast Refresh.
- `DEBUG=nasti:start` reports the input that invalidated a generation and SSR
  404 request paths. The example root routes configure `notFoundComponent`;
  applications should do the same (or set Router's `defaultNotFoundComponent`).
  Only known non-RSC TanStack dependency `"use client"` diagnostics are filtered,
  not arbitrary directives or runtime warnings.
- Both normal SSR and browser React graphs use Redact when enabled. RSC and
  `react-server` condition graphs retain real React. Redact currently requires
  React 19 here; its React 18 post-transform is not implemented.
  `preset: 'nano'` requires explicitly restoring hydration for Start.
- Client maps exclude original `sourcesContent`, which could otherwise expose
  a server function's untransformed body. Server output/maps are never served
  by the built-in preview or Start dev host. Avoid manually serving the entire
  `dist/` directory: serve only `dist/client/`.
- RSC, prerendering, SPA mode, automatic route code splitting, advanced
  `hydrateWhen` compilation, custom compiler/serialization adapter plugins,
  and third-party Vite deployment plugins are **not implemented**.
  This API is not a drop-in replacement for all upstream Vite plugin options.
  Production fetch deployment beyond the included Node preview remains the
  application's responsibility.

## Validation

```sh
node --test test/tanstack.test.mjs

pnpm --filter playground-tanstack-react exec playwright install chromium
NASTI_BROWSER_TESTS=1 node --test test/tanstack.test.mjs
# To use a locally installed Chrome instead:
# NASTI_CHROME_PATH='/path/to/chrome' NASTI_BROWSER_TESTS=1 node --test test/tanstack.test.mjs
```

The default tests exercise real native builds, production SSR/HTTP, generated
assets, server-source isolation including source maps, linked workspace saves,
route add/unlink, Solid DOM/SSR output, base paths, and unsupported configuration.
The opt-in Chromium tests additionally assert hydration, state retention after
Start component edits, live `createServerFn`/server-dependency replacement,
loader refresh, lazy-route HMR, route-topology reloads, visible connection and
timed Refresh logs, client navigation, deep-link reload, standalone Redact
and Solid mounting, and Solid Refresh without a page reload. CI enables that
browser gate on Node 24; Start tests are skipped on Node 20, while the ordinary
Nasti test matrix continues to run there.
