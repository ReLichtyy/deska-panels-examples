// Constants and small factories shared by every module. Nothing here touches
// the DOM or the bridge.

/** The home page: 1200 x 800 logical units. The panel opens fitted to it, and
 *  compiled diagrams are laid out to its size. */
export const SHEET = Object.freeze({ width: 1200, height: 800 })

/** The whole canvas: 3 x 3 pages with the home page in the middle, so
 *  coordinates run from -1200 to 2400 across and -800 to 1600 down. It is a
 *  bounded work area, not an infinite one. */
export const CANVAS = Object.freeze({ x: -SHEET.width, y: -SHEET.height, width: SHEET.width * 3, height: SHEET.height * 3 })

export const BACKGROUNDS = Object.freeze(['plain', 'dots', 'grid'])

/** Shapes the document can hold besides freehand strokes. */
export const SHAPE_KINDS = Object.freeze(['line', 'arrow', 'rect', 'ellipse', 'diamond', 'text', 'fill'])
export const BOX_KINDS = Object.freeze(['rect', 'ellipse', 'diamond'])
export const LINE_KINDS = Object.freeze(['line', 'arrow'])

export const LIMITS = Object.freeze({
  strokes: 1500,
  pointsPerStroke: 4000,
  shapes: 800,
  widthMin: 1,
  widthMax: 40,
  sizeMin: 8,
  sizeMax: 120,
  textLength: 1000,
  fillRings: 40,
  fillPoints: 2500,
  mermaidLength: 6000,
  // Deska keeps 256 KB per package; stay well under it.
  projectBytes: 200 * 1024,
})

/** Name and ink for each swatch. Ink colors are document content, not UI. */
export const PALETTE = Object.freeze([
  { name: 'Negro', value: '#1b1b1f' },
  { name: 'Rojo', value: '#e5484d' },
  { name: 'Naranja', value: '#f76b15' },
  { name: 'Amarillo', value: '#e5b800' },
  { name: 'Verde', value: '#30a46c' },
  { name: 'Azul', value: '#0090ff' },
  { name: 'Violeta', value: '#8e4ec6' },
  { name: 'Gris', value: '#8b8d98' },
])

export const DEFAULT_COLOR = PALETTE[0].value
export const DEFAULT_WIDTH = 4
export const DEFAULT_TEXT_SIZE = 28
export const LABEL_SIZE = 22

let counter = 0

/** A fresh id, unique within a document and across reloads. */
export function newId() {
  counter += 1
  return `s${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export function round1(n) {
  return Math.round(n * 10) / 10
}

/** A committed stroke: immutable, so history can share it between snapshots. */
export function createStroke({ id = newId(), color, width, points }) {
  return Object.freeze({ id, color, width, points: Object.freeze(points.map((p) => Object.freeze([round1(p[0]), round1(p[1])]))) })
}

/** A committed shape, normalized and immutable. Optional fields are only
 *  present when they carry something, which keeps the JSON small.
 *
 *  line, arrow:       points [[x, y], [x, y]], dash, text (label)
 *  rect, ellipse,
 *  diamond:           x, y, w, h, fill, round (rect only), text (label)
 *  text:              x, y, text, size
 *  fill:              rings [[[x, y], ...], ...] painted with `color`, even-odd,
 *                     so a ring inside another one is a hole
 *  boxes also take    fillColor: the whole inside painted one solid color
 *  every shape:       id, kind, color, width, size (label font), group */
export function createShape(spec) {
  const shape = { id: spec.id || newId(), kind: spec.kind, color: spec.color, width: spec.width }
  if (LINE_KINDS.includes(spec.kind)) {
    shape.points = Object.freeze(spec.points.map((p) => Object.freeze([round1(p[0]), round1(p[1])])))
    if (spec.dash) shape.dash = true
  } else if (spec.kind === 'text') {
    shape.x = round1(spec.x)
    shape.y = round1(spec.y)
  } else if (spec.kind === 'fill') {
    shape.rings = Object.freeze(spec.rings.map((ring) => Object.freeze(ring.map((p) => Object.freeze([Math.round(p[0]), Math.round(p[1])])))))
  } else {
    shape.x = round1(spec.x)
    shape.y = round1(spec.y)
    shape.w = round1(spec.w)
    shape.h = round1(spec.h)
    if (spec.fill) shape.fill = true
    if (typeof spec.fillColor === 'string') shape.fillColor = spec.fillColor
    if (spec.kind === 'rect' && spec.round) shape.round = true
  }
  if (typeof spec.text === 'string' && spec.text !== '') shape.text = spec.text
  if (spec.size !== undefined && (spec.kind === 'text' || shape.text !== undefined)) shape.size = Math.round(spec.size * 10) / 10
  if (typeof spec.group === 'string' && spec.group !== '') shape.group = spec.group
  // Rotation is around the unrotated box center, in radians. Omitted means zero.
  if ((BOX_KINDS.includes(spec.kind) || spec.kind === 'text') && Number.isFinite(spec.angle) && spec.angle) {
    const angle = Math.atan2(Math.sin(spec.angle), Math.cos(spec.angle))
    if (Math.abs(angle) > 0.000001) shape.angle = angle
  }
  return Object.freeze(shape)
}

export function emptyDocument() {
  return { background: 'plain', strokes: [], shapes: [], mermaid: '' }
}
