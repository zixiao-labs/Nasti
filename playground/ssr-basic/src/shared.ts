import './theme.css'

export interface Greeting {
  side: string
  ssr: boolean
}

export function renderGreeting(side: string): string {
  const data: Greeting = { side, ssr: import.meta.env.SSR }
  return `<h1 class="hello">hello from ${data.side} (SSR=${data.ssr})</h1>`
}
