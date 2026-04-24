import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { reactNativePlugin } from '../plugins/react-native.js'
import type { ResolvedConfig } from '../types.js'

// Helper to build a minimal ResolvedConfig for plugin testing
function makeConfig(overrides: Partial<ResolvedConfig['reactNative']> = {}): ResolvedConfig {
  return {
    root: '/project',
    base: '/',
    mode: 'production',
    target: 'react-native',
    framework: 'react',
    command: 'build',
    resolve: {
      alias: {},
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      conditions: [],
      mainFields: [],
    },
    plugins: [],
    server: {} as any,
    build: {} as any,
    electron: {} as any,
    reactNative: {
      platform: 'android',
      entry: 'index.ts',
      external: [],
      ...overrides,
    },
    envPrefix: [],
    logLevel: 'info',
  }
}

describe('reactNativePlugin', () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
  })

  describe('plugin identity', () => {
    it('returns a plugin with name nasti:react-native', () => {
      const plugin = reactNativePlugin(makeConfig())
      expect(plugin.name).toBe('nasti:react-native')
    })

    it('enforces pre execution order', () => {
      const plugin = reactNativePlugin(makeConfig())
      expect(plugin.enforce).toBe('pre')
    })
  })

  describe('resolveId - always-external packages', () => {
    it('marks react as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'react', undefined, {} as any)
      expect(result).toEqual({ id: 'react', external: true })
    })

    it('marks react-native as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'react-native', undefined, {} as any)
      expect(result).toEqual({ id: 'react-native', external: true })
    })

    it('marks expo as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'expo', undefined, {} as any)
      expect(result).toEqual({ id: 'expo', external: true })
    })
  })

  describe('resolveId - prefix-based external packages', () => {
    it('marks react-native/* sub-paths as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'react-native/Libraries/Utilities/Platform', undefined, {} as any)
      expect(result).toEqual({ id: 'react-native/Libraries/Utilities/Platform', external: true })
    })

    it('marks @react-native/* packages as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, '@react-native/assets', undefined, {} as any)
      expect(result).toEqual({ id: '@react-native/assets', external: true })
    })

    it('marks @react-native-community/* packages as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, '@react-native-community/netinfo', undefined, {} as any)
      expect(result).toEqual({ id: '@react-native-community/netinfo', external: true })
    })

    it('marks @react-navigation/* packages as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, '@react-navigation/native', undefined, {} as any)
      expect(result).toEqual({ id: '@react-navigation/native', external: true })
    })

    it('marks expo-* packages as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'expo-camera', undefined, {} as any)
      expect(result).toEqual({ id: 'expo-camera', external: true })
    })

    it('marks expo-modules-core as external', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'expo-modules-core', undefined, {} as any)
      expect(result).toEqual({ id: 'expo-modules-core', external: true })
    })
  })

  describe('resolveId - user-defined external packages', () => {
    it('marks user-specified packages as external', () => {
      const plugin = reactNativePlugin(makeConfig({ external: ['react-native-reanimated', '@my-company/native-module'] }))
      const r1 = plugin.resolveId!.call({} as any, 'react-native-reanimated', undefined, {} as any)
      const r2 = plugin.resolveId!.call({} as any, '@my-company/native-module', undefined, {} as any)
      expect(r1).toEqual({ id: 'react-native-reanimated', external: true })
      expect(r2).toEqual({ id: '@my-company/native-module', external: true })
    })

    it('does not mark unlisted packages as external via user config', () => {
      const plugin = reactNativePlugin(makeConfig({ external: ['some-lib'] }))
      const result = plugin.resolveId!.call({} as any, 'other-lib', '/project/src/App.tsx', {} as any)
      expect(result).toBeNull()
    })
  })

  describe('resolveId - platform file resolution', () => {
    it('returns null when no platform/native files exist for relative import', () => {
      existsSyncSpy.mockReturnValue(false)
      const plugin = reactNativePlugin(makeConfig({ platform: 'ios' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBeNull()
    })

    it('returns null when no importer is provided for relative import', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, './components/Button', undefined, {} as any)
      expect(result).toBeNull()
    })

    it('returns null for non-relative, non-absolute, non-external package', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.resolveId!.call({} as any, 'lodash', '/project/src/App.tsx', {} as any)
      expect(result).toBeNull()
    })

    it('resolves platform-specific file when it exists (ios)', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/components/Button.ios.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'ios' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button.ios.tsx')
    })

    it('resolves .native file when platform-specific file does not exist', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/components/Button.native.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'android' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button.native.tsx')
    })

    it('strips existing .tsx extension before trying platform variants', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/components/Button.android.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'android' }))
      // Import with extension already present
      const result = plugin.resolveId!.call({} as any, './components/Button.tsx', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button.android.tsx')
    })

    it('strips existing .ts extension before trying platform variants', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/utils/helper.ios.ts'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'ios' }))
      const result = plugin.resolveId!.call({} as any, './utils/helper.ts', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/utils/helper.ios.ts')
    })

    it('resolves platform index file when directory platform variant exists', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/components/Button/index.android.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'android' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button/index.android.tsx')
    })

    it('resolves .native index file as fallback', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/components/Button/index.native.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'ios' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button/index.native.tsx')
    })

    it('handles absolute source path', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === '/project/src/components/Button.ios.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'ios' }))
      const result = plugin.resolveId!.call({} as any, '/project/src/components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button.ios.tsx')
    })

    it('prefers platform-specific file over .native file', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        const s = String(p)
        // Both exist - platform should win
        return s === '/project/src/components/Button.android.tsx' ||
               s === '/project/src/components/Button.native.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'android' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button.android.tsx')
    })

    it('prefers platform-specific file with different extension over .native file (cross-extension priority)', () => {
      existsSyncSpy.mockImplementation((p: any) => {
        const s = String(p)
        // Button.ios.ts exists but Button.native.tsx also exists
        // Platform-specific .ts should win over .native.tsx
        return s === '/project/src/components/Button.ios.ts' ||
               s === '/project/src/components/Button.native.tsx'
      })

      const plugin = reactNativePlugin(makeConfig({ platform: 'ios' }))
      const result = plugin.resolveId!.call({} as any, './components/Button', '/project/src/App.tsx', {} as any)
      expect(result).toBe('/project/src/components/Button.ios.ts')
    })
  })

  describe('load - static asset stub', () => {
    it('returns stub for .png files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/logo.png')
      expect(result).toBe('export default { uri: "logo.png", width: 0, height: 0 };')
    })

    it('returns stub for .jpg files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/photo.jpg')
      expect(result).toBe('export default { uri: "photo.jpg", width: 0, height: 0 };')
    })

    it('returns stub for .jpeg files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/image.jpeg')
      expect(result).toBe('export default { uri: "image.jpeg", width: 0, height: 0 };')
    })

    it('returns stub for .gif files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/animation.gif')
      expect(result).toBe('export default { uri: "animation.gif", width: 0, height: 0 };')
    })

    it('returns stub for .svg files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/icon.svg')
      expect(result).toBe('export default { uri: "icon.svg", width: 0, height: 0 };')
    })

    it('returns stub for .ttf font files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/font.ttf')
      expect(result).toBe('export default { uri: "font.ttf", width: 0, height: 0 };')
    })

    it('returns stub for .otf font files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/font.otf')
      expect(result).toBe('export default { uri: "font.otf", width: 0, height: 0 };')
    })

    it('returns stub for .mp4 video files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/video.mp4')
      expect(result).toBe('export default { uri: "video.mp4", width: 0, height: 0 };')
    })

    it('returns stub for .mp3 audio files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/sound.mp3')
      expect(result).toBe('export default { uri: "sound.mp3", width: 0, height: 0 };')
    })

    it('strips query string from filename in stub', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/logo.png?v=1')
      expect(result).toBe('export default { uri: "logo.png", width: 0, height: 0 };')
    })

    it('returns null for .ts files (not an asset)', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/src/App.ts')
      expect(result).toBeNull()
    })

    it('returns null for .tsx files (not an asset)', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/src/App.tsx')
      expect(result).toBeNull()
    })

    it('returns null for .js files (not an asset)', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/src/index.js')
      expect(result).toBeNull()
    })

    it('returns null for .json files (not an asset)', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/package.json')
      expect(result).toBeNull()
    })

    it('correctly JSON-encodes filenames with special characters in stub', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/my "image".png') as string
      expect(result).toContain('"my \\"image\\".png"')
    })

    it('returns stub for .webp files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/image.webp')
      expect(result).toBe('export default { uri: "image.webp", width: 0, height: 0 };')
    })

    it('returns stub for .bmp files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/image.bmp')
      expect(result).toBe('export default { uri: "image.bmp", width: 0, height: 0 };')
    })

    it('returns stub for .wav audio files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/sound.wav')
      expect(result).toBe('export default { uri: "sound.wav", width: 0, height: 0 };')
    })

    it('returns stub for .aac audio files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/sound.aac')
      expect(result).toBe('export default { uri: "sound.aac", width: 0, height: 0 };')
    })

    it('returns stub for .woff font files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/font.woff')
      expect(result).toBe('export default { uri: "font.woff", width: 0, height: 0 };')
    })

    it('returns stub for .woff2 font files', () => {
      const plugin = reactNativePlugin(makeConfig())
      const result = plugin.load!.call({} as any, '/project/assets/font.woff2')
      expect(result).toBe('export default { uri: "font.woff2", width: 0, height: 0 };')
    })
  })
})