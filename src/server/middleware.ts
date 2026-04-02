// HTTP 中间件 - 请求拦截与按需转译
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from '../types.js'
import { PluginContainer } from '../core/plugin-container.js'
import { ModuleGraph } from '../core/module-graph.js'
import { transformCode, shouldTransform, getModuleType } from '../core/transformer.js'
import { readHtmlFile, processHtml } from '../plugins/html.js'
import { loadEnv, buildEnvDefine, replaceEnvInCode } from '../core/env.js'

export interface TransformMiddlewareContext {
  config: ResolvedConfig
  pluginContainer: PluginContainer
  moduleGraph: ModuleGraph
}

/** 主转译中间件 - 处理模块请求 */
export function transformMiddleware(ctx: TransformMiddlewareContext) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '/'

    // 跳过非 GET 请求
    if (req.method !== 'GET') return next()

    // 处理 HMR 客户端请求
    if (url === '/@nasti/client') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(getHmrClientCode())
      return
    }

    // 处理 HTML 请求
    if (url === '/' || url.endsWith('.html')) {
      const html = await readHtmlFile(ctx.config.root)
      if (html) {
        let processedHtml = html

        // 执行 transformIndexHtml 钩子
        for (const plugin of ctx.config.plugins) {
          if (plugin.transformIndexHtml) {
            const result = await plugin.transformIndexHtml(processedHtml)
            if (typeof result === 'string') {
              processedHtml = result
            } else if (result && 'html' in result) {
              processedHtml = processHtml(result.html, result.tags)
            } else if (Array.isArray(result)) {
              processedHtml = processHtml(processedHtml, result)
            }
          }
        }

        // 注入 HMR 客户端（仅当 hmr 未被禁用时）
        if (ctx.config.server.hmr !== false) {
          processedHtml = processedHtml.replace(
            '<head>',
            '<head>\n  <script type="module" src="/@nasti/client"></script>',
          )
        }

        res.setHeader('Content-Type', 'text/html')
        res.end(processedHtml)
        return
      }
    }

    // 处理模块请求（.ts, .tsx, .jsx, .vue, .css 等）
    if (isModuleRequest(url)) {
      try {
        const result = await transformRequest(url, ctx)
        if (result) {
          const contentType = url.endsWith('.css')
            ? 'application/javascript' // CSS 已转为 JS 模块
            : 'application/javascript'
          res.setHeader('Content-Type', contentType)
          res.setHeader('Cache-Control', 'no-cache')
          res.end(typeof result === 'string' ? result : result.code)
          return
        }
      } catch (err: any) {
        console.error(`[nasti] Transform error: ${url}`, err.message)
        res.statusCode = 500
        res.end(`Transform error: ${err.message}`)
        return
      }
    }

    next()
  }
}

/** 转译单个模块 */
export async function transformRequest(
  url: string,
  ctx: TransformMiddlewareContext,
): Promise<{ code: string; map?: unknown } | null> {
  const { config, pluginContainer, moduleGraph } = ctx

  // 检查缓存
  const cached = moduleGraph.getModuleByUrl(url)
  if (cached?.transformResult) {
    return cached.transformResult as { code: string; map?: unknown }
  }

  // 解析文件路径
  const filePath = resolveUrlToFile(url, config.root)
  if (!filePath || !fs.existsSync(filePath)) return null

  // 创建/获取模块节点
  const mod = await moduleGraph.ensureEntryFromUrl(url)
  moduleGraph.registerModule(mod, filePath)

  // 读取源码
  let code = fs.readFileSync(filePath, 'utf-8')

  // 通过插件管道 transform
  const pluginResult = await pluginContainer.transform(code, filePath)
  if (pluginResult) {
    code = typeof pluginResult === 'string' ? pluginResult : pluginResult.code
  }

  // OXC 转译 (TS/JSX/TSX)
  if (shouldTransform(filePath)) {
    const result = transformCode(filePath, code, {
      sourcemap: true,
      jsxRuntime: 'automatic',
      jsxImportSource: config.framework === 'vue' ? 'vue' : 'react',
      reactRefresh: config.framework !== 'vue',
    })
    code = result.code
  }

  // 替换 import.meta.env.* 为实际值
  const env = loadEnv(config.mode, config.root, config.envPrefix)
  const envDefine = buildEnvDefine(env, config.mode)
  code = replaceEnvInCode(code, envDefine)

  // 重写 bare imports 为浏览器可用路径
  code = rewriteImports(code, config)

  const transformResult = { code }
  mod.transformResult = transformResult
  return transformResult
}

/** 重写 import/export 语句中的 bare specifier */
function rewriteImports(code: string, _config: ResolvedConfig): string {
  // 处理所有 from '...' 形式（import ... from、export ... from、export * from）
  return code.replace(
    /\bfrom\s+(['"])([^'"./][^'"]*)\1/g,
    (match, quote: string, specifier: string) => {
      return `from ${quote}/@modules/${specifier}${quote}`
    },
  ).replace(
    // 处理纯副作用导入: import 'bare-specifier'
    /\bimport\s+(['"])([^'"./][^'"]*)\1/g,
    (match, quote: string, specifier: string) => {
      return `import ${quote}/@modules/${specifier}${quote}`
    },
  ).replace(
    // 处理动态导入: import('bare-specifier')
    /\bimport\s*\(\s*(['"])([^'"./][^'"]*)\1\s*\)/g,
    (match, quote: string, specifier: string) => {
      return `import(${quote}/@modules/${specifier}${quote})`
    },
  )
}

function resolveUrlToFile(url: string, root: string): string | null {
  // 去除查询参数
  const cleanUrl = url.split('?')[0]

  // /@modules/ 前缀 → node_modules 预构建
  if (cleanUrl.startsWith('/@modules/')) {
    const moduleName = cleanUrl.slice('/@modules/'.length)
    try {
      const req = createRequire(path.resolve(root, 'package.json'))
      return req.resolve(moduleName)
    } catch {
      return null
    }
  }

  // 普通路径
  return path.resolve(root, cleanUrl.replace(/^\//, ''))
}

function isModuleRequest(url: string): boolean {
  const cleanUrl = url.split('?')[0]
  return /\.(ts|tsx|jsx|js|mjs|vue|css|json)$/.test(cleanUrl) ||
    cleanUrl.startsWith('/@modules/')
}

function getHmrClientCode(): string {
  return `
// Nasti HMR Client
const socket = new WebSocket(\`ws://\${location.host}\`, 'nasti-hmr');
const hotModulesMap = new Map();

socket.addEventListener('message', ({ data }) => {
  const payload = JSON.parse(data);
  switch (payload.type) {
    case 'connected':
      console.log('[nasti] connected.');
      break;
    case 'update':
      payload.updates.forEach((update) => {
        if (update.type === 'js-update') {
          fetchUpdate(update);
        } else if (update.type === 'css-update') {
          updateCss(update.path);
        }
      });
      break;
    case 'full-reload':
      console.log('[nasti] full reload');
      location.reload();
      break;
    case 'error':
      console.error('[nasti] error:', payload.err.message);
      showErrorOverlay(payload.err);
      break;
  }
});

async function fetchUpdate(update) {
  const mod = hotModulesMap.get(update.path);
  if (mod) {
    const newMod = await import(update.acceptedPath + '?t=' + update.timestamp);
    mod.callbacks.forEach((cb) => cb(newMod));
  } else {
    // 没有注册 hot 回调，尝试重新 import
    await import(update.path + '?t=' + update.timestamp);
  }
}

function updateCss(path) {
  const el = document.querySelector(\`style[data-nasti-css="\${path}"]\`);
  if (el) {
    fetch(path + '?t=' + Date.now())
      .then(r => r.text())
      .then(css => { el.textContent = css; });
  }
}

function showErrorOverlay(err) {
  const overlay = document.createElement('div');
  overlay.id = 'nasti-error-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);color:#fff;font-family:monospace;padding:2rem;overflow:auto;';
  const title = document.createElement('h2');
  title.style.color = '#ff5555';
  title.textContent = 'Build Error';
  const pre = document.createElement('pre');
  pre.textContent = err.message + '\\n' + (err.stack || '');
  const btn = document.createElement('button');
  btn.style.cssText = 'margin-top:1rem;padding:0.5rem 1rem;cursor:pointer';
  btn.textContent = 'Close';
  btn.onclick = () => overlay.remove();
  overlay.appendChild(title);
  overlay.appendChild(pre);
  overlay.appendChild(btn);
  document.body.appendChild(overlay);
}

// import.meta.hot API
const createHotContext = (ownerPath) => ({
  accept(deps, callback) {
    if (typeof deps === 'function' || !deps) {
      // self-accepting
      const callbacks = hotModulesMap.get(ownerPath)?.callbacks || [];
      callbacks.push(deps || (() => {}));
      hotModulesMap.set(ownerPath, { callbacks });
    }
  },
  prune(callback) {
    // 模块被移除时执行
  },
  dispose(callback) {
    // 模块更新前执行清理
  },
  invalidate() {
    location.reload();
  },
  data: {},
});

// 暴露给模块使用
if (!window.__nasti_hot_map) window.__nasti_hot_map = new Map();
window.__NASTI_HMR__ = { createHotContext };
`
}
