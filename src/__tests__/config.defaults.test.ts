import { describe, it, expect } from 'vitest'
import { defaults } from '../config/defaults.js'

describe('config/defaults - ReactNative defaults', () => {
  it('includes reactNative in the defaults object', () => {
    expect(defaults).toHaveProperty('reactNative')
  })

  it('sets default platform to android', () => {
    expect(defaults.reactNative.platform).toBe('android')
  })

  it('sets default entry to index.ts', () => {
    expect(defaults.reactNative.entry).toBe('index.ts')
  })

  it('sets default external to an empty array', () => {
    expect(defaults.reactNative.external).toEqual([])
    expect(Array.isArray(defaults.reactNative.external)).toBe(true)
  })

  it('reactNative object has all required fields', () => {
    const { reactNative } = defaults
    expect(reactNative).toHaveProperty('platform')
    expect(reactNative).toHaveProperty('entry')
    expect(reactNative).toHaveProperty('external')
  })

  it('target defaults to web (not react-native)', () => {
    expect(defaults.target).toBe('web')
  })

  it('all top-level defaults remain intact alongside new reactNative field', () => {
    expect(defaults.root).toBe('.')
    expect(defaults.base).toBe('/')
    expect(defaults.mode).toBe('development')
    expect(defaults.logLevel).toBe('info')
    expect(defaults.plugins).toEqual([])
  })
})