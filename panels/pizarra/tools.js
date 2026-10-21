// What a pointer does on the sheet, per tool: draw a stroke, erase whole items,
// drag out a shape, place text, select and move or resize, or pan the view.
// attachInput (input.js) owns the pointer lifecycle; this file is the handlers
// it calls, and the few operations on the selection the interface needs.

import { BOX_KINDS, CANVAS, LIMITS, LINE_KINDS, createShape, createStroke } from './model.js'
import { panBy } from './drawing.js'
import { computeFill } from './bucket.js'
import { processShape } from './objects.js'
import { boxFromDrag, handleCursor, handlesOf, hitShape, hitStroke, inRings, resizeShape, rotateShape, shapeCenter, shapeBounds, strokeBounds, translateItem } from './shapes.js'
import { appearance, commit, findItem, hooks, selectedRefs, selectionOf, state, view } from './state.js'

const STEP_PX = 0.9 // screen pixels between stored stroke points: dense enough to look smooth at any zoom, no denser than that
const ERASE_PX = 6 // screen pixels of slack around an item
const SELECT_PX = 5
const HANDLE_PX = 10
const CLICK_PX = 5 // a drag shorter than this is a click
const DEFAULT_BOX = { rect: [170, 96], ellipse: [140, 100], diamond: [170, 110] }

export const SHAPE_TOOLS = Object.freeze(['line', 'arrow', 'rect', 'ellipse', 'diamond'])

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** What render() needs besides the document. */
export function overlay() {
  const d = state.drag
  const replace = !d ? null : d.type === 'move' ? new Map(d.previews.map((item) => [item.id, item])) : new Map([[d.original.id, d.preview]])
  return {
    liveStroke: state.liveStroke,
    liveShape: state.liveShape,
    hidden: state.erase ? state.erase.ids : null,
    replace,
    selection: state.selection,
    marquee: state.marquee,
    appear: appearance(),
  }
}

// Erasing ------------------------------------------------------------------------

function eraseAt(x, y) {
  const reach = ERASE_PX / view.scale
  const ids = state.erase.ids
  let touched = false
  for (const s of state.doc.strokes) {
    if (hitStroke(s, x, y, reach)) {
      ids.add(s.id)
      touched = true
    }
  }
  for (const s of state.doc.shapes) {
    if (s.kind !== 'fill' && hitShape(s, x, y, reach, false)) {
      ids.add(s.id)
      touched = true
    }
  }
  // A painted area is under everything, so rubbing out a line drawn on it
  // leaves the paint; the paint goes only where nothing else is.
  if (!touched) for (const s of state.doc.shapes) if (s.kind === 'fill' && inRings(s.rings, x, y)) ids.add(s.id)
}

function eraseTo(point) {
  // Sample along the segment so a fast drag cannot skip over a thin line.
  const { last } = state.erase
  const steps = Math.max(1, Math.ceil(Math.hypot(point.x - last.x, point.y - last.y) / 4))
  for (let i = 1; i <= steps; i++) eraseAt(last.x + ((point.x - last.x) * i) / steps, last.y + ((point.y - last.y) * i) / steps)
  state.erase.last = { x: point.x, y: point.y }
}

function commitErase() {
  const ids = state.erase.ids
  state.erase = null
  if (!ids.size) return
  state.selection = selectionOf(selectedRefs(state.selection).filter((ref) => !ids.has(ref.id)))
  commit({ strokes: state.doc.strokes.filter((s) => !ids.has(s.id)), shapes: state.doc.shapes.filter((s) => !ids.has(s.id)) })
}

// Freehand ------------------------------------------------------------------------

function addPoint(point, minStep) {
  const pts = state.liveStroke.points
  const last = pts[pts.length - 1]
  if (pts.length >= LIMITS.pointsPerStroke) return
  if (Math.hypot(point.x - last[0], point.y - last[1]) < minStep) return
  pts.push([point.x, point.y])
}

function finishStroke(point) {
  addPoint(point, 0.3)
  const live = state.liveStroke
  state.liveStroke = null
  commit({ strokes: [...state.doc.strokes, createStroke({ color: live.color, width: live.width, points: live.points })] })
}

// Shapes and text -------------------------------------------------------------------

function buildShape(kind, a, b) {
  if (state.processTool) return processShape(state.processTool, a, b)
  const style = { color: state.color, width: state.width, fill: state.fill, round: state.round, dash: state.dash }
  if (LINE_KINDS.includes(kind)) return createShape({ kind, points: [[a.x, a.y], [b.x, b.y]], ...style })
  const box = boxFromDrag(a, b)
  return createShape({ kind, ...box, w: Math.max(box.w, 1), h: Math.max(box.h, 1), ...style })
}

function addShape(shape) {
  if (state.doc.shapes.length >= LIMITS.shapes) {
    hooks.message(`La pizarra tiene el máximo de ${LIMITS.shapes} figuras.`, 'error')
    return
  }
  return commit({ shapes: [...state.doc.shapes, shape] })
}

// Shapes, lines, arrows, text and process objects place one item, then hand
// back the lasting tool that was in use before them (select, pen, eraser or
// fill). On the select tool the new item comes back selected.
export const ONE_SHOT_TOOLS = Object.freeze(['line', 'arrow', 'rect', 'ellipse', 'diamond', 'text'])

function returnToPreviousTool(placedId = null) {
  state.processTool = null
  state.tool = state.returnTool
  state.selection = placedId && state.tool === 'select' ? { kind: 'shape', id: placedId } : null
  hooks.refresh()
}

function placeShape(shape) {
  if (addShape(shape)) returnToPreviousTool(shape.id)
}

function finishCreate(point) {
  const { start, kind } = state.create
  state.create = null
  state.liveShape = null
  if (state.processTool) {
    const dragged = Math.hypot(point.px - start.px, point.py - start.py) >= CLICK_PX
    const shape = processShape(state.processTool, start, dragged ? point : null)
    if (shape && addShape(shape)) {
      // The label editor needs the new shape selected to find it.
      state.selection = { kind: 'shape', id: shape.id }
      const spec = editSpec()
      returnToPreviousTool(shape.id)
      if (spec && shape.kind !== 'arrow') hooks.editText({ ...spec, select: true })
    }
    return
  }
  if (kind === 'text') {
    hooks.editText({
      x: start.x,
      y: start.y,
      size: state.textSize,
      color: state.color,
      text: '',
      center: false,
      onCommit: (text) => addText(start.x, start.y, text),
    })
    returnToPreviousTool()
    return
  }
  const dragged = Math.hypot(point.px - start.px, point.py - start.py)
  if (dragged >= CLICK_PX) {
    placeShape(buildShape(kind, start, point))
    return
  }
  // A click makes a box of a default size around the point; a line needs a drag.
  if (!BOX_KINDS.includes(kind)) return
  const [w, h] = DEFAULT_BOX[kind]
  const x = clamp(start.x - w / 2, CANVAS.x, CANVAS.x + CANVAS.width - w)
  const y = clamp(start.y - h / 2, CANVAS.y, CANVAS.y + CANVAS.height - h)
  placeShape(createShape({ kind, x, y, w, h, color: state.color, width: state.width, fill: state.fill, round: state.round }))
}

export function addText(x, y, text) {
  const clean = text.replace(/\s+$/g, '')
  if (!clean) return
  if (state.doc.shapes.length >= LIMITS.shapes) {
    hooks.message(`La pizarra tiene el máximo de ${LIMITS.shapes} figuras.`, 'error')
    return
  }
  const size = state.textSize
  addShape(
    createShape({
      kind: 'text',
      x: clamp(x, CANVAS.x, CANVAS.x + CANVAS.width - 24),
      y: clamp(y, CANVAS.y, CANVAS.y + CANVAS.height - size * 1.25),
      text: clean.slice(0, LIMITS.textLength),
      size,
      color: state.color,
      width: 1,
    }),
  )
}

// The paint bucket -------------------------------------------------------------------

const boxArea = (b) => (b.kind === 'ellipse' ? (Math.PI / 4) * b.w * b.h : b.kind === 'diamond' ? (b.w * b.h) / 2 : b.w * b.h)

function paintBox(box) {
  // The same color again takes the paint off.
  const fillColor = box.fillColor === state.color ? undefined : state.color
  commit(replaceItem('shape', createShape({ ...box, fillColor })))
}

/** Paints the area under the point: a box takes the color on its whole inside;
 *  any other closed area (drawn by hand, or made of lines and boxes) becomes a
 *  painted polygon. Painting an area again recolors it, and the same color
 *  takes it off. */
function bucket(point) {
  const { x, y } = point
  let box = null
  const shapes = state.doc.shapes
  for (let i = shapes.length - 1; i >= 0 && !box; i--) {
    if (BOX_KINDS.includes(shapes[i].kind) && hitShape(shapes[i], x, y, 0, true)) box = shapes[i]
  }
  const region = computeFill(state.doc, x, y)
  if (region.status === 'ok') {
    const same = [...shapes].reverse().find((s) => {
      if (s.kind !== 'fill' || !inRings(s.rings, x, y)) return false
      const b = shapeBounds(s)
      const r = region.bounds
      return Math.abs(b.x - r.x1) < 8 && Math.abs(b.y - r.y1) < 8 && Math.abs(b.x + b.w - r.x2) < 8 && Math.abs(b.y + b.h - r.y2) < 8
    })
    if (same) {
      if (same.color === state.color) commit({ shapes: shapes.filter((s) => s.id !== same.id) })
      else commit(replaceItem('shape', createShape({ ...same, color: state.color })))
      return
    }
    // A box whose inside is nearly the whole area is painted as a box (it stays one
    // editable thing); a smaller area drawn inside it is painted on its own.
    if (box && region.area >= 0.6 * boxArea(box)) return paintBox(box)
    if (shapes.length >= LIMITS.shapes) return hooks.message(`La pizarra tiene el máximo de ${LIMITS.shapes} figuras.`, 'error')
    commit({ shapes: [...shapes, createShape({ kind: 'fill', rings: region.rings, color: state.color, width: 1 })] })
    return
  }
  if (box) return paintBox(box)
  hooks.message(region.status === 'open' ? 'El área no está cerrada: no se puede rellenar.' : 'Toca dentro de un área, no sobre una línea.', 'error')
}

// Selecting, moving, resizing -----------------------------------------------------------

function pickItem(x, y) {
  const reach = SELECT_PX / view.scale
  const strokes = state.doc.strokes
  for (let i = strokes.length - 1; i >= 0; i--) if (hitStroke(strokes[i], x, y, reach)) return { kind: 'stroke', item: strokes[i] }
  const shapes = state.doc.shapes
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].kind !== 'fill' && hitShape(shapes[i], x, y, reach, true)) return { kind: 'shape', item: shapes[i] }
  }
  for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i].kind === 'fill' && hitShape(shapes[i], x, y, reach, true)) return { kind: 'shape', item: shapes[i] }
  return null
}

const boundsOf = (kind, item) => (kind === 'stroke' ? strokeBounds(item) : shapeBounds(item))

function unionBounds(boxes) {
  const x1 = Math.min(...boxes.map((b) => b.x))
  const y1 = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.w))
  const y2 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Shift adds or removes the item under the pointer; a plain press on empty
 *  sheet starts a selection box, and on a selected item moves the whole selection. */
function beginSelect(point, additive) {
  const current = findItem(state.selection)
  if (!additive && current && state.selection.kind === 'shape') {
    const reach = HANDLE_PX / view.scale
    const handle = handlesOf(current, view.scale).find((h) => Math.hypot(point.x - h.x, point.y - h.y) <= reach)
    if (handle) {
      const center = shapeCenter(current)
      state.drag = { type: handle.id === 'rotate' ? 'rotate' : 'resize', handle: handle.id, original: current, preview: current, moved: false, startAngle: Math.atan2(point.y - center.y, point.x - center.x) }
      return true
    }
  }
  const refs = selectedRefs(state.selection)
  const hit = pickItem(point.x, point.y)
  if (!hit) {
    if (!additive && state.selection) {
      state.selection = null
      hooks.refresh()
    }
    state.marquee = { start: { x: point.x, y: point.y }, end: { x: point.x, y: point.y }, base: additive ? refs : [] }
    return true
  }
  const selected = refs.some((ref) => ref.id === hit.item.id)
  if (additive) {
    state.selection = selectionOf(selected ? refs.filter((ref) => ref.id !== hit.item.id) : [...refs, { kind: hit.kind, id: hit.item.id }])
    hooks.refresh()
    hooks.repaint()
    return false
  }
  if (!selected) state.selection = { kind: hit.kind, id: hit.item.id }
  const items = selectedRefs(state.selection).map((ref) => ({ kind: ref.kind, item: findItem(ref) })).filter((entry) => entry.item)
  state.drag = {
    type: 'move',
    start: { x: point.x, y: point.y },
    items,
    bounds: unionBounds(items.map((entry) => boundsOf(entry.kind, entry.item))),
    previews: items.map((entry) => entry.item),
    moved: false,
  }
  hooks.refresh()
  return true
}

/** Everything wholly inside the box joins the selection, as on a desktop. */
function finishMarquee(point) {
  const { start, base } = state.marquee
  state.marquee = null
  const box = boxFromDrag(start, point)
  if (Math.max(box.w, box.h) * view.scale < CLICK_PX) return
  const inside = (b) => b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h
  const refs = [...base]
  for (const s of state.doc.shapes) if (inside(shapeBounds(s)) && !refs.some((r) => r.id === s.id)) refs.push({ kind: 'shape', id: s.id })
  for (const s of state.doc.strokes) if (inside(strokeBounds(s)) && !refs.some((r) => r.id === s.id)) refs.push({ kind: 'stroke', id: s.id })
  state.selection = selectionOf(refs)
}

/** Selects every stroke and shape (Ctrl+A). */
export function selectAll() {
  state.selection = selectionOf([...state.doc.shapes.map((s) => ({ kind: 'shape', id: s.id })), ...state.doc.strokes.map((s) => ({ kind: 'stroke', id: s.id }))])
}

function moveDrag(point) {
  const d = state.drag
  if (d.type === 'move') {
    const dx = point.x - d.start.x
    const dy = point.y - d.start.y
    // The selection moves as one: the step is clamped so all of it stays on the sheet.
    const b = d.bounds
    const sx = clamp(dx, CANVAS.x - b.x, CANVAS.x + CANVAS.width - (b.x + b.w))
    const sy = clamp(dy, CANVAS.y - b.y, CANVAS.y + CANVAS.height - (b.y + b.h))
    d.previews = d.items.map((entry) => translateItem(entry.item, sx, sy, entry.kind === 'stroke'))
    d.moved = d.moved || Math.hypot(dx, dy) * view.scale > 2
  } else if (d.type === 'rotate') {
    const center = shapeCenter(d.original)
    const delta = Math.atan2(point.y - center.y, point.x - center.x) - d.startAngle
    d.preview = rotateShape(d.original, (d.original.angle || 0) + delta)
    d.moved = d.moved || Math.abs(delta) > 0.001
  } else {
    d.preview = resizeShape(d.original, d.handle, point.x, point.y)
    d.moved = d.moved || JSON.stringify(d.preview) !== JSON.stringify(d.original)
  }
}

function replaceItem(kind, item) {
  const key = kind === 'stroke' ? 'strokes' : 'shapes'
  return { [key]: state.doc[key].map((i) => (i.id === item.id ? item : i)) }
}

/** One commit that swaps in new versions of several items. */
function replaceItems(items) {
  const next = new Map(items.map((item) => [item.id, item]))
  return {
    strokes: state.doc.strokes.map((i) => next.get(i.id) || i),
    shapes: state.doc.shapes.map((i) => next.get(i.id) || i),
  }
}

function finishDrag() {
  const d = state.drag
  state.drag = null
  if (!d.moved) return
  commit(d.type === 'move' ? replaceItems(d.previews) : replaceItem('shape', d.preview))
}

// Handlers for attachInput ----------------------------------------------------------

export function createHandlers(canvas, locate) {
  const cursorAt = (point) => {
    if (state.mode === 'move' || state.space || state.tool !== 'select') return ''
    const current = findItem(state.selection)
    const handle = current && state.selection.kind === 'shape'
      ? handlesOf(current, view.scale).find(h => Math.hypot(point.x - h.x, point.y - h.y) <= HANDLE_PX / view.scale)
      : null
    return handle ? handleCursor(current, handle.id) : pickItem(point.x, point.y) ? 'move' : 'default'
  }
  const endPan = () => {
    canvas.style.cursor = ''
    // The hand stays armed until another tool, the hand button again or Escape;
    // Space, middle- and right-button panning leave the drawing tool and mode intact.
    state.pan = null
    canvas.classList.remove('is-panning')
  }
  const reset = () => {
    endPan()
    state.liveStroke = null
    state.liveShape = null
    state.erase = null
    state.drag = null
    state.marquee = null
    state.create = null
  }

  return {
    locate,
    hover(point) { canvas.style.cursor = cursorAt(point) },

    begin(point, event) {
      // The right button has no menu here, so it pans like the middle one.
      const panButton = event && event.pointerType === 'mouse' && (event.button === 1 || event.button === 2)
      if (state.mode === 'move' || state.space || panButton) {
        state.pan = { px: point.px, py: point.py }
        canvas.classList.add('is-panning')
        return true
      }
      if (event && event.pointerType === 'mouse' && event.button !== 0) return false
      if (!point.inside) {
        if (state.tool === 'select' && state.selection) {
          state.selection = null
          hooks.refresh()
          hooks.repaint()
        }
        return false
      }
      const tool = state.tool
      if (tool === 'fill') {
        bucket(point)
        return false
      }
      if (tool === 'pen') {
        if (state.doc.strokes.length >= LIMITS.strokes) {
          hooks.message(`La pizarra tiene el máximo de ${LIMITS.strokes} trazos.`, 'error')
          return false
        }
        state.liveStroke = { color: state.color, width: state.width, points: [[point.x, point.y]] }
      } else if (tool === 'eraser') {
        state.erase = { ids: new Set(), last: { x: point.x, y: point.y } }
        eraseAt(point.x, point.y)
      } else if (tool === 'select') {
        if (!beginSelect(point, !!(event && event.shiftKey))) return false
        const d = state.drag
        canvas.style.cursor = !d ? 'crosshair' : d.type === 'rotate' ? 'grabbing' : d.type === 'resize' ? handleCursor(d.original, d.handle) : 'move'
      } else {
        state.create = { start: { x: point.x, y: point.y, px: point.px, py: point.py }, kind: tool }
      }
      hooks.repaint()
      return true
    },

    move(points) {
      for (const point of points) {
        if (state.pan) {
          panBy(view, point.px - state.pan.px, point.py - state.pan.py)
          state.pan = { px: point.px, py: point.py }
        } else if (state.liveStroke) addPoint(point, Math.min(8, Math.max(0.4, STEP_PX / view.scale)))
        else if (state.erase) eraseTo(point)
        else if (state.drag) moveDrag(point)
        else if (state.marquee) state.marquee.end = { x: point.x, y: point.y }
        else if (state.create && state.create.kind !== 'text') {
          const { start, kind } = state.create
          state.liveShape = Math.hypot(point.px - start.px, point.py - start.py) >= CLICK_PX ? buildShape(kind, start, point) : null
        }
      }
      hooks.repaint()
    },

    end(point) {
      canvas.style.cursor = ''
      if (state.pan) endPan()
      else if (state.liveStroke) finishStroke(point)
      else if (state.erase) {
        eraseTo(point)
        commitErase()
      } else if (state.drag) {
        moveDrag(point)
        finishDrag()
      } else if (state.marquee) finishMarquee(point)
      else if (state.create) finishCreate(point)
      hooks.repaint()
      hooks.refresh()
    },

    cancel() {
      reset()
      hooks.refresh()
      hooks.repaint()
    },
  }
}

// Operations on the selection -----------------------------------------------------------

export function deleteSelection() {
  const ids = new Set(selectedRefs(state.selection).filter((ref) => findItem(ref)).map((ref) => ref.id))
  if (!ids.size) return false
  state.selection = null
  return commit({ strokes: state.doc.strokes.filter((i) => !ids.has(i.id)), shapes: state.doc.shapes.filter((i) => !ids.has(i.id)) })
}

/** The item with { color, width, size, fill, round, dash } applied where they make sense, or null. */
function restyled(kind, item, patch) {
  const next = {}
  if (patch.color) next.color = patch.color
  if (patch.width) next.width = patch.width
  if (kind === 'stroke') return Object.keys(next).length ? createStroke({ ...item, ...next }) : null
  if (patch.size && (item.kind === 'text' || item.text)) next.size = patch.size
  if (BOX_KINDS.includes(item.kind) && typeof patch.fill === 'boolean') {
    next.fill = patch.fill
    next.fillColor = undefined
  }
  if (item.kind === 'rect' && typeof patch.round === 'boolean') next.round = patch.round
  if (LINE_KINDS.includes(item.kind) && typeof patch.dash === 'boolean') next.dash = patch.dash
  return Object.keys(next).length ? createShape({ ...item, ...next }) : null
}

/** Applies a style patch to everything selected, as one undo step. */
export function restyleSelection(patch) {
  const changed = selectedRefs(state.selection)
    .map((ref) => { const item = findItem(ref); return item && restyled(ref.kind, item, patch) })
    .filter(Boolean)
  if (!changed.length) return false
  return commit(replaceItems(changed))
}

/** What the text editor needs to edit the selected item's text, or null. */
export function editSpec() {
  const sel = state.selection
  const item = findItem(sel)
  if (!item || sel.kind !== 'shape' || item.kind === 'fill') return null
  let x
  let y
  let center = true
  if (item.kind === 'text') {
    x = item.x
    y = item.y
    center = false
  } else if (LINE_KINDS.includes(item.kind)) {
    x = (item.points[0][0] + item.points[1][0]) / 2
    y = (item.points[0][1] + item.points[1][1]) / 2
  } else {
    x = item.x + item.w / 2
    y = item.y + item.h / 2
  }
  return {
    x,
    y,
    size: item.size || (item.kind === 'text' ? state.textSize : 22),
    color: item.color,
    text: item.text || '',
    center,
    angle: item.angle || 0,
    rotationCenter: item.angle ? shapeCenter(item) : null,
    onCommit: (text) => setItemText(item.id, text),
  }
}

function setItemText(id, text) {
  const item = state.doc.shapes.find((s) => s.id === id)
  if (!item) return
  const clean = text.replace(/\s+$/g, '').slice(0, LIMITS.textLength)
  if (item.kind === 'text' && !clean) {
    state.selection = null
    commit({ shapes: state.doc.shapes.filter((s) => s.id !== id) })
    return
  }
  if ((item.text || '') === clean) return
  commit(replaceItem('shape', createShape({ ...item, text: clean || undefined })))
}
