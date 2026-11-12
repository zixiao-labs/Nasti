import fs from 'node:fs/promises'
import path from 'node:path'
import type { CompileResult } from 'svelte/compiler'
import type { NastiPlugin, PluginContext, ResolvedConfig } from '../types.js'
import { importProjectPackage } from '../core/project-import.js'
import { transformCode } from '../core/transformer.js'

const STYLE_QUERY = '?svelte&type=style&lang.css'

/** Native Svelte 5 compiler, isolated per environment and consuming workspace. */
export function sveltePlugin(config: ResolvedConfig): NastiPlugin {
  let compiler: Promise<typeof import('svelte/compiler')> | undefined
  const getCompiler = () => compiler ??= importProjectPackage(config.root, 'svelte/compiler')

  async function compile(context: PluginContext, source: string, filename: string): Promise<CompileResult> {
    const tools = await getCompiler()
    const processed = config.svelte.preprocess
      ? await tools.preprocess(source, config.svelte.preprocess, { filename })
      : undefined
    for (const dependency of processed?.dependencies ?? []) {
      context.addWatchFile(path.resolve(path.dirname(filename), dependency))
    }
    const result = tools.compile(processed?.code ?? source, {
      ...config.svelte.compilerOptions,
      filename,
      rootDir: config.root,
      generate: context.environment?.consumer === 'server' ? 'server' : 'client',
      dev: config.mode === 'development',
      css: 'external',
      hmr: false,
      sourcemap: processed?.map,
    })
    for (const warning of result.warnings) {
      config.logger.warn(`[nasti:svelte] ${filename}: ${warning.message}`)
    }
    return result
  }

  return {
    name: 'nasti:svelte',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith(STYLE_QUERY)) return source
      return null
    },
    async load(id) {
      if (!id.endsWith(STYLE_QUERY)) return null
      const filename = id.slice(0, -STYLE_QUERY.length)
      this.addWatchFile(filename)
      // Recompile instead of retaining stale CSS when styles are removed or
      // a preprocessor dependency changes without editing the parent component.
      const result = await compile(this, await fs.readFile(filename, 'utf8'), filename)
      return { code: result.css?.code ?? '', map: result.css?.map }
    },
    async transform(source, id) {
      if (id.includes('?')) return null
      if (/\.svelte\.[jt]s$/.test(id)) {
        const tools = await getCompiler()
        const code = id.endsWith('.ts')
          ? transformCode(id, source, { sourcemap: false }).code : source
        const result = tools.compileModule(code, {
          filename: id,
          rootDir: config.root,
          generate: this.environment?.consumer === 'server' ? 'server' : 'client',
          dev: config.mode === 'development',
        })
        return { code: result.js.code, map: result.js.map, moduleType: 'js' }
      }
      if (!id.endsWith('.svelte')) return null
      const result = await compile(this, source, id)
      return {
        code: result.js.code + (result.css?.code
          ? `\nimport ${JSON.stringify(id + STYLE_QUERY)};\n` : ''),
        map: result.js.map,
        moduleType: 'js',
      }
    },
  }
}
