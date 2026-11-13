import { useState } from 'preact/hooks'

export function App() {
  const [count, setCount] = useState<number>(0)
  return (
    <main>
      <h1>Nasti + Preact</h1>
      <button onClick={() => setCount(count + 1)}>Count: {count}</button>
      <p>Edit App.tsx to test Prefresh.</p>
    </main>
  )
}
