// Tailwind v4 integration: when a stylesheet contains v4 directives
// (`@import "tailwindcss"`, `@theme`, `@apply`, `@plugin`, `@source`,
// `@utility`, `@variant`, `@custom-variant`, `@reference`, or `@tailwind`),
// we hand the entire CSS to `@tailwindcss/node`'s `compile()` (which
// internally resolves all `@import`s, including bare specifiers like
// `@heroui/styles`) and then scan the project for candidate utilities via
// `@tailwindcss/oxide`. Both packages are resolved from the project's own
// `node_modules` — they are optional peer dependencies of Nasti.
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Matches the documented v4 at-rules. `@import "tailwindcss..."` is enough
// to trigger the full pipeline; the other directives are recognized as a
// safety net for stylesheets that bring their own preflight / utilities
// scaffolding without going through the canonical entry.
const TAILWIND_DIRECTIVE_RE =
  /@(?:import\s+["']tailwindcss(?:\b|\/)|tailwind\b|theme\b|apply\b|plugin\b|source\b|utility\b|variant\b|custom-variant\b|reference\b)/

export function hasTailwindDirectives(css: string): boolean {
  // Strip comments to avoid false positives from commented-out directives
  const withoutBlockComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, '')
  return TAILWIND_DIRECTIVE_RE.test(withoutLineComments)
}

type SourceEntry = { base: string; pattern: string; negated: boolean }

type TailwindModules = {
  node: {
    compile(
      css: string,
      options: { base: string; from: string; onDependency: (p: string) => void },
    ): Promise<{ sources: SourceEntry[]; build(candidates: string[]): string }>
  }
  oxide: {
    Scanner: new (options: { sources?: SourceEntry[] }) => {
      scan(): string[]
      files: string[]
    }
  }
}

let cached: TailwindModules | null = null
let cachedRoot: string | null = null

async function loadTailwind(projectRoot: string): Promise<TailwindModules> {
  if (cached && cachedRoot === projectRoot) return cached
  // createRequire anchored at a *file* under the project root, otherwise
  // Node interprets `projectRoot` as a parent directory and resolution
  // walks outside the project's node_modules.
  const req = createRequire(path.join(projectRoot, 'package.json'))
  let nodePath: string
  let oxidePath: string
  try {
    nodePath = req.resolve('@tailwindcss/node')
    oxidePath = req.resolve('@tailwindcss/oxide')
  } catch {
    throw new Error(
      '[nasti] CSS contains Tailwind v4 directives but `@tailwindcss/node` ' +
        'and/or `@tailwindcss/oxide` are not installed in this project. ' +
        'Install them with:  npm i -D tailwindcss @tailwindcss/node @tailwindcss/oxide',
    )
  }
  const node = (await import(pathToFileURL(nodePath).href)) as TailwindModules['node']
  const oxide = (await import(pathToFileURL(oxidePath).href)) as TailwindModules['oxide']
  cached = { node, oxide }
  cachedRoot = projectRoot
  return cached
}

export type TailwindCompileResult = {
  css: string
  dependencies: string[]
}

export async function compileTailwind(
  css: string,
  fromFile: string,
  projectRoot: string,
): Promise<TailwindCompileResult> {
  const { node, oxide } = await loadTailwind(projectRoot)

  const dependencies: string[] = []
  const compiler = await node.compile(css, {
    base: path.dirname(fromFile),
    from: fromFile,
    onDependency: (p: string) => dependencies.push(p),
  })

  // Tailwind reports the source roots it wants scanned for class candidates
  // (driven by the implicit project root for `@import "tailwindcss"` and by
  // any explicit `@source` directives). We forward them verbatim to the
  // oxide scanner.
  const scanner = new oxide.Scanner({ sources: compiler.sources })
  const candidates = scanner.scan()

  return {
    css: compiler.build(candidates),
    dependencies: [...dependencies, ...scanner.files],
  }
}
