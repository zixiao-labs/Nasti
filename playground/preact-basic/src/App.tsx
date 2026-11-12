import { useState } from 'preact/hooks'

export function App() {
  const [count, setCount] = useState(0)
  return <main>
    <h1>Nasti + Preact</h1>
    <button id="counter" onClick={() => setCount(count + 1)}>Count {count}</button>
  </main>
}
