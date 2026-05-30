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
- **内置 Vue 支持** - SFC 编译 + Vue HMR（可选依赖 `@vue/compiler-sfc`）
- **Electron 41+ 支持** - 一键构建主进程 / Preload / 渲染进程，支持 ESM 主进程
- **Monaco Editor 集成** - 内置 `monacoEditorPlugin`，预打包 Web Worker，修复 HMR 期间的 EMFILE
- **Dev Server + HMR** - 开发服务器 + WebSocket 热模块替换
- **TypeScript 优先** - 原生 TS 支持，零配置

## Quick Start

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
  electron: {
    main: 'src/electron/main.ts',        // 主进程入口
    preload: 'src/electron/preload.ts',  // Preload 脚本（可传数组）
    mainFormat: 'cjs',                   // 主进程输出格式：'cjs' | 'esm'
    preloadFormat: 'cjs',                // Preload 输出格式
    nodeTarget: 'node22',                // Electron 41 捆绑 Node 22
    autoRestart: true,                   // 主/preload 变更后自动重启
    minVersion: 41,                      // 最低 Electron 版本
  },
})
```

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
