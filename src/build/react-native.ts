import path from 'node:path'
import fs from 'node:fs'
import { rolldown } from 'rolldown'
import type { NastiConfig } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { reactNativePlugin } from '../plugins/react-native.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine } from '../core/env.js'
import pc from 'picocolors'

/**
 * Builds a React Native bundle for the project using the resolved Nasti configuration.
 *
 * @param inlineConfig - Partial Nasti configuration to merge with the resolved config for the `react-native` build
 * @throws Error - If no entry file is found (suggest creating `index.ts` or setting `reactNative.entry` in nasti.config.ts)
 */
export async function buildReactNative(inlineConfig: NastiConfig = {}): Promise<void> {
  const config = await resolveConfig({ ...inlineConfig, target: 'react-native' }, 'build')
  const startTime = performance.now()

  const platform = config.reactNative.platform
  const outDir = path.resolve(config.root, config.build.outDir)

  console.log(pc.cyan('\n📱 nasti react-native') + pc.dim(` v${__NASTI_VERSION__}`))
  console.log(pc.dim(`  root:     ${config.root}`))
  console.log(pc.dim(`  mode:     ${config.mode}`))
  console.log(pc.dim(`  platform: ${platform}`))

  // 查找入口：优先使用配置项，其次自动检测
  let entry = path.resolve(config.root, config.reactNative.entry)
  if (!fs.existsSync(entry)) {
    const fallbacks = [
      'index.ts',
      'index.tsx',
      'index.js',
      'src/index.ts',
      'src/index.tsx',
      'src/index.js',
    ]
    entry = ''
    for (const fb of fallbacks) {
      const full = path.resolve(config.root, fb)
      if (fs.existsSync(full)) {
        entry = full
        break
      }
    }
  }
  if (!entry) {
    throw new Error(
      'React Native 入口文件未找到。请创建 index.ts 或在 nasti.config.ts 中设置 reactNative.entry。',
    )
  }

  if (config.build.emptyOutDir && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = buildEnvDefine(env, config.mode)

  // oxc-transform 插件（TS/JSX 转译，React Native 不需要 DOM 环境）
  const oxcTransformPlugin = {
    name: 'nasti:oxc-transform',
    transform(code: string, id: string) {
      if (!shouldTransform(id)) return null
      const result = transformCode(id, code, {
        sourcemap: config.build.sourcemap,
        jsxRuntime: 'automatic',
        jsxImportSource: 'react',
      })
      return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
    },
  }

  const allPlugins = [
    reactNativePlugin(config),
    resolvePlugin(config),
    ...config.plugins.map((p) => ({
      name: p.name,
      resolveId: p.resolveId as any,
      load: p.load as any,
      transform: p.transform as any,
      buildStart: p.buildStart as any,
      buildEnd: p.buildEnd as any,
    })),
  ]

  const bundle = await rolldown({
    input: entry,
    define: {
      ...envDefine,
      // Metro/Hermes 约定的全局 __DEV__ 标志
      __DEV__: config.mode === 'development' ? 'true' : 'false',
    },
    plugins: [oxcTransformPlugin, ...allPlugins],
    ...(config.build.rolldownOptions as any),
  })

  const bundleFileName = `${platform}.bundle`
  await bundle.write({
    dir: outDir,
    format: 'cjs',
    sourcemap: config.build.sourcemap,
    minify: config.build.minify,
    entryFileNames: bundleFileName,
  })

  await bundle.close()

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
  console.log(pc.green(`\n✓ Bundle ready in ${elapsed}s`))
  console.log(pc.dim(`  output: ${config.build.outDir}/${bundleFileName}\n`))
}
