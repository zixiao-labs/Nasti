/** 保留语义 query，仅移除浏览器为 HMR 缓存失效附加的 `t` 参数。 */
export function removeTimestampQuery(url: string): string {
  const hashIndex = url.indexOf('#')
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const queryIndex = withoutHash.indexOf('?')
  if (queryIndex < 0) return url

  const pathname = withoutHash.slice(0, queryIndex)
  const query = withoutHash
    .slice(queryIndex + 1)
    .split('&')
    .filter((part) => !/^t=\d+$/.test(part))
    .join('&')
  return pathname + (query ? `?${query}` : '') + hash
}
