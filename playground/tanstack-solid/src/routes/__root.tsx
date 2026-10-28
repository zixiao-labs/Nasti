import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/solid-router'
import { HydrationScript } from 'solid-js/web'
import '../style.css'

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head><HydrationScript /><HeadContent /></head>
      <body><Outlet /><Scripts /></body>
    </html>
  ),
})
