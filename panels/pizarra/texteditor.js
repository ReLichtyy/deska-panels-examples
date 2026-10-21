// An in-place text editor: a bare textarea laid over the canvas at the spot
// where the text lives, because prompt() does not exist in the sandbox. It has
// no box of its own: the caret sits where the text will be drawn and the field
// grows with what is typed. Enter starts a new line. Pressing outside the
// text, or Ctrl or Cmd + Enter, commits; Escape cancels.

import { renderMode } from './drawing.js'
import { fontFor, textMetrics } from './text.js'
import { adaptColor } from './theme.js'

let current = null

// Pressing anywhere outside the box finishes the text. The canvas cancels the
// default of its own pointerdown (so a drag does not select page text), which
// also keeps the textarea focused, so blur alone never fires there.
document.addEventListener(
  'pointerdown',
  (event) => {
    if (current && !current.el.contains(event.target)) closeTextEditor(true)
  },
  true,
)

export function textEditorOpen() {
  return current !== null
}

/** Closes the open editor. `commit` false throws the text away. */
export function closeTextEditor(commit = true) {
  if (!current) return
  const { el, onCommit, done } = current
  current = null
  const text = el.value
  el.remove()
  if (commit && !done) onCommit(text)
}

/** spec: { x, y, size, color, text, center, select, onCommit(text) } in sheet
 *  units; select puts the whole text in selection so typing replaces it. */
export function openTextEditor(stage, view, spec) {
  closeTextEditor(true)
  const el = document.createElement('textarea')
  el.className = 'text-editor'
  el.value = spec.text
  el.spellcheck = false
  el.setAttribute('aria-label', 'Texto. Enter hace otra línea. Pulsa fuera para terminar o Escape para cancelar.')
  const px = Math.max(12, spec.size * view.scale)
  el.style.font = fontFor(px)
  el.style.color = adaptColor(spec.color, renderMode())
  el.style.left = `${view.ox + spec.x * view.scale}px`
  el.style.top = `${view.oy + spec.y * view.scale}px`
  el.style.textAlign = spec.center ? 'center' : 'left'
  if (spec.center) el.style.transform = 'translate(-50%, -50%)'
  if (spec.angle && spec.rotationCenter) {
    el.style.left = `${view.ox + spec.rotationCenter.x * view.scale}px`
    el.style.top = `${view.oy + spec.rotationCenter.y * view.scale}px`
    el.style.transform = `translate(-50%, -50%) rotate(${spec.angle}rad)`
  }
  const fit = () => {
    const m = textMetrics(el.value || ' ', px)
    el.rows = m.lines.length
    el.style.width = `${Math.ceil(m.w + px * 0.5)}px`
    el.style.height = `${Math.ceil(m.h)}px`
  }
  fit()
  stage.append(el)

  const entry = { el, onCommit: spec.onCommit, done: false }
  current = entry
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      entry.done = true
      closeTextEditor(false)
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      closeTextEditor(true)
    }
  })
  el.addEventListener('input', fit)
  el.addEventListener('blur', () => {
    if (current === entry) closeTextEditor(true)
  })
  el.focus()
  if (spec.select) el.select()
  else el.setSelectionRange(el.value.length, el.value.length)
}
