import fs from 'node:fs'
import type { NastiPlugin } from '../types.js'
import { importProjectPackage, resolveProjectImport } from '../core/project-import.js'

export interface RedactOptions {
  preset?: 'full' | 'nano'
  features?: {
    activity?: boolean
    fragmentRefs?: boolean
    viewTransitions?: boolean
    portal?: boolean
    context?: boolean
    suspense?: boolean
    memo?: boolean
    forwardRef?: boolean
    lazy?: boolean
    classComponents?: boolean
    hydration?: boolean
  }
}

/**
 * Reuse Redact's alias/feature rules, not its Vite config hooks. One runtime in
 * both React client and SSR graphs is required for Start hydration parity.
 * RSC and react-server environments are excluded and retain real React.
 * Enables bundled dev when Start is absent and inlines React compatibility
 * packages in eligible server environments. Configuration requires React 19;
 * Start also requires context and hydration, explicitly enabled for nano.
 * Configuration rejects incompatible settings and propagates dependency
 * resolution, manifest reading/parsing, and upstream initialization errors.
 */
export function redact(options: RedactOptions = {}): NastiPlugin {
  let upstream: any[]
  let root: string
  return {
    name: 'nasti:redact',
    enforce: 'pre',
    post: ['nasti:resolve'],
    applyToEnvironment(environment) {
      return environment.name !== 'rsc' && !environment.options.resolve.conditions.includes('react-server')
    },
    async configResolved(config) {
      if (config.framework !== 'react') {
        throw new Error('[nasti:redact] Redact requires framework: "react".')
      }
      // Inspect the final plugin list, including file-config + inline plugins.
      // Separate prebundles can duplicate dispatcher state; Start already owns
      // a complete native client graph, while SPAs use the native dev engine.
      if (config.command === 'serve' && !config.plugins.some((p) => p.name === 'nasti:tanstack-start')) {
        config.experimental.bundledDev = true
      }
      if (config.plugins.some((p) => p.name === 'nasti:tanstack-start') &&
          (options.features?.hydration === false ||
            (options.preset === 'nano' && options.features?.hydration !== true))) {
        throw new Error('[nasti:redact] TanStack Start requires the Redact hydration feature.')
      }
      if (config.plugins.some((p) => p.name === 'nasti:tanstack-start') &&
          (options.features?.context === false ||
            (options.preset === 'nano' && options.features?.context !== true))) {
        throw new Error('[nasti:redact] TanStack Start requires the Redact context feature.')
      }
      root = config.root
      // React 18 needs Redact's separate post-transform contract. Fail explicitly
      // instead of silently omitting that compatibility pass.
      const react = JSON.parse(fs.readFileSync(new URL(resolveProjectImport(root, 'react/package.json')), 'utf8'))
      if (!/^19\./.test(react.version)) {
        throw new Error('[nasti:redact] The native Redact adapter currently requires React 19.')
      }
      const { redact: createRedact } = await importProjectPackage(root, '@tanstack/redact/vite')
      upstream = createRedact({ ...options, resolveFrom: root })
      // The official integration contains no Vite runtime import. Its resolver
      // owns feature switches and canonical realpaths; bypass Vite-only hooks.
      upstream[0].configResolved({ root })
      // Bare replacements must reach Redact's resolver before SSR externalization.
      for (const [name, environment] of Object.entries(config.environments)) {
        if (environment.consumer !== 'server' || name === 'rsc' ||
            environment.resolve.conditions.includes('react-server') ||
            environment.resolve.noExternal === true) continue
        environment.resolve.noExternal = [
          ...environment.resolve.noExternal,
          'react', 'react-dom', 'scheduler', 'use-sync-external-store', '@tanstack/redact',
        ]
      }
    },
    async resolveId(source, importer, resolveOptions) {
      return upstream[0].resolveId.call(this, source, importer, resolveOptions)
    },
  }
}
