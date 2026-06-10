// 环境变量加载 - 读取 .env 文件并生成 import.meta.env 定义
import path from 'node:path'
import fs from 'node:fs'

export interface EnvRecord {
  [key: string]: string
}

/**
 * 从 .env 文件加载环境变量，按优先级合并：
 *   .env < .env.[mode] < .env.local < .env.[mode].local
 */
export function loadEnv(mode: string, root: string, prefixes: string[]): EnvRecord {
  const envFiles = [
    '.env',
    `.env.${mode}`,
    '.env.local',
    `.env.${mode}.local`,
  ]

  const raw: EnvRecord = {}

  for (const file of envFiles) {
    const filePath = path.resolve(root, file)
    if (!fs.existsSync(filePath)) continue
    const content = fs.readFileSync(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      // 去除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      raw[key] = value
    }
  }

  // 只保留符合 prefix 的变量
  const filtered: EnvRecord = {}
  for (const [key, value] of Object.entries(raw)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      filtered[key] = value
    }
  }

  return filtered
}

/**
 * 将过滤后的 env 转为 Rolldown define 对象
 * 例: { VITE_FOO: 'bar' } → { 'import.meta.env.VITE_FOO': '"bar"' }
 * 同时注入 import.meta.env.MODE / DEV / PROD / SSR
 *
 * per-env define 钩子（Phase1→Phase2 接口契约）：`overrides` 允许调用方按
 * 环境覆盖任意 define —— server 环境传 `ssrDefineOverrides('server')` 注入
 * `import.meta.env.SSR='true'`，不再写死 'false'。
 */
export function buildEnvDefine(
  env: EnvRecord,
  mode: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const define: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    define[`import.meta.env.${key}`] = JSON.stringify(value)
  }

  define['import.meta.env.MODE'] = JSON.stringify(mode)
  define['import.meta.env.DEV'] = mode !== 'production' ? 'true' : 'false'
  define['import.meta.env.PROD'] = mode === 'production' ? 'true' : 'false'
  define['import.meta.env.SSR'] = 'false'

  return { ...define, ...overrides }
}

/** 按环境 consumer 派生 import.meta.env.SSR 的 define 覆盖 */
export function ssrDefineOverrides(consumer: 'client' | 'server'): Record<string, string> {
  return { 'import.meta.env.SSR': consumer === 'server' ? 'true' : 'false' }
}

/**
 * 在代码字符串中替换 import.meta.env.KEY（用于 dev 服务器按需转换）
 */
export function replaceEnvInCode(code: string, define: Record<string, string>): string {
  let result = code
  for (const [key, value] of Object.entries(define)) {
    // 转义正则特殊字符
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(escaped, 'g'), value)
  }
  return result
}
