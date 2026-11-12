import type { InputOptions, RolldownLog } from 'rolldown'
import type { ResolvedConfig } from '../types.js'
import { createDebugger } from './debug.js'

const debug = createDebugger('nasti:rolldown')

/** Keep user handlers and fatal escalation, but send their default output through Nasti. */
export function rolldownLogger(
  config: ResolvedConfig,
  options: InputOptions,
): Pick<InputOptions, 'onLog'> {
  return {
    onLog(level, log, defaultHandler) {
      const print = (level: string, value: RolldownLog | string) => {
        const message = typeof value === 'string' ? value
          : [
              value.plugin && `[${value.plugin}]`,
              value.code && `[${value.code}]`,
              value.loc && `${value.loc.file ?? value.id ?? ''}:${value.loc.line}:${value.loc.column}`,
              value.message,
              value.frame,
            ].filter(Boolean).join('\n')
        if (level === 'warn') config.logger.warn(message)
        else if (level === 'debug') debug?.(message)
        else config.logger.info(message)
      }
      const fallback: Parameters<NonNullable<InputOptions['onLog']>>[2] = (level, value) => {
        // Rolldown attaches diagnostic fields and throws, even at logLevel: silent.
        if (level === 'error') return defaultHandler(level, value)
        if (level === 'warn' && options.onwarn) {
          options.onwarn(typeof value === 'string' ? { message: value } : value, (warning) => {
            print('warn', typeof warning === 'function' ? warning() : warning)
          })
        } else {
          print(level, value)
        }
      }
      if (options.onLog) options.onLog(level, log, fallback)
      else fallback(level, log)
    },
  }
}
