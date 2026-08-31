// build.minify 的归一化：Nasti 对外暴露 `boolean | 'oxc' | NastiMinifyOptions`，
// 而 Rolldown 的 OutputOptions.minify 只认 `boolean | 'dce-only' | MinifyOptions`。
//
// 历史上各调用点都写 `!!config.build.minify`，这会把细粒度对象压成 `true`，
// 于是 mangle 选项（含类名最小化）根本传不下去。本模块把「布尔判定」与
// 「透传给 Rolldown 的值」拆成两个函数，调用点按语义各取所需。

import type { MinifyOption, ResolvedMinifyOption } from '../types.js'

/**
 * 压缩是否开启 —— 供 `cssMinify` 跟随、体积报告等只关心开关的场合使用。
 *
 * 注意不能简单用 `!!`：`'dce-only'` 与空对象 `{}` 都是真值，但前者只做
 * 死代码消除、后者是「按 OXC 默认项压缩」，二者都算开启；只有 `false`
 * 才是关闭。
 */
export function isMinifyEnabled(minify: MinifyOption | undefined): boolean {
  return minify !== false && minify !== undefined
}

/**
 * 归一化为 Rolldown `OutputOptions.minify` 接受的值。
 *
 * - `'oxc'`：2.x 之前的历史写法，语义等同 `true`（Rolldown 本来就只有
 *   OXC 一个 minifier），归一为 `true` 保持向后兼容；
 * - 对象：原样透传，交给 OXC minifier（`compress` / `mangle` / `codegen`）。
 *   其中 `mangle.keepNames.class` 控制类名是否参与最小化，
 *   `mangle.mangleProps` 是 Rolldown 1.2.6 / OXC 0.147 新增的属性名最小化。
 */
export function resolveMinifyOption(
  minify: MinifyOption | undefined,
): ResolvedMinifyOption {
  if (minify === undefined) return false
  if (minify === 'oxc') return true
  return minify
}
