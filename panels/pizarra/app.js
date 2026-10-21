/* Pizarra: a compact whiteboard and diagram sketcher. The document is data:
 * freehand strokes (id, color, width, points) and shapes (lines, arrows,
 * rectangles, circles, diamonds, text) on a logical 1200 x 800 sheet. The
 * canvas is only a picture of that data and is redrawn from it.
 *
 * Files: model.js (constants, factories), text.js (measuring), shapes.js
 * (geometry), drawing.js (canvas, zoom and pan), history.js (undo/redo),
 * transfer.js (JSON export/import and validation), state.js (live state and
 * the single commit()), input.js (pointer lifecycle), tools.js (what each tool
 * does), texteditor.js (in-place text), diagram.js (the Mermaid compiler),
 * archive.js and archivepanel.js (the last few drawings, kept small), objects.js (the basic diagram objects) and mermaidpanel.js (the editor) and this file:
 * the interface, storage and wiring.
 *
 * What this panel teaches:
 * - Pointer Events with capture, one active pointer, and clean cancelling.
 * - A bitmap sized to devicePixelRatio and redrawn from data on resize.
 * - Saving only what the bridge confirmed: "Guardado" appears after
 *   storage.set resolves, never before.
 * - Import and export without a file API: text through the clipboard.
 * - A diagram compiler with no dependencies, whose output is plain shapes. */

import { BACKGROUNDS, LIMITS, PALETTE } from './model.js'
import { ZOOM, fitView, panBy, render, resetZoom, setRenderMode, sizeBitmap, toLogical, zoomAt } from './drawing.js'
import { attachInput } from './input.js'
import { archiveDocument, closeHistory, historyOpen, initArchivePanel, loadArchive, redrawHistory } from './archivepanel.js'
import { initMermaidPanel, syncMermaidPanel } from './mermaidpanel.js'
import { PROCESS_OBJECTS } from './objects.js'
import { applySnapshot, commit, elementCount, findItem, history, hooks, selectionKey, snapshot, state, view } from './state.js'
import { clearTextMetrics, fontFor } from './text.js'
import { closeTextEditor, openTextEditor } from './texteditor.js'
import { ONE_SHOT_TOOLS, createHandlers, deleteSelection, editSpec, overlay, restyleSelection, selectAll } from './tools.js'
import { THEME_CHOICES, adaptColor, applyTheme, effectiveMode } from './theme.js'
import { parseProject, serializeProject, toProject, validateProject } from './transfer.js'

const KEY = 'board'
const SAVE_DELAY_MS = 600
const CLIPBOARD_MAX = 64 * 1024
const $ = (id) => document.getElementById(id)

const canvas = $('board')
const ctx = canvas.getContext('2d')

let dataOpen = false
let hover = false // the pointer is over the sheet
let panelName = 'Pizarra'

const init = await deska.ready()
if (init && init.panel && typeof init.panel.name === 'string') panelName = init.panel.name

// The board's theme: Auto follows Deska; Claro and Oscuro are the person's own
// choice. The panel around the board always follows Deska.
let themeChoice = 'auto'
let hostMode = (deska.theme && deska.theme.mode) || (init && init.theme && init.theme.mode) || 'dark'

// Messages --------------------------------------------------------------------------

let messageTimer = null
function showMessage(text, kind = '') {
  const el = $('message')
  clearTimeout(messageTimer)
  el.textContent = text
  el.className = `toast${kind ? ` is-${kind}` : ''}`
  if (text && kind !== 'error') messageTimer = setTimeout(() => showMessage(''), 3500)
}

function bridgeProblem(err, action) {
  const messages = {
    not_focused: `Haz clic en el panel y vuelve a intentar: ${action}.`,
    too_large: 'Pesa más de 64 KB, el máximo que Deska copia de una vez.',
    permission_denied: 'Este panel no tiene permiso para eso. Revisa sus permisos en la Biblioteca de paneles.',
    rate_limited: 'Demasiadas peticiones seguidas. Prueba de nuevo en un momento.',
    storage_full: 'El almacenamiento está lleno. Borra algo del dibujo e inténtalo de nuevo.',
  }
  const code = err && err.code
  return messages[code] || `No se pudo ${action} (${code || 'error desconocido'}).`
}

// Saving ---------------------------------------------------------------------------
// The status says "Guardado" only after deska.storage.set resolved for the
// latest revision. Until then it says what is really happening.

let revision = 0
let savedRevision = 0
let saving = false
let saveFailed = false
let saveTimer = null

function setSaveState(kind) {
  const el = $('save')
  const texts = { idle: '', dirty: 'Cambios sin guardar…', saving: 'Guardando…', saved: 'Guardado', error: 'Sin guardar' }
  el.textContent = texts[kind]
  el.className = `save${kind === 'saved' ? ' is-ok' : kind === 'error' ? ' is-error' : ''}`
  $('retry').hidden = kind !== 'error'
}

function markChanged() {
  revision += 1
  saveFailed = false
  setSaveState('dirty')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS)
}

async function flushSave() {
  clearTimeout(saveTimer)
  if (saving || revision === savedRevision) return
  saving = true
  const sent = revision
  setSaveState('saving')
  try {
    await deska.storage.set(KEY, toProject(state.doc))
    savedRevision = sent
  } catch (err) {
    saveFailed = true
    setSaveState('error')
    showMessage(`Sin guardar: ${bridgeProblem(err, 'guardar el dibujo')}`, 'error')
  } finally {
    saving = false
  }
  if (saveFailed) return
  if (revision !== savedRevision) flushSave()
  else setSaveState('saved')
}

$('retry').addEventListener('click', () => {
  saveFailed = false
  flushSave()
})

// Loading --------------------------------------------------------------------------

try {
  const prefs = await deska.storage.get('prefs')
  if (prefs && typeof prefs === 'object' && THEME_CHOICES.includes(prefs.theme)) themeChoice = prefs.theme
} catch {
  // Without a saved preference the theme is Auto, which is always right.
}

try {
  const saved = await deska.storage.get(KEY)
  if (saved !== null && saved !== undefined) {
    const result = validateProject(saved)
    if (result.ok) state.doc = result.doc
    else showMessage(`El dibujo guardado no se pudo cargar (${result.error}) Se reemplazará al dibujar.`, 'error')
  }
} catch (err) {
  showMessage(bridgeProblem(err, 'cargar el último dibujo'), 'error')
}

await loadArchive()

// Rendering ------------------------------------------------------------------------

let frame = 0
function requestRender() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

function draw() {
  render(ctx, view, state.doc, overlay())
  // A fade-in is running: ask for the next frame until it ends.
  if (state.appear) requestRender()
}

/** Fits the sheet to the stage and resizes the bitmap. Resizing clears the
 *  canvas, so the redraw is synchronous: no blank frame. */
function layout(force = false) {
  const stage = $('stage')
  if (!stage.clientWidth || !stage.clientHeight) return
  const dpr = window.devicePixelRatio || 1
  // The observer and the window both report the same resize: draw once.
  if (!force && stage.clientWidth === view.cssW && stage.clientHeight === view.cssH && dpr === view.dpr) return
  closeTextEditor(true)
  fitView(view, stage.clientWidth, stage.clientHeight, dpr)
  sizeBitmap(canvas, view)
  draw()
}

new ResizeObserver(() => layout()).observe($('stage'))
window.addEventListener('resize', () => layout())
// devicePixelRatio changes (zoom, moving to another screen) without a resize.
function watchPixelRatio() {
  const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  query.addEventListener(
    'change',
    () => {
      layout(true)
      watchPixelRatio()
    },
    { once: true },
  )
}
watchPixelRatio()

// Theme -----------------------------------------------------------------------------

/** Puts the board's theme on the canvas, the swatches and the history. */
function applyAppearance() {
  const { mode, surfaces } = applyTheme(themeChoice, { mode: hostMode })
  setRenderMode(mode, surfaces)
  for (const button of document.querySelectorAll('[data-theme-pref]')) button.setAttribute('aria-pressed', String(button.dataset.themePref === themeChoice))
  paintSwatches()
  refresh()
  layout(true)
  redrawHistory()
}

for (const button of document.querySelectorAll('[data-theme-pref]')) {
  button.addEventListener('click', async () => {
    themeChoice = button.dataset.themePref
    applyAppearance()
    try {
      await deska.storage.set('prefs', { theme: themeChoice })
    } catch (err) {
      showMessage(bridgeProblem(err, 'guardar el tema de la pizarra'), 'error')
    }
  })
}

// Deska changed its theme: the panel follows it (the SDK does that), and so does
// the board on Auto; a board set to Claro or Oscuro stays as chosen.
deska.on('theme', (next) => {
  hostMode = next && next.mode === 'light' ? 'light' : 'dark'
  applyAppearance()
})

// Pointer --------------------------------------------------------------------------

const input = attachInput(
  canvas,
  createHandlers(canvas, (event) => toLogical(view, canvas.getBoundingClientRect(), event.clientX, event.clientY)),
)

hooks.changed = () => {
  markChanged()
  refresh()
  requestRender()
}
hooks.repaint = requestRender
hooks.refresh = () => refresh()
// Canvas text falls back to another face until Excalifont arrives; measure and
// paint again whenever a subset finishes loading.
document.fonts.addEventListener('loadingdone', () => {
  clearTextMetrics()
  refresh()
})
document.fonts.load(fontFor(20)).catch((error) => console.warn('Excalifont failed to load', error))
hooks.message = showMessage
// Open the editor on the next frame, once the click that asked for it is over.
hooks.editText = (spec) => requestAnimationFrame(() => openTextEditor($('stage'), view, spec))

// Controls -------------------------------------------------------------------------

const TOOL_NAMES = {
  select: 'Seleccionar',
  pen: 'Lápiz',
  eraser: 'Borrador',
  line: 'Línea',
  arrow: 'Flecha',
  rect: 'Rectángulo',
  ellipse: 'Círculo',
  diamond: 'Rombo',
  text: 'Texto',
  fill: 'Relleno',
}
let lastTitle = null
let lastSelection = null
let established = null // the tool's own color, width and text size while something is selected

/** While something is selected the controls show its color, width and
 *  text size, and changing them restyles it. The tools keep their own values:
 *  they are put back when the selection goes away, so selecting a thin
 *  diagram node never leaves the pen thin. */
function syncFromSelection() {
  const id = selectionKey(state.selection)
  if (id === lastSelection) return
  const before = lastSelection
  lastSelection = id
  if (before === null && id !== null) established = { color: state.color, width: state.width, textSize: state.textSize, fill: state.fill, round: state.round, dash: state.dash }
  if (id === null) {
    if (established) Object.assign(state, established)
    established = null
    return
  }
  const item = findItem(state.selection)
  if (!item) return
  state.color = item.color
  state.fill = !!item.fill
  state.round = !!item.round
  state.dash = !!item.dash
  if (item.kind !== 'text') state.width = Math.min(24, Math.max(1, Math.round(item.width)))
  const size = Math.round(item.size || 0)
  if ([20, 28, 40, 64].includes(size)) state.textSize = size
}

function paintControls() {
  let preset = false
  for (const swatch of document.querySelectorAll('.swatch')) {
    const on = swatch.dataset.color === state.color
    swatch.setAttribute('aria-pressed', String(on))
    preset = preset || on
  }
  $('custom-color-quick').closest('.custom').classList.toggle('is-active', !preset)
  $('width-quick').value = String(state.width)
  $('width-quick-out').textContent = String(state.width)
  $('custom-color-quick').value = state.color
}

function refresh() {
  syncFromSelection()
  paintControls()
  const n = elementCount()
  const count = n === 1 ? '1 elemento' : `${n} elementos`
  $('undo').disabled = !history.canUndo
  $('redo').disabled = !history.canRedo
  $('clear').disabled = n === 0
  $('readout').textContent = count
  const badge = state.mode === 'move' ? 'Mover' : state.selection?.kind === 'group' ? `${state.selection.items.length} elementos` : state.processTool ? PROCESS_OBJECTS.find((o) => o.id === state.processTool).name : TOOL_NAMES[state.tool]
  if ($('tool-badge').textContent !== badge) {
    $('tool-badge').textContent = badge
    bump($('tool-badge'))
  }
  paintProperties()
  for (const button of document.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool && state.mode === 'draw' && !state.processTool))
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode))
  paintMoreTools()
  for (const name of Object.keys(TOOL_NAMES)) canvas.classList.toggle(`tool-${name}`, name === state.tool && state.mode === 'draw')
  canvas.classList.toggle('is-move', state.mode === 'move')
  $('zoom-reset').textContent = `${Math.round(view.zoom * 100)}%`
  $('zoom-out').disabled = view.zoom <= ZOOM.min
  $('zoom-in').disabled = view.zoom >= ZOOM.max
  const title = n === 0 ? panelName : count
  if (title !== lastTitle) {
    lastTitle = title
    deska.setTitle(title).catch((err) => console.warn(`setTitle: ${err.code}`))
  }
}

/** Picks a tool and goes to draw mode, as the tool buttons and keys do. */
function chooseTool(tool) {
  input.cancel()
  closeTextEditor(true)
  setMoreTools(false)
  state.tool = tool
  state.processTool = null
  if (!ONE_SHOT_TOOLS.includes(tool)) state.returnTool = tool
  welcomeDismissed = true
  if (tool !== 'select') state.selection = null
  state.mode = 'draw'
  setMenu(false)
  setSection(null)
  refresh()
  requestRender()
}

function setMode(mode) {
  input.cancel()
  closeTextEditor(true)
  setMoreTools(false)
  state.mode = mode
  welcomeDismissed = true
  refresh()
  requestRender()
}

// Color, width and text size apply to the selection when there is one.
function setColor(value) {
  state.color = value.toLowerCase()
  if (state.tool === 'eraser') chooseTool('pen')
  if (state.selection) restyleSelection({ color: state.color })
  refresh()
}

function setBackground(value) {
  if (!BACKGROUNDS.includes(value)) return
  state.doc.background = value
  for (const button of document.querySelectorAll('[data-background]')) button.setAttribute('aria-pressed', String(button.dataset.background === value))
}

function buildPalette(box, afterPick) {
  for (const { name, value } of PALETTE) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'swatch'
    button.dataset.color = value
    button.style.background = value
    button.setAttribute('aria-label', `${name} ${value}`)
    button.setAttribute('aria-pressed', 'false')
    button.title = name
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>'
    button.addEventListener('click', () => {
      setColor(value)
      afterPick()
    })
    box.insertBefore(button, box.querySelector('[data-after-swatches]'))
  }
}

/** Swatches show the colors as they will look in the theme in use. */
function paintSwatches() {
  const shown = effectiveMode(themeChoice, hostMode)
  for (const swatch of document.querySelectorAll('.swatch')) {
    const color = adaptColor(swatch.dataset.color, shown)
    swatch.style.background = color
    swatch.style.setProperty('--check', isLight(color) ? '#1b1b1f' : '#ffffff')
  }
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16)
  const lum = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return lum > 150
}

const busy = () => input.active || dataOpen

function undo() {
  if (busy()) return
  closeTextEditor(true)
  const previous = history.undo(snapshot())
  if (!previous) return
  applySnapshot(previous)
  hooks.changed()
}

function redo() {
  if (busy()) return
  closeTextEditor(true)
  const next = history.redo(snapshot())
  if (!next) return
  applySnapshot(next)
  hooks.changed()
}

// Floating menu and contextual style controls ---------------------------------------
const SECTIONS = ['settings', 'mermaid', 'processes']
let openSection = null
let menuOpen = false
let propertiesExpanded = false
let welcomeDismissed = false
const compact = matchMedia('(max-width: 760px)')

function paintMoreTools() {
  const active = state.mode === 'draw' && (state.processTool === 'note' || (!state.processTool && ['eraser', 'fill'].includes(state.tool)))
  const collapsed = $('extra-tools').hidden
  $('more-tools').dataset.active = String(active && collapsed)
  const label = active && collapsed ? `Más herramientas: ${state.processTool === 'note' ? 'Nota' : TOOL_NAMES[state.tool]}` : 'Más herramientas'
  $('more-tools').setAttribute('aria-label', label)
  $('more-tools').title = label
}

function setMoreTools(open) {
  const extras = $('extra-tools')
  if (!open && extras.contains(document.activeElement)) $('more-tools').focus()
  extras.hidden = !open
  $('app').classList.toggle('tools-expanded', open)
  $('more-tools').setAttribute('aria-expanded', String(open))
  paintMoreTools()
  paintWelcome()
}

$('more-tools').addEventListener('click', () => {
  input.cancel()
  closeTextEditor(true)
  setMenu(false)
  setSection(null)
  setMoreTools($('extra-tools').hidden)
})
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.tool-strip')) setMoreTools(false)
}, true)

function setMenu(open, focus = false) {
  if (open) setMoreTools(false)
  menuOpen = open
  $('main-menu').hidden = !open
  $('menu-toggle').setAttribute('aria-expanded', String(open || openSection !== null))
  if (open) {
    setSection(null)
    closeHistory()
  }
  paintProperties()
  if (focus) (open ? $('main-menu').querySelector('button') : $('menu-toggle')).focus()
}

function setSection(name) {
  openSection = name
  for (const id of SECTIONS) {
    const el = $(`sec-${id}`)
    el.hidden = id !== name
    el.inert = id !== name
  }
  if (name) {
    menuOpen = false
    $('main-menu').hidden = true
    closeHistory()
  }
  $('menu-toggle').setAttribute('aria-expanded', String(menuOpen || name !== null))
  for (const button of document.querySelectorAll('[data-section]')) button.setAttribute('aria-expanded', String(button.dataset.section === name))
  paintProperties()
}

$('menu-toggle').addEventListener('click', () => {
  input.cancel()
  closeTextEditor(true)
  if (openSection) { setSection(null); setMenu(false) }
  else setMenu(!menuOpen, true)
})
for (const button of document.querySelectorAll('[data-section]')) {
  button.addEventListener('click', () => {
    setSection(button.dataset.section)
    $(`sec-${openSection}`).querySelector('button').focus()
  })
}
for (const button of document.querySelectorAll('[data-back-menu]')) button.addEventListener('click', () => setMenu(true, true))
$('project-menu').addEventListener('click', openData)
$('history-btn').addEventListener('click', () => setMenu(false))
canvas.addEventListener('pointerdown', () => {
  setMenu(false)
  setSection(null)
  if (compact.matches) { propertiesExpanded = false; paintProperties() }
}, true)

function paintWelcome() {
  $('welcome').hidden = welcomeDismissed || elementCount() > 0 || menuOpen || openSection !== null || dataOpen || !$('extra-tools').hidden
}

$('welcome-start').addEventListener('click', () => {
  chooseTool('pen')
  canvas.focus({ preventScroll: true })
})

function paintProperties() {
  paintWelcome()
  const item = findItem(state.selection)
  const def = state.processTool && PROCESS_OBJECTS.find((o) => o.id === state.processTool)
  const group = state.selection?.kind === 'group'
  const kind = group ? 'group' : item?.kind || def?.spec.kind || state.tool
  const available = state.mode === 'draw' && (state.tool !== 'select' || !!item || group) && state.tool !== 'eraser'
  const visible = available && !menuOpen && !openSection && !dataOpen && propertiesExpanded
  $('properties').hidden = !visible
  $('properties-toggle').hidden = !available
  $('properties-toggle').setAttribute('aria-expanded', String(visible))
  $('stroke-controls').hidden = ['text', 'fill'].includes(kind)
  $('fill-controls').hidden = !['rect', 'ellipse', 'diamond'].includes(kind)
  $('edge-controls').hidden = kind !== 'rect'
  $('dash-controls').hidden = !['line', 'arrow'].includes(kind)
  $('text-controls').hidden = !(kind === 'text' || item?.text || def?.spec.text)
  $('delete-selection').hidden = !item && !group
  for (const prop of ['fill', 'round', 'dash']) {
    for (const button of document.querySelectorAll(`[data-${prop}]`)) button.setAttribute('aria-pressed', String((button.dataset[prop] === 'true') === state[prop]))
  }
  for (const button of document.querySelectorAll('[data-size]')) button.setAttribute('aria-pressed', String(Number(button.dataset.size) === state.textSize))
  for (const button of document.querySelectorAll('[data-object]')) button.setAttribute('aria-pressed', String(state.processTool === button.dataset.object))
}

$('properties-toggle').addEventListener('click', () => {
  const opening = $('properties').hidden
  propertiesExpanded = opening
  setMenu(false)
  setSection(null)
  paintProperties()
})
$('properties-close').addEventListener('click', () => {
  propertiesExpanded = false
  paintProperties()
  $('properties-toggle').focus()
})
compact.addEventListener('change', () => { propertiesExpanded = false; paintProperties() })
for (const prop of ['fill', 'round', 'dash']) {
  for (const button of document.querySelectorAll(`[data-${prop}]`)) button.addEventListener('click', () => {
    state[prop] = button.dataset[prop] === 'true'
    if (state.selection) restyleSelection({ [prop]: state[prop] })
    refresh()
  })
}
for (const button of document.querySelectorAll('[data-size]')) button.addEventListener('click', () => {
  state.textSize = Number(button.dataset.size)
  if (state.selection) restyleSelection({ size: state.textSize })
  refresh()
})
$('delete-selection').addEventListener('click', () => deleteSelection())

function chooseProcess(id) {
  const def = PROCESS_OBJECTS.find((o) => o.id === id)
  if (!def || busy()) return
  chooseTool(def.spec.kind)
  state.processTool = id
  if (def.spec.color) state.color = def.spec.color
  state.fill = !!def.spec.fill
  state.round = !!def.spec.round
  refresh()
}
for (const button of document.querySelectorAll('[data-object]')) button.addEventListener('click', () => chooseProcess(button.dataset.object))

function bump(el) {
  el.classList.remove('bump')
  void el.offsetWidth
  el.classList.add('bump')
}

// Clear, with confirmation. window.confirm does not exist in the sandbox.
function openConfirm() {
  if (!elementCount()) return
  input.cancel()
  closeTextEditor(true)
  setMenu(false)
  setSection(null)
  for (const part of dataLocked()) part.inert = true
  $('board').inert = true
  $('confirm').hidden = false
  $('confirm-no').focus()
}

function closeConfirm() {
  $('confirm').hidden = true
  for (const part of dataLocked()) part.inert = false
  $('board').inert = false
  $('menu-toggle').focus()
}

$('clear').addEventListener('click', openConfirm)
$('confirm-no').addEventListener('click', () => closeConfirm('clear'))
$('confirm-yes').addEventListener('click', () => {
  if (elementCount()) {
    archiveDocument(state.doc)
    state.selection = null
    commit({ strokes: [], shapes: [] })
    showMessage('Pizarra limpia. Puedes deshacer.')
  }
  closeConfirm('mode-draw')
})

/** Replaces the whole drawing: one undo step, the controls follow. */
function applyDocument(doc) {
  closeTextEditor(true)
  history.record(snapshot())
  state.doc = doc
  state.selection = null
  setBackground(doc.background)
  syncMermaidPanel()
  hooks.changed()
}

// Project: export and import as text ----------------------------------------------------

function setDataMessage(text, kind = '') {
  const el = $('data-message')
  el.textContent = text
  el.className = `data-message${kind ? ` is-${kind}` : ''}`
}

const dataLocked = () => [$('topbar'), $('sections'), $('bottombar'), $('main-menu'), $('properties')]

function openData() {
  input.cancel()
  closeTextEditor(true)
  if (!$('confirm').hidden) $('confirm').hidden = true
  setMenu(false)
  setSection(null)
  closeHistory()
  $('board').inert = true
  dataOpen = true
  paintProperties()
  const text = serializeProject(state.doc)
  const bytes = new Blob([text]).size
  $('data-text').value = text
  $('data').hidden = false
  $('open-data').setAttribute('aria-expanded', 'true')
  for (const part of dataLocked()) part.inert = true
  const n = elementCount()
  setDataMessage(
    bytes > CLIPBOARD_MAX
      ? `Pesa ${Math.ceil(bytes / 1024)} KB y Copiar solo llega a 64 KB. Selecciona el texto y cópialo a mano.`
      : `${n} elementos, ${Math.max(1, Math.round(bytes / 1024))} KB.`,
    bytes > CLIPBOARD_MAX ? 'error' : '',
  )
  $('data-text').focus()
  $('data-text').select()
}

function closeData() {
  dataOpen = false
  $('board').inert = false
  $('data').hidden = true
  $('open-data').setAttribute('aria-expanded', 'false')
  for (const part of dataLocked()) part.inert = false
  $('menu-toggle').focus()
  paintProperties()
}

$('open-data').addEventListener('click', openData)
$('data-close').addEventListener('click', closeData)

$('data-copy').addEventListener('click', async () => {
  const text = $('data-text').value
  if (new Blob([text]).size > CLIPBOARD_MAX) {
    setDataMessage('Pesa más de 64 KB, el máximo que Deska copia de una vez. Selecciona el texto y cópialo a mano.', 'error')
    return
  }
  try {
    await deska.clipboard.write(text)
    setDataMessage('Copiado al portapapeles.', 'ok')
  } catch (err) {
    setDataMessage(bridgeProblem(err, 'copiar'), 'error')
  }
})

$('data-import').addEventListener('click', () => {
  const result = parseProject($('data-text').value)
  if (!result.ok) {
    setDataMessage(`No se importó nada: ${result.error}`, 'error')
    return
  }
  archiveDocument(state.doc)
  applyDocument(result.doc)
  closeData()
  showMessage(`Proyecto importado: ${elementCount()} elementos. Puedes deshacer.`)
})

// Events ---------------------------------------------------------------------------

for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => chooseTool(button.dataset.tool))
// Pressing the armed hand again puts it down.
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => setMode(button.dataset.mode === 'move' && state.mode === 'move' ? 'draw' : button.dataset.mode))
$('undo').addEventListener('click', undo)
$('redo').addEventListener('click', redo)
for (const button of document.querySelectorAll('[data-background]')) {
  button.addEventListener('click', () => {
    setBackground(button.dataset.background)
    markChanged()
    requestRender()
  })
}
$('custom-color-quick').addEventListener('input', (event) => setColor(event.target.value))
$('width-quick').addEventListener('input', (event) => {
  state.width = Number(event.target.value)
  if (state.tool === 'eraser') chooseTool('pen')
  refresh()
})
// Applying to the selection waits for the slider to settle: one history step.
$('width-quick').addEventListener('change', () => {
  if (state.selection) restyleSelection({ width: state.width })
})

$('zoom-in').addEventListener('click', () => zoomView(1.25))
$('zoom-out').addEventListener('click', () => zoomView(0.8))
$('zoom-reset').addEventListener('click', () => {
  if (busy()) return
  resetZoom(view)
  refresh()
  draw()
})

function zoomView(factor) {
  if (busy()) return
  closeTextEditor(true)
  if (zoomAt(view, factor, view.cssW / 2, view.cssH / 2)) {
    refresh()
    draw()
  }
}

// The view moves inside fixed bounds (the sheet cannot be dragged out of
// reach), by: the wheel or two-finger scroll, a drag in Mover mode, the
// middle button, or a drag with the space bar held. Ctrl or Cmd with the wheel
// (a trackpad pinch sends the same) zooms.
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    if (busy()) return
    closeTextEditor(true)
    const unit = event.deltaMode === 1 ? 16 : 1
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect()
      zoomAt(view, event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top)
    } else {
      panBy(view, -event.deltaX * unit, -event.deltaY * unit)
    }
    refresh()
    requestRender()
  },
  { passive: false },
)

// A middle-button press would start browser autoscroll.
canvas.addEventListener('mousedown', (event) => {
  if (event.button === 1) event.preventDefault()
})

canvas.addEventListener('pointerenter', () => (hover = true))
canvas.addEventListener('pointerleave', () => (hover = false))

canvas.addEventListener('dblclick', () => {
  if (state.tool !== 'select' || state.mode !== 'draw') return
  const spec = editSpec()
  if (spec) hooks.editText(spec)
})

const TOOL_KEYS = { v: 'select', p: 'pen', e: 'eraser', f: 'fill', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', b: 'diamond', t: 'text' }

document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
  if (event.key === 'Escape') {
    if (!$('extra-tools').hidden) { setMoreTools(false); $('more-tools').focus() }
    else if (historyOpen()) closeHistory(true)
    else if (menuOpen || openSection) { setSection(null); setMenu(false, true) }
    else if (!$('confirm').hidden) closeConfirm('clear')
    else if (dataOpen) closeData()
    else if (input.active) {
      input.cancel()
      showMessage('Interacción cancelada.')
    } else if (state.mode === 'move') {
      setMode('draw')
    } else if (state.selection) {
      state.selection = null
      refresh()
      requestRender()
    }
    return
  }
  if (typing || dataOpen || !$('confirm').hidden) return
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  const free = event.target === document.body || event.target === canvas
  // Space pans while the pointer is over the sheet, even if a button has focus.
  if (event.key === ' ' && (free || hover)) {
    state.space = true
    event.preventDefault()
    return
  }
  if (mod && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  } else if (mod && key === 'y') {
    event.preventDefault()
    redo()
  } else if (mod && key === 'a' && !busy()) {
    event.preventDefault()
    if (state.tool !== 'select' || state.mode !== 'draw') chooseTool('select')
    selectAll()
    refresh()
    requestRender()
  } else if (mod || event.altKey) {
    // Other shortcuts belong to the browser.
  } else if (key === 'delete' || key === 'backspace') {
    if (state.selection && !busy()) {
      event.preventDefault()
      deleteSelection()
    }
  } else if (key === 'enter') {
    const spec = state.selection && !busy() ? editSpec() : null
    if (spec) {
      event.preventDefault()
      hooks.editText(spec)
    }
  } else if (TOOL_KEYS[key]) chooseTool(TOOL_KEYS[key])
  else if (key === 'd') setMode('draw')
  else if (key === 'm') setMode('move')
  else if (key === 'n') chooseProcess('note')
})

document.addEventListener('keyup', (event) => {
  if (event.key !== ' ') return
  // A focused button would otherwise be pressed by the space bar's release.
  if (state.space) event.preventDefault()
  state.space = false
})

// A pending interaction never survives the panel being hidden or losing focus.
function dropPending() {
  state.space = false
  closeHistory()
  input.cancel()
  closeTextEditor(true)
  flushSave()
}

deska.on('visibility', ({ visible }) => {
  if (visible) layout(true)
  else dropPending()
})
window.addEventListener('blur', dropPending)
window.addEventListener('pagehide', flushSave)

// Start ----------------------------------------------------------------------------

buildPalette($('palette-quick'), () => {})
applyAppearance()
initArchivePanel({ apply: applyDocument, canOpen: () => !busy() })
initMermaidPanel({ touch: markChanged, afterInsert: () => { setSection(null); chooseTool('select') } })
syncMermaidPanel()
setSection(null)
setBackground(state.doc.background)
refresh()
layout()
$('app').removeAttribute('aria-busy')
