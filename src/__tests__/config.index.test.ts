import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineConfig, resolveConfig } from '../config/index.js'
import { defaults } from '../config/defaults.js'

// Mock filesystem to avoid reading actual config files
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: actual.readFileSync,
  }
})

describe('config/index - defineConfig', () => {
  it('returns the same config object passed in', () => {
    const input = { root: '/my/project', mode: 'production' as const }
    const result = defineConfig(input)
    expect(result).toBe(input)
  })

  it('allows target: react-native', () => {
    const config = defineConfig({ target: 'react-native' })
    expect(config.target).toBe('react-native')
  })

  it('allows target: web', () => {
    const config = defineConfig({ target: 'web' })
    expect(config.target).toBe('web')
  })

  it('allows target: electron', () => {
    const config = defineConfig({ target: 'electron' })
    expect(config.target).toBe('electron')
  })
})

describe('config/index - resolveConfig reactNative merging', () => {
  it('applies default reactNative config when no inline config provided', async () => {
    const resolved = await resolveConfig({}, 'build')
    expect(resolved.reactNative).toBeDefined()
    expect(resolved.reactNative.platform).toBe(defaults.reactNative.platform)
    expect(resolved.reactNative.entry).toBe(defaults.reactNative.entry)
    expect(resolved.reactNative.external).toEqual(defaults.reactNative.external)
  })

  it('overrides reactNative.platform from inline config', async () => {
    const resolved = await resolveConfig({ reactNative: { platform: 'ios' } }, 'build')
    expect(resolved.reactNative.platform).toBe('ios')
  })

  it('overrides reactNative.entry from inline config', async () => {
    const resolved = await resolveConfig({ reactNative: { entry: 'src/main.ts' } }, 'build')
    expect(resolved.reactNative.entry).toBe('src/main.ts')
  })

  it('overrides reactNative.external from inline config', async () => {
    const resolved = await resolveConfig(
      { reactNative: { external: ['react-native-reanimated'] } },
      'build',
    )
    expect(resolved.reactNative.external).toEqual(['react-native-reanimated'])
  })

  it('merges partial reactNative inline config with defaults', async () => {
    const resolved = await resolveConfig({ reactNative: { platform: 'ios' } }, 'build')
    // entry should still be the default even though platform was overridden
    expect(resolved.reactNative.entry).toBe(defaults.reactNative.entry)
    expect(resolved.reactNative.external).toEqual(defaults.reactNative.external)
  })

  it('resolves target: react-native when specified', async () => {
    const resolved = await resolveConfig({ target: 'react-native' }, 'build')
    expect(resolved.target).toBe('react-native')
  })

  it('includes reactNative in the resolved config object structure', async () => {
    const resolved = await resolveConfig({}, 'build')
    expect(resolved).toHaveProperty('reactNative')
    expect(typeof resolved.reactNative).toBe('object')
  })

  it('uses production mode for build command', async () => {
    const resolved = await resolveConfig({}, 'build')
    expect(resolved.mode).toBe('production')
  })

  it('uses development mode for serve command', async () => {
    const resolved = await resolveConfig({}, 'serve')
    expect(resolved.mode).toBe('development')
  })

  it('reactNative config does not affect other config sections', async () => {
    const resolved = await resolveConfig(
      { reactNative: { platform: 'ios', external: ['my-native-module'] } },
      'build',
    )
    // Electron config should remain at defaults
    expect(resolved.electron.mainFormat).toBe(defaults.electron.mainFormat)
    expect(resolved.electron.main).toBe(defaults.electron.main)
  })

  it('filters plugins by apply field set to build', async () => {
    const buildPlugin = {
      name: 'test-build-plugin',
      apply: 'build' as const,
    }
    const servePlugin = {
      name: 'test-serve-plugin',
      apply: 'serve' as const,
    }
    const resolved = await resolveConfig({ plugins: [buildPlugin, servePlugin] }, 'build')
    const names = resolved.plugins.map((p) => p.name)
    expect(names).toContain('test-build-plugin')
    expect(names).not.toContain('test-serve-plugin')
  })

  it('runs plugin config hook and merges returned values', async () => {
    const configPlugin = {
      name: 'test-config-plugin',
      config: vi.fn().mockReturnValue({ logLevel: 'warn' as const }),
    }
    const resolved = await resolveConfig({ plugins: [configPlugin] }, 'build')
    expect(configPlugin.config).toHaveBeenCalled()
    expect(resolved.logLevel).toBe('warn')
  })

  it('runs plugin configResolved hook', async () => {
    const configResolvedSpy = vi.fn()
    const plugin = {
      name: 'test-resolved-plugin',
      configResolved: configResolvedSpy,
    }
    await resolveConfig({ plugins: [plugin] }, 'build')
    expect(configResolvedSpy).toHaveBeenCalledOnce()
  })
})