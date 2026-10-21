// Geometry for strokes and shapes: bounds, hit testing, moving and resizing.
// Pure functions over immutable items; every change returns a new item.

import { BOX_KINDS, CANVAS, LABEL_SIZE, LIMITS, LINE_KINDS, createShape, createStroke } from './model.js'
import { textMetrics } from './text.js'

const MIN_BOX = 12

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** True when (x, y) touches the stroke, with `tolerance` sheet units of slack. */
export function hitStroke(stroke, x, y, tolerance) {
  // Most strokes are nowhere near the pointer: the box says so without walking the points.
  const b = strokeBounds(stroke)
  if (x < b.x - tolerance || x > b.x + b.w + tolerance || y < b.y - tolerance || y > b.y + b.h + tolerance) return false
  const reach = stroke.width / 2 + tolerance
  const pts = stroke.points
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true
  }
  return false
}

// Strokes and shapes never change once committed, so their boxes are worked out once.
const boundsMemo = new WeakMap()
function memoized(item, compute) {
  let b = boundsMemo.get(item)
  if (!b) {
    b = compute(item)
    boundsMemo.set(item, b)
  }
  return b
}

export function strokeBounds(stroke) {
  return memoized(stroke, computeStrokeBounds)
}

function computeStrokeBounds(stroke) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const [x, y] of stroke.points) {
    x1 = Math.min(x1, x)
    y1 = Math.min(y1, y)
    x2 = Math.max(x2, x)
    y2 = Math.max(y2, y)
  }
  const pad = stroke.width / 2
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + stroke.width, h: y2 - y1 + stroke.width }
}

/** Where a shape's label is drawn and how big it is. */
export function labelSize(shape) {
  return shape.size || LABEL_SIZE
}

export function shapeBounds(shape) {
  return memoized(shape, (item) => {
    const b = localBounds(item)
    if (!item.angle) return b
    const center = shapeCenter(item)
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
      .map(([x, y]) => rotatePoint({ x, y }, center, item.angle))
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y)
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  })
}

/** The element's own axes, before rotation; shared by handles, text and rendering. */
export function localBounds(shape) {
  if (shape.kind === 'fill') {
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const ring of shape.rings) {
      for (const [x, y] of ring) {
        x1 = Math.min(x1, x)
        y1 = Math.min(y1, y)
        x2 = Math.max(x2, x)
        y2 = Math.max(y2, y)
      }
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
  if (LINE_KINDS.includes(shape.kind)) {
    const [a, b] = shape.points
    const pad = shape.width / 2
    return { x: Math.min(a[0], b[0]) - pad, y: Math.min(a[1], b[1]) - pad, w: Math.abs(a[0] - b[0]) + shape.width, h: Math.abs(a[1] - b[1]) + shape.width }
  }
  if (shape.kind === 'text') {
    const m = textMetrics(shape.text, shape.size)
    return { x: shape.x, y: shape.y, w: m.w, h: m.h }
  }
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
}

export function shapeCenter(shape) {
  const b = localBounds(shape)
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function rotatePoint(point, center, angle) {
  const c = Math.cos(angle), s = Math.sin(angle)
  const dx = point.x - center.x, dy = point.y - center.y
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c }
}

function inBounds(b, x, y, slack) {
  return x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack
}

/** Whether (x, y) touches the shape.
 *  area: true selects by the whole inside (the select tool); false makes an
 *  empty shape touchable only on its outline and label (the eraser), so a
 *  stroke drawn inside a box can be erased without erasing the box. */
/** Even-odd test: is (x, y) inside the rings, a ring inside another being a hole? */
export function inRings(rings, x, y) {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

export function hitShape(shape, x, y, tolerance, area) {
  if (shape.angle) ({ x, y } = rotatePoint({ x, y }, shapeCenter(shape), -shape.angle))
  if (shape.kind === 'fill') return inRings(shape.rings, x, y)
  const reach = shape.width / 2 + tolerance
  if (LINE_KINDS.includes(shape.kind)) {
    const [a, b] = shape.points
    return distToSegment(x, y, a[0], a[1], b[0], b[1]) <= reach
  }
  if (shape.kind === 'text') return inBounds(localBounds(shape), x, y, tolerance)
  const b = localBounds(shape)
  if (!inBounds(b, x, y, reach)) return false
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const rx = b.w / 2
  const ry = b.h / 2
  if (shape.kind === 'rect') {
    if (area || shape.fill || shape.fillColor) return true
    const inner = inBounds({ x: b.x + reach, y: b.y + reach, w: b.w - 2 * reach, h: b.h - 2 * reach }, x, y, 0)
    return !inner || labelHit(shape, x, y, tolerance)
  }
  if (shape.kind === 'ellipse') {
    const v = Math.hypot((x - cx) / rx, (y - cy) / ry)
    if (area || shape.fill || shape.fillColor) return v <= 1 + reach / Math.min(rx, ry)
    return Math.abs(v - 1) * Math.min(rx, ry) <= reach || labelHit(shape, x, y, tolerance)
  }
  // diamond
  const v = Math.abs(x - cx) / rx + Math.abs(y - cy) / ry
  if (area || shape.fill || shape.fillColor) return v <= 1 + reach / Math.min(rx, ry)
  const corners = [
    [cx, b.y],
    [b.x + b.w, cy],
    [cx, b.y + b.h],
    [b.x, cy],
  ]
  for (let i = 0; i < 4; i++) {
    const p = corners[i]
    const q = corners[(i + 1) % 4]
    if (distToSegment(x, y, p[0], p[1], q[0], q[1]) <= reach) return true
  }
  return labelHit(shape, x, y, tolerance)
}

function labelHit(shape, x, y, tolerance) {
  if (!shape.text) return false
  const m = textMetrics(shape.text, labelSize(shape))
  const cx = shape.x + shape.w / 2
  const cy = shape.y + shape.h / 2
  return inBounds({ x: cx - m.w / 2, y: cy - m.h / 2, w: m.w, h: m.h }, x, y, tolerance)
}

/** The handles shown on a selected shape: id, position. */
export function handlesOf(shape, scale = 1) {
  if (LINE_KINDS.includes(shape.kind)) return shape.points.map((p, i) => ({ id: i, x: p[0], y: p[1] }))
  if (!BOX_KINDS.includes(shape.kind) && shape.kind !== 'text') return []
  const b = localBounds(shape), center = shapeCenter(shape)
  return [
    { id: 'nw', x: b.x, y: b.y },
    { id: 'ne', x: b.x + b.w, y: b.y },
    { id: 'se', x: b.x + b.w, y: b.y + b.h },
    { id: 'sw', x: b.x, y: b.y + b.h },
    { id: 'rotate', x: center.x, y: b.y - 28 / scale },
  ].map(h => ({ ...h, ...rotatePoint(h, center, shape.angle || 0) }))
}

export function handleCursor(shape, handle) {
  if (handle === 'rotate') return 'grab'
  if (typeof handle === 'number') return 'crosshair'
  const base = handle === 'nw' || handle === 'se' ? Math.PI / 4 : -Math.PI / 4
  const sector = ((Math.round((base + (shape.angle || 0)) / (Math.PI / 4)) % 4) + 4) % 4
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][sector]
}

function rebuild(shape, patch) {
  return createShape({ ...shape, ...patch })
}

/** Moves a stroke or shape by (dx, dy), kept inside the canvas. */
export function translateItem(item, dx, dy, isStroke) {
  const b = isStroke ? strokeBounds(item) : shapeBounds(item)
  const sx = clamp(dx, CANVAS.x - b.x, CANVAS.x + CANVAS.width - (b.x + b.w))
  const sy = clamp(dy, CANVAS.y - b.y, CANVAS.y + CANVAS.height - (b.y + b.h))
  if (isStroke) return createStroke({ ...item, points: item.points.map((p) => [p[0] + sx, p[1] + sy]) })
  if (LINE_KINDS.includes(item.kind)) return rebuild(item, { points: item.points.map((p) => [p[0] + sx, p[1] + sy]) })
  if (item.kind === 'fill') return rebuild(item, { rings: item.rings.map((ring) => ring.map((p) => [p[0] + sx, p[1] + sy])) })
  return rebuild(item, { x: item.x + sx, y: item.y + sy })
}

/** Moves one handle of a shape to (x, y). */
export function resizeShape(shape, handle, x, y) {
  const px = clamp(x, CANVAS.x, CANVAS.x + CANVAS.width)
  const py = clamp(y, CANVAS.y, CANVAS.y + CANVAS.height)
  if (LINE_KINDS.includes(shape.kind)) {
    return rebuild(shape, { points: shape.points.map((p, i) => (i === handle ? [px, py] : p)) })
  }
  if (!['nw', 'ne', 'se', 'sw'].includes(handle)) return shape
  const b = localBounds(shape), center = shapeCenter(shape), angle = shape.angle || 0
  const pointer = rotatePoint({ x: px, y: py }, center, -angle)
  const sx = handle.includes('w') ? -1 : 1, sy = handle.includes('n') ? -1 : 1
  const anchor = { x: sx < 0 ? b.x + b.w : b.x, y: sy < 0 ? b.y + b.h : b.y }
  const anchorWorld = rotatePoint(anchor, center, angle)
  let w = Math.max(MIN_BOX, sx * (pointer.x - anchor.x))
  let h = Math.max(MIN_BOX, sy * (pointer.y - anchor.y))
  let size = shape.size
  if (shape.kind === 'text') {
    // Uniform scaling follows the corner diagonal; never stretch glyphs.
    const factor = (sx * (pointer.x - anchor.x) * b.w + sy * (pointer.y - anchor.y) * b.h) / Math.max(1, b.w * b.w + b.h * b.h)
    size = Math.round(clamp(shape.size * factor, LIMITS.sizeMin, LIMITS.sizeMax) * 10) / 10
    const measured = textMetrics(shape.text, size)
    w = measured.w
    h = measured.h
  }
  const offset = rotatePoint({ x: sx * w / 2, y: sy * h / 2 }, { x: 0, y: 0 }, angle)
  const next = rebuild(shape, { x: anchorWorld.x + offset.x - w / 2, y: anchorWorld.y + offset.y - h / 2, ...(shape.kind === 'text' ? { size } : { w, h }) })
  // Preserve the fixed anchor at the canvas boundary by refusing an out-of-bounds resize.
  const bounds = shapeBounds(next)
  return insideCanvas(bounds) ? next : shape
}

function insideCanvas(b) {
  return b.x >= CANVAS.x - 0.1 && b.y >= CANVAS.y - 0.1 && b.x + b.w <= CANVAS.x + CANVAS.width + 0.1 && b.y + b.h <= CANVAS.y + CANVAS.height + 0.1
}

export function rotateShape(shape, angle) {
  if (!BOX_KINDS.includes(shape.kind) && shape.kind !== 'text') return shape
  const rotated = rebuild(shape, { angle })
  const b = shapeBounds(rotated)
  if (b.w > CANVAS.width || b.h > CANVAS.height) return shape
  return translateItem(rotated, 0, 0, false)
}

/** A shape's box from a drag between two sheet points. */
export function boxFromDrag(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}
