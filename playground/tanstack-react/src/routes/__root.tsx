import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import '../style.css'

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
      <body><Outlet /><Scripts /></body>
    </html>
  ),
})
