/**
 * Solid's granular Refresh compares captured bindings by identity. A new Route
 * object is managed by Router HMR, while RPC callers need stable identities that
 * forward to their newest implementation. Neither should remount a component.
 *
 * Runs after Start's server-body extraction and Solid Refresh's Babel pass.
 */
export function solidStartRefreshBindings({ types: t }: any) {
  return {
    name: 'nasti:solid-start-refresh-bindings',
    visitor: {
      Program: {
        exit(program: any) {
          const rpcImports = new Set<string>()
          const componentImports = new Set<string>()
          const routeFactories = new Set<string>()
          for (const statement of program.node.body) {
            if (!t.isImportDeclaration(statement)) continue
            for (const specifier of statement.specifiers) {
              if (!t.isImportSpecifier(specifier)) continue
              if (statement.source.value === '@tanstack/solid-start/client-rpc' &&
                  specifier.imported.name === 'createClientRpc') rpcImports.add(specifier.local.name)
              if (statement.source.value === 'solid-refresh' &&
                  specifier.imported.name === '$$component') componentImports.add(specifier.local.name)
              if (statement.source.value === '@tanstack/solid-router' &&
                  /^create(?:LazyFile|File|Root)Route/.test(specifier.imported.name)) routeFactories.add(specifier.local.name)
            }
          }
          const routeInit = program.scope.getBinding('Route')?.path.node.init
          const routeCallee = t.isCallExpression(routeInit)
            ? (t.isCallExpression(routeInit.callee) ? routeInit.callee.callee : routeInit.callee) : undefined
          const hasRoute = t.isIdentifier(routeCallee) && routeFactories.has(routeCallee.name)
          const keepRpc = program.scope.generateUidIdentifier('nastiKeepServerFn')
          let usedRpc = false
          program.traverse({
            VariableDeclarator(declaration: any) {
              const init = declaration.node.init
              if (!t.isIdentifier(declaration.node.id) || !t.isCallExpression(init) ||
                  !t.isMemberExpression(init.callee) || init.callee.property.name !== 'handler') return
              const rpc = init.arguments[0]
              if (!t.isCallExpression(rpc) || !t.isIdentifier(rpc.callee) ||
                  !rpcImports.has(rpc.callee.name) || !t.isStringLiteral(rpc.arguments[0])) return
              declaration.node.init = t.callExpression(keepRpc, [
                t.memberExpression(t.metaProperty(t.identifier('import'), t.identifier('meta')), t.identifier('hot')),
                t.stringLiteral(rpc.arguments[0].value),
                init,
              ])
              usedRpc = true
              declaration.skip()
            },
            CallExpression(call: any) {
              if (!t.isIdentifier(call.node.callee) || !componentImports.has(call.node.callee.name)) return
              const options = call.node.arguments[3]
              if (!t.isObjectExpression(options)) return
              for (const option of options.properties) {
                if (!t.isObjectProperty(option) || option.key.name !== 'dependencies' ||
                    !t.isArrowFunctionExpression(option.value) || !t.isObjectExpression(option.value.body)) continue
                // The upstream route HMR handler patches the original live Route.
                // Its replacement export is not a component dependency change.
                if (!hasRoute) continue
                option.value.body.properties = option.value.body.properties.filter(
                  (property: any) => !(t.isObjectProperty(property) && property.key.name === 'Route'),
                )
              }
            },
          })
          if (usedRpc) program.unshiftContainer('body', t.importDeclaration([
            t.importSpecifier(keepRpc, t.identifier('keepServerFn')),
          ], t.stringLiteral('nasti:start-refresh')))
        },
      },
    },
  }
}

export const START_REFRESH_RUNTIME = `
export function keepServerFn(hot, id, next) {
  if (!hot) return next;
  const key = 'nasti:start:rpc:' + id;
  let record = hot.data[key];
  if (!record) {
    record = hot.data[key] = { current: next };
    record.proxy = new Proxy(next, {
      apply(_target, receiver, args) { return Reflect.apply(record.current, receiver, args); },
      get(_target, property) { return Reflect.get(record.current, property); },
    });
  }
  record.current = next;
  return record.proxy;
}
`
