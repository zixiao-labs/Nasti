// 主进程 / preload 在 dev 与 build 中共用同一条 Node 编译管线。
import fs from 'node:fs'
import path from 'node:path'
import { rolldown } from 'rolldown'
import type { ResolvedConfig } from '../types.js'
import { electronPlugin } from '../plugins/electron.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { transformCode, transformReactCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine, ssrDefineOverrides } from '../core/env.js'
import { resolveMinifyOption } from '../core/minify.js'

interface ElectronNodeOptions {
  outFile: string
  format: 'cjs' | 'esm'
  /** 仅 dev 注入；同时开启 sourcemap 并关闭压缩。 */
  devUrl?: string
}

/** 单文件输出，返回编译图中的磁盘文件，供开发模式监听导入的模块。 */
export async function bundleElectronNode(
  config: ResolvedConfig,
  entry: string,
  opts: ElectronNodeOptions,
): Promise<string[]> {
  const development = opts.devUrl !== undefined
  const sourcemap = development ? true : config.build.sourcemap
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = {
    ...buildEnvDefine(env, config.mode, ssrDefineOverrides('server')),
    __ELECTRON__: 'true',
    __NASTI_TARGET__: JSON.stringify('electron'),
    ...(development ? { __NASTI_DEV_SERVER_URL__: JSON.stringify(opts.devUrl) } : {}),
  }
  const {
    output: userOutput,
    transform: userTransform,
    resolve: userResolve,
    ...restInputOptions
  } = config.build.rolldownOptions

  const bundle = await rolldown({
    ...restInputOptions,
    input: entry,
    platform: 'node',
    transform: {
      ...userTransform,
      target: config.electron.nodeTarget,
      define: { ...(userTransform?.define ?? {}), ...envDefine },
    },
    // 不继承 renderer 的 browser conditions。让 Rolldown 根据 import/require
    // 分别选择条件导出，尤其不能在 dev 中先用 require.resolve 抢走 ESM 入口。
    resolve: {
      ...userResolve,
      extensions: userResolve?.extensions ?? config.resolve.extensions,
      conditionNames: userResolve?.conditionNames ?? [
        'node',
        config.mode,
        // import/require 由 Rolldown 按导入种类添加；保留自定义条件。
        ...config.resolve.conditions.filter((condition) =>
          !['browser', 'import', 'require', 'default'].includes(condition)),
      ],
      mainFields: userResolve?.mainFields ?? config.resolve.mainFields.filter((field) => field !== 'browser'),
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
        ...userResolve?.extensionAlias,
      },
    },
    plugins: [
      {
        name: 'nasti:oxc-transform',
        async transform(code, id) {
          const result = config.framework === 'react'
            ? await transformReactCode(id, code, {
                react: config.react,
                consumer: 'server',
                development: config.mode === 'development',
                sourcemap: !!sourcemap,
                target: config.electron.nodeTarget,
                onWarning: (message) => config.logger.warn(`[nasti:react] ${message}`),
              })
            : shouldTransform(id)
              ? transformCode(id, code, {
                  sourcemap: !!sourcemap,
                  jsxRuntime: 'automatic',
                  jsxImportSource: 'vue',
                  target: config.electron.nodeTarget,
                })
              : null
          if (!result) return null
          return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
        },
      },
      electronPlugin(config),
      resolvePlugin(config, { nativeResolver: true }),
    ],
  })

  try {
    fs.mkdirSync(path.dirname(opts.outFile), { recursive: true })
    // renderer 的 output.dir 与 Node 的单文件 output.file 互斥。
    const { dir: _dir, ...output } = userOutput ?? {}
    await bundle.write({
      sourcemap,
      minify: development ? false : resolveMinifyOption(config.build.minify),
      ...output,
      ...(development ? { sourcemap: true, minify: false } : {}),
      file: opts.outFile,
      format: opts.format,
      codeSplitting: false,
    })
    // platform:node 的 ESM 输出由 Rolldown 自带 createRequire shim；
    // 不手写 banner，避免与用户自己声明的 require 发生变量冲突。
    return (await bundle.watchFiles).filter((file) => !file.startsWith('\0') && fs.existsSync(file))
  } finally {
    await bundle.close()
  }
}
