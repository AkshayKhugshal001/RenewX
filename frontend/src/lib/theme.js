// Light / dark / system theme. The choice is kept per device (localStorage); the resolved theme is set as
// <html data-theme="light|dark"> and index.css switches its colour variables on it.
const KEY = 'renewx:theme'
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

export const THEMES = ['light', 'dark', 'system']

export function getThemeChoice() {
  try {
    const v = localStorage.getItem(KEY)
    return THEMES.includes(v) ? v : 'light'
  } catch {
    return 'light'
  }
}

const resolve = (choice) => (choice === 'system' ? (media?.matches ? 'dark' : 'light') : choice)

function apply(choice) {
  document.documentElement.dataset.theme = resolve(choice)
}

export function setThemeChoice(choice) {
  try { localStorage.setItem(KEY, choice) } catch { /* storage blocked – still apply for this visit */ }
  apply(choice)
}

/** Call once before rendering: applies the saved theme and follows the OS when "system" is chosen. */
export function initTheme() {
  apply(getThemeChoice())
  media?.addEventListener?.('change', () => getThemeChoice() === 'system' && apply('system'))
}
