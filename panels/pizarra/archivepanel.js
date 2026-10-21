// The Historial button and its list of the last drawings. A drawing goes into
// the archive when it is about to be replaced (cleared, imported, swapped for
// another) or when the person asks for a copy. Restoring swaps: the drawing on
// the board is archived first, so nothing is lost by looking back.

import { render } from './drawing.js'
import { ARCHIVE, expand, looksLikeEntry, pushEntry } from './archive.js'
import { shapeBounds, strokeBounds } from './shapes.js'
import { hooks, state } from './state.js'
import { validateProject } from './transfer.js'

const KEY = 'history'
const $ = (id) => document.getElementById(id)
const THUMB = { w: 72, h: 48, dpr: 2 }

let entries = [] // newest first
let applyDocument = () => {}
let open = false

export const historyOpen = () => open

/** The theme changed: draw the previews again. */
export function redrawHistory() {
  if (open) renderList()
}

// Storage --------------------------------------------------------------------------

export async function loadArchive() {
  try {
    const saved = await deska.storage.get(KEY)
    entries = Array.isArray(saved) ? saved.filter(looksLikeEntry).slice(0, ARCHIVE.max) : []
  } catch (err) {
    entries = []
    hooks.message(`No se pudo leer el historial (${(err && err.code) || 'error'}).`, 'error')
  }
}

async function persist() {
  try {
    await deska.storage.set(KEY, entries)
  } catch (err) {
    const full = err && err.code === 'storage_full'
    hooks.message(full ? 'No hay espacio para el historial.' : `No se pudo guardar el historial (${(err && err.code) || 'error'}).`, 'error')
  }
}

/** Puts a drawing in the archive. Returns whether it was added. */
export function archiveDocument(doc) {
  const result = pushEntry(entries, doc, Date.now())
  if (result.reason === 'big') {
    hooks.message('Ese dibujo es demasiado grande para el historial.', 'error')
    return false
  }
  if (!result.added) return false
  entries = result.list
  persist()
  if (open) renderList()
  return true
}

// List -----------------------------------------------------------------------------------

function ago(seconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds))
  if (s < 60) return 'Hace un momento'
  if (s < 3600) return `Hace ${Math.round(s / 60)} min`
  if (s < 86400) return `Hace ${Math.round(s / 3600)} h`
  return `Hace ${Math.round(s / 86400)} d`
}

/** Draws a drawing small, fitted to what it contains. */
function drawThumb(canvas, doc) {
  canvas.width = THUMB.w * THUMB.dpr
  canvas.height = THUMB.h * THUMB.dpr
  const boxes = [...doc.strokes.map(strokeBounds), ...doc.shapes.map(shapeBounds)]
  if (!boxes.length) return
  const x1 = Math.min(...boxes.map((b) => b.x))
  const y1 = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.w))
  const y2 = Math.max(...boxes.map((b) => b.y + b.h))
  const pad = 24
  const w = Math.max(1, x2 - x1) + pad * 2
  const h = Math.max(1, y2 - y1) + pad * 2
  const scale = Math.min(THUMB.w / w, THUMB.h / h)
  const view = {
    cssW: THUMB.w,
    cssH: THUMB.h,
    dpr: THUMB.dpr,
    scale,
    ox: (THUMB.w - (x2 - x1) * scale) / 2 - x1 * scale,
    oy: (THUMB.h - (y2 - y1) * scale) / 2 - y1 * scale,
  }
  render(canvas.getContext('2d'), view, { ...doc, background: 'plain' }, { cache: false })
}

function renderList() {
  const list = $('history-list')
  list.replaceChildren()
  let changed = false
  entries = entries.filter((entry, index) => {
    const result = validateProject(expand(entry))
    if (!result.ok) {
      changed = true
      return false
    }
    const li = document.createElement('li')
    li.className = 'hist-item'
    li.style.setProperty('--i', String(index))

    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'hist-restore'
    const thumb = document.createElement('canvas')
    thumb.className = 'thumb'
    drawThumb(thumb, result.doc)
    const text = document.createElement('span')
    text.className = 'hist-text'
    const when = document.createElement('strong')
    when.textContent = ago(entry.t)
    const count = document.createElement('span')
    count.textContent = entry.n === 1 ? '1 elemento' : `${entry.n} elementos`
    text.append(when, count)
    restore.append(thumb, text)
    restore.setAttribute('aria-label', `Restaurar el dibujo de ${when.textContent.toLowerCase()}, ${count.textContent}`)
    restore.addEventListener('click', () => restoreEntry(entry))

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn icon hist-remove'
    remove.setAttribute('aria-label', 'Quitar del historial')
    remove.title = 'Quitar del historial'
    remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>'
    remove.addEventListener('click', () => {
      entries = entries.filter((e) => e !== entry)
      persist()
      renderList()
    })

    li.append(restore, remove)
    list.append(li)
    return true
  })
  if (changed) persist()
  $('history-empty').hidden = entries.length > 0
}

function restoreEntry(entry) {
  const result = validateProject(expand(entry))
  entries = entries.filter((e) => e !== entry)
  if (!result.ok) {
    persist()
    renderList()
    hooks.message('Ese dibujo del historial estaba dañado y se quitó.', 'error')
    return
  }
  // Swap: what is on the board goes into the archive in its place.
  const swapped = pushEntry(entries, state.doc, Date.now())
  if (swapped.added) entries = swapped.list
  persist()
  applyDocument(result.doc)
  closeHistory()
}

// Popover ----------------------------------------------------------------------------------

export function openHistory() {
  open = true
  renderList()
  $('history-pop').hidden = false
  $('history-btn').setAttribute('aria-expanded', 'true')
}

export function closeHistory(focusButton = false) {
  if (!open) return
  open = false
  $('history-pop').hidden = true
  $('history-btn').setAttribute('aria-expanded', 'false')
  if (focusButton) $('menu-toggle').focus()
}

export function initArchivePanel({ apply, canOpen }) {
  applyDocument = apply
  $('history-btn').addEventListener('click', () => {
    if (open) closeHistory()
    else if (canOpen()) openHistory()
  })
  $('history-save').addEventListener('click', () => archiveDocument(state.doc))
  // Touching anything outside the list closes it.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (open && !event.target.closest('#history-pop, #history-btn')) closeHistory()
    },
    true,
  )
}
