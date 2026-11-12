import { useState } from 'preact/hooks'

export default function Counter() {
  const [count, setCount] = useState(0)
  return <button id="counter" onClick={() => setCount(count + 1)}>Count {count}</button>
}
