import { createLazyFileRoute, Link } from '@tanstack/react-router'

export const Route = createLazyFileRoute('/about')({
  component: () => <main><h1>About Nasti</h1><Link to="/">Home</Link></main>,
})
