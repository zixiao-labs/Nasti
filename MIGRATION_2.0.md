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

## Phase 2：多端 builder + SSR（未开始）
（待补）

## Phase 3：完整打包模式（未开始）
（待补）
