// Light and dark for the board. The panel around it (bars, buttons, bubbles)
// always follows Deska through its tokens; this is only about the board: the
// paper and its frame, the colors being drawn with and the ones suggested. The
// choice is Auto (the board follows Deska's mode), Claro or Oscuro.
//
// Colors stay what the person chose in the document. Only what is shown is
// adapted: near-neutral inks swap their lightness (black ink looks white on the
// dark paper and back), and the rest are lifted a little so they hold up on
// dark. Switching the board's theme never changes what is saved.

export const SURFACES = Object.freeze({
  light: { frame: '#202226', paper: '#fbfaf6', dot: '#b9b6ab', line: '#dedbd0', select: '#0b7bff', ink: '#1b1b1f', muted: '#62616a' },
  dark: { frame: '#0c0c0e', paper: '#121214', dot: '#474850', line: '#2a2b31', select: '#aaa2ff', ink: '#e4e4ea', muted: '#a4a4ae' },
})

// The palette's first ink, the one new drawings start with. It is shown in the
// board's own text color, so on Auto it is exactly Deska's text color.
export const DEFAULT_INK = '#1b1b1f'
let ink = { light: SURFACES.light.ink, dark: SURFACES.dark.ink }

export const THEME_CHOICES = Object.freeze(['auto', 'light', 'dark'])

/** The mode in effect: the person's choice, or Deska's when it is Auto. */
export function effectiveMode(choice, hostMode) {
  return choice === 'light' || choice === 'dark' ? choice : hostMode === 'light' ? 'light' : 'dark'
}

/** The board's surfaces. On Auto the board is part of Deska, like Chess: the
 *  paper is Deska's background, the default ink and quiet labels its text
 *  colors and the selection its accent, with the frame, dots and lines mixed
 *  from them. `token(name)` reads a Deska token; any
 *  token that is missing or not a plain color keeps the built-in value. */
export function boardSurfaces(choice, mode, token) {
  const base = SURFACES[mode]
  if (choice !== 'auto' || typeof token !== 'function') return base
  const bg = parseColor(token('--deska-bg'))
  const text = parseColor(token('--deska-text'))
  const accent = parseColor(token('--deska-accent'))
  const secondary = parseColor(token('--deska-text-secondary'))
  if (!bg) return base
  const shade = mode === 'dark' ? [0, 0, 0] : [32, 34, 38]
  return Object.freeze({
    paper: toHex(bg),
    frame: toHex(mix(bg, shade, mode === 'dark' ? 0.45 : 0.85)),
    dot: text ? toHex(mix(bg, text, 0.28)) : base.dot,
    line: text ? toHex(mix(bg, text, 0.12)) : base.line,
    select: accent ? toHex(accent) : base.select,
    ink: text ? toHex(text) : base.ink,
    muted: secondary ? toHex(secondary) : base.muted,
  })
}

/** Puts the board's paper and frame on the page and returns the mode and
 *  surfaces in effect. Deska's own tokens are left exactly as the SDK wrote them. */
export function applyTheme(choice, host) {
  const mode = effectiveMode(choice, host && host.mode === 'light' ? 'light' : 'dark')
  const root = document.documentElement
  root.dataset.boardMode = mode
  const css = getComputedStyle(root)
  const surfaces = boardSurfaces(choice, mode, (name) => css.getPropertyValue(name).trim())
  root.style.setProperty('--paper', surfaces.paper)
  root.style.setProperty('--frame', surfaces.frame)
  root.style.setProperty('--canvas-muted', surfaces.muted)
  setInk(mode, surfaces.ink)
  // The controls use Deska's accent; this is only the fallback without tokens.
  if (surfaces === SURFACES[mode]) root.style.removeProperty('--board-select')
  else root.style.setProperty('--board-select', surfaces.select)
  return { mode, surfaces }
}

/** [r, g, b] from #rgb, #rrggbb or rgb()/rgba(); null for anything else. */
export function parseColor(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
    const n = parseInt(hex, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(v)
  if (!m) return null
  const rgb = m.slice(1, 4).map(Number)
  return rgb.every((c) => c <= 255) ? rgb : null
}

const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t))
const toHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`

// Colors ---------------------------------------------------------------------------------

function toHsl(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [(h * 60 + 360) % 360, s, l]
}

function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

const memo = new Map()

/** The color the default ink is shown in for `mode`. */
function setInk(mode, color) {
  if (ink[mode] === color) return
  ink = { ...ink, [mode]: color }
  memo.clear()
}

/** How a stored color is shown in `mode`. The default ink takes the board's
 *  text color; otherwise light shows a color as it is. */
export function adaptColor(hex, mode) {
  if (typeof hex === 'string' && hex.toLowerCase() === DEFAULT_INK) return ink[mode === 'dark' ? 'dark' : 'light']
  if (mode !== 'dark' || typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  const known = memo.get(hex)
  if (known) return known
  const [h, s, l] = toHsl(hex)
  // Neutral inks swap lightness (near-black becomes near-white); colored ones are lifted.
  const shown = s < 0.18 ? fromHsl(h, s, Math.min(0.94, Math.max(0.1, 1 - l))) : fromHsl(h, s, l + (1 - l) * 0.16)
  memo.set(hex, shown)
  return shown
}
