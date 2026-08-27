<div align="center">

# Nasti

**基于 [Rolldown](https://rolldown.rs) + [OXC](https://oxc.rs) 的高性能 Web 打包器**

*兼容 Vite 插件生态，内置 React & Vue 支持*

[![CI](https://github.com/zixiao-labs/Nasti/actions/workflows/ci.yml/badge.svg)](https://github.com/zixiao-labs/Nasti/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nasti-toolchain%2Fnasti)](https://www.npmjs.com/package/@nasti-toolchain/nasti)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](#features) | [文档](https://nasti.zixiaolabs.com) | [快速开始](#quick-start)

</div>

---

## Features

- **Rolldown 驱动** - Rust 编写的打包内核，生产构建速度比 Rollup 快 10-30x
- **OXC 转译** - Rust 编写的 TS/JSX/TSX 转译器，比 Babel 快 20-50x
- **Vite 插件兼容** - 直接使用现有 Vite/Rollup 插件（resolveId / load / transform）
- **内置 React 支持** - JSX 自动转换 + React Fast Refresh HMR
- **内置 Vue 支持** - SFC 编译 + Vue HMR；测试版支持 Vue 3.6 Vapor Mode（可选依赖 `@vue/compiler-sfc`）
- **Electron 41+ 支持** - React/Vue renderer + 主进程 / Preload，支持 ESM 主进程
- **Environment Driver** - 可桥接 Rspeedy 等非 Rolldown 工具链，含 build/dev/watch 生命周期
- **Monaco Editor 集成** - 内置 `monacoEditorPlugin`，预打包 Web Worker，修复 HMR 期间的 EMFILE
- **Dev Server + HMR** - 开发服务器 + WebSocket 热模块替换
- **TypeScript 优先** - 原生 TS 支持，零配置

## Quick Start

Requires Node.js `^20.19.0` or `>=22.12.0`.

```bash
# 安装
npm install -D @nasti-toolchain/nasti

# 启动开发服务器
npx nasti dev

# 生产构建
npx nasti build
```

## 项目结构

Nasti 期望的项目结构与 Vite 一致：

```
my-project/
├── index.html          # 入口 HTML
├── src/
│   ├── main.tsx        # JS 入口（在 index.html 中引用）
│   └── App.tsx
├── public/             # 静态资源（原样复制）
└── nasti.config.ts     # 配置文件（可选）
```

## Configuration

```ts
// nasti.config.ts
import { defineConfig } from '@nasti-toolchain/nasti'

export default defineConfig({
  // 框架: 'react' | 'vue' | 'auto'（自动检测）
  framework: 'react',

  server: {
    port: 3000,
    host: true,       // 监听所有地址
    open: true,        // 自动打开浏览器
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    minify: true,
  },

  resolve: {
    alias: {
      '@': '/src',
    },
  },

  // 直接使用 Vite 插件
  plugins: [],
})
```

### 生产构建：手动代码拆分 & Tree-shaking

`build.rolldownOptions` 透传 Rolldown 底层选项：input 侧（如 `treeshake`、`resolve`、`external`）合并进打包，`output` 合并进产物写出阶段，用于手动控制 vendor 分包与 Tree-shaking。`input` / `plugins` 由 Nasti 接管，`output.dir` 始终由 `build.outDir` 决定。

```ts
export default defineConfig({
  build: {
    rolldownOptions: {
      // Tree-shaking（input 选项）
      treeshake: { moduleSideEffects: [{ test: /\/barrel\//, sideEffects: false }] },
      // 代码拆分（output 选项）
      output: {
        advancedChunks: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/]react/, priority: 20 },
            { name: 'vendor', test: /node_modules/, priority: 10 },
          ],
        },
        chunkFileNames: 'assets/chunks/[name].[hash].js',
      },
    },
  },
})
```

## CLI

```bash
# 开发服务器
nasti dev [root] [--port 3000] [--host] [--open]

# 生产构建（Web / Electron）
nasti build [root] [--outDir dist] [--sourcemap] [--minify] [--target web|electron]

# 预览构建产物
nasti preview [root] [--port 4173]

# Electron 开发模式（需预装 electron ^41）
nasti electron [root] [--port 3000] [--no-spawn] [--no-restart]

# Electron 生产构建（等价于 nasti build --target electron）
nasti electron-build [root] [--outDir dist]
```

## Programmatic API

```ts
import { build, createServer, defineConfig } from '@nasti-toolchain/nasti'

// 开发服务器
const server = await createServer({
  root: '.',
  server: { port: 3000 },
})
await server.listen()

// 生产构建
await build({
  root: '.',
  build: { outDir: 'dist' },
})
```

## Plugin API

Nasti 的插件接口与 Vite 完全兼容：

```ts
import type { NastiPlugin } from '@nasti-toolchain/nasti'

function myPlugin(): NastiPlugin {
  return {
    name: 'my-plugin',
    enforce: 'pre',  // 'pre' | 'post'（可选）
    apply: 'build',  // 'build' | 'serve'（可选）

    resolveId(source, importer) {
      // 解析模块 ID
    },

    load(id) {
      // 加载模块内容
    },

    transform(code, id) {
      // 转换模块代码
      return { code: transformedCode }
    },
  }
}
```

## React pipeline

React projects keep the existing automatic JSX and Fast Refresh behavior. The transform is now
configured through a dedicated pipeline whose option names follow `@vitejs/plugin-react`:

```ts
export default defineConfig({
  framework: 'react',
  react: {
    include: /\.[tj]sx?$/,
    exclude: /node_modules/,
    jsxRuntime: 'automatic',
    jsxImportSource: 'react',
  },
})
```

The pipeline stays in the legacy transform slot: existing plugins still receive the same source
shape and run in the same order in development and production.

### React Compiler (experimental)

Install the optional native compiler and enable it explicitly:

```bash
npm install -D oxc-transform-react
```

```ts
export default defineConfig({
  framework: 'react',
  react: {
    compiler: true,
    // Or: compiler: { compilationMode: 'annotation', target: '19' },
  },
})
```

Compiler optimization is limited to `client` consumers. Server environments still use the same
JSX runtime transform without compiling component memoization, which keeps server/client graphs
explicit for full-stack frameworks.

### RSC reference generator (experimental)

The opt-in `rsc()` plugin provides the low-level bundler generation needed by React Server
Components: `"use client"` proxies in the RSC graph, file-level `"use server"` references,
automatic client-boundary entries, the `react-server` condition, and an inspectable chunk
manifest.

```bash
npm install react-server-dom-webpack
```

```ts
import { defineConfig, rsc } from '@nasti-toolchain/nasti'

export default defineConfig({
  framework: 'react',
  plugins: [
    rsc({
      entries: {
        client: 'src/entry.client.tsx',
        ssr: 'src/entry.ssr.tsx',
        rsc: 'src/entry.rsc.tsx',
      },
    }),
  ],
})
```

Production builds emit `rsc-manifest.json`, mapping stable `/<root-relative-module>#<export>`
reference IDs to real client/RSC chunks. A framework remains responsible for request routing,
Flight streaming, and installing its server-function dispatcher at
`globalThis[Symbol.for('nasti.rsc.callServer')]`. This split lets Kunlun Next.js own application
conventions without coupling Nasti to a specific runtime.

## Vue 支持

Vue 支持需要安装可选依赖：

```bash
npm install -D @vue/compiler-sfc
```

```ts
// nasti.config.ts
export default defineConfig({
  framework: 'vue',
})
```

### Vapor Mode（测试版，需 Vue / `@vue/compiler-sfc` ≥ 3.6）

若仍在使用 Vue 3.5，请先升级依赖（详见 [website/pages/vue.html](./website/pages/vue.html)）：

```bash
npm install vue@^3.6.0-rc.2
npm install -D @vue/compiler-sfc@^3.6.0-rc.2
```

[Vapor Mode](https://github.com/vuejs/core/releases) 是 Vue 3.6 的 opt-in 编译模式，跳过 Virtual DOM，生成直接 DOM 操作。Nasti 支持单文件标记与环境级强制：

```vue
<!-- 单文件 opt-in -->
<script setup vapor>
import { ref } from 'vue'
const count = ref(0)
</script>
```

```ts
// 环境级强制：对 <script setup> / 纯 template SFC 启用 Vapor
export default defineConfig({
  framework: 'vue',
  environments: {
    client: {
      vue: { features: { vapor: true } },
    },
  },
})
```

启用后，终端与浏览器控制台会打印测试版免责声明。Vapor Mode **不适合 SSR**；生产环境无崩溃保证，仅建议用于试验或局部性能热点。

## Electron 支持

Nasti 原生支持 Electron，**最低 Electron 41**（对应 Node 22 / Chromium 138，完整 ESM 主进程）。

```bash
# 安装 Electron（按需选择版本，支持 41、42、43+）
npm install -D electron@^41
```

```ts
// nasti.config.ts
import { defineConfig } from '@nasti-toolchain/nasti'

export default defineConfig({
  target: 'electron',
  framework: 'auto',                    // 自动识别 React / Vue
  electron: {
    main: 'src/electron/main.ts',        // 主进程入口
    preload: 'src/electron/preload.ts',  // Preload 脚本（可传数组）
    renderer: 'src/renderer/index.html', // React / Vue renderer HTML
    mainFormat: 'cjs',                   // 主进程输出格式：'cjs' | 'esm'
    preloadFormat: 'cjs',                // Preload 输出格式
    nodeTarget: 'node22',                // Electron 41 捆绑 Node 22
    autoRestart: true,                   // 主/preload 变更后自动重启
    minVersion: 41,                      // 最低 Electron 版本
  },
})
```

Vue renderer 直接使用标准 SFC：

```ts
// src/renderer/main.ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

生产 renderer 默认使用 `base: './'`，因此 `BrowserWindow.loadFile()` 可以正确加载
hashed JS/CSS；显式配置其他 `base` 时保留用户值。

开发：

```bash
# 同时启动渲染进程 dev server + Electron，主/preload 变更自动重启
nasti electron
```

生产构建（产物结构）：

```text
dist/
├── renderer/            # Web 渲染层
├── main.cjs             # 主进程（可配置为 .mjs）
└── preload.cjs          # Preload 脚本
```

主进程示例：

```ts
// src/electron/main.ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })

  // 开发模式下 Nasti 会通过环境变量传入 dev server URL
  if (process.env.NASTI_DEV_SERVER_URL) {
    await win.loadURL(process.env.NASTI_DEV_SERVER_URL)
  } else {
    await win.loadFile(path.resolve(__dirname, 'renderer/index.html'))
  }
}

app.whenReady().then(createWindow)
```

> 详细说明见 [Electron 指南](https://nasti.zixiaolabs.com/pages/electron.html)。

## External Environment Driver

Rspeedy 等外部工具链可以接管单个环境，同时保留 Nasti 的 CLI、日志与多环境编排：

```ts
export default defineConfig({
  environments: {
    lynx: {
      consumer: 'client',
      driver: 'rspeedy',
    },
  },
  plugins: [pluginRspeedyBridge()],
})
```

bridge 插件通过 `createEnvironmentDriver()` 提供 `build`、`serve`、`watchChange`
和 `close`，并可使用 `setup(api)`、`api.expose/useExposed` 与
`afterBuildApp(results, api, context)` 协调多个插件或环境。

## 原生多环境聚合（Lynx BG / MT）

纯 Lynx 应用可以禁用默认 Web client，把同一入口交给两套独立的 client-consumer
Rolldown 环境。每套环境都有独立 module graph、resolve conditions、插件上下文和输出目录：

```ts
export default defineConfig({
  environments: {
    client: { buildEnabled: false },
    'lynx-background': {
      consumer: 'client',
      entry: 'src/index.ts',
      resolve: { conditions: ['lynx-background', 'browser', 'import'] },
    },
    'lynx-main-thread': {
      consumer: 'client',
      entry: 'src/index.ts',
      resolve: { conditions: ['lynx-main-thread', 'browser', 'import'] },
      build: {
        target: 'es2019',
        // 保留 CSS 模块图与 chunk 所有权，但不生成浏览器副作用/文件。
        css: { inject: false, emit: false },
      },
      vue: {
        template: { compilerOptions: { whitespace: 'condense' } },
        transformTemplate(source, context) {
          return transformLynxTemplate(source, context.environmentName)
        },
      },
    },
  },
  plugins: [pluginVueLynxNative()],
})
```

Environment API 是 `conditionNames` 和 `mainFields` 的唯一高层配置入口：
请使用 `environments.<name>.resolve.conditions` / `mainFields`（client 也可使用
top-level `resolve`）。这些值会无条件覆盖
`build.rolldownOptions.resolve.conditionNames` / `mainFields` 中的对应底层选项。

生产与 dev 插件钩子的 `this.environment` 都会准确指向当前 BG/MT 环境。
每个 client-consumer 环境拥有独立的 module graph、transform 缓存和命名 HMR
通道；工具链可以调用 `server.transformEnvironmentRequest(name, url)`（或
`server.environments[name].transformRequest(url)`）取得特定环境的转换结果。
`handleHotUpdateApp` 在一个文件完成所有环境的失效与重转后只调用一次：

```ts
const pluginVueLynxNative = () => ({
  name: 'vue-lynx:native',

  async handleHotUpdateApp({ environments }) {
    for (const [name, update] of Object.entries(environments)) {
      await reencodeAffectedSections(name, update.transformed)
    }
  },
})
```

CSS 原文/转换结果可从 `environment.getCssModule(id)` /
`environment.getCssModules()` 读取，无需解析浏览器 `<style>` 注入代码。
生产插件还可登记结构化 manifest，并在 app 级 finalizer 中直接查询
entry、chunk、CSS、asset 和 source map，最后写出聚合 bundle：

```ts
const pluginVueLynxNative = () => ({
  name: 'vue-lynx:native',

  generateBundle() {
    this.environment.setBuildMetadata({
      manifest: { thread: this.environment.name },
    })
  },

  afterBuildApp(_results, _api, app) {
    const background = app.getEntry('lynx-background', 'index')
    const mainThread = app.getEntry('lynx-main-thread', 'index')
    if (!background || !mainThread) throw new Error('Missing Lynx thread entry')

    app.emitFile({
      type: 'asset',
      fileName: 'main.native.lynx.bundle',
      source: encodeLynxBundle({ background, mainThread }),
    })
  },
})
```

`build()` 的 `environmentResults` 会包含原生环境自动推导的 `entries`、插件登记的
`manifest/stats`、`chunks/assets/css/sourceMaps` 及完整 `output`；对应的
`BuildAppContext.getChunk/getCss/getSourceMap/resolvePublicPath` 可跨环境关联初始与
lazy chunk。app 级产物同时出现在 `BuildResult.appOutput`。高层
`environments.<name>.build.target` 会同时应用于 OXC 的 TS/JSX 转换和 Rolldown
的最终输出，无需再设置底层 `rolldownOptions.transform.target`。

## Monaco Editor 支持

内置 `monacoEditorPlugin`（对标 `vite-plugin-monaco-editor`），解决两个老大难问题：

1. Monaco 的 Web Worker 是独立入口，必须单独打包
2. `monaco-editor` 包含 2000+ 源文件，按 ESM 逐文件服务会在 HMR 时触发 **EMFILE（too many open files）** — 本插件将 Worker 预打包到磁盘缓存，并把 `monaco-editor` 目录显式从 watcher 中剔除

```bash
npm install monaco-editor
```

```ts
// nasti.config.ts
import { defineConfig, monacoEditorPlugin } from '@nasti-toolchain/nasti'

export default defineConfig({
  plugins: [
    monacoEditorPlugin({
      // 默认全部启用：editorWorkerService / css / html / json / typescript
      languageWorkers: ['editorWorkerService', 'json', 'typescript'],

      // 自定义 Worker（如 monaco-graphql）
      customWorkers: [
        { label: 'graphql', entry: 'monaco-graphql/esm/graphql.worker' },
      ],

      // Worker URL 前缀，可指向 CDN 绝对 URL
      publicPath: 'monacoeditorwork',

      // 兼容旧 API：将 monaco 暴露到 window.monaco
      globalAPI: false,
    }),
  ],
})
```

应用代码无需任何胶水：

```ts
import * as monaco from 'monaco-editor'

monaco.editor.create(document.getElementById('editor')!, {
  value: 'function hi() { console.log("hello monaco") }',
  language: 'typescript',
  theme: 'vs-dark',
  automaticLayout: true,
})
```

> 详细说明见 [Monaco Editor 指南](https://nasti.zixiaolabs.com/pages/monaco.html)。

## License

[MIT](./LICENSE) - Made by [zixiao-labs](https://github.com/zixiao-labs)

> Nasti - 明日方舟干员命名 :
