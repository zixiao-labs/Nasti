// Logger - 真正的日志系统（仿 Vite node/logger.ts）
// 接线 config.logLevel，统一 dev/build 输出面
import readline from 'node:readline'
import pc from 'picocolors'

export type LogType = 'error' | 'warn' | 'info'
export type LogLevel = LogType | 'silent'

export interface LogOptions {
  /** 是否清屏（仅 allowClearScreen 且 TTY 下生效） */
  clear?: boolean
  /** 是否带 HH:mm:ss 时间戳前缀 */
  timestamp?: boolean
  /** 关联的 Error（用于 hasErrorLogged 去重） */
  error?: Error | null
}

export interface Logger {
  info(msg: string, options?: LogOptions): void
  warn(msg: string, options?: LogOptions): void
  /** 同一条 warn 整个进程只输出一次 */
  warnOnce(msg: string, options?: LogOptions): void
  error(msg: string, options?: LogOptions): void
  clearScreen(type: LogType): void
  /** 该 Error 是否已经走 logger.error 输出过（避免 CLI 兜底重复打印） */
  hasErrorLogged(error: Error): boolean
  hasWarned: boolean
}

export interface LoggerOptions {
  prefix?: string
  allowClearScreen?: boolean
  customLogger?: Logger
  console?: Console
}

export const LogLevels: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
}

let lastType: LogType | undefined
let lastMsg: string | undefined
let sameCount = 0

function getTimeFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
}

export function createLogger(
  level: LogLevel = 'info',
  options: LoggerOptions = {},
): Logger {
  if (options.customLogger) {
    return options.customLogger
  }

  const timeFormatter = getTimeFormatter()
  const loggedErrors = new WeakSet<Error>()
  const { prefix = '[nasti]', allowClearScreen = true, console: console_ = console } = options
  const thresh = LogLevels[level]
  const canClearScreen =
    allowClearScreen && process.stdout.isTTY && !process.env.CI
  const clear = canClearScreen ? clearScreen : () => {}

  function format(type: LogType, msg: string, options: LogOptions = {}): string {
    if (options.timestamp) {
      const tag =
        type === 'info'
          ? pc.cyan(pc.bold(prefix))
          : type === 'warn'
            ? pc.yellow(pc.bold(prefix))
            : pc.red(pc.bold(prefix))
      return `${pc.dim(timeFormatter.format(new Date()))} ${tag} ${msg}`
    }
    return msg
  }

  function output(type: LogType, msg: string, options: LogOptions = {}): void {
    if (thresh < LogLevels[type]) return
    const method = type === 'info' ? 'log' : type

    if (options.error) {
      loggedErrors.add(options.error)
    }
    if (canClearScreen) {
      // 同消息折叠为 (xN)
      if (type === lastType && msg === lastMsg) {
        sameCount++
        clear()
        console_[method](format(type, msg, options), pc.yellow(`(x${sameCount + 1})`))
      } else {
        sameCount = 0
        lastMsg = msg
        lastType = type
        if (options.clear) clear()
        console_[method](format(type, msg, options))
      }
    } else {
      console_[method](format(type, msg, options))
    }
  }

  const warnedMessages = new Set<string>()

  const logger: Logger = {
    hasWarned: false,
    info(msg, opts) {
      output('info', msg, opts)
    },
    warn(msg, opts) {
      logger.hasWarned = true
      output('warn', msg, opts)
    },
    warnOnce(msg, opts) {
      if (warnedMessages.has(msg)) return
      logger.hasWarned = true
      output('warn', msg, opts)
      warnedMessages.add(msg)
    },
    error(msg, opts) {
      output('error', msg, opts)
    },
    clearScreen(type) {
      if (thresh >= LogLevels[type]) clear()
    },
    hasErrorLogged(error) {
      return loggedErrors.has(error)
    },
  }

  return logger
}

function clearScreen(): void {
  const repeatCount = process.stdout.rows - 2
  const blank = repeatCount > 0 ? '\n'.repeat(repeatCount) : ''
  console.log(blank)
  readline.cursorTo(process.stdout, 0, 0)
  readline.clearScreenDown(process.stdout)
}

export interface ServerUrls {
  local: string[]
  network: string[]
}

/** 打印 dev server 地址：➜ Local / Network，端口加粗 */
export function printServerUrls(
  urls: ServerUrls,
  info: Logger['info'],
): void {
  const colorUrl = (url: string) =>
    pc.cyan(url.replace(/:(\d+)\//, (_, port) => `:${pc.bold(port)}/`))
  for (const url of urls.local) {
    info(`  ${pc.green('➜')}  ${pc.bold('Local')}:   ${colorUrl(url)}`)
  }
  for (const url of urls.network) {
    info(`  ${pc.green('➜')}  ${pc.bold('Network')}: ${colorUrl(url)}`)
  }
  if (urls.network.length === 0) {
    info(
      pc.dim(`  ${pc.green('➜')}  ${pc.bold('Network')}: use `) +
        pc.bold('--host') +
        pc.dim(' to expose'),
    )
  }
}
