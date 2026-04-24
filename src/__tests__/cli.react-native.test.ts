import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the react-native CLI command logic extracted from src/cli.ts.
 *
 * The CLI action function:
 * 1. Validates that --platform is either 'ios' or 'android'
 * 2. Calls buildReactNative with the correct config object
 * 3. Defaults mode to 'production' and root to '.'
 * 4. Only includes entry in reactNative config if options.entry is provided
 */

// Simulate the action handler logic from the CLI react-native command
async function cliReactNativeAction(
  root: string | undefined,
  options: {
    platform: string
    entry?: string
    outDir: string
    sourcemap?: boolean
    minify: boolean
    mode?: string
  },
  buildReactNative: (config: any) => Promise<void>,
): Promise<void> {
  const platform = options.platform
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`Invalid --platform "${platform}". Expected "ios" or "android".`)
  }
  await buildReactNative({
    root: root ?? '.',
    mode: options.mode ?? 'production',
    target: 'react-native',
    reactNative: {
      platform,
      ...(options.entry ? { entry: options.entry } : {}),
    },
    build: {
      outDir: options.outDir,
      sourcemap: options.sourcemap,
      minify: options.minify,
    },
  })
}

describe('CLI react-native command action logic', () => {
  let mockBuildReactNative: (config: any) => Promise<void>

  beforeEach(() => {
    mockBuildReactNative = vi.fn().mockResolvedValue(undefined)
  })

  describe('platform validation', () => {
    it('throws for invalid platform value', async () => {
      await expect(
        cliReactNativeAction(undefined, { platform: 'web', outDir: 'dist', minify: true }, mockBuildReactNative),
      ).rejects.toThrow('Invalid --platform "web". Expected "ios" or "android".')
    })

    it('throws for platform: windows', async () => {
      await expect(
        cliReactNativeAction(undefined, { platform: 'windows', outDir: 'dist', minify: true }, mockBuildReactNative),
      ).rejects.toThrow('Invalid --platform "windows"')
    })

    it('throws for empty string platform', async () => {
      await expect(
        cliReactNativeAction(undefined, { platform: '', outDir: 'dist', minify: true }, mockBuildReactNative),
      ).rejects.toThrow('Invalid --platform ""')
    })

    it('accepts android platform', async () => {
      await expect(
        cliReactNativeAction(undefined, { platform: 'android', outDir: 'dist', minify: true }, mockBuildReactNative),
      ).resolves.toBeUndefined()
    })

    it('accepts ios platform', async () => {
      await expect(
        cliReactNativeAction(undefined, { platform: 'ios', outDir: 'dist', minify: true }, mockBuildReactNative),
      ).resolves.toBeUndefined()
    })
  })

  describe('config object construction', () => {
    it('defaults root to . when not provided', async () => {
      await cliReactNativeAction(undefined, { platform: 'android', outDir: 'dist', minify: true }, mockBuildReactNative)
      expect(mockBuildReactNative).toHaveBeenCalledWith(
        expect.objectContaining({ root: '.' }),
      )
    })

    it('uses provided root', async () => {
      await cliReactNativeAction('/my/app', { platform: 'android', outDir: 'dist', minify: true }, mockBuildReactNative)
      expect(mockBuildReactNative).toHaveBeenCalledWith(
        expect.objectContaining({ root: '/my/app' }),
      )
    })

    it('defaults mode to production when not provided', async () => {
      await cliReactNativeAction(undefined, { platform: 'android', outDir: 'dist', minify: true }, mockBuildReactNative)
      expect(mockBuildReactNative).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'production' }),
      )
    })

    it('uses provided mode when specified', async () => {
      await cliReactNativeAction(
        undefined,
        { platform: 'android', outDir: 'dist', minify: false, mode: 'development' },
        mockBuildReactNative,
      )
      expect(mockBuildReactNative).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'development' }),
      )
    })

    it('always sets target to react-native', async () => {
      await cliReactNativeAction(undefined, { platform: 'android', outDir: 'dist', minify: true }, mockBuildReactNative)
      expect(mockBuildReactNative).toHaveBeenCalledWith(
        expect.objectContaining({ target: 'react-native' }),
      )
    })

    it('does not include entry in reactNative config when not provided', async () => {
      await cliReactNativeAction(
        undefined,
        { platform: 'android', outDir: 'dist', minify: true },
        mockBuildReactNative,
      )
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.reactNative).not.toHaveProperty('entry')
    })

    it('includes entry in reactNative config when provided', async () => {
      await cliReactNativeAction(
        undefined,
        { platform: 'android', entry: 'src/main.ts', outDir: 'dist', minify: true },
        mockBuildReactNative,
      )
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.reactNative.entry).toBe('src/main.ts')
    })

    it('passes platform to reactNative config', async () => {
      await cliReactNativeAction(undefined, { platform: 'ios', outDir: 'dist', minify: true }, mockBuildReactNative)
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.reactNative.platform).toBe('ios')
    })

    it('passes outDir to build config', async () => {
      await cliReactNativeAction(undefined, { platform: 'android', outDir: 'output', minify: true }, mockBuildReactNative)
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.build.outDir).toBe('output')
    })

    it('passes sourcemap to build config', async () => {
      await cliReactNativeAction(
        undefined,
        { platform: 'android', outDir: 'dist', sourcemap: true, minify: true },
        mockBuildReactNative,
      )
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.build.sourcemap).toBe(true)
    })

    it('passes minify: false to build config when no-minify', async () => {
      await cliReactNativeAction(
        undefined,
        { platform: 'android', outDir: 'dist', minify: false },
        mockBuildReactNative,
      )
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.build.minify).toBe(false)
    })

    it('passes minify: true to build config by default', async () => {
      await cliReactNativeAction(
        undefined,
        { platform: 'android', outDir: 'dist', minify: true },
        mockBuildReactNative,
      )
      const callArg = mockBuildReactNative.mock.calls[0][0]
      expect(callArg.build.minify).toBe(true)
    })

    it('android platform calls buildReactNative once', async () => {
      await cliReactNativeAction(undefined, { platform: 'android', outDir: 'dist', minify: true }, mockBuildReactNative)
      expect(mockBuildReactNative).toHaveBeenCalledOnce()
    })

    it('does not call buildReactNative when platform is invalid', async () => {
      await expect(
        cliReactNativeAction(undefined, { platform: 'invalid', outDir: 'dist', minify: true }, mockBuildReactNative),
      ).rejects.toThrow()
      expect(mockBuildReactNative).not.toHaveBeenCalled()
    })
  })
})