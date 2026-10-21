// Text measuring shared by drawing, hit testing and the diagram compiler.
// Measures with a canvas when there is one and estimates otherwise, so the
// compiler can also run where there is no DOM.

export const LINE_HEIGHT = 1.25
// Excalidraw's hand-drawn face, bundled in fonts/ so it works offline.
export const FONT_FAMILY = 'Excalifont, "Segoe UI Emoji", sans-serif'

let probe = null

function context() {
  if (probe === null) {
    try {
      probe = document.createElement('canvas').getContext('2d') || false
    } catch {
      probe = false
    }
  }
  return probe || null
}

export function fontFor(size) {
  return `${size}px ${FONT_FAMILY}`
}

// The same label is measured on every redraw; measuring is the slow part.
const memo = new Map()

/** Drops cached sizes; call once a web font finishes loading. */
export function clearTextMetrics() {
  memo.clear()
}

/** { lines, w, h, lineHeight } for `text` at `size` sheet units. */
export function textMetrics(text, size) {
  const key = `${size}|${text}`
  const known = memo.get(key)
  if (known) return known
  const measured = measure(text, size)
  if (memo.size > 400) memo.clear()
  memo.set(key, measured)
  return measured
}

function measure(text, size) {
  const lines = String(text).split('\n')
  const c = context()
  let w = 0
  if (c) {
    c.font = fontFor(size)
    for (const line of lines) w = Math.max(w, c.measureText(line).width)
  } else {
    for (const line of lines) w = Math.max(w, line.length * size * 0.55)
  }
  const lineHeight = size * LINE_HEIGHT
  return { lines, w, h: lines.length * lineHeight, lineHeight }
}
