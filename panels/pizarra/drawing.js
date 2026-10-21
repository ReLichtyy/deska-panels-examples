// Everything about putting the document on the canvas: the fit of the
// 1200 x 800 sheet into the panel (with zoom and pan), pointer to sheet
// coordinates, and rendering from data. Nothing here owns state beyond the
// view object it is given.

import { CANVAS, LABEL_SIZE, LINE_KINDS, SHEET } from './model.js'
import { fontFor, textMetrics } from './text.js'
import { handlesOf, localBounds, shapeCenter, shapeBounds, strokeBounds } from './shapes.js'

import { SURFACES, adaptColor } from './theme.js'

// The mode drawn in: set by the interface when the theme changes.
let mode = 'light'
let FRAME = SURFACES.light.frame
let PAPER = SURFACES.light.paper
let DOT = SURFACES.light.dot
let LINE = SURFACES.light.line
let SELECT = SURFACES.light.select

export function setRenderMode(next, surfaces = SURFACES[next === 'dark' ? 'dark' : 'light']) {
  mode = next === 'dark' ? 'dark' : 'light'
  ;({ frame: FRAME, paper: PAPER, dot: DOT, line: LINE, select: SELECT } = surfaces)
}

export const renderMode = () => mode

// Lines stay visible when the drawing is small on screen. A stroke 4 units wide
// at 30% zoom would be half a pixel: faint, grey and broken. So no line is drawn
// thinner than MIN_LINE_PX on screen (thicker ones keep their width), and
// arrowheads keep a minimum size too. `unit` is one screen pixel in canvas
// units, set at the start of every render.
const MIN_LINE_PX = 1.5
const MIN_HEAD_PX = 9
let unit = 1
const lineWidth = (w) => Math.max(w, MIN_LINE_PX * unit)
const SPACING = 40
const MARGIN = 10

// Zoom is relative to the fit of the home page: 1 is the panel opening, below
// 1 shows more of the canvas, above 1 less.
export const ZOOM = Object.freeze({ min: 0.3, max: 6 })

export function createView() {
  return { cssW: 0, cssH: 0, dpr: 1, base: 1, zoom: 1, panX: 0, panY: 0, scale: 1, ox: 0, oy: 0 }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** Derives scale and origin from base fit, zoom and pan. The origin is where
 *  logical (0, 0), the corner of the home page, lands on screen. Pan is kept
 *  so the canvas can never be dragged out of reach: it either stays centered
 *  when it is smaller than the panel, or its edges stop at the panel's. */
function place(view) {
  view.scale = view.base * view.zoom
  const homeX = (view.cssW - SHEET.width * view.scale) / 2
  const homeY = (view.cssH - SHEET.height * view.scale) / 2
  const fitAxis = (size, extent, origin, home, pan) => {
    const span = extent * view.scale
    const start = home + pan // where logical 0 lands before clamping
    if (span <= size - 2 * MARGIN) return (size - span) / 2 - origin * view.scale
    return clamp(start, size - MARGIN - span - origin * view.scale, MARGIN - origin * view.scale)
  }
  view.ox = fitAxis(view.cssW, CANVAS.width, CANVAS.x, homeX, view.panX)
  view.oy = fitAxis(view.cssH, CANVAS.height, CANVAS.y, homeY, view.panY)
  view.panX = view.ox - homeX
  view.panY = view.oy - homeY
}

/** Fits the home page inside a cssW x cssH box, centered, without distorting
 *  it. Zoom and pan survive a resize. */
export function fitView(view, cssW, cssH, dpr) {
  view.cssW = cssW
  view.cssH = cssH
  view.dpr = dpr
  view.base = Math.max(0.01, Math.min((cssW - 2 * MARGIN) / SHEET.width, (cssH - 2 * MARGIN) / SHEET.height))
  place(view)
}

export function panBy(view, dx, dy) {
  view.panX += dx
  view.panY += dy
  place(view)
}

/** Zooms by `factor` keeping the canvas point under (cx, cy) in place.
 *  Returns false when already at the limit. */
export function zoomAt(view, factor, cx, cy) {
  const zoom = clamp(view.zoom * factor, ZOOM.min, ZOOM.max)
  if (zoom === view.zoom) return false
  const lx = (cx - view.ox) / view.scale
  const ly = (cy - view.oy) / view.scale
  view.zoom = zoom
  view.scale = view.base * zoom
  view.panX = cx - lx * view.scale - (view.cssW - SHEET.width * view.scale) / 2
  view.panY = cy - ly * view.scale - (view.cssH - SHEET.height * view.scale) / 2
  place(view)
  return true
}

/** Back to the home page, fitted. */
export function resetZoom(view) {
  view.zoom = 1
  view.panX = 0
  view.panY = 0
  place(view)
}

/** The canvas point at the middle of the panel, in logical units. */
export function viewCenter(view) {
  return { x: (view.cssW / 2 - view.ox) / view.scale, y: (view.cssH / 2 - view.oy) / view.scale }
}

/** Sizes the bitmap to the CSS box times devicePixelRatio. Clears the canvas. */
export function sizeBitmap(canvas, view) {
  const w = Math.max(1, Math.round(view.cssW * view.dpr))
  const h = Math.max(1, Math.round(view.cssH * view.dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
}

/** Client coordinates to canvas coordinates. `inside` says whether the raw
 *  point fell on the canvas; x and y are clamped onto it either way. px and py
 *  are the same point in CSS pixels of the canvas, for panning. */
export function toLogical(view, rect, clientX, clientY) {
  const kx = rect.width ? view.cssW / rect.width : 1
  const ky = rect.height ? view.cssH / rect.height : 1
  const px = (clientX - rect.left) * kx
  const py = (clientY - rect.top) * ky
  const rx = (px - view.ox) / view.scale
  const ry = (py - view.oy) / view.scale
  return {
    x: clamp(rx, CANVAS.x, CANVAS.x + CANVAS.width),
    y: clamp(ry, CANVAS.y, CANVAS.y + CANVAS.height),
    px,
    py,
    inside: rx >= CANVAS.x && rx <= CANVAS.x + CANVAS.width && ry >= CANVAS.y && ry <= CANVAS.y + CANVAS.height,
  }
}

// Drawing items ---------------------------------------------------------------------

function drawStroke(ctx, stroke) {
  const pts = stroke.points
  const ink = adaptColor(stroke.color, mode)
  ctx.strokeStyle = ink
  ctx.fillStyle = ink
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0][0], pts[0][1], lineWidth(stroke.width) / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.lineWidth = lineWidth(stroke.width)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  traceStroke(ctx, pts)
  ctx.stroke()
}

/** Adds a freehand line to the current path, smoothed through its midpoints. */
export function traceStroke(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2
    const my = (pts[i][1] + pts[i + 1][1]) / 2
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last[0], last[1])
}

/** Starts a new path with the outline of a rectangle, circle or diamond. */
export function traceBox(ctx, shape) {
  const { x, y, w, h } = shape
  ctx.beginPath()
  if (shape.kind === 'rect') {
    if (shape.round) roundedRect(ctx, x, y, w, h, Math.min(h / 2, 18))
    else ctx.rect(x, y, w, h)
  } else if (shape.kind === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  } else {
    ctx.moveTo(x + w / 2, y)
    ctx.lineTo(x + w, y + h / 2)
    ctx.lineTo(x + w / 2, y + h)
    ctx.lineTo(x, y + h / 2)
    ctx.closePath()
  }
}

function drawLines(ctx, text, size, cx, cy, align) {
  const m = textMetrics(text, size)
  ctx.font = fontFor(size)
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  let y = cy - m.h / 2 + m.lineHeight / 2
  for (const line of m.lines) {
    ctx.fillText(line, cx, y)
    y += m.lineHeight
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + k, y)
  ctx.arcTo(x + w, y, x + w, y + h, k)
  ctx.arcTo(x + w, y + h, x, y + h, k)
  ctx.arcTo(x, y + h, x, y, k)
  ctx.arcTo(x, y, x + w, y, k)
  ctx.closePath()
}

function arrowHead(ctx, from, to, width) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0])
  const len = Math.max(12, width * 4.5, MIN_HEAD_PX * unit)
  ctx.beginPath()
  ctx.moveTo(to[0], to[1])
  ctx.lineTo(to[0] - len * Math.cos(angle - 0.4), to[1] - len * Math.sin(angle - 0.4))
  ctx.lineTo(to[0] - len * Math.cos(angle + 0.4), to[1] - len * Math.sin(angle + 0.4))
  ctx.closePath()
  ctx.fill()
}

/** Used by rendering and bucket rasterization so rotation has one geometry. */
export function applyShapeRotation(ctx, shape) {
  if (!shape.angle) return
  const c = shapeCenter(shape)
  ctx.translate(c.x, c.y)
  ctx.rotate(shape.angle)
  ctx.translate(-c.x, -c.y)
}

function drawShape(ctx, shape) {
  ctx.save()
  applyShapeRotation(ctx, shape)
  drawLocalShape(ctx, shape)
  ctx.restore()
}

function drawLocalShape(ctx, shape) {
  if (shape.kind === 'fill') {
    ctx.beginPath()
    for (const ring of shape.rings) {
      ctx.moveTo(ring[0][0], ring[0][1])
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1])
      ctx.closePath()
    }
    ctx.fillStyle = adaptColor(shape.color, mode)
    ctx.fill('evenodd')
    return
  }
  const ink = adaptColor(shape.color, mode)
  ctx.strokeStyle = ink
  ctx.fillStyle = ink
  const lw = lineWidth(shape.width)
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])

  if (shape.kind === 'text') {
    drawLines(ctx, shape.text, shape.size, shape.x, shape.y + (textMetrics(shape.text, shape.size).h) / 2, 'left')
    return
  }

  if (LINE_KINDS.includes(shape.kind)) {
    const [a, b] = shape.points
    if (shape.dash) ctx.setLineDash([lw * 3, lw * 2.5])
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
    ctx.setLineDash([])
    if (shape.kind === 'arrow') arrowHead(ctx, a, b, lw)
    if (shape.text) {
      const size = shape.size || LABEL_SIZE
      const m = textMetrics(shape.text, size)
      const cx = (a[0] + b[0]) / 2
      const cy = (a[1] + b[1]) / 2
      ctx.fillStyle = PAPER
      ctx.fillRect(cx - m.w / 2 - 4, cy - m.h / 2 - 2, m.w + 8, m.h + 4)
      ctx.fillStyle = ink
      drawLines(ctx, shape.text, size, cx, cy, 'center')
    }
    return
  }

  const { x, y, w, h } = shape
  traceBox(ctx, shape)
  if (shape.fillColor) {
    // The bucket: the whole inside, one solid color.
    ctx.save()
    ctx.fillStyle = adaptColor(shape.fillColor, mode)
    ctx.fill()
    ctx.restore()
  } else if (shape.fill) {
    ctx.save()
    ctx.globalAlpha = 0.16
    ctx.fill()
    ctx.restore()
  }
  ctx.stroke()
  if (shape.text) drawLines(ctx, shape.text, shape.size || LABEL_SIZE, x + w / 2, y + h / 2, 'center')
}

function drawSelection(ctx, view, item, isStroke) {
  const b = isStroke ? strokeBounds(item) : localBounds(item)
  const u = 1 / view.scale
  ctx.save()
  ctx.strokeStyle = SELECT
  ctx.fillStyle = PAPER
  ctx.lineWidth = u
  ctx.setLineDash([])
  ctx.save()
  if (!isStroke) applyShapeRotation(ctx, item)
  ctx.strokeRect(b.x, b.y, b.w, b.h)
  ctx.restore()
  if (!isStroke) {
    for (const hnd of handlesOf(item, view.scale)) {
      ctx.beginPath()
      if (hnd.id === 'rotate') ctx.arc(hnd.x, hnd.y, 4 * u, 0, Math.PI * 2)
      else ctx.rect(hnd.x - 4 * u, hnd.y - 4 * u, 8 * u, 8 * u)
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** Several items: a light outline on each and one box around them all, no handles. */
function drawGroupSelection(ctx, view, entries) {
  if (!entries.length) return
  const u = 1 / view.scale
  ctx.save()
  ctx.strokeStyle = SELECT
  ctx.lineWidth = u
  ctx.setLineDash([4 * u, 3 * u])
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const { ref, item } of entries) {
    const isStroke = ref.kind === 'stroke'
    const b = isStroke ? strokeBounds(item) : localBounds(item)
    ctx.save()
    if (!isStroke) applyShapeRotation(ctx, item)
    ctx.strokeRect(b.x, b.y, b.w, b.h)
    ctx.restore()
    const outer = isStroke ? b : shapeBounds(item)
    x1 = Math.min(x1, outer.x)
    y1 = Math.min(y1, outer.y)
    x2 = Math.max(x2, outer.x + outer.w)
    y2 = Math.max(y2, outer.y + outer.h)
  }
  ctx.setLineDash([])
  const pad = 6 * u
  ctx.strokeRect(x1 - pad, y1 - pad, x2 - x1 + 2 * pad, y2 - y1 + 2 * pad)
  ctx.restore()
}

/** The selection box being dragged on empty sheet. */
function drawMarquee(ctx, view, { start, end }) {
  const u = 1 / view.scale
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const w = Math.abs(start.x - end.x)
  const h = Math.abs(start.y - end.y)
  ctx.save()
  ctx.fillStyle = SELECT
  ctx.globalAlpha = 0.1
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = 1
  ctx.strokeStyle = SELECT
  ctx.lineWidth = u
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

/** The visible part of the canvas in logical units, so the pattern is only
 *  drawn where someone can see it. */
function visibleRect(view) {
  const x1 = Math.max(CANVAS.x, (0 - view.ox) / view.scale)
  const y1 = Math.max(CANVAS.y, (0 - view.oy) / view.scale)
  const x2 = Math.min(CANVAS.x + CANVAS.width, (view.cssW - view.ox) / view.scale)
  const y2 = Math.min(CANVAS.y + CANVAS.height, (view.cssH - view.oy) / view.scale)
  return { x1, y1, x2, y2 }
}

function drawBackground(ctx, view, background) {
  const v = visibleRect(view)
  const firstX = Math.ceil(v.x1 / SPACING) * SPACING
  const firstY = Math.ceil(v.y1 / SPACING) * SPACING
  if (background === 'dots') {
    ctx.fillStyle = DOT
    const r = Math.max(1.6, 1.1 / view.scale)
    for (let x = firstX; x <= v.x2; x += SPACING) {
      for (let y = firstY; y <= v.y2; y += SPACING) {
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else if (background === 'grid') {
    ctx.strokeStyle = LINE
    ctx.lineWidth = Math.max(1, 0.9 / view.scale)
    ctx.beginPath()
    for (let x = firstX; x <= v.x2; x += SPACING) {
      ctx.moveTo(x, v.y1)
      ctx.lineTo(x, v.y2)
    }
    for (let y = firstY; y <= v.y2; y += SPACING) {
      ctx.moveTo(v.x1, y)
      ctx.lineTo(v.x2, y)
    }
    ctx.stroke()
  }
}

/** The scene: frame, paper, background, shapes, then strokes. Items outside
 *  the visible part of the canvas are not drawn. `replace` swaps items (a drag
 *  preview), `hidden` skips ids (the eraser), `appear` fades new shapes in. */
function drawScene(ctx, view, doc, replace, hidden, appear) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = FRAME
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const k = view.dpr * view.scale
  ctx.setTransform(k, 0, 0, k, view.dpr * view.ox, view.dpr * view.oy)
  ctx.save()
  ctx.beginPath()
  ctx.rect(CANVAS.x, CANVAS.y, CANVAS.width, CANVAS.height)
  ctx.clip()
  ctx.fillStyle = PAPER
  ctx.fillRect(CANVAS.x, CANVAS.y, CANVAS.width, CANVAS.height)
  drawBackground(ctx, view, doc.background)

  const v = visibleRect(view)
  const seen = (b) => b.x <= v.x2 && b.x + b.w >= v.x1 && b.y <= v.y2 && b.y + b.h >= v.y1
  const pick = (item) => (replace && replace.has(item.id) ? replace.get(item.id) : item)

  // Painted areas first, so lines, labels and boxes stay on top of them.
  for (const original of [...doc.shapes.filter((s) => s.kind === 'fill'), ...doc.shapes.filter((s) => s.kind !== 'fill')]) {
    if (hidden && hidden.has(original.id)) continue
    const shape = pick(original)
    const b = shapeBounds(shape)
    if (!seen(b)) continue
    if (appear && appear.ids.has(shape.id)) {
      ctx.save()
      ctx.globalAlpha = appear.p
      const scale = 0.88 + 0.12 * appear.p
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      ctx.translate(cx, cy)
      ctx.scale(scale, scale)
      ctx.translate(-cx, -cy)
      drawShape(ctx, shape)
      ctx.restore()
    } else drawShape(ctx, shape)
  }
  for (const original of doc.strokes) {
    if (hidden && hidden.has(original.id)) continue
    const stroke = pick(original)
    if (seen(strokeBounds(stroke))) drawStroke(ctx, stroke)
  }
  ctx.restore()
}

// What does not change while drawing (everything already committed) is kept as
// an image, so a stroke in progress costs one blit and one new stroke, not a
// redraw of the whole drawing on every pointer move.
const sceneCache = new WeakMap()

/** Redraws everything from data, shapes first and freehand strokes over them.
 *  overlay (all optional):
 *    liveStroke, liveShape  what is being drawn right now
 *    hidden                 Set of ids the eraser has marked
 *    replace                Map of id -> item drawn instead (a drag preview)
 *    selection              { kind: 'stroke' | 'shape', id } or { kind: 'group', items }
 *    marquee                { start, end } selection box being dragged
 *    appear                 { ids: Set, p: 0..1 } shapes fading in
 *    cache                  false to always draw directly (thumbnails) */
export function render(ctx, view, doc, overlay = {}) {
  const { liveStroke = null, liveShape = null, hidden = null, replace = null, selection = null, marquee = null, appear = null, cache = true } = overlay
  const canvas = ctx.canvas
  unit = 1 / view.scale
  if (!cache || hidden || replace || appear) {
    drawScene(ctx, view, doc, replace, hidden, appear)
  } else {
    let entry = sceneCache.get(canvas)
    if (!entry) {
      const layer = document.createElement('canvas')
      entry = { layer, ctx: layer.getContext('2d'), key: '', strokes: null, shapes: null }
      sceneCache.set(canvas, entry)
    }
    if (entry.layer.width !== canvas.width || entry.layer.height !== canvas.height) {
      entry.layer.width = canvas.width
      entry.layer.height = canvas.height
      entry.key = ''
    }
    const key = [view.scale, view.ox, view.oy, view.dpr, view.cssW, view.cssH, doc.background, mode, FRAME, PAPER, DOT, LINE, SELECT].join('|')
    if (entry.key !== key || entry.strokes !== doc.strokes || entry.shapes !== doc.shapes) {
      drawScene(entry.ctx, view, doc, null, null, null)
      entry.key = key
      entry.strokes = doc.strokes
      entry.shapes = doc.shapes
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(entry.layer, 0, 0)
  }
  if (!liveShape && !liveStroke && !selection && !marquee) return
  const k = view.dpr * view.scale
  ctx.setTransform(k, 0, 0, k, view.dpr * view.ox, view.dpr * view.oy)
  ctx.save()
  ctx.beginPath()
  ctx.rect(CANVAS.x, CANVAS.y, CANVAS.width, CANVAS.height)
  ctx.clip()
  if (liveShape) drawShape(ctx, liveShape)
  if (liveStroke) drawStroke(ctx, liveStroke)
  const shown = (ref) => {
    const found = (ref.kind === 'stroke' ? doc.strokes : doc.shapes).find((item) => item.id === ref.id)
    return found && replace && replace.has(found.id) ? replace.get(found.id) : found
  }
  if (selection && selection.kind === 'group') {
    drawGroupSelection(ctx, view, selection.items.map((ref) => ({ ref, item: shown(ref) })).filter((e) => e.item))
  } else if (selection) {
    const found = shown(selection)
    if (found) drawSelection(ctx, view, found, selection.kind === 'stroke')
  }
  if (marquee) drawMarquee(ctx, view, marquee)
  ctx.restore()
}
