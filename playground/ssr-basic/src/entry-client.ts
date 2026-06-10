import { renderGreeting } from './shared.js'

const app = document.getElementById('app')!
app.innerHTML = renderGreeting('client')
