import './style.css'

const app = document.getElementById('app')!
app.innerHTML = `<h1 class="title">Nasti basic playground</h1><button id="lazy-btn">load lazy</button>`

document.getElementById('lazy-btn')!.addEventListener('click', async () => {
  const { renderLazy } = await import('./lazy.js')
  renderLazy(app)
})

console.log('mode:', import.meta.env.MODE, 'dev:', import.meta.env.DEV)
