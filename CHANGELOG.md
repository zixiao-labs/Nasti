# Changelog

## Unreleased

### WebGPU and Vercel Labs vgpu

- Add opt-in `webgpuPlugin()` for importing plain `.wgsl` shaders as strings in
  development and production, with TypeScript declarations at
  `@nasti-toolchain/nasti/webgpu`.
- Support the official `@vgpu/wgsl/loader-vite` plugin and its compiled
  `ShaderSource` modules without adding GPU packages to Nasti's runtime dependencies.
- Track plugin `addWatchFile` inputs in development, including transitive WGSL
  dependencies in prebundled and linked workspace packages. Propagate shader
  changes through HMR boundaries, discard removed dependencies, isolate concurrent
  transforms, and recover after deleted shader inputs are recreated.
- Resolve shader `?raw` and `?url` imports relative to their importer and through
  aliases. Emit content-hashed, base-prefixed resource URLs in production and serve
  raw shader bytes separately from JavaScript import wrappers in development.
- Preserve import-like text inside shader strings instead of rewriting it as
  JavaScript module dependencies, and retain filesystem allowlist checks for
  outside-root shader resources.
- Add a browser-only `playground/webgpu` workspace with direct application
  dependencies, usage documentation, and CI build/typecheck coverage. Disable
  install scripts for vgpu's unused headless Node backend in this workspace.
- Add ten GPU-independent regressions covering shader output, assets, types,
  workspace resolution, HMR, real file watching, and failure recovery.

Validation on Node 24: all 164 tests, root and playground typechecks, the playground
production build, and a development HTTP module-loading smoke check passed.
Actual GPU rendering and the headless Node backend were not exercised; this
integration does not provide a WebGPU polyfill or change Electron GPU flags.

## 2.6.6

### Native client dependency pipeline

- Compile on-demand dependency bundles through the owning client environment's
  ordered resolve/load/transform hooks, preserving plugin context and hook filters.
- Use native browser/package resolution with environment conditions and main fields
  for dependency entries and transitive edges. Resolve package-private `#` imports
  inside their owning package instead of emitting invalid browser URLs.
- Apply environment and user defines before tree shaking; reject live Node builtin
  imports rather than stubbing server implementations. Isolate bundle caches by
  server/environment and discard failed or invalidated entry generations.
- Preserve inherited Rolldown transform/define options when an environment overrides
  output options. Keep application aliases out of dependency bundles, and normalize
  compiler-generated absolute imports and semantic-query loader IDs.
- Add browser-condition, compiler-hook, private-import, transitive dependency,
  environment define isolation, and server-secret/Node-boundary regressions.

The real Wuling Start development HTTP/Chrome reproduction was run against packed
local candidates. The original `node:async_hooks`, private-import, missing define,
and absolute split-import failures were removed, but the hydration click assertion
still timed out. This release does **not** certify Wuling OpenSpec task 4.1.

Publication follows PR review/CI and the `npm-publish` environment approval gate;
a version bump or PR is not evidence that npm publication completed.

**Full changelog**: https://github.com/zixiao-labs/Nasti/compare/v2.6.5...v2.6.6

## 2.6.5

### SSR development module loading

- Fix circular module evaluation deadlocks, including cycles spanning concurrent
  `ssrLoadModule` calls. Only cycle-closing importer waits receive partial exports;
  other callers still await evaluation and top-level await.
- Keep active evaluation waits scoped to cache-entry generations so invalidated
  in-flight loads cannot create false cycles in replacement evaluations.
- Wait for whole static evaluation groups before resolving public imports, and
  propagate cyclic failures to every dependent member. Dynamic imports remain
  separate from static cycle progress and never receive partial exports.
- Resolve external dependencies relative to their importing filesystem module,
  preserving nested package versions in non-hoisted installations. Virtual
  importers retain the application-root fallback.
- Add ESM/CJS cycle, concurrent evaluation, top-level await, invalidation, and
  transitive external-dependency regression coverage.
- Verify the real Wuling Start server-entry loader against the local candidate;
  document the runner's existing cyclic re-export/linking limitations.

These runner fixes do not by themselves implement or certify Wuling's development
HTTP host or browser hydration (OpenSpec task 4.1).

**Full changelog**: https://github.com/zixiao-labs/Nasti/compare/v2.6.4...v2.6.5

## 2.6.4

本次更新包含 [PR #48](https://github.com/zixiao-labs/Nasti/pull/48)，让 production build 和自定义 dev pipeline 支持 Rolldown object-form plugin hooks。

### Plugin API

- Support Rolldown object-form hooks with per-hook `order`, `filter`, and `sequential` metadata in production builds.
- Apply object-form `resolveId`, `load`, and `transform` handlers, filters, and per-hook ordering in the custom dev pipeline.
- Preserve the Nasti environment as hook `this`, including for object-form hooks; carry loaded module types into dev transform filters.

**完整变更**：https://github.com/zixiao-labs/Nasti/compare/v2.6.3...v2.6.4

## 2.6.3

### 原生文件监听与 SSR 开发失效

- 修复 Chokidar 原生事件节流窗口可能丢弃最后一次源码修改的问题：SSR 读取后的即时编辑及连续快速保存不再漏发 `change`，ESM/CJS 公共入口采用同一规则。
- 仅对原生事件命中的已监听文件执行一次尾随 metadata 检查；正常事件与补发事件共用 inode/size/mtime 快照，避免重复更新及 access-time-only 读取导致的 SSR 失效循环。不是定时轮询，也不增加第二套文件监听器。
- 保留 Chokidar 的 add/unlink、atomic save、忽略目录及 workspace 监听范围；`unwatch` / `close` 清理待执行检查，旧的异步 stat 不能覆盖更新后的快照。
- 动态 `watcher.add()` 保留 `ignoreInitial` 语义；恢复 atomic replacement 时同步清理待发的旧 unlink。此适配依赖原生 raw event 与 atomic 状态，Chokidar 固定为 `5.0.0`，后续升级须重新验证监听回归。
- 添加真实磁盘快速编辑、SSR 传递依赖/图失效、删除重建、只读 metadata 及 unwatch/close 的 ESM/CJS 回归。核心监听修复不代表完整 TanStack Start SSR/HTTP/浏览器集成已验收。

**完整变更**：https://github.com/zixiao-labs/Nasti/compare/v2.6.2...v2.6.3

## 2.6.2

本次更新包含 [PR #47](https://github.com/zixiao-labs/Nasti/pull/47)，修复 SSR server transform/module graph 生命周期及初始化失败后的重试。

### SSR server transform/module graph 生命周期

- 为原生 server-consumer dev 环境提供 `transformEnvironmentRequest` /
  `environment.transformRequest`，无需先 `listen()`；返回 runner-ready 代码，不复用浏览器 HMR 管线。
- SSR 求值与公开转换共用真实环境 module graph 和转换缓存，记录静态、字面量及实际执行的动态导入双向依赖边；外部化模块不进入本地图。
- 规范 ID、URL/扩展名/virtual alias 共用节点，保留语义 query，移除 HMR 时间戳；各 server 环境的 runner/graph 独立并在首次请求时并发去重初始化。
- 图版本同步求值缓存失效，保留 `change/add/unlink` 保守全量策略；旧的进行中转换不能覆盖新图或缓存。保留 Node ESM conditions、`noExternal` 和 client HMR 行为。
- runtime dynamic import 经已返回的 exports 再次调用也遵循图失效；已解析的内联依赖不再丢失 importer 上下文后二次外部化，保留 external callback 的逐导入边决策。
- 环境或 runner 初始化失败后清理失败状态，后续转换与 SSR 加载可正常重试，不永久复用被拒绝的初始化 promise。
- 增加 ESM/CJS 核心能力、隔离、依赖替换、动态导入、并发、失效及初始化重试回归；这不是完整 TanStack Start SSR/HTTP/浏览器集成验收。

**完整变更**：https://github.com/zixiao-labs/Nasti/compare/v2.6.1...v2.6.2

## 2.6.1

本次更新包含 [PR #46](https://github.com/zixiao-labs/Nasti/pull/46)，修复 SSR 开发缓存失效并统一开发/构建依赖内联规则。

### SSR 开发与编译边界

- 修复文件 `change` / `add` / `unlink` 后 SSR 入口及传递依赖仍返回旧 exports 的问题：同步清理 runner cache 与所有 server-consumer 环境的 transform graph。当前采用保守全量失效，不改变 client HMR 边界。
- 防止失效前尚未完成的旧加载失败时删除新的 runner cache entry。
- 新增 `resolve.noExternal`，支持 `true`、包/子路径字符串、`*` 通配符和 RegExp 数组，统一 SSR dev/build 的内联规则。Node 内建始终 external；显式 `build.rolldownOptions.external` 保留整体覆盖默认策略的优先级。
- SSR 内联依赖保留环境 `mainFields` 与自定义 conditions，dev/build 使用一致的 ESM 导入条件，不因最终输出为 CJS 而选择 `require` 分支。alias 与虚拟 ID 进入真实 resolve/load/transform 管线，虚拟 importer 的 bare 依赖从项目根解析；公开/规范虚拟 ID 共用同一求值缓存。
- 修复无扩展名虚拟模块及 query ID 的 runner parser 选择，并显式报告转换错误，不再静默返回空 exports。真实 module/cache ID 保持不变。
- 添加真实 watcher、传递依赖、server graph、并发失效、dev/build 外部化及 ESM/CJS 公共入口回归测试。

### 下游补丁迁移

本版本用于替代 Wuling 的 `@nasti-toolchain/nasti@2.6.0` SSR 能力补丁。**PR 合并或版本号更新不等于 npm 已发布**。请先确认正式 `2.6.1` 可从 npm 安装，再执行以下迁移：

1. 将 Nasti 依赖和适配器的严格版本基线更新为 `2.6.1`。
2. 移除 `patchedDependencies` 中的 `@nasti-toolchain/nasti@2.6.0` 登记及对应 `.patch` 文件，正常更新锁文件；不要手工编辑 `node_modules`。
3. 保留独立的 `@vue/compiler-sfc` package extension、dedupe/define 适配器桥接；它们不属于本次运行补丁。
4. 通过干净的冻结安装及补丁覆盖的能力回归后，再验收运行补丁已移除并升级完成；Start 桥接测试独立验收，不得将尚未通过的 gate 标记完成。

**2.6.1 发布时仍未覆盖的能力**：server-consumer 环境尚未提供 `transformRequest` dev pipeline，runner 也未自动填充依赖 module graph（后续修复见 2.6.2）。本版本不代表完整 Start SSR、HTTP 或浏览器集成已通过。

**完整变更**：https://github.com/zixiao-labs/Nasti/compare/v2.6.0...v2.6.1

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
