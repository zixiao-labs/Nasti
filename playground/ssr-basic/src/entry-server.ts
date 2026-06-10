import { sep } from 'node:path'
import { renderGreeting } from './shared.js'

export async function render(): Promise<string> {
  // node 内建外部化验证 + 共享模块复用
  const marker = sep === '/' ? 'posix' : 'win32'
  return `${renderGreeting('server')}<!--${marker}-->`
}
