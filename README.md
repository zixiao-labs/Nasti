<div align="center">

# Nasti

**基于 [Rolldown](https://rolldown.rs) + [OXC](https://oxc.rs) 的高性能 Web 打包器**

*兼容 Vite 插件生态，内置 React & Vue 支持*

[![CI](https://github.com/zixiao-labs/Nasti/actions/workflows/ci.yml/badge.svg)](https://github.com/zixiao-labs/Nasti/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/nasti-build)](https://www.npmjs.com/package/nasti-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](#features) | [文档](https://nasti.zixiaolabs.com) | [快速开始](#quick-start)

</div>

---

## Features

- **Rolldown 驱动** - Rust 编写的打包内核，生产构建速度比 Rollup 快 10-30x
- **OXC 转译** - Rust 编写的 TS/JSX/TSX 转译器，比 Babel 快 20-50x
- **Vite 插件兼容** - 直接使用现有 Vite/Rollup 插件（resolveId / load / transform，Electron 移植工作正在进行中）
- **内置 React 支持** - JSX 自动转换 + React Fast Refresh HMR
- **内置 Vue 支持** - SFC 编译 + Vue HMR（可选依赖 `@vue/compiler-sfc`）
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
import { defineConfig } from 'nasti-build'

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

## CLI

```bash
# 开发服务器
nasti dev [root] [--port 3000] [--host] [--open]

# 生产构建
nasti build [root] [--outDir dist] [--sourcemap] [--minify]

# 预览构建产物
nasti preview [root] [--port 4173]
```

## Programmatic API

```ts
import { build, createServer, defineConfig } from 'nasti-build'

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
import type { NastiPlugin } from 'nasti-build'

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

## License

[MIT](./LICENSE) - Made by [zixiao-labs](https://github.com/zixiao-labs)

> Nasti - 明日方舟莱茵生命工程科主任娜斯提

快的太吓人