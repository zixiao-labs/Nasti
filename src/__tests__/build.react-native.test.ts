import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'

// Use vi.hoisted to define mocks accessible in vi.mock factories
const { mockBundleWrite, mockBundleClose, mockRolldown } = vi.hoisted(() => {
  const mockBundleWrite = vi.fn().mockResolvedValue(undefined)
  const mockBundleClose = vi.fn().mockResolvedValue(undefined)
  const mockRolldown = vi.fn().mockResolvedValue({
    write: mockBundleWrite,
    close: mockBundleClose,
  })
  return { mockBundleWrite, mockBundleClose, mockRolldown }
})

vi.mock('rolldown', () => ({
  rolldown: mockRolldown,
}))

vi.mock('../core/transformer.js', () => ({
  transformCode: vi.fn().mockReturnValue({ code: '', map: null }),
  shouldTransform: vi.fn().mockReturnValue(false),
}))

vi.mock('../core/env.js', () => ({
  loadEnv: vi.fn().mockReturnValue({}),
  buildEnvDefine: vi.fn().mockReturnValue({}),
}))

vi.mock('../plugins/resolve.js', () => ({
  resolvePlugin: vi.fn().mockReturnValue({ name: 'nasti:resolve' }),
}))

vi.mock('picocolors', () => ({
  default: {
    cyan: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
  },
}))

vi.mock('../config/index.js', () => ({
  resolveConfig: vi.fn(),
  defineConfig: (c: any) => c,
}))

vi.mock('../plugins/react-native.js', () => ({
  reactNativePlugin: vi.fn().mockReturnValue({ name: 'nasti:react-native' }),
}))

import { buildReactNative } from '../build/react-native.js'
import { resolveConfig } from '../config/index.js'

function makeResolvedConfig(overrides: Record<string, any> = {}) {
  return {
    root: '/project',
    mode: 'production',
    target: 'react-native',
    reactNative: {
      platform: 'android',
      entry: 'index.ts',
      external: [],
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      minify: true,
      emptyOutDir: false,
      rolldownOptions: {},
    },
    envPrefix: ['NASTI_'],
    plugins: [],
    ...overrides,
  }
}

describe('buildReactNative', () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>
  let rmSyncSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(resolveConfig).mockResolvedValue(makeResolvedConfig() as any)
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any)
    rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined)
    mockBundleWrite.mockReset().mockResolvedValue(undefined)
    mockBundleClose.mockReset().mockResolvedValue(undefined)
    mockRolldown.mockReset().mockResolvedValue({
      write: mockBundleWrite,
      close: mockBundleClose,
    })
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
    mkdirSyncSpy.mockRestore()
    rmSyncSpy.mockRestore()
    vi.clearAllMocks()
  })

  describe('entry file resolution', () => {
    it('throws when no entry file can be found', async () => {
      existsSyncSpy.mockReturnValue(false)

      await expect(buildReactNative({ root: '/project' })).rejects.toThrow(
        'React Native 入口文件未找到',
      )
    })

    it('throws with informative message mentioning nasti.config.ts when no entry found', async () => {
      existsSyncSpy.mockReturnValue(false)

      await expect(buildReactNative({ root: '/project' })).rejects.toThrow(
        'nasti.config.ts',
      )
    })

    it('uses configured entry if it exists', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'my-entry.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'my-entry.ts')
      })

      await buildReactNative({ root: '/project' })

      expect(mockRolldown).toHaveBeenCalledOnce()
      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'my-entry.ts'))
    })

    it('falls back to index.ts when configured entry does not exist', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'nonexistent.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'index.ts')
      })

      await buildReactNative({ root: '/project' })

      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'index.ts'))
    })

    it('falls back to index.tsx when index.ts does not exist', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'nonexistent.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'index.tsx')
      })

      await buildReactNative({ root: '/project' })

      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'index.tsx'))
    })

    it('falls back to index.js when neither index.ts nor index.tsx exist', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'nonexistent.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'index.js')
      })

      await buildReactNative({ root: '/project' })

      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'index.js'))
    })

    it('falls back to src/index.ts', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'nonexistent.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'src/index.ts')
      })

      await buildReactNative({ root: '/project' })

      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'src/index.ts'))
    })

    it('falls back to src/index.tsx', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'nonexistent.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'src/index.tsx')
      })

      await buildReactNative({ root: '/project' })

      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'src/index.tsx'))
    })

    it('falls back to src/index.js as last resort', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'android', entry: 'nonexistent.ts', external: [] },
        }) as any,
      )
      existsSyncSpy.mockImplementation((p: any) => {
        return String(p) === path.resolve('/project', 'src/index.js')
      })

      await buildReactNative({ root: '/project' })

      const callArg = mockRolldown.mock.calls[0][0]
      expect(callArg.input).toBe(path.resolve('/project', 'src/index.js'))
    })
  })

  describe('bundle output', () => {
    beforeEach(() => {
      // Make all entry file checks return true so the build proceeds
      existsSyncSpy.mockImplementation((p: any) => String(p).endsWith('index.ts'))
    })

    it('writes android.bundle for android platform', async () => {
      await buildReactNative({})

      expect(mockBundleWrite).toHaveBeenCalledOnce()
      const writeArg = mockBundleWrite.mock.calls[0][0]
      expect(writeArg.entryFileNames).toBe('android.bundle')
    })

    it('writes ios.bundle for ios platform', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          reactNative: { platform: 'ios', entry: 'index.ts', external: [] },
        }) as any,
      )

      await buildReactNative({ reactNative: { platform: 'ios' } })

      const writeArg = mockBundleWrite.mock.calls[0][0]
      expect(writeArg.entryFileNames).toBe('ios.bundle')
    })

    it('writes bundle as CJS format', async () => {
      await buildReactNative({})

      const writeArg = mockBundleWrite.mock.calls[0][0]
      expect(writeArg.format).toBe('cjs')
    })

    it('outputs to configured outDir', async () => {
      await buildReactNative({})

      const writeArg = mockBundleWrite.mock.calls[0][0]
      expect(writeArg.dir).toBe(path.resolve('/project', 'dist'))
    })

    it('closes the bundle after writing', async () => {
      await buildReactNative({})

      expect(mockBundleClose).toHaveBeenCalledOnce()
    })

    it('creates output directory', async () => {
      await buildReactNative({})

      expect(mkdirSyncSpy).toHaveBeenCalledWith(
        path.resolve('/project', 'dist'),
        { recursive: true },
      )
    })
  })

  describe('__DEV__ define flag', () => {
    beforeEach(() => {
      existsSyncSpy.mockImplementation((p: any) => String(p).endsWith('index.ts'))
    })

    it('sets __DEV__ to false in production mode', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({ mode: 'production' }) as any,
      )

      await buildReactNative({})

      const rolldownArg = mockRolldown.mock.calls[0][0]
      expect(rolldownArg.define.__DEV__).toBe('false')
    })

    it('sets __DEV__ to true in development mode', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({ mode: 'development' }) as any,
      )

      await buildReactNative({ mode: 'development' })

      const rolldownArg = mockRolldown.mock.calls[0][0]
      expect(rolldownArg.define.__DEV__).toBe('true')
    })
  })

  describe('outDir cleanup', () => {
    beforeEach(() => {
      // Both entry and outDir exist
      existsSyncSpy.mockReturnValue(true)
    })

    it('removes outDir when emptyOutDir is true', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          build: { outDir: 'dist', sourcemap: false, minify: true, emptyOutDir: true, rolldownOptions: {} },
        }) as any,
      )

      await buildReactNative({})

      expect(rmSyncSpy).toHaveBeenCalledWith(
        path.resolve('/project', 'dist'),
        { recursive: true, force: true },
      )
    })

    it('does not remove outDir when emptyOutDir is false', async () => {
      vi.mocked(resolveConfig).mockResolvedValue(
        makeResolvedConfig({
          build: { outDir: 'dist', sourcemap: false, minify: true, emptyOutDir: false, rolldownOptions: {} },
        }) as any,
      )

      await buildReactNative({})

      expect(rmSyncSpy).not.toHaveBeenCalled()
    })
  })

  describe('resolveConfig call', () => {
    beforeEach(() => {
      existsSyncSpy.mockImplementation((p: any) => String(p).endsWith('index.ts'))
    })

    it('calls resolveConfig with target: react-native', async () => {
      await buildReactNative({ root: '/project' })

      expect(resolveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ target: 'react-native' }),
        'build',
      )
    })

    it('passes inline config merged to resolveConfig', async () => {
      await buildReactNative({ root: '/custom', mode: 'development' })

      expect(resolveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ root: '/custom', mode: 'development', target: 'react-native' }),
        'build',
      )
    })
  })
})