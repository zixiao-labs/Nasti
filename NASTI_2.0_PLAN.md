# Nasti 2.0 实施计划

> 目标：在保持 1.x 行为不破坏的前提下，引入 **Environment API（多端）**、**SSR**、**完整打包模式（Full Bundle Mode）**、**Verbose 终端输出**，并把 **CSS** 管线做成 Rolldown 安全、可代码分割的产物。并为未来的Nuxt.js移植，Nuxt Labs合作，以及LightningTest测试框架，NastiPress静态生成，武陵Devops和Logos的后续开发奠定坚实的基础。

> 本计划基于对 **Vite v8.0.16** 源码的逐文件核对，以及对 Nasti 本地安装的 **rolldown@1.0.0-rc.13** 的运行时探测（见附录 A/B）。研究经过对抗式核验（10 个 agent / 5 路并行），下文凡标注 `✓核实` 的均已亲自验证。

---

## 0. 背景与核心洞察

### 0.1 Nasti 现状（1.7.1）
- **Dev**：完全 unbundled，`transformMiddleware` 逐模块按需转译（connect + sirv + chokidar + ws）。
- **Build**：单次 Rolldown pass，从 `index.html` 正则提取入口。
- **单一隐式环境**：只有 client/browser，一个 `ModuleGraph` + 一个 `PluginContainer`。
- **日志**：`console.log` + picocolors，散落各处；`config.logLevel` 已声明但**未接线**（types.ts:30）。
- **CSS**：已用 `moduleType:'js'` 绕开 Rolldown（css.ts:88,105），但 build 期是运行时 `<style>` 注入或粗糙的 `emitCssFile`（无 hash/去重/PostCSS/CSS Modules/代码分割）。

### 0.2 🔑 战略洞察：复用 `rolldown/experimental` 的原生插件
Vite 8 把大量"Vite 专属"子系统**下沉成了 Rolldown 的原生 Rust 插件**，从 `rolldown/experimental` 导出。Nasti 同样基于 Rolldown，**可直接复用**，避免用 JS 重写并与 Vite 行为对齐。

**✓核实**（`node -e 'require("rolldown/experimental")'`，rc.13，共 38 个导出）：

| 导出 | 用途 | Nasti 用处 | Vite 8 用法 |
|---|---|---|---|
| `dev` / `DevEngine` | dev 打包引擎 + HMR | **完整打包模式核心** | `fullBundleEnvironment.ts` |
| `moduleRunnerTransform` | SSR 模块转换 | **SSR dev 执行** | `ssr` 环境 |
| `viteReporterPlugin` | **构建产物体积表（gzip）** | 直接拿到 Vite 同款表 | `plugins/reporter.ts:2` |
| `viteReactRefreshWrapperPlugin` | React Fast Refresh | 打包模式下的 HMR | bundled client |
| `viteResolvePlugin` / `viteTransformPlugin` | 解析 / OXC 转译 | 替换 `resolve.ts`/`transformer.ts` | 各环境 |
| `viteManifestPlugin` | manifest.json | SSR preload | `plugins/manifest.ts` |
| `viteBuildImportAnalysisPlugin` / `viteModulePreloadPolyfillPlugin` | 导入分析 / preload | 生产构建 | build |
| `viteImportGlobPlugin` / `viteDynamicImportVarsPlugin` / `viteWebWorkerPostPlugin` / `viteWasmFallbackPlugin` / `viteJsonPlugin` / `viteAliasPlugin` / `viteLoadFallbackPlugin` | glob / 动态导入 / worker / wasm / json / alias / load fallback | 生态兼容 | 各 plugin |
| `scan` | 依赖扫描 | optimizeDeps（如需） | `optimizer/scan.ts` |

> ⚠️ **`memfs` 例外**：类型里有，但在 **native（napi）构建下运行时为 `undefined`**（仅 WASI/wasm runtime 提供）。完整打包模式的内存产物存储用普通 `Map` —— 这也正是 Vite 自己 `MemoryFiles` 类的做法（`fullBundleEnvironment.ts:28`）。

### 0.3 关键约束（Rolldown 1.x，见 §5）
1. **原生 CSS 打包已移除**（rolldown#4271）：CSS 类型模块进入 bundler 会抛错。唯一被认可的路径是 `moduleType:'js'` + 自抽取——Nasti 必须**长期**在 JS 层拥有 CSS。
   > 注：Nasti 注释里引用的 `UNSUPPORTED_FEATURE` 错误码名**未经核实**；事实（CSS 打包不支持/抛错）正确，但不要断言该码名。
2. **`dev`/`DevEngine` 等是实验性、未版本化**（rc 线无 semver 保护）：完整打包模式必须 **opt-in + 守卫导入 + 锁版本**。

---

## 1. 总体架构：Environment API 作为主干

SSR、完整打包模式、多端/Electron **全部表达为 environment**。这是耦合度最高、其他特性都依赖的改动。

### 1.1 Vite 8 的分层（✓核实）
- `PartialEnvironment`→`BaseEnvironment`→`DevEnvironment`/`BuildEnvironment`（`baseEnvironment.ts:13,104`、`environment.ts:7`）。
- 每个 env 自带：`name`、`config`（Proxy：env 选项优先，回退 top-level，`baseEnvironment.ts:47-60`）、`logger`、**自己的** `moduleGraph` + `pluginContainer` + `hot` 通道（`server/environment.ts:54,127,140,205`）。
- 插件通过 **Rolldown 的 `PluginContext.environment`** 感知当前环境；`applyToEnvironment(env)` 过滤、`configEnvironment` 钩子、`perEnvironmentState` WeakMap（`environment.ts:20`）。
- `consumer:'client'|'server'` 驱动 per-env resolve（conditions/mainFields/builtins/keepProcessEnv）。
- 多端构建走 `createBuilder().buildApp()`（`build.ts:1791,1816`），默认 `sharedConfigBuild:false`/`sharedPlugins:false`，按 env 串行。

### 1.2 Nasti 的精简版（NastiEnvironment）
Nasti 当前只有单图，**收敛成一个精简 `NastiEnvironment` 类**即可，无需照搬全部分层：

```ts
// src/core/environment.ts（新增）
class NastiEnvironment {
  name: string
  consumer: 'client' | 'server'
  mode: 'dev' | 'build'
  config: ResolvedConfig            // env 选项 over top-level（保持 client 镜像）
  plugins: NastiPlugin[]            // applyToEnvironment 过滤后
  pluginContainer: PluginContainer  // 带 environment 构造
  moduleGraph: ModuleGraph          // per-env
  hot: HotChannel                   // client=ws；其余=noop/in-memory
  async init() { /* 建 pluginContainer */ }
}
```

**配置面**（types.ts）：
```ts
interface NastiConfig {
  environments?: Record<string, EnvironmentOptions>   // 默认 { client, ssr }
  // ...
}
interface EnvironmentOptions {
  consumer?: 'client' | 'server'
  resolve?: ResolveConfig
  build?: BuildConfig
}
// ResolvedConfig.environments: Record<string, ResolvedEnvironmentOptions>
```

**关键改动**：
- `plugin-container.ts`：构造时带 `environment`，暴露 `this.environment`；把写死的 `ssr:false`（plugin-container.ts:80）改为 `consumer==='server'`。
- 统一 `server/index.ts:27-34` 与 `build/index.ts:69-75` 的内置插件拼装为**一个 per-env 函数**。
- `server.moduleGraph` 保留为 client 图别名（加未来弃用注记，跟随 Vite 退役 flat `server.*`）。
- **back-compat 镜像**：top-level `resolve`/`build` ↔ `environments.client` 必须精确镜像，否则现有插件全炸。默认一切按 client 行为。
- **运行时验证（Phase 1 检查）**：在 config 初始化路径（plugin-container 构造/environment 暴露时）和构建 per-env 插件的函数中（统一 server/index.ts:27-34 和 build/index.ts:69-75 的代码），添加仅在开发模式下（默认）启用的断言，比较 top-level `resolve`/`build` 对象与 `environments.client` 的序列化表示（包括 sourcemap 和 timestamp 策略）是否逐字节一致。不匹配时抛出/记录清晰的错误。文档化精确的比较规则（包含/排除哪些字段）。提供 opt-in 回归测试运行器，自动跨示例项目比较快照。

---

## 2. 五大特性详设

> 顺序按**落地阶段**排列（Phase 0 → 3）。每节含：设计 / 配置 / 关键步骤 / 文件 / 风险。

### 2.1 Verbose 终端输出（Phase 0，独立，先落地）
**设计**：仿 `node/logger.ts` 建真正的 `Logger`，接线已声明的 `config.logLevel`（其枚举已与 Vite `LogType+'silent'` 一致）。单一 `config.logger`（Nasti 输出是单环境，**不要** per-env logger）。构建体积表**采用原生 `viteReporterPlugin`**（✓核实存在），并保留 JS gzip 表 fallback。

**配置/CLI**：`--logLevel` / `--clearScreen` / `--debug`(`-d`) / `--filter`(`-f`) / `--verbose`，在建 logger 前解析。

**关键步骤**：
- `core/logger.ts`：`LogLevels{silent:0,error:1,warn:2,info:3}`、`createLogger`（timestamp/prefix/clearScreen/同消息去重 `(xN)`/`warnOnce`/`hasErrorLogged` WeakSet）、`printServerUrls`（`➜ Local/Network`，bold 端口）。✓核实自 `logger.ts:30,68,168`。
- `core/debug.ts`：`createDebugger('nasti:*')`，受 `DEBUG` + `NASTI_DEBUG_FILTER` 控制（建议同时认 `vite:*` 以兼容移植插件）。
- `build/reporter.ts`：`viteReporterPlugin`（守卫导入）+ JS fallback（`node:zlib` gzip、`Intl.NumberFormat` kB、最大列右对齐、WARN 级大 chunk 警告）。**修复** build/index.ts:198-205 体积统计只算 `chunk.code`、漏掉 assets 的 bug，改用 `Buffer.byteLength` 含 asset.source。
- dev banner（ready-in ms + Local/Network）、`server/hmr.ts` 带时间戳的 `hmr update`/`page reload`。
- `cli.ts` 4 处 `console.error` 改走 `logger.error` + `hasErrorLogged` 去重。

**新增**：`core/logger.ts`、`core/debug.ts`、`build/reporter.ts`
**改动**：`build/index.ts`、`server/index.ts`、`server/hmr.ts`、`cli.ts`、`types.ts`、`config/index.ts`

**风险**：`viteReporterPlugin` 实验性→守卫+JS fallback；gzip 大包耗时→`build.reportCompressedSize` 门控；`clearScreen` 非 TTY/CI 下禁用；大 chunk 警告必须走 `logger.warn`（否则被 logLevel 吞）；不要做 `press h` 提示（除非真有 shortcuts 子系统）。

---

### 2.2 CSS 管线（Phase 0，独立，先落地）
**设计**：**所有 CSS 留在 JS 层**（`moduleType:'js'`，Nasti 已在 css.ts:88,105 这么做——这是 #4271 后唯一被认可的契约）。把 build 期的运行时注入换成**真正的 per-chunk 抽取**：
1. 拆 `css.ts`：**compile 阶段**（返回 CSS 字符串 + modules map，不带 moduleType）+ **css-post 阶段**（`moduleType:'js'` + 模块级 `styles` Map）。**dev 的 `<style>`+HMR 路径原样保留**（css.ts:34-57）。
2. **`renderChunk`** 聚合该 chunk 的 CSS（按 `chunk.modules` id 从 styles Map 取）、解析 `url()`/asset 占位、Lightning CSS 压缩、`this.emitFile({type:'asset'})` 产出带 hash 的 `.css`、记录 `importedCss`。
3. 经现有 `processHtml`/`HtmlTagDescriptor`（html.ts）向 index.html 注入静态 `<link rel=stylesheet>`。
4. `augmentChunkHash` 把 importedCss 折进 JS chunk hash（缓存正确性）；`getEmptyChunkReplacer` 清理纯 CSS chunk 产生的空 JS。

> **关键仓库事实（✓核实）**：build/index.ts:128-139 把 Nasti 插件映射成**真正的 Rolldown 插件**，但只转发 `resolveId/load/transform/buildStart/buildEnd/closeBundle`。因此 **`renderChunk` 必须同时加进 `NastiPlugin` 类型 *和* 这张转发表**；转发后 `this.emitFile`/`this.getFileName` 才是 Rolldown 真正的 Rollup 兼容 context（**不是** plugin-container.ts:33-41 那个只在 buildStart 用的 stub）。**实施**：在 Nasti-to-Rolldown 插件映射器（build/index.ts 的映射逻辑）中添加 renderChunk，将其绑定/转发到真实的 Rollup context（this.emitFile 和 this.getFileName 是 Rollup 兼容实现）。更新 NastiPlugin 类型以包含 renderChunk 钩子签名。添加最小测试调用 plugin.renderChunk 并断言 this.emitFile/this.getFileName 存在且行为正确。将此变更标记为 Phase 0 阻塞项（见附录 C）。

> **校正（来自核验）**：Vite 8 **默认转换器是 PostCSS**，只有**压缩器**默认 Lightning CSS。所以 Nasti 选 Lightning CSS 是**有意为之的取舍**（纯 Rust、依赖更小），需如实标注，**不要**说成"对齐 Vite 默认转换器"。

**配置**：`css.transformer`/`css.modules`/`css.lightningcss` + `build.cssCodeSplit`/`build.cssMinify` + `?inline`/`?raw`。

**新增**：`core/css-engine.ts`、`plugins/css-post.ts`
**改动**：`plugins/css.ts`、`plugins/assets.ts`、`build/index.ts`、`plugins/html.ts`、`types.ts`

**风险**：`chunk.modules` id 必须与 styles Map 的 key（null-byte/query 规范化）一致——上线前测；跨 chunk **CSS 串接顺序**错会改 specificity→串行 emit 队列 + 快照测试；**Tailwind v4 已自行 flatten `@import`**（css.ts:25-28），别再过 Lightning CSS 的 @import→对 Tailwind 输出跳过该步；统一 CSS hash 与 Rolldown `assetFileNames`，别用 assets.ts:50-55 的独立 sha256；动态 import 的路由级 CSS 需运行时 `<link>` 防 FOUC。

---

### 2.3 Environment API 主干（Phase 1）
见 §1.2。**先以 client-only 默认落地**，让现有 React/Vue/Electron 应用行为**逐字节不变**。

**关键步骤**：
- types.ts：加 `EnvironmentOptions`/`ResolvedEnvironmentOptions`/`environments` map + `consumer`；`PluginContext` 加 `environment`；`ModuleNode` 加 `environment` 字段；定义 `HotChannel`。
- `resolveConfig`：默认注入 `{client, ssr}`；`consumer = options.consumer ?? (name==='client'?'client':'server')`；per-env resolve（client 含 `'browser'` condition；server=node conditions 去 `'browser'` + server mainFields + builtins 外部化）；处理 `isSsrTargetWebworker`（server consumer 但 browser-like resolve + `keepProcessEnv:false`）。
- `core/environment.ts`：`NastiEnvironment` + `init()` + restart 的 `previousInstance` 交接（new.init → previous.close → new.listen）；工厂门控（仿 Vite，`RunnableEnvironment` 不可直接 new）。
- `plugin-container.ts`：带 env、暴露 `this.environment`、`ssr:false`→`consumer==='server'`；dev 生命周期钩子默认 **client 单次触发** `buildStart`/`watchChange`，加 `perEnvironment*` opt-in。
- 加 `applyToEnvironment` + `configEnvironment` + `resolveEnvironmentPlugins(env)`；统一内置+用户插件拼装。
- `HotChannel`：ws 实现 client 版；非 client 用 noop/in-memory；**接口一次性包含 `invoke{fetchModule, getBuiltins, _skipFsCheck}`**（供后续 SSR/edge 用，避免重构）。

**新增**：`core/environment.ts`、`core/hot-channel.ts`
**改动**：`types.ts`、`config/index.ts`、`config/defaults.ts`、`plugin-container.ts`、`module-graph.ts`、`server/index.ts`、`server/ws.ts`、`build/index.ts`

**风险（高耦合）**：top-level↔environments.client 镜像不精确→插件与现有应用同时炸；生命周期钩子 fan-out 决策错→插件副作用重复触发。**用 React/Vue/Electron 三个示例做前后逐字节对拍**。

---

### 2.4 多端构建 + SSR（Phase 2）
**多端构建**：抽出 `getRolldownOptions(environment)`（来自 build/index.ts:108-154 的 userOutput/userTransform/define 合并/入口/assetFileNames），按 env consumer 参数化（format/define/external/conditions）。`build/index.ts` 加 builder 串行迭代 `config.environments`，调 `buildEnvironment(env)`；用 `declare module 'rolldown'` 把 `this.environment` 注入 Rolldown build 钩子。
- **Electron** 的 renderer/main/preload（build/electron.ts 已是三次 Rolldown pass）折叠为环境 `{client(renderer), main(server,cjs/esm), preload(server)}`，保留 native-dep 自动外部化。**先保留 bespoke 路径，env 对拍通过后再删**。

**SSR**：`environments.ssr`，`consumer='server'`。
- **Dev 执行**：用 `moduleRunnerTransform`（✓核实导出）建 `RunnableEnvironment`，模块经其转成 runner 可执行形态，由 module runner 经 `HotChannel.invoke` 的 `fetchModule`+`getBuiltins` 喂入（`_skipFsCheck` 用于网络暴露的 transport）。
  > 对照 Vite：`DevEnvironment.hot.setInvokeHandler({fetchModule, getBuiltins})` 是 RPC 桥，runner 回调 `fetchModule`→`transformRequest`→求值（✓核实 `server/environment.ts:146-160,230-249`）。
- **Prod 构建**：per-env builder 出 SSR bundle（node conditions、server mainFields、builtins 外部化）。
- `ssrLoadModule` 作为 runner 的 back-compat shim。
- **`import.meta.env.SSR` 必须 consumer 派生**：更新 `core/env.ts` 中的 `buildEnvDefine`，不再硬编码 `import.meta.env.SSR='false'`，而是提供 per-env define 钩子（例如接受 overrides map 或 callback），允许调用方为 server vs client 分别设置。使 `build/index.ts` 和 dev server 构造调用该钩子以为 server 运行注入 `SSR='true'`。在 §4 中记录 Phase1→Phase2 接口契约为"per-env define hook for import.meta.env.SSR"，并添加"define mechanism supports per-env overrides"到 Phase 1 退出标准（附录 C），确保 per-env define 已实现且可测试。
- `isSsrTargetWebworker` 是 edge/worker 的先例（server consumer + browser-like resolve）。

**新增**：`server/runnable-environment.ts`
**改动**：`core/env.ts`、`config/index.ts`、`server/index.ts`、`build/index.ts`、`core/hot-channel.ts`

**风险**：`moduleRunnerTransform` 实验性；`getBuiltins` 的 string/RegExp 序列化要对齐 runner 期望；`_skipFsCheck` 安全相关（任何网络/edge transport）；`ssrLoadModule` shim 要保留足够 Vite 语义让移植的 SSR 框架可用。

---

### 2.5 完整打包模式 / Full Bundle Mode（Phase 3，opt-in，最后做）
**设计**：opt-in `experimental.bundledDev`（CLI `--bundle`），**仅 client 环境**（同 Vite `FullBundleDevEnvironment`，非 client 直接 throw，✓核实 fullBundleEnvironment.ts:81），把 unbundled transform+sirv 管线换成长驻 Rolldown `DevEngine`。

**配置面（对标 Vite，✓核实 config.ts:584,617,862,254,250）**：
```ts
interface NastiConfig { experimental?: ExperimentalOptions }
interface ExperimentalOptions {
  /** dev 用 Rolldown dev() 引擎整体打包 client 环境后从内存服务。@experimental @default false */
  bundledDev?: boolean
}
// config/defaults.ts: experimental:{ bundledDev:false }
// resolveConfig: isBundledDev = command==='serve' && !!experimental.bundledDev
// server/index.ts: if(experimental.bundledDev) <bundled path> else <现有 unbundled>
```
> 两级设计：先做全局 `experimental.bundledDev`，待 Environment API 稳定后补 per-env `isBundled` 覆盖——与 Vite 演进一致。

**rc.13 精确 API（✓核实 `experimental-index.d.mts`）**：
```ts
dev(inputOptions, outputOptions, devOptions): Promise<DevEngine>
DevOptions { onHmrUpdates?, onOutput?, watch?: { skipWrite?:boolean }, rebuildStrategy?: 'always'|'auto'|'never' }
class DevEngine {
  run(): Promise<void>
  ensureCurrentBuildFinish(): Promise<void>
  getBundleState(): Promise<BindingBundleState>      // 注意：async
  ensureLatestBuildOutput(): Promise<void>
  invalidate(file, firstInvalidatedBy?): Promise<BindingClientHmrUpdate[]>  // 返回 updates 数组
  registerModules(clientId, modules[]): Promise<void>
  removeClient(clientId): Promise<void>
  compileEntry(moduleId, clientId): Promise<string>  // 懒编译
  close(): Promise<void>
}
```
**机制**（仿 fullBundleEnvironment.ts）：
- `dev(getRolldownOptions(clientEnv) + experimental.devMode{lazy:true, implement:<nasti hmr runtime 字符串>}, {entryFileNames:'assets/[name].js', chunkFileNames:'assets/[name]-[hash].js', minify:false, sourcemap:true}, {onHmrUpdates, onOutput, watch:{skipWrite:true}, rebuildStrategy:'auto'})`；`optimization.inlineConst=false`（Rolldown bug 规避，vitejs/vite#21843）。
- 产物存**内存 `Map`**（非 memfs），经 memory-files 中间件服务（ETag/304、mrmime、`.html` 交给 index-html 中间件）。
- **HMR**：`onHmrUpdates` 回调 `{updates, changedFiles}`；`changedFiles.length===0` 早退；`Error` 实例→广播 `{type:'error'}`；`Patch`→存产物 + 映射 `hmrBoundaries`→`{type:'js-update'}`；`FullReload`→`ensureLatestBuildOutput` + 防抖 full-reload；`Noop`→忽略。patch 代码尾部加 `'\n; export {}'`（XSSI 加固）。
- **懒编译**：`/@nasti/lazy?id=&clientId=`→`compileEntry`（强制两参）。
- **客户端**：基于注入的 Rolldown `DevRuntime` 生成 `clientId`、`registerModules`、`import(patchUrl).then(()=>__rolldown_runtime__.loadExports(acceptedPath))`；防多 tab 的 clientId 冲突 throw。
- **React Fast Refresh** 用 `viteReactRefreshWrapperPlugin`（✓核实），退役 unbundled 的服务端 wrapper（仅此路径）。
- **watcher**：只从 chokidar 摘掉 `root`（DevEngine 自己 watch）；config/env/public 仍 watch 以触发重启。

**新增**：`server/bundled/dev-engine.ts`、`memory-files.ts`、`middleware-memory-files.ts`、`middleware-lazy.ts`、`hmr-runtime.ts`
**改动**：`server/index.ts`、`server/ws.ts`、`config/index.ts`、`types.ts`、`build/index.ts`、`cli.ts`、`package.json`（锁 rolldown 版本）

**风险（最高）**：rc.13 实验 API 无 semver；Nasti 的 per-request PluginContainer 变换（虚拟模块、import 改写、env define、`bundlePackageAsEsm` + react-aria 等 subpath shim）若不重表达为 Rolldown/OXC 插件**会静默失效**；node_modules 交给 Rolldown 单图后，bespoke 修复可能回归。→ **严格 opt-in，unbundled 保持默认**；推广前移植关键变换为 Rolldown 插件 + 加 react-aria context-identity 回归测试。

**渐进迁移策略与兼容性矩阵**：为避免静默破坏，采用分阶段迁移 per-request PluginContainer 转换到 Rolldown/OXC 插件：
- **Phase 3.0**：迁移无状态转换（如 env define）以验证 DevEngine 机制。
- **Phase 3.1**：增量迁移虚拟模块和 import-rewrite 转换，每个转换配对 unbundled vs bundled 回归测试。
- **Phase 3.2**：最后处理生态系统 shim（如 react-aria context-identity、bundlePackageAsEsm/subpath shim），持续监控。
- **严格 opt-in bundled 模式**：保持 unbundled 为默认。添加"bundled mode compatibility matrix"列出已验证可用的 Nasti 功能/插件。
- **迁移要求**：任何被移植的 per-request PluginContainer 转换必须包含自动化配对回归测试和 rollout 检查清单，确认后才能移除旧路径。

---

## 3. 分阶段路线图

| 阶段 | 目标 | 依赖 | 退出标准 |
|---|---|---|---|
| **Phase 0**：输出 + CSS 地基 | 真·体积表、dev banner、HMR 日志、debug 命名空间；CSS 真·per-chunk hash 抽取 | 无 | `nasti build` 打印 Vite 形态的对齐 gzip 表 + 黄色大 chunk 警告；`nasti dev` 显示 ready-in + Local/Network；HMR 打 `hmr update`/`page reload`；`DEBUG=nasti:*` 生效；多组件共享 CSS 产出 content-hash 的 `assets/*.css` 经 `<link>` 注入（产物无运行时 `<style>`），CSS 变则 JS chunk hash 变，无 Rolldown 报错 |
| **Phase 1**：Environment 主干 | environments 配置 map + consumer + per-env container/graph/hot + `this.environment` | Phase 0 | `config.environments.client/.ssr` 含正确 per-consumer resolve；插件可读 `this.environment`；React/Vue/Electron 示例前后逐字节一致；`applyToEnvironment` 过滤正确；define mechanism supports per-env overrides（per-env define hook for import.meta.env.SSR 已实现且可测试）；运行时验证断言 top-level resolve/build 与 environments.client 镜像一致。**尚无 SSR 执行** |
| **Phase 2**：多端 builder + SSR | builder 迭代 environments；Electron 折入；`RunnableEnvironment`（moduleRunnerTransform） | Phase 1 | `nasti build` 串行跑 N 个环境；Electron 经 env 模型产物与旧 bespoke 一致；最小 SSR 应用经 RunnableEnvironment（ssrLoadModule shim）服务端渲染，node conditions 正确、server 图 `import.meta.env.SSR===true` |
| **Phase 3**：完整打包模式 | `experimental.bundledDev`（`--bundle`）：DevEngine + 内存产物 + onHmrUpdates 驱动 HMR | Phase 2 | `--bundle` 冷启动服务内存 bundle；单文件改动出 Patch 无整页刷新；边界破坏触发 full reload；动态 import 经 `/@nasti/lazy` 编译；多 tab 不冲突；React Fast Refresh 经原生 wrapper 工作；错误进 overlay。**unbundled 仍为默认且不变** |

---

## 4. 依赖顺序与跨特性冲突

**依赖顺序**：Logger → CSS 抽取 →（二者独立、先行）→ Environment 主干 → per-env builder → SSR / RunnableEnvironment → 完整打包模式（最高风险，依赖主干 + 共享 `getRolldownOptions` + CSS 改造）。

**冲突**：
1. **完整打包模式 vs CSS**：unbundled/build 走自管 `renderChunk` 出 hashed `.css` + 静态 `<link>`；bundled dev 里 CSS 由 DevEngine 以 HMR patch/asset 产出，dev `<style>` 注入路径被绕过。`css-update` HMR 与 `<link>` 注入要**按模式各写一份**。
2. **Environment 主干 vs 全部**：耦合最高的单点改动；back-compat 镜像不完美会同时打挂插件与现有应用。
3. **Logger vs 全部**：先落地，否则新代码（reporter、dev-engine overlay、hmr 日志）要从 `console.*` 回填。
4. **React Fast Refresh 双实现**：unbundled 用服务端 per-module wrapper；bundled 用原生 `viteReactRefreshWrapperPlugin`——两者边界行为要一致。
5. **`emitFile` 三条路径别混**：PluginContainer stub（plugin-container.ts:33-41，仅 buildStart）/ Rolldown 真 context（renderChunk 必须用这条）/ assets.ts sha256（应统一到 Rolldown `assetFileNames`）。
6. **`env.ts` per-env define for import.meta.env.SSR**：`buildEnvDefine` 不再硬编码 `import.meta.env.SSR='false'`，改为 per-env define 钩子（overrides map/callback），build/index.ts 和 dev server 调用它为 server 注入 `SSR='true'`。Phase1→Phase2 接口契约："per-env define hook for import.meta.env.SSR"。

---

## 5. Rolldown 1.x 约束（rc.13）

- **原生 CSS 打包已移除**（#4271），无第一方 `rolldown_plugin_css`（RFC 截至 2026-06 仍未落地）→ Nasti **长期**在 JS 层拥有 CSS。不要断言 `UNSUPPORTED_FEATURE` 码名。
- **`dev`/`DevEngine` 实验、未版本化**；rc.13 签名与早期文档**不同**（`getBundleState` async、`invalidate` 返回 updates 数组、有 `rebuildStrategy`）→ 按**已安装的 `.d.mts`** 编码。
- **rolldown 锁定 rc.13**（非 1.0 stable）：Rollup 兼容的 per-call API（`rolldown()`/`bundle.write`/`close`）稳定够用，但 DCE/分包启发式与实验面可能无 semver 变动。
- **`define` 在 1.x 移到 `transform.define`**（Nasti 已在 build/index.ts:120-124 规避）：新的 env-aware define 必须续用 `transform.define`。
- **Rolldown 无原生 environment 概念**：纯 Vite 层抽象（per-call options + 增强的 plugin context `declare module 'rolldown'` 加 `this.environment`）。Nasti 必须照抄此模式。
- ✓ **正面**：rc.13 的 `rolldown/experimental` 确实导出了所有所需积木（见 §0.2），实质降低 SSR/完整打包/reporter 的工作量——但都需守卫。

---

## 6. 风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| 全盘依赖 rc.13 实验 API（未版本化） | 高 | 锁精确版本；每个 `rolldown/experimental` 导入**守卫 + 优雅 fallback**（JS reporter / unbundled dev / JS CSS）；按 `.d.mts` 编码；加 rolldown 升级即报警的 smoke test |
| Environment 主干破坏 flat config + 插件 API back-compat | 高 | 精确镜像 environments.client；一切默认 client；`server.moduleGraph` 留别名；React/Vue/Electron 前后对拍 |
| 完整打包模式把 per-request 变换搬进 Rolldown 后静默失效（虚拟模块/import 改写/define/react-aria shim） | 高 | bundled 严格 opt-in、unbundled 为默认；推广前移植关键变换为 Rolldown 插件 + react-aria 回归测试 |
| CSS `renderChunk` 抽取依赖 `chunk.modules` id 匹配 + emitFile/getFileName 可用（当前都未转发） | 中 | 加 renderChunk 到类型 + 转发表；测 id 规范化；一行探针确认 rc.13 renderChunk 暴露 `this.emitFile/getFileName` |
| 跨 chunk CSS 串接顺序错改 specificity | 中 | 按 render 顺序串行 emit 队列 + 快照测试；文档化 Tailwind 输出为 final |
| SSR module-runner + invoke 契约（fetchModule/getBuiltins/_skipFsCheck）安全面大 | 中 | 独立 Phase 2、主干验稳后做；显式带 `_skipFsCheck`；照抄 Vite getBuiltins 序列化；ssrLoadModule shim 先用最小 SSR 框架验证 |
| 多端串行构建放大耗时（Electron=3 env） | 低 | 默认串行（同 Vite）；后续暴露并行；Electron bespoke 路径保留至 env 对拍通过 |
| Logger clearScreen / `press h` 提示降低 UX | 低 | 仿 Vite hasExistingLogs 守卫，CI/非 TTY 禁用 clearScreen；无 shortcuts 子系统则不做 `press h` |

---

## 7. 待决策项（含推荐）

1. **SSR 运行时现在做还是延后？** → **推荐：Phase 2 才落地 runner，但 Phase 1 先把 `environments.ssr`(consumer='server') 的配置形态与 resolve 选项定稳。** moduleRunnerTransform 虽已可用，但生产级 runner + fetchModule transport 是大且安全敏感的面，先用 per-env build 验主干。
2. **Electron 现在改成环境还是延后？** → **推荐：Phase 1 保留 bespoke，Phase 2 迁移**（它是最佳验证用例：renderer=client，main/preload=server + 已实现的 native-dep 外部化），作为 Phase 2 验收，通过后删 bespoke。
3. **back-compat 镜像做多全？** → **推荐：初期全镜像**（Nasti 插件读 flat config，风险最低），但给 `server.moduleGraph`/`transformRequest` 加未来弃用注记，跟随 Vite 退役 flat `server.*` 的方向。
4. **体积表用原生 `viteReporterPlugin` 还是手写 JS？** → **推荐：原生 + JS fallback**（原生在锁定版本已确认可用，拿 Vite 同款格式；守卫导入 + 留 JS 表，rolldown 升级不致打挂构建）。
5. **`HotChannel` 现在就做全 invoke 契约？** → **推荐：接口一次定全（含 invoke + getBuiltins + _skipFsCheck），实现只先做 client ws 的 send/on**，非 client 给 noop/in-memory。一次设计好接口，避免 SSR/edge 到来时重构。
6. **CSS 引擎：仅 Lightning CSS 还是 + PostCSS？** → **推荐：Lightning CSS 单一内置引擎 + `transformer:'none'`/`cssMinify:false` 逃生舱**，但如实说明这是**相对 Vite 默认（PostCSS 转换器 + Lightning 压缩器）的有意分歧**（纯 Rust、依赖更小）；仅当真实项目需要 autoprefixer 类 PostCSS 插件时再加可选 PostCSS 路径。

---

## 附录 A：已核验的 Vite v8.0.16 源码引用
- Environment：`environment.ts:7-11,20-33`、`baseEnvironment.ts:13,47-60,104`、`server/environment.ts:54,127,140-160,205,230-249`、`config.ts:250,254,268-270,322,584,617,862,1652`、`build.ts:576,798,1208,1707,1739,1816`。
- `rolldown/experimental` 复用：`reporter.ts:2`、`build.ts:26`、`plugins/{importAnalysisBuild,dynamicImportVars,importMetaGlob,manifest,modulePreloadPolyfill,oxc,resolve,worker}.ts`、`optimizer/scan.ts:5`、`internalIndex.ts:1`。
- Full Bundle Mode：`server/environments/fullBundleEnvironment.ts`（全文，尤 :28 MemoryFiles、:61 类、:81 仅 client、:108-189 dev()/onHmrUpdates、:299 devMode.lazy）。
- 日志：`logger.ts:30,68,87-132,168`、`baseEnvironment.ts:61-100`（per-env 着色）。
- CSS：`plugins/css.ts:296(vite:css),462(vite:css-post),611/641(moduleType:js),1176(analysis),1248(getEmptyChunkReplacer)`。

## 附录 B：已核验的 rolldown rc.13 运行时探测
- `require("rolldown/experimental")`：38 导出；`dev`/`DevEngine`/`moduleRunnerTransform`/`scan`/`viteReporterPlugin`/`viteReactRefreshWrapperPlugin` + 全套 `vite*` 插件**均为 function**；**`memfs` 运行时 `undefined`**（native 构建，仅 WASI 提供）。
- `experimental-index.d.mts`：`DevEngine`/`DevOptions{onHmrUpdates,onOutput,rebuildStrategy,watch.skipWrite}` 签名见 §2.5。

## 附录 C：现有 Nasti 待改锚点与 Phase 0 阻塞项
`types.ts:30`(logLevel 未接线)、`build/index.ts:120-124`(transform.define)、`:128-139`(插件转发表，缺 renderChunk，**Phase 0 阻塞项**：必须添加 renderChunk 到 NastiPlugin 类型和转发表，确保 this.emitFile/getFileName 可用)、`:198-205`(体积统计漏 assets)、`plugins/css.ts:25-28`(Tailwind)、`:34-57`(dev style)、`:88,105`(moduleType:js)、`plugin-container.ts:33-41`(emitFile stub)、`:80`(ssr:false)、`assets.ts:50-55`(sha256)、`core/env.ts`(buildEnvDefine 写死 SSR='false'，**Phase 1 改为 per-env define 钩子**)、`server/index.ts:27-34` vs `build/index.ts:69-75`(内置插件重复拼装)。
