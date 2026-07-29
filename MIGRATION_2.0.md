# Nasti 2.0 迁移指南（随开发滚动更新）

> 对照项目：**logos**（Electron+React+Monaco）、**Wuling-DevOps/frontend**（React+Tailwind v4+HeroUI+chen）、**Chen-the-Dawnstreak**（框架，bundler 无关插件）。
> 每个 Phase 落地后在真实项目上验证并更新本文档。

## Phase 0：Logger + CSS 抽取（已落地，commit 4e70da4 / ec66f73）

### 行为变化

| 变化 | 影响 | 需要的迁移动作 |
|---|---|---|
| **build 期 CSS 不再运行时 `<style>` 注入**，改为 per-chunk 抽取成带 hash 的 `assets/*.css`：entry 走 HTML 静态 `<link>`，动态 chunk 走幂等运行时 `<link>` 注入 | 所有项目（正向：产物可缓存/CDN/CSP 友好，JS 体积下降——CSS 文本不再双份进 JS） | 无需动作。依赖 `import css from './x.css'` 拿字符串的代码需改 `./x.css?inline`（三个项目均未发现此用法） |
| `import css from './x.css'` 的默认导出在 build 中变为 `''`（与 Vite 一致） | 无项目受影响 | 需要字符串时用 `?inline` |
| `build.css.emitCssFile` 弃用（抽取成为默认且不可关） | 无项目使用 | 删除该配置即可 |
| **build 期用户插件的 `transformIndexHtml` 现在会执行**（1.x 只跑内置插件，静默忽略用户插件） | **Wuling**：chen 的 PWA 注入（manifest link/theme-color/SW 注册脚本）现在 build 时生效 → 与 index.html 中当年因钩子不生效而**硬编码的同名标签重复**（重复无害，但建议清理） | Wuling：从 `index.html` 删掉硬编码的 `<link rel="manifest">` 与 `<meta name="theme-color">`（chen 插件会注入）；或在 chen 侧做幂等检查 |
| 大 chunk 警告（>500 kB，可调 `build.chunkSizeWarningLimit`） | logos 的 monaco chunk（3.6 MB）会出黄色警告 | 可选：logos 配 `build.chunkSizeWarningLimit` 静音，或用 advancedChunks 拆分 |
| 日志统一走 Logger，新增 CLI `--logLevel/--clearScreen/-d --debug/-f --filter/--verbose` | 全部（正向） | 无 |
| 构建体积表换成原生 viteReporterPlugin（Vite 同款 gzip 表） | 全部（正向） | 无 |
| 动态 chunk 的 CSS 经 `<link>` 异步加载，存在极短 FOUC 窗口（1.x 是 chunk 执行时同步 `<style>`） | logos 的 monaco 懒加载界面理论上有毫秒级未样式窗口（Electron file:// 本地加载，实测无感） | 无需动作；Phase 3 打包模式会换 DevEngine 路径 |

### 实测结果
- **Wuling frontend**：`nasti build` 通过（1.22s/199 files）。Tailwind v4+HeroUI 编译为单个 minified `main.*.css` + `<link>`；chen 的 `closeBundle` 产物（sw.js/manifest.json）正常；sourcemap 正常。
- **logos**：`nasti build` 通过（1.07s/92 files）。monaco ~98 个 CSS import 按 chunk 聚合抽取；`base:'./'` 相对路径在静态 `<link>` 与动态注入两条路径都正确（file:// 兼容）。
- **chen**：经 Wuling 全链路验证 configResolved/resolveId/load/transform/transformIndexHtml/closeBundle；dev 钩子（configureServer/handleHotUpdate/moduleGraph/ws）Phase 0 未触碰。

### dev 行为
dev 的 CSS `<style>`+HMR 注入路径逐字节不变；HMR 新增带时间戳的 `hmr update`/`page reload` 日志。

---

## Phase 1：Environment API 主干（已落地，commit f6995f2）

### 行为变化

| 变化 | 影响 | 需要的迁移动作 |
|---|---|---|
| 新增 `config.environments`（默认 `{client, ssr}`），client 与 top-level `resolve`/`build` 同引用精确镜像（运行时断言） | 三个项目均无感——flat config 原样可用 | 无 |
| 插件新钩子：`applyToEnvironment(env)` / `configEnvironment(name, opts)`；钩子里可读 `this.environment` | chen 可用它做 SSR/client 差异化（Vite 同款 API 形态） | 可选采用 |
| `server.environments.client` 持有 per-env 容器/模块图/HotChannel；`server.moduleGraph` 保留为 client 图别名（加弃用注记） | chen 的 configureServer 用 `server.moduleGraph`/`watcher`/`ws` —— 全部继续工作 | 建议 chen 新代码改用 `server.environments.client.moduleGraph`，2.x 移除别名前完成 |
| `buildEnvDefine` 支持 per-env overrides；`import.meta.env.SSR` 由 consumer 派生（Phase 2 SSR 接口契约） | 无现状影响（client 仍为 false） | 无 |
| resolveId 钩子的 `options.ssr` 不再写死 false，由环境 consumer 派生 | client 环境恒 false，行为不变 | 无 |

### 🎁 顺带修复：Vue SFC 支持（1.7.1 的 dev 与 build 双双损坏）
- **build**：`App.vue?vue&type=style` 虚拟模块没有 load 钩子，Rolldown 按字面路径读盘 → `UNLOADABLE_DEPENDENCY` 直接失败。已修：vuePlugin 新增 load 钩子，style 子块 id 改 `&lang.css` 结尾接入 CSS 管线（含 scoped，抽取为 hashed .css）。
- **dev**：style 子模块 URL 被"读盘+剥 query"路径错当成完整 SFC 重新编译，样式从未注入。已修：middleware 对带语义 query 的请求先走插件 load→transform 管道。
- **这就是 create-nasti Vue 模板等待的核心修复**——发布 2.0 后 create-nasti 即可解锁 Vue 模板。

### 实测结果
- playground/basic：产物 sha 逐字节一致 ✓
- Wuling frontend / logos：hashed 文件集完全一致（=内容一致）✓
- playground/vue-basic（新增）：build 产出 scoped CSS 正确、dev 样式虚拟模块正常服务 ✓
- 探针验证：`applyToEnvironment` 过滤（ssr-only 插件被 client 剔除）、`this.environment === client/client`、per-env define（server → SSR='true'）✓

## Phase 2：多端 builder + SSR（已落地，commit c8ada94）

### 行为变化

| 变化 | 影响 | 需要的迁移动作 |
|---|---|---|
| `nasti build` 串行构建多环境：client + 所有**显式声明 `entry`** 的环境；默认注入的裸 ssr 环境不构建 | 三个项目无感（都只有 client） | 想要 SSR 构建：`environments.ssr.entry: 'src/entry-server.ts'` |
| 非 client 环境产物默认到 `<outDir>/<envName>/`（如 `dist/ssr/`）、esm、`[name].js` 不带 hash、默认不压缩 | 新功能 | 可经 `environments.<name>.build` 覆盖 |
| server consumer 构建：platform=node、env conditions/mainFields 接到 rolldown resolve、node 内建+bare import 默认外部化 | 新功能 | 内联依赖用 `environments.<name>.build.rolldownOptions.external` 覆盖 |
| 新增 `server.ssrLoadModule(url)`（Vite shim，底层 module runner + HotChannel invoke） | **chen 框架**：未来做 SSR 路由渲染的直接入口，API 与 Vite 同形 | 可选采用 |
| SSR 管线中 css import 返回纯字符串导出（无 DOM 副作用），`import.meta.env.SSR === true` | 新功能 | 无 |
| `BuildResult` 增加 `environments` 字段（`output` 保持 client 产物，1.x 形态不变） | 编程 API 用户无感 | 无 |
| `EnvironmentInstance.setBuildMetadata(metadata)` 成为必填公开 API | 自定义 `EnvironmentInstance` 实现若缺少该方法会产生类型错误 | 实现该方法，并合并/保存环境级 `entries`、`manifest`、`stats` 等元数据 |
| `afterBuildApp` 类型签名新增第三个 `context: BuildAppContext` 参数 | 沿用旧两参数类型声明的插件需要迁移签名 | 改为 `afterBuildApp(results, api, context)`；通过 context 查询环境产物并用 `emitFile` 写出 app 级产物 |
| Electron main/preload 仍走 bespoke 路径（renderer 已经流经新 builder）。env 模型折叠待对拍后切换 | **logos** 无感（electron-build 实测端到端正常） | 无 |

### 实测结果
- playground/ssr-basic（新增）：dev `ssrLoadModule` 渲染 `SSR=true` + node:path 外部化；`nasti build` 产出 client + dist/ssr/entry-server.js，prod bundle 直接 node 执行 ✓
- 回归：playground sha 一致、Wuling/logos 文件集一致、Vue scoped CSS 一致、logos electron-build 端到端正常 ✓

### Phase 2 遗留（跟进项）
- Electron main/preload 折叠为环境（bespoke 对拍通过后删除）——计划允许的保留项
- Vue SSR（compileTemplate ssr 模式）未实现——React/纯 TS SSR 可用

## Phase 3：完整打包模式（已落地）

### 行为变化

| 变化 | 影响 | 需要的迁移动作 |
|---|---|---|
| 新增 opt-in `experimental.bundledDev`（CLI `--bundle`）：dev 用 Rolldown `dev()` 引擎整体打包 client 环境，产物存内存 Map 经中间件服务（ETag/304） | 三个项目无感——**unbundled 仍为默认**，不开启时该路径完全不执行 | 想试用：`nasti dev --bundle` 或配置 `experimental.bundledDev: true` |
| HMR 由 DevEngine 内置 watcher 驱动：自接受模块（CSS 等）产出 Patch 经 `<link>` 同源 patch URL 推送；无 HMR 边界的改动触发整页刷新 | 新功能 | 无 |
| 动态 `import()` 走懒编译端点（rc.13 stub 硬编码 `/@vite/lazy`，`/@nasti/lazy` 同义），首次点击时按需编译 | 新功能 | 无 |
| React Fast Refresh 经 rolldown 原生 `viteReactRefreshWrapperPlugin` + bundle 内 runtime/preamble 虚拟模块（与 unbundled 的服务端 wrapper 是两套实现） | React 项目（logos/Wuling）bundled 模式下可用；契约经 rc.13 探针验证 | 无 |
| `rolldown` 依赖从 `^1.0.0-rc.12` **锁定到精确 `1.0.0-rc.13`**（dev()/DevEngine 实验 API 无 semver 保护，按已安装 `.d.mts` 编码） | 全部（升级 rolldown 需同步验证 bundled 模式） | 无 |
| dev 的 CSS `<style>` 注入模板加 `import.meta.hot.prune` 存在性守卫（bundled 的 rolldown hot context 无 prune）+ `moduleType:'js'` 标注（unbundled 中间件忽略该字段） | 无感（unbundled 行为不变，模板逐字节等效） | 无 |

### 已知限制（rc.13 实验 API，均已在代码注释中记录）
- **`engine.invalidate(file)` 不可用**：一旦有客户端注册过模块，任意路径格式都会触发 rolldown panic（`hmr_stage.rs:100`，纯 rolldown 最小复现确认）。HMR 完全依赖引擎内置 watcher —— 不要恢复显式失效路径。
- **catch-all `load` 钩子会清空引擎 watch 列表**：rc.13 只 watch 原生加载过的模块路径。`nasti:resolve` 的兜底 load（unbundled PluginContainer 必需）已在 bundled 模式剥除；**用户插件若带「存在即读盘」的 load，对应文件将失去 HMR**。
- 端口被占自动 +1 时，默认 DevRuntime 烤进 bundle 的 ws 地址指向原端口，HMR 失联（产物仍可正常服务）。
- 仅 client 环境（同 Vite `FullBundleDevEnvironment`）。

### 实测结果（playground/basic `--bundle`）
- 冷启动：内存 bundle 服务（ETag/304 正确）、index.html 入口改写到 `/assets/main.js`、refresh runtime/preamble 进 bundle ✓
- 懒编译：bundle 内 lazy proxy chunk → `/@vite/lazy?id=&clientId=` → `compileEntry` 按需编译 lazy.ts+lazy.css（CSS 含 `<style>` 注入与 hot 守卫）✓
- HMR：style.css 改动 → Patch（patch 内容含新 CSS、XSSI 加固尾缀）经 `hmr:update` 推送 ✓；main.ts（无边界）→ 引擎报 `no hmr boundary` → `ensureLatestBuildOutput` + 整页刷新 ✓
- 回归：unbundled dev（`<style>`+HMR 注入、/@nasti/client、transform 管线）与生产构建路径不受影响（css.ts 改动仅在 `command === 'serve'` 分支）✓

### 下游兼容性验证（2026-06-12，本分支全量 Phase 0–3）
- **Wuling frontend**：`nasti build` 1.55s / **199 files**（与 Phase 2 记录一致）；chen 全链路（PWA 标签注入 + sw.js/manifest.json closeBundle 产物）；单 `main.*.css` + `<link>` ✓
- **logos**：`nasti build` **92 files**（与 Phase 2 一致，monaco 大 chunk 黄色警告=预期）；`nasti electron-build` renderer+main.cjs+preload.cjs 端到端 ✓
- **create-nasti Vue 模板**：dev（SFC 编译 + HMR 上下文注入）与 build 双通 —— **发布 2.0 即解锁 Vue 模板**；react-tanstack 模板 build 通过（覆盖 plugin-tanstack 集成）✓
- playground basic/vue-basic（scoped CSS 抽取）/ssr-basic（client+SSR 双产物）build 全过 ✓

### Phase 3 遗留（跟进项）
- React Fast Refresh 浏览器内端到端（patch 执行→组件态保留）待真实 React 项目人工验证 —— 服务端契约（wrapper 激活/注册/preamble 单实例）已经探针验证
- 多 tab clientId 隔离与 error overlay 行为待浏览器实测
- bundled 模式兼容矩阵 + 关键 per-request 变换移植（计划 §2.5 Phase 3.1/3.2）随推广推进
