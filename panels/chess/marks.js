// Board palettes and the analysis marks a person draws with the right button: arrows and square
// highlights. Pure functions, so the page and the tests share them. Marks are never saved or sent.

export const PALETTES = {
  ocean: { light: '#dce5e8', dark: '#537d91' },
  walnut: { light: '#eed9b7', dark: '#926d50' },
  slate: { light: '#d9dce0', dark: '#69727e' },
}

const byte = (n) => Math.max(0, Math.min(255, Math.round(n)))
const hex2 = (n) => byte(n).toString(16).padStart(2, '0')

/**
 * Any opaque-or-not color Deska or the browser can hand over, as '#rrggbb' (alpha is dropped), or null.
 * Deska resolves its theme colors to `rgb(r, g, b)` before sending them, so hex alone is not enough:
 * accepts #rgb, #rrggbb, #rrggbbaa and rgb()/rgba() in the comma, space and slash forms, with percentages.
 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  let m = /^#([\da-f]{3,8})$/i.exec(text)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    return h.length === 6 || h.length === 8 ? `#${h.slice(0, 6).toLowerCase()}` : null
  }
  m = /^rgba?\(\s*([+-]?[\d.]+%?)\s*[,\s]\s*([+-]?[\d.]+%?)\s*[,\s]\s*([+-]?[\d.]+%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(text)
  if (!m) return null
  const channel = (part) => (part.endsWith('%') ? (Number.parseFloat(part) * 255) / 100 : Number.parseFloat(part))
  const values = m.slice(1, 4).map(channel)
  return values.some((v) => !Number.isFinite(v)) ? null : `#${values.map(hex2).join('')}`
}

/** Mixes a color (any form normalizeColor knows) toward white by `amount` (0..1), as '#rrggbb'. */
export function tint(color, amount) {
  const hex = normalizeColor(color)
  if (!hex) return '#f7e9e3'
  const channel = (i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount) + 255 * amount)
  return `#${[1, 3, 5].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`
}

/** The app palette is the theme accent on dark squares and a pale tint of it on light squares. */
export const appPalette = (accent) => ({ dark: normalizeColor(accent) || '#ff7a5c', light: tint(accent, 0.86) })

// Four brushes, as on lichess and chess.com. Each is drawn over a dark halo, so it reads on light
// and dark squares of every palette.
export const BRUSHES = Object.freeze({
  green: '#3dbb5a',
  red: '#ef4b3f',
  blue: '#3f8cff',
  yellow: '#ffc21a',
})
export const HALO = 'rgba(12, 14, 16, 0.8)'
export const BRUSH_ALPHA = 0.9
export const HIGHLIGHT_ALPHA = 0.55

/** Shift = red, Ctrl or Cmd = blue, Alt = yellow, otherwise green. */
export function brushFor(event) {
  if (event.shiftKey) return 'red'
  if (event.ctrlKey || event.metaKey) return 'blue'
  if (event.altKey) return 'yellow'
  return 'green'
}

const same = (a, b) => a.f === b.f && a.r === b.r

// Drawing the same mark again removes it; the same squares in another brush recolor it.
function toggle(list, item, matches) {
  const index = list.findIndex(matches)
  if (index === -1) return [...list, item]
  if (list[index].brush === item.brush) return list.filter((_, i) => i !== index)
  return list.map((existing, i) => (i === index ? item : existing))
}

/** list: [{ from, to, brush }]. Returns a new list. */
export const toggleArrow = (list, arrow) =>
  toggle(list, arrow, (a) => same(a.from, arrow.from) && same(a.to, arrow.to))

/** list: [{ f, r, brush }]. Returns a new list. */
export const toggleHighlight = (list, square) => toggle(list, square, (s) => same(s, square))

// Color math for contrast: used by the tests and by readableInk.
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const linear = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])

/** Draws `top` (#rrggbb) at `alpha` over `bottom` (#rrggbb) and returns the result as [r, g, b] 0..1. */
export function composite(top, alpha, bottom) {
  const a = channels(top)
  const b = channels(bottom)
  return a.map((v, i) => v * alpha + b[i] * (1 - alpha))
}

export const toHex = (rgb) => `#${rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`

export function contrast(a, b) {
  const la = luminance(Array.isArray(a) ? a : channels(a))
  const lb = luminance(Array.isArray(b) ? b : channels(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The person's accent used as ink (a line, an icon, a border) on a ground: the accent itself when it
 * reads there (3:1), otherwise moved toward white or black until it does. A dark teal accent on a dark
 * panel would otherwise draw lines nobody can see. Fills that carry their own on-accent text keep the accent.
 */
export function readableInk(accent, ground, minRatio = 3) {
  const a = normalizeColor(accent)
  const g = normalizeColor(ground)
  if (!a || !g) return a
  if (contrast(a, g) >= minRatio) return a
  const toward = contrast('#ffffff', g) >= contrast('#000000', g) ? '#ffffff' : '#000000'
  for (let step = 1; step <= 20; step++) {
    const mixed = toHex(composite(toward, step * 0.05, a))
    if (contrast(mixed, g) >= minRatio) return mixed
  }
  return toward
}
