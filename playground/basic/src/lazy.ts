import './lazy.css'

export function renderLazy(root: HTMLElement): void {
  const div = document.createElement('div')
  div.className = 'lazy-box'
  div.textContent = 'lazy chunk loaded'
  root.appendChild(div)
}
