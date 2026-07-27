import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(currentDir, 'preload.cjs'),
    },
  })

  if (typeof __NASTI_DEV_SERVER_URL__ !== 'undefined') {
    await window.loadURL(__NASTI_DEV_SERVER_URL__)
  } else {
    await window.loadFile(path.join(currentDir, 'renderer/index.html'))
  }
}

void app.whenReady().then(createWindow).catch((error: unknown) => {
  console.error('[nasti] failed to start Electron application', error)
  app.exit(1)
})
