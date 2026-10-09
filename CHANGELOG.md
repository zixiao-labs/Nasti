# Changelog

## 2.6.0

本次更新包含 [PR #45](https://github.com/zixiao-labs/Nasti/pull/45)，增强 Electron ESM 构建与开发流程，保留 CommonJS 默认配置。

### Electron

- 统一主进程与 preload 的开发/生产编译规则，按输出格式和构建模式选择 Node `import` / `require`、`development` / `production` 条件导出，并继承自定义 Node 条件。
- 支持 NodeNext 风格的源码解析：`.mjs` → `.mts`、`.cjs` → `.cts`、`.js` → `.ts` / `.tsx`；默认解析扩展名增加 `.mts` 和 `.cts`。
- 改进 ESM-only 依赖和 ESM / CommonJS 混合加载，保留顶层 `await` 与 `import.meta.url`，使用 Rolldown 的 `createRequire` 桥接。
- `electron.external` 同时外部化指定包及其子路径；外部依赖仍需随应用分发。
- 开发模式监听主进程/preload 导入的本地模块；编译失败时保留旧进程，缺失模块补齐后可自动恢复构建与重启。
- 修复 `nasti electron --no-spawn` 一次性编译后未关闭 renderer server 的问题，使命令可正常退出。

### 依赖与文档

- 升级 Rolldown 至 `1.2.13`、OXC 至 `0.153`，以及 cac `7`、chokidar `5`、dotenv `18` 等运行时依赖；Vue 与可选 SFC 编译器锁定为 `3.6.0-rc.10`。
- 更新 Electron ESM、sandboxed preload、应用分发及实验性 ASAR 后端的使用说明。

### 实验性工具（不随主 npm 包发布）

- 新增私有 workspace 包 `@nasti-toolchain/electron-packager`：共享 Rust ASAR 核心、异步 napi-rs `pack()` API 和可选诊断 CLI。
- 面向已暂存完整的应用目录，支持并行 SHA-256 完整性计算、流式归档和显式解包路径；增加官方 `@electron/asar` 互操作测试、基准及 Linux/macOS/Windows 原生 CI。
- 不默认接入 Nasti 构建链路，也不是 electron-builder 的替代品；不负责依赖收集/重建、安装包、签名、公证、自动更新或发布。

### 升级注意事项

- Nasti 的 Node 要求仍为 `^20.19.0 || >=22.12.0`；本仓库构建工具链的 Node 要求与发布包运行时要求不同。
- Electron 主进程与 preload 仍默认输出 CJS；ESM 主进程需显式配置 `electron.mainFormat: 'esm'`。
- 默认最低 Electron 版本仍为 `41`；ESM 至少需要 Electron `28`。使用旧版运行时时需同时调整 `minVersion` 和 `nodeTarget`。
- Sandboxed preload 建议继续使用 CJS；ESM preload 输出 `.mjs`，需显式设置 `sandbox: false`，动态 Node 导入还要求 `contextIsolation: true`。Nasti 不会自动降低安全配置。
- 若此前仅外部化包根、依赖其子路径被打包，需检查 `electron.external` 的新行为，并确保这些子路径依赖可在应用运行时解析。
- 启用实验性 React Compiler 的项目需同步升级可选 peer `oxc-transform-react` 至 `^0.153.0`；可选 RSC peer `react-server-dom-webpack` 的 `^19.0.0` 范围保持不变。

**完整变更**：https://github.com/zixiao-labs/Nasti/compare/v2.5.2...v2.6.0
