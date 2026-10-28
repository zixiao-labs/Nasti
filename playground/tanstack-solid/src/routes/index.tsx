import { createSignal } from 'solid-js'
import { createFileRoute, Link } from '@tanstack/solid-router'
import { createServerFn } from '@tanstack/solid-start'
import { sharedLabel } from '@nasti-toolchain/tanstack-shared'
import { serverValue } from '@nasti-toolchain/tanstack-shared/server'

const readServer = createServerFn({ method: 'GET' }).handler(() => serverValue())
const postServer = createServerFn({ method: 'POST' }).handler(() => 'POST_OK')

export const Route = createFileRoute('/')({
  loader: () => readServer(),
  component: Home,
})

function Home() {
  const [count, setCount] = createSignal(0)
  const [result, setResult] = createSignal('')
  const value = Route.useLoaderData()
  return (
    <main>
      <h1>{sharedLabel}</h1>
      <p id="server-value">{value()}</p>
      <button id="counter" onClick={() => setCount(count() + 1)}>Count {count()}</button>
      <button id="rpc" onClick={async () => setResult(await postServer())}>Run server function</button>
      <p id="rpc-result">{result()}</p>
      <Link to="/about">About</Link>
    </main>
  )
}
