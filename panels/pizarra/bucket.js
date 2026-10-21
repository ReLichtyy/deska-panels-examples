// The paint bucket's eyes: given a point, find the closed area around it and
// return its outline as polygons. The drawing is vector, so the area is found on
// a throwaway raster: every line is drawn into it (a little thicker, which closes
// the small gaps a hand leaves), the point is flood-filled, and the edge of what
// was reached is traced back into rings and thinned. The result is stored as a
// small polygon, never as pixels.

import { CANVAS, LIMITS, LINE_KINDS } from './model.js'
import { simplify } from './archive.js'
import { applyShapeRotation, traceBox, traceStroke } from './drawing.js'

const RES = 0.5 // raster pixels per canvas unit
const MIN_INK = 6 // canvas units: no line is thinner than this here, so small gaps close
const W = Math.ceil(CANVAS.width * RES)
const H = Math.ceil(CANVAS.height * RES)
const STRIDE = W + 1

let raster = null
function rasterContext() {
  if (!raster) {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    raster = canvas.getContext('2d', { willReadFrequently: true })
  }
  return raster
}

/** Draws every line of the drawing as solid ink. Text and painted areas are not barriers. */
function drawInk(ctx, doc) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, W, H)
  ctx.setTransform(RES, 0, 0, RES, -CANVAS.x * RES, -CANVAS.y * RES)
  ctx.strokeStyle = '#000'
  ctx.fillStyle = '#000'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of doc.strokes) {
    const w = Math.max(s.width, MIN_INK)
    if (s.points.length === 1) {
      ctx.beginPath()
      ctx.arc(s.points[0][0], s.points[0][1], w / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.lineWidth = w
    ctx.beginPath()
    traceStroke(ctx, s.points)
    ctx.stroke()
  }
  for (const sh of doc.shapes) {
    if (sh.kind === 'fill' || sh.kind === 'text') continue
    ctx.save()
    applyShapeRotation(ctx, sh)
    ctx.lineWidth = Math.max(sh.width, MIN_INK)
    if (LINE_KINDS.includes(sh.kind)) {
      ctx.beginPath()
      ctx.moveTo(sh.points[0][0], sh.points[0][1])
      ctx.lineTo(sh.points[1][0], sh.points[1][1])
    } else {
      traceBox(ctx, sh)
    }
    ctx.stroke()
    ctx.restore()
  }
}

/** Scanline flood fill from (sx, sy). Gives up as soon as it reaches the edge of the canvas. */
function flood(ink, sx, sy) {
  const reg = new Uint8Array(W * H)
  const stack = [sx, sy]
  let pixels = 0
  let x1 = W
  let y1 = H
  let x2 = 0
  let y2 = 0
  while (stack.length) {
    const y = stack.pop()
    const x0 = stack.pop()
    const row = y * W
    if (reg[row + x0] || ink[row + x0]) continue
    let l = x0
    while (l > 0 && !ink[row + l - 1] && !reg[row + l - 1]) l--
    let r = x0
    while (r < W - 1 && !ink[row + r + 1] && !reg[row + r + 1]) r++
    if (l === 0 || r === W - 1 || y === 0 || y === H - 1) return { open: true }
    for (let x = l; x <= r; x++) reg[row + x] = 1
    pixels += r - l + 1
    x1 = Math.min(x1, l)
    x2 = Math.max(x2, r)
    y1 = Math.min(y1, y)
    y2 = Math.max(y2, y)
    for (const ny of [y - 1, y + 1]) {
      const nrow = ny * W
      let run = false
      for (let x = l; x <= r; x++) {
        const open = !ink[nrow + x] && !reg[nrow + x]
        if (open && !run) {
          stack.push(x, ny)
          run = true
        } else if (!open) run = false
      }
    }
  }
  return { reg, pixels, box: { x1, y1, x2, y2 } }
}

/** Grows the area by one pixel so its edge lies under the lines that bound it. */
function grow(reg, box) {
  const out = new Uint8Array(reg)
  for (let y = box.y1; y <= box.y2; y++) {
    for (let x = box.x1; x <= box.x2; x++) {
      if (!reg[y * W + x]) continue
      out[y * W + x - 1] = 1
      out[y * W + x + 1] = 1
      out[(y - 1) * W + x] = 1
      out[(y + 1) * W + x] = 1
    }
  }
  return out
}

/** The boundary of a mask as closed rings of raster vertices [x, y]. */
function trace(mask, box) {
  const from = []
  const to = []
  const add = (ax, ay, bx, by) => {
    from.push(ay * STRIDE + ax)
    to.push(by * STRIDE + bx)
  }
  for (let y = box.y1 - 1; y <= box.y2 + 1; y++) {
    for (let x = box.x1 - 1; x <= box.x2 + 1; x++) {
      if (!mask[y * W + x]) continue
      if (!mask[(y - 1) * W + x]) add(x, y, x + 1, y)
      if (!mask[y * W + x + 1]) add(x + 1, y, x + 1, y + 1)
      if (!mask[(y + 1) * W + x]) add(x + 1, y + 1, x, y + 1)
      if (!mask[y * W + x - 1]) add(x, y + 1, x, y)
    }
  }
  const first = new Map()
  const second = new Map()
  for (let e = 0; e < from.length; e++) {
    if (!first.has(from[e])) first.set(from[e], e)
    else second.set(from[e], e)
  }
  const used = new Uint8Array(from.length)
  const pick = (v) => {
    const a = first.get(v)
    if (a !== undefined && !used[a]) return a
    const b = second.get(v)
    return b !== undefined && !used[b] ? b : undefined
  }
  const rings = []
  for (let e0 = 0; e0 < from.length; e0++) {
    if (used[e0]) continue
    const start = from[e0]
    const ring = []
    let e = e0
    while (e !== undefined) {
      used[e] = 1
      ring.push([from[e] % STRIDE, Math.floor(from[e] / STRIDE)])
      if (to[e] === start) break
      e = pick(to[e])
    }
    rings.push(ring)
  }
  return rings
}

const shoelace = (ring) => {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return Math.abs(a / 2)
}

/** Drops vertices in the middle of a straight run. */
function straighten(ring) {
  const out = []
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n]
    const c = ring[i]
    const q = ring[(i + 1) % n]
    if ((c[0] - p[0]) * (q[1] - c[1]) !== (c[1] - p[1]) * (q[0] - c[0])) out.push(c)
  }
  return out
}

/** Thins a closed ring. */
function thin(ring, eps) {
  const open = simplify([...ring, ring[0]], eps)
  open.pop()
  return open
}

/**
 * Finds the closed area around the canvas point (x, y).
 * Returns { status: 'ok', rings, area, bounds }, or { status: 'open' } when the
 * area leaks to the edge of the canvas, or { status: 'ink' } when the point is
 * on a line. rings are in canvas units, bounds is { x1, y1, x2, y2 }.
 */
export function computeFill(doc, x, y) {
  const ctx = rasterContext()
  drawInk(ctx, doc)
  const data = ctx.getImageData(0, 0, W, H).data
  const ink = new Uint8Array(W * H)
  for (let i = 0, p = 3; i < ink.length; i++, p += 4) if (data[p] > 40) ink[i] = 1

  let sx = Math.round((x - CANVAS.x) * RES)
  let sy = Math.round((y - CANVAS.y) * RES)
  sx = Math.min(W - 1, Math.max(0, sx))
  sy = Math.min(H - 1, Math.max(0, sy))
  if (ink[sy * W + sx]) {
    // A click on a line: look a few pixels around for the nearest open spot.
    let found = null
    for (let r = 1; r <= 4 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = sx + dx
          const ny = sy + dy
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !ink[ny * W + nx]) {
            found = [nx, ny]
            break
          }
        }
      }
    }
    if (!found) return { status: 'ink' }
    ;[sx, sy] = found
  }

  const area = flood(ink, sx, sy)
  if (area.open) return { status: 'open' }
  const mask = grow(area.reg, area.box)
  const rings = trace(mask, area.box)

  // Straight runs and staircase edges become a few long segments.
  let kept = []
  for (const eps of [1, 1.6, 2.5, 4, 7]) {
    kept = rings
      .map((ring) => ({ ring: thin(straighten(ring), eps), size: shoelace(ring) }))
      .filter((r) => r.ring.length >= 3 && r.size >= 12)
      .sort((a, b) => b.size - a.size)
      .slice(0, LIMITS.fillRings)
    if (kept.reduce((n, r) => n + r.ring.length, 0) <= LIMITS.fillPoints * 0.6) break
  }
  if (!kept.length) return { status: 'ink' }

  const out = kept.map((r) => r.ring.map(([vx, vy]) => [Math.round(CANVAS.x + vx / RES), Math.round(CANVAS.y + vy / RES)]))
  let bx1 = Infinity
  let by1 = Infinity
  let bx2 = -Infinity
  let by2 = -Infinity
  for (const ring of out) {
    for (const [px, py] of ring) {
      bx1 = Math.min(bx1, px)
      by1 = Math.min(by1, py)
      bx2 = Math.max(bx2, px)
      by2 = Math.max(by2, py)
    }
  }
  return { status: 'ok', rings: out, area: area.pixels / (RES * RES), bounds: { x1: bx1, y1: by1, x2: bx2, y2: by2 } }
}
