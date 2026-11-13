import fs from 'node:fs'
import type { NastiPlugin, ResolvedConfig } from '../types.js'
import { importProjectPackage } from '../core/project-import.js'
import { transformCode } from '../core/transformer.js'
import { isAllowedDevModulePath } from '../server/fs-allow.js'
import { SourceMapConsumer, SourceMapGenerator } from 'source-map-js'

const COMPONENT_RE = /\.svelte$/
const MODULE_RE = /\.svelte\.[jt]s$/
const STYLE_RE = /^(.+\.svelte)\?svelte&type=style&lang\.css$/

/**
 * Svelte 5 owns component HMR and runes compilation. CSS virtual modules go
 * through the shared CSS pipeline (dev injection / build extraction).
 * Compiler tools are resolved from the consuming workspace, not Nasti's own.
 */
export function sveltePlugin(config: ResolvedConfig): NastiPlugin {
  let compiler: Promise<any> | undefined
  const loadCompiler = () => compiler ??= importProjectPackage(config.root, 'svelte/compiler')
  const development = config.mode === 'development'
  const compile = async (source: string, filename: string, server: boolean) => {
    const svelte = await loadCompiler()
    const result = svelte.compile(source, {
      filename,
      generate: server ? 'server' : 'client',
      dev: development,
      hmr: !server && development && config.command === 'serve' && config.server.hmr !== false,
      css: 'external',
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
      if (STYLE_RE.test(source)) return source
      return null
    },

    async load(id) {
      const match = STYLE_RE.exec(id)
      if (!match) return null
      let filename: string
      try {
        filename = fs.realpathSync(match[1])
        if (!fs.statSync(filename).isFile()) return null
      } catch {
        return null
      }
      if (!isAllowedDevModulePath(filename, config.root)) {
        // Returning null would let the server fall back to reading the parent.
        throw new Error('[nasti:svelte] Style request is outside the allowed filesystem paths')
      }
      // Read the current source even on direct CSS requests, so there is no
      // stale compiler cache after a component or stylesheet edit.
      const result = await compile(
        fs.readFileSync(filename, 'utf8'),
        match[1],
        this.environment?.consumer === 'server',
      )
      return { code: result.css?.code ?? '', map: result.css?.map }
    },

    async transform(code, id) {
      if (!COMPONENT_RE.test(id) && !MODULE_RE.test(id)) return null
      const server = this.environment?.consumer === 'server'
      if (COMPONENT_RE.test(id)) {
        const result = await compile(code, id, server)
        const cssImport = !server && result.css?.code
          ? `\nimport ${JSON.stringify(`${id}?svelte&type=style&lang.css`)};\n`
          : ''
        return { code: result.js.code + cssImport, map: result.js.map }
      }

      const svelte = await loadCompiler()
      // compileModule accepts JS only; strip TS without consuming runes.
      const stripped = id.endsWith('.ts') ? transformCode(id, code) : undefined
      const result = svelte.compileModule(stripped?.code ?? code, {
        filename: id,
        generate: server ? 'server' : 'client',
        dev: development,
      })
      for (const warning of result.warnings) {
        config.logger.warn(`[nasti:svelte] ${id}: ${warning.message}`)
      }
      let map = result.js.map
      if (map && stripped?.map) {
        const generator = SourceMapGenerator.fromSourceMap(new SourceMapConsumer(map))
        generator.applySourceMap(new SourceMapConsumer(JSON.parse(stripped.map)), map.sources[0])
        map = generator.toJSON()
      }
      return { code: result.js.code, map }
    },
  }
}
