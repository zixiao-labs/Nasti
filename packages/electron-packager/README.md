# 实验性 Electron ASAR 归档后端（私有）

`@nasti-toolchain/electron-packager` 是 **opt-in、实验性、private** package，仅把已经暂存好的 Electron app 目录归档成官方 `@electron/asar` 可读取的 ASAR。**不是 drop-in electron-builder，也不是完整打包器或 installer。**

## 构建与运行

需要 Rust/Cargo，以及 Node >=22.12。本地构建按当前主机生成 `.node`；
安装 devDependencies 不会编译/下载本 package 的 binding。

```sh
# 仓库根，推荐使用与主工程一致的 Node 24 开发环境：
pnpm install --frozen-lockfile
pnpm --filter @nasti-toolchain/electron-packager build

cd packages/electron-packager
# 或单独 npm run build:binding / npm run build:cli

# 可选 CLI：普通 cargo build/test 不开启 binding、不需要 Node 动态符号
cargo build --release --locked
./target/release/nasti-electron-packager pack /absolute/staged-app /absolute/output/app.asar \
  --unpack node_modules/native-addon \
  --unpack assets/helper

# 仅诊断 CLI wrapper 调用已构建 binary：
npm run pack -- /absolute/staged-app /absolute/output/app.asar --unpack assets/helper
```

## Node API（默认入口）

```js
import { pack } from '@nasti-toolchain/electron-packager';

await pack({
  input: '/absolute/staged-app',
  output: '/absolute/output/app.asar',
  unpack: ['node_modules/native-addon', 'assets/helper'], // 可省略
});
```

公开类型为 `pack({ input: string, output: string, unpack?: string[] }): Promise<void>`。
ESM wrapper 没有 top-level await，直接加载本地 `nasti-electron-packager.node`，
不 spawn 子进程、不自动编译/下载。缺失或无法加载 binding 时，导入错误明确提示
`npm run build:binding`。调用参数转换、扫描、I/O 等失败经 Promise rejection 返回。
Rust core 在 `src/lib.rs`，napi-rs `AsyncTask` 的 `compute` 在线程池执行整个归档，
不会在 Node 事件循环同步打包；`src/main.rs` 只负责可选 CLI 的参数与错误展示。
AsyncTask 使用 Node/libuv 工作池，可能与其他工作池任务竞争；每次 pack 内的 hash
worker 上限仍为 8，同时调用多个 pack 会累加资源，应由调用方控制并发。
声明文件手工维护小 API，构建生成的 `generated.d.ts` 仅作核对，不作为公开入口。

输出父目录必须已经存在。`app.asar` 与 `app.asar.unpacked` 均不得已存在，即便此次不需要 unpack；不会覆盖旧输出。没有 install/postinstall 编译、预构建 binary 下载或发布时自动获取机制。

`--unpack` 可重复，每次必须是输入中存在的精确相对文件或目录路径。目录匹配自身与 `directory/` 下全部后代，不误匹配同名开头的相邻目录。采用 `/`，不接受绝对路径、`..`、`.`、空分段或反斜杠。**没有 glob 语义**，`*` 不是通配符。需要 unpack 原生模块及其运行时资源时由调用方明确指定。

## 输入契约与职责边界

输入必须是独立的 staged app，含有效 `package.json`、正确 `main` 及完整 runtime dependencies。根 `main` 必须明确指向已暂存文件（缺省为 `index.js`，支持开头 `./`）；不模拟 Node 的扩展名/目录入口解析。工具检查根和已暂存 `node_modules` 包 manifest 的 `dependencies`，沿目录祖先寻找已暂存 manifest；被 `optionalDependencies` 覆盖的依赖允许缺失。不检查版本、peerDependencies，也不能证明动态 `require`、条件 exports、平台资源、可选依赖与业务配置在 Electron 中一定可运行；调用方仍须 staging 检查和真实应用 smoke test。

不负责 JS bundling、依赖收集/裁剪、native rebuild、Electron 下载、平台应用骨架、installer、更新包、签名/notarization 或 fuse 校验。不要直接拿源码工作区或 pnpm symlink 布局当 staged app。

## 当前实现与限制

- UTF-8 嵌套/Unicode 路径、dotfiles、空文件/目录；Unix owner executable bit 写入 header，unpacked 文件保留源权限。Windows 没有 Unix executable bit。
- 输入本身（包括尾随 `/` 或 `/.`）及树内全部 symlink（包括 dangling link）与 socket/FIFO/device 等特殊文件拒绝；系统祖先路径如 macOS `/var` 允许 canonicalize。发现 `.pnpm` 目录拒绝，普通同名 dotfile 允许；要求事先物化 runtime dependencies。
- 单文件大小最大 `u32::MAX`，扫描阶段拒绝更大的 packed/unpacked 文件（Electron FileInfo.size 为 uint32）。Pickle header string 长度最大 `i32::MAX`，外层 payload 使用 checked u32；不靠分配 2 GiB 测边界。依赖候选 manifest 用预建 `HashSet<PathBuf>` 查询，避免每次线性扫描完整文件索引。
- 路径排序、header 与文件写出串行确定性；按文件并行计算 SHA256，固定 4 MiB integrity blocks。与官方 4.0.1 一致，空文件有一个空内容块 hash，整块倍数文件末尾也有额外空块 hash。并发上限 `min(available_parallelism, 8)`，每 worker 至多 4 MiB 数据 buffer；metadata/header/hash 数组随文件数及块数增长，不将整个大文件读入内存。
- 写出阶段再次流式计算 hash，与预计算结果核对，并复查目录快照。两遍读取/再次 hashing 是当前一致性保护的成本，不承诺性能提升。
- AArch64 保留 `sha2` 的 `asm-aarch64` 硬件 SHA 后端，运行时 CPU 检测支持回退；不使用 `target-cpu=native`。
- 正常错误时临时目录自动清理，完整数据校验后才发布。ASAR 使用同文件系统 hard-link 原子 no-clobber 发布；需要支持 hard links。sidecar 先独占创建，失败会清理本次创建的目录。ASAR 与 sidecar 不是跨文件原子事务；断电、强制 kill、文件系统清理失败可能留下临时目录或 sidecar，需要人工清理，不能当成成功。
- **打包期间源目录和输出父目录必须保持不变。不是恶意并发修改的安全边界**：metadata/hash 复查能发现常见修改，但不是完整文件系统快照、无 OS 级目录锁，不能宣称抵抗 symlink 替换/TOCTOU 攻击。
- 不支持非 UTF-8 文件名、压缩、transform、glob unpack、dedup、symlink、跨平台 installer；大目录仍需在内存保存 header 与文件索引。

## 验证

安装 package devDependencies（仓库 pnpm workspace 配置由主工程维护），再运行：

```sh
cargo fmt --check
cargo test
cargo clippy -- -D warnings
cargo clippy --features binding -- -D warnings
npm run build
npm test
npm run benchmark
```

`scripts/compat.mjs` 显式使用官方 `@electron/asar` 4.0.1 作为 oracle，对 CLI 与 binding 检查 list、extractFile/extractAll、每文件/每块 integrity、空文件和块边界、executable、unpack sidecar、确定性与错误不覆盖。还检查稀疏 4 GiB 文件快速拒绝、symlink 尾随路径、manifest 依赖布局、Promise/事件循环进度、无 TLA wrapper 与缺 binding 提示。测试不由仓库裸 `node --test` 隐式发现，避免普通 JS 测试要求 native binary。

benchmark 只测 ASAR 阶段，assets scenario 固定 1000 × 8 KiB 文件、32 MiB 大文件与 1 MiB unpacked 文件；dependencies scenario 在此基础上添加 200 个根依赖包（各一个 8 KiB 文件及 manifest，每包依赖 20 个 hoisted 包）、20 个 hoisted manifests 和 1 个 nested override manifest，共 4200 次 required dependency 查找。双方启用 SHA256/4 MiB blocks 及相同 native 目录 unpack；每 scenario 先预热一次，再交替执行五次取 median。

主比较为同一 Node 进程直接 `await pack(...)` 的 napi binding 对官方 API，不包含 CLI 子进程；编译、fixture 生成、校验和输出删除在计时外，最终测量不与构建并行。Rust 的输入校验、复查与额外 hashing 仍在计时内，因此不代表完全相同内部工作量。脚本输出当前机器实测数据，不推断 installer 性能，不声称普遍速度提升。

官方格式资料：https://github.com/electron/asar 。以此 package 的官方互操作测试作为兼容性判据，而不是仅凭手写格式假设。

本次开发最终实测：macOS arm64、Node v24.15.0，release 本地 binding：

| scenario | napi binding median | 官方 4.0.1 median |
| --- | ---: | ---: |
| assets | 153.38 ms | 341.84 ms |
| dependencies | 205.65 ms | 473.47 ms |

五次样本（ms，当前工作区复测、执行顺序交替）：assets binding `[164.26, 153.38, 139.31, 171.80, 135.58]`，官方 `[341.84, 344.23, 344.55, 333.12, 313.20]`；dependencies binding `[215.40, 205.65, 203.06, 205.19, 209.47]`，官方 `[481.30, 473.47, 470.55, 483.63, 463.80]`。
此机器/合成 fixture 上 binding 更快，不代表其他机器、实际项目、Electron 启动或 installer 普遍提升。
Linux/Windows 的检查已配置到仓库 CI，但本次未在这些系统上实际运行；installer、签名、公证和真实 native addon 的 ABI 重建未验证。

## 真实 Electron 集成验证

仓库另有显式 smoke script，使用绑定生成 ASAR 后在真实 Electron 中启动 ESM main、
沙箱 CJS preload 和 renderer，检查页面与 preload bridge；不被普通 Node 测试自动发现。
本次在 macOS arm64 / Electron **44.7.0** 上验证通过。

```sh
# 从仓库根运行，需可用的桌面环境（Linux CI 需自行配置显示服务）：
pnpm build
pnpm --filter @nasti-toolchain/electron-packager build
npx -y --package=electron@44.7.0 -c 'node scripts/electron-smoke.mjs "$(command -v electron)" --napi'
```

这只是运行时 smoke，不代表签名后的发行包或 Electron integrity fuse 已验证。
