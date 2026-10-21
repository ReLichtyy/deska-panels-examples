// The one place that holds the live state of the board and the single way
// to change the document (commit), so history, size limits and saving are
// handled once. app.js fills in `hooks`; everything else only calls them.

import { DEFAULT_COLOR, DEFAULT_TEXT_SIZE, DEFAULT_WIDTH, emptyDocument } from './model.js'
import { createView } from './drawing.js'
import { createHistory } from './history.js'
import { tooBig } from './transfer.js'

export const view = createView()
export const history = createHistory()

export const state = {
  doc: emptyDocument(),
  tool: 'select', // select pen eraser line arrow rect ellipse diamond text
  processTool: null, // armed process object; created only on the canvas
  returnTool: 'select', // the lasting tool a one-shot tool hands back to after placing
  fill: false,
  round: false,
  dash: false,
  mode: 'draw', // draw (use the tool) or move (pan the sheet)
  color: DEFAULT_COLOR,
  width: DEFAULT_WIDTH,
  textSize: DEFAULT_TEXT_SIZE,
  selection: null, // one item { kind: 'stroke' | 'shape', id } or several { kind: 'group', items: [{ kind, id }] }
  marquee: null, // select tool dragging over empty sheet: { start: {x, y}, end: {x, y} }
  // What a pointer interaction is doing right now. At most one is set.
  liveStroke: null,
  liveShape: null,
  erase: null, // { ids: Set, last: {x, y} }
  drag: null, // select tool: { type: 'move' | 'group' | 'resize' | 'rotate', ... }
  create: null, // shape tools: { start, kind }
  pan: null, // { px, py }
  space: false, // the space bar is held: drags pan
  appear: null, // { ids: Set, start } shapes fading in
}

export const hooks = {
  changed() {},
  repaint() {},
  refresh() {},
  message() {},
  editText() {},
}

export function snapshot() {
  return { strokes: state.doc.strokes, shapes: state.doc.shapes }
}

/** Swaps in a snapshot and drops a selection that no longer exists. */
export function applySnapshot(snap) {
  state.doc.strokes = snap.strokes
  state.doc.shapes = snap.shapes
  state.selection = selectionOf(selectedRefs(state.selection).filter((ref) => (ref.kind === 'stroke' ? snap.strokes : snap.shapes).some((i) => i.id === ref.id)))
}

/** The only way to change what the document holds. `next` may carry strokes,
 *  shapes or both; what it leaves out stays. Returns false (and says why) when
 *  the result would not fit in storage. */
export function commit(next) {
  const candidate = { ...state.doc, strokes: next.strokes ?? state.doc.strokes, shapes: next.shapes ?? state.doc.shapes }
  if (tooBig(candidate)) {
    hooks.message('No cabe más en la pizarra: se llegó al límite de almacenamiento. Borra o deshaz algo.', 'error')
    return false
  }
  history.record(snapshot())
  state.doc.strokes = candidate.strokes
  state.doc.shapes = candidate.shapes
  hooks.changed()
  return true
}

const APPEAR_MS = 240
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** New shapes fade and grow in for a moment, unless motion is turned down. */
export function announce(ids) {
  if (calm() || !ids.length) return
  state.appear = { ids: new Set(ids), start: performance.now() }
  hooks.repaint()
}

/** Progress of the fade-in as { ids, p } (eased), or null when it is over. */
export function appearance() {
  const a = state.appear
  if (!a) return null
  const t = (performance.now() - a.start) / APPEAR_MS
  if (t >= 1) {
    state.appear = null
    return null
  }
  return { ids: a.ids, p: 1 - (1 - t) ** 3 }
}

export function elementCount() {
  return state.doc.strokes.length + state.doc.shapes.length
}

/** The items a selection stands for, one or several. */
export function selectedRefs(selection) {
  if (!selection) return []
  return selection.kind === 'group' ? selection.items : [selection]
}

/** The selection for a list of item refs: none, one item, or a group. */
export function selectionOf(refs) {
  if (!refs.length) return null
  if (refs.length === 1) return { kind: refs[0].kind, id: refs[0].id }
  return { kind: 'group', items: refs.map(({ kind, id }) => ({ kind, id })) }
}

/** A stable key for "what is selected", for noticing changes. */
export function selectionKey(selection) {
  return selectedRefs(selection).map((ref) => ref.id).join(' ') || null
}

/** Finds a stroke or shape by id; null for a group, which is not one item. */
export function findItem(selection) {
  if (!selection || selection.kind === 'group') return null
  const list = selection.kind === 'stroke' ? state.doc.strokes : state.doc.shapes
  return list.find((i) => i.id === selection.id) || null
}
