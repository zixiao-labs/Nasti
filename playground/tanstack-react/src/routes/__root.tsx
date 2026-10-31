import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import '../style.css'

export const Route = createRootRoute({
  notFoundComponent: () => <p>Not Found</p>,
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
      <body><Outlet /><Scripts /></body>
    </html>
  ),
})
