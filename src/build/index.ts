// 生产构建 - 调用 Rolldown API 打包
import path from 'node:path'
import fs from 'node:fs'
import { rolldown } from 'rolldown'
import type { NastiConfig, ResolvedConfig } from '../types.js'
import { resolveConfig } from '../config/index.js'
import { resolvePlugin } from '../plugins/resolve.js'
import { cssPlugin } from '../plugins/css.js'
import { assetsPlugin } from '../plugins/assets.js'
import { htmlPlugin, readHtmlFile, processHtml } from '../plugins/html.js'
import { transformCode, shouldTransform } from '../core/transformer.js'
import { loadEnv, buildEnvDefine } from '../core/env.js'
import { PluginContainer } from '../core/plugin-container.js'
import pc from 'picocolors'

export interface BuildResult {
  output: Array<{ fileName: string; type: string; code?: string; source?: Uint8Array | string }>
}

export async function build(inlineConfig: NastiConfig = {}): Promise<BuildResult> {
  const config = await resolveConfig(inlineConfig, 'build')
  const startTime = performance.now()

  console.log(pc.cyan('\n🔨 nasti build') + pc.dim(` v${__NASTI_VERSION__}`))
  console.log(pc.dim(`  root: ${config.root}`))
  console.log(pc.dim(`  mode: ${config.mode}`))

  const outDir = path.resolve(config.root, config.build.outDir)

  // 清空输出目录
  if (config.build.emptyOutDir && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  // 查找 HTML 入口中的 script 标签作为 entry
  const html = await readHtmlFile(config.root)
  let entryPoints: string[] = []

  if (html) {
    const scriptMatches = html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)
    for (const match of scriptMatches) {
      const src = match[1]
      if (src && !src.startsWith('http')) {
        entryPoints.push(path.resolve(config.root, src.replace(/^\//, '')))
      }
    }
  }

  if (entryPoints.length === 0) {
    // 回退: 尝试常见入口
    const fallbackEntries = ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/index.ts', 'src/index.tsx', 'src/index.js']
    for (const entry of fallbackEntries) {
      const fullPath = path.resolve(config.root, entry)
      if (fs.existsSync(fullPath)) {
        entryPoints.push(fullPath)
        break
      }
    }
  }

  if (entryPoints.length === 0) {
    throw new Error('No entry point found. Add a <script> tag to index.html or create src/main.ts')
  }

  // 构建内置插件 + 用户插件作为 Rolldown 插件
  const builtinPlugins = [
    resolvePlugin(config),
    cssPlugin(config),
    assetsPlugin(config),
  ]
  const allPlugins = [...builtinPlugins, ...config.plugins]

  // 运行插件的 buildStart 钩子，并收集 emitFile 输出文件
  const pluginContainer = new PluginContainer(config)
  await pluginContainer.buildStart()

  // oxc-transform 插件（作为 Rolldown 插件）
  const oxcTransformPlugin = {
    name: 'nasti:oxc-transform',
    transform(code: string, id: string) {
      if (!shouldTransform(id)) return null
      const result = transformCode(id, code, {
        sourcemap: !!config.build.sourcemap,
        jsxRuntime: 'automatic',
        jsxImportSource: config.framework === 'vue' ? 'vue' : 'react',
      })
      return { code: result.code, map: result.map ? JSON.parse(result.map) : undefined }
    },
  }

  // 加载环境变量并生成 define 替换表
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = buildEnvDefine(env, config.mode)

  // 调用 Rolldown
  // Rolldown 1.x 把 `define` 从顶层 InputOptions 移到了 `transform.define`，
  // 顶层传入会触发 "Invalid key: Expected never but received 'define'" 警告并
  // 静默丢弃 —— 导致 `import.meta.env.*` 不被替换。
  const bundle = await rolldown({
    input: entryPoints,
    transform: { define: envDefine },
    plugins: [
      oxcTransformPlugin,
      // 转换 Nasti 插件为 Rolldown 插件格式
      ...allPlugins.map((p) => ({
        name: p.name,
        resolveId: p.resolveId as any,
        load: p.load as any,
        transform: p.transform as any,
        buildStart: p.buildStart as any,
        buildEnd: p.buildEnd as any,
        // Forward `closeBundle` to Rolldown — it invokes the hook during
        // `bundle.close()` below. This is the hook Vite plugins (e.g. PWA
        // manifest/SW writers) rely on for final-stage artifact emission.
        closeBundle: p.closeBundle as any,
      })),
    ],
    ...(config.build.rolldownOptions as any),
  })

  const { output } = await bundle.write({
    dir: outDir,
    format: 'esm',
    sourcemap: !!config.build.sourcemap,
    minify: !!config.build.minify,
    entryFileNames: 'assets/[name].[hash].js',
    chunkFileNames: 'assets/[name].[hash].js',
    assetFileNames: 'assets/[name].[hash][extname]',
  })

  await bundle.close()
  await pluginContainer.buildEnd()

  // 将 emitFile 产出的文件写入输出目录
  for (const ef of pluginContainer.getEmittedFiles()) {
    const dest = path.resolve(outDir, ef.fileName)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, ef.source)
  }

  // 处理 HTML
  if (html) {
    let processedHtml = html

    // 执行插件的 transformIndexHtml 钩子
    const htmlPlugin_ = htmlPlugin(config)
    if (htmlPlugin_.transformIndexHtml) {
      const result = await htmlPlugin_.transformIndexHtml(processedHtml)
      if (typeof result === 'string') {
        processedHtml = result
      } else if (result && 'html' in result) {
        processedHtml = processHtml(result.html, result.tags)
      } else if (Array.isArray(result)) {
        processedHtml = processHtml(processedHtml, result)
      }
    }

    // 替换 script src 为打包后的路径（支持多入口）
    for (const chunk of output) {
      if (chunk.type === 'chunk' && chunk.isEntry && chunk.facadeModuleId) {
        const originalEntry = path.relative(config.root, chunk.facadeModuleId)
        processedHtml = processedHtml.replace(
          new RegExp(`(src=["'])/?(${escapeRegExp(originalEntry)})(["'])`, 'g'),
          `$1${config.base}${chunk.fileName}$3`,
        )
      }
    }

    fs.writeFileSync(path.resolve(outDir, 'index.html'), processedHtml)
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)
  const totalSize = output.reduce((sum, chunk) => {
    if (chunk.type === 'chunk' && chunk.code) return sum + chunk.code.length
    return sum
  }, 0)

  console.log(pc.green(`\n✓ Built in ${elapsed}s`))
  console.log(pc.dim(`  ${output.length} files, ${formatSize(totalSize)} total`))
  console.log(pc.dim(`  output: ${config.build.outDir}/\n`))

  return { output: output as any }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} kB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
