export default {
  target: 'electron',
  framework: 'auto',
  electron: {
    main: 'src/electron/main.ts',
    preload: 'src/electron/preload.ts',
    renderer: 'src/renderer/index.html',
  },
}
