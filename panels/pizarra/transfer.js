// Export and import of a project as JSON, and validation of anything that
// comes from outside: a pasted text or a stored value. Nothing here touches
// the DOM or the bridge.
//
//   { "format": "deska-pizarra", "version": 3,
//     "sheet": { "width": 1200, "height": 800 },   the home page
//     "canvas": { "x": -1200, "y": -800, "width": 3600, "height": 2400 },
//     coordinates may be anywhere on the canvas, negative ones included
//     "background": "plain" | "dots" | "grid",
//     "strokes": [ { "id", "color": "#rrggbb", "width", "points": [[x, y], ...] } ],
//     "shapes":  [ { "id", "kind": "line|arrow|rect|ellipse|diamond|text", "color", "width", ... } ],
//     "mermaid": "source text of the diagram editor" }
//
// Version 1 (strokes only) and version 2 (everything on the home page) still import.

import { BACKGROUNDS, BOX_KINDS, CANVAS, LIMITS, LINE_KINDS, SHAPE_KINDS, SHEET, createShape, createStroke } from './model.js'

export const FORMAT = 'deska-pizarra'
export const VERSION = 4

const COLOR = /^#[0-9a-fA-F]{6}$/

/** The plain object that is stored and exported. */
export function toProject(doc) {
  return {
    format: FORMAT,
    version: VERSION,
    sheet: { width: SHEET.width, height: SHEET.height },
    canvas: { x: CANVAS.x, y: CANVAS.y, width: CANVAS.width, height: CANVAS.height },
    background: doc.background,
    strokes: doc.strokes.map((s) => ({ id: s.id, color: s.color, width: s.width, points: s.points.map((p) => [p[0], p[1]]) })),
    shapes: doc.shapes.map((s) => JSON.parse(JSON.stringify(s))),
    mermaid: doc.mermaid || '',
  }
}

export function serializeProject(doc) {
  return JSON.stringify(toProject(doc))
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function fail(error) {
  return { ok: false, error }
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n)
const inSheetX = (n) => finite(n) && n >= CANVAS.x && n <= CANVAS.x + CANVAS.width
const inSheetY = (n) => finite(n) && n >= CANVAS.y && n <= CANVAS.y + CANVAS.height
const OUT = `queda fuera del lienzo (${CANVAS.width} × ${CANVAS.height}).`

function checkPoint(p) {
  return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])
}

/** Validates one shape. Returns { shape } or { error }. */
function validateShape(raw, at) {
  if (!isObject(raw)) return { error: `${at}: no es un objeto.` }
  if (!SHAPE_KINDS.includes(raw.kind)) return { error: `${at}: "kind" debe ser uno de: ${SHAPE_KINDS.join(', ')}.` }
  if (raw.angle !== undefined && (!finite(raw.angle) || Math.abs(raw.angle) > Math.PI || (!BOX_KINDS.includes(raw.kind) && raw.kind !== 'text'))) {
    return { error: `${at}: "angle" debe estar entre -π y π y solo se admite en texto y figuras.` }
  }
  if (typeof raw.color !== 'string' || !COLOR.test(raw.color)) return { error: `${at}: el color debe ser #rrggbb.` }
  if (!finite(raw.width) || raw.width < LIMITS.widthMin || raw.width > LIMITS.widthMax) {
    return { error: `${at}: el grosor debe estar entre ${LIMITS.widthMin} y ${LIMITS.widthMax}.` }
  }
  if (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > LIMITS.textLength)) {
    return { error: `${at}: "text" debe ser un texto de hasta ${LIMITS.textLength} caracteres.` }
  }
  if (raw.kind === 'text' && (typeof raw.text !== 'string' || raw.text === '')) return { error: `${at}: un bloque de texto necesita "text".` }
  if (raw.size !== undefined && (!finite(raw.size) || raw.size < LIMITS.sizeMin || raw.size > LIMITS.sizeMax)) {
    return { error: `${at}: "size" debe estar entre ${LIMITS.sizeMin} y ${LIMITS.sizeMax}.` }
  }
  if (raw.kind === 'text' && raw.size === undefined) return { error: `${at}: un bloque de texto necesita "size".` }
  if (raw.group !== undefined && (typeof raw.group !== 'string' || raw.group.length > 32)) return { error: `${at}: "group" debe ser un texto de hasta 32 caracteres.` }
  if (raw.fillColor !== undefined && (typeof raw.fillColor !== 'string' || !COLOR.test(raw.fillColor))) return { error: `${at}: "fillColor" debe ser #rrggbb.` }
  for (const flag of ['fill', 'round', 'dash']) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') return { error: `${at}: "${flag}" debe ser true o false.` }
  }

  if (LINE_KINDS.includes(raw.kind)) {
    if (!Array.isArray(raw.points) || raw.points.length !== 2 || !raw.points.every(checkPoint)) return { error: `${at}: "points" debe tener dos puntos [x, y].` }
    if (!raw.points.every((p) => inSheetX(p[0]) && inSheetY(p[1]))) return { error: `${at}: un punto ${OUT}` }
  } else if (raw.kind === 'text') {
    if (!inSheetX(raw.x) || !inSheetY(raw.y)) return { error: `${at}: la posición ${OUT}` }
  } else if (raw.kind === 'fill') {
    if (!Array.isArray(raw.rings) || raw.rings.length < 1 || raw.rings.length > LIMITS.fillRings) return { error: `${at}: "rings" debe tener de 1 a ${LIMITS.fillRings} contornos.` }
    let total = 0
    for (const ring of raw.rings) {
      if (!Array.isArray(ring) || ring.length < 3) return { error: `${at}: cada contorno necesita al menos 3 puntos.` }
      total += ring.length
      if (!ring.every(checkPoint)) return { error: `${at}: cada punto debe ser [x, y] con números.` }
      if (!ring.every((p) => inSheetX(p[0]) && inSheetY(p[1]))) return { error: `${at}: un punto ${OUT}` }
    }
    if (total > LIMITS.fillPoints) return { error: `${at}: tiene más de ${LIMITS.fillPoints} puntos.` }
  } else {
    if (!finite(raw.x) || !finite(raw.y) || !finite(raw.w) || !finite(raw.h)) return { error: `${at}: x, y, w y h deben ser números.` }
    if (raw.w < 1 || raw.h < 1) return { error: `${at}: w y h deben ser al menos 1.` }
    if (!inSheetX(raw.x) || !inSheetY(raw.y) || !inSheetX(raw.x + raw.w - 0.5) || !inSheetY(raw.y + raw.h - 0.5)) return { error: `${at}: la figura ${OUT}` }
  }
  return { shape: createShape(raw) }
}

/** Validates an already parsed value. Returns { ok, doc } or { ok: false, error }. */
export function validateProject(value) {
  if (!isObject(value)) return fail('El proyecto debe ser un objeto JSON.')
  if (value.format !== FORMAT) return fail(`No es un proyecto de Pizarra (se esperaba format "${FORMAT}").`)
  if (!Number.isInteger(value.version) || value.version < 1) return fail('Falta la versión del proyecto.')
  if (value.version > VERSION) return fail(`El proyecto es de una versión más nueva (${value.version}) que la que entiende este panel (${VERSION}).`)
  if (!isObject(value.sheet) || value.sheet.width !== SHEET.width || value.sheet.height !== SHEET.height) {
    return fail(`La hoja debe medir ${SHEET.width} × ${SHEET.height}.`)
  }
  if (!BACKGROUNDS.includes(value.background)) return fail(`El fondo debe ser uno de: ${BACKGROUNDS.join(', ')}.`)
  if (!Array.isArray(value.strokes)) return fail('"strokes" debe ser una lista.')
  if (value.strokes.length > LIMITS.strokes) return fail(`Hay más de ${LIMITS.strokes} trazos.`)

  const ids = new Set()
  const strokes = []
  for (let i = 0; i < value.strokes.length; i++) {
    const raw = value.strokes[i]
    const at = `Trazo ${i + 1}`
    if (!isObject(raw)) return fail(`${at}: no es un objeto.`)
    if (typeof raw.id !== 'string' || raw.id === '' || raw.id.length > 64) return fail(`${at}: el identificador debe ser un texto de 1 a 64 caracteres.`)
    if (ids.has(raw.id)) return fail(`${at}: el identificador "${raw.id}" está repetido.`)
    ids.add(raw.id)
    if (typeof raw.color !== 'string' || !COLOR.test(raw.color)) return fail(`${at}: el color debe ser #rrggbb.`)
    if (!finite(raw.width) || raw.width < LIMITS.widthMin || raw.width > LIMITS.widthMax) {
      return fail(`${at}: el grosor debe estar entre ${LIMITS.widthMin} y ${LIMITS.widthMax}.`)
    }
    if (!Array.isArray(raw.points) || raw.points.length < 1 || raw.points.length > LIMITS.pointsPerStroke) {
      return fail(`${at}: debe tener de 1 a ${LIMITS.pointsPerStroke} puntos.`)
    }
    for (const p of raw.points) {
      if (!checkPoint(p)) return fail(`${at}: cada punto debe ser [x, y] con números.`)
      if (!inSheetX(p[0]) || !inSheetY(p[1])) return fail(`${at}: un punto ${OUT}`)
    }
    strokes.push(createStroke({ id: raw.id, color: raw.color.toLowerCase(), width: raw.width, points: raw.points }))
  }

  // Shapes arrived with version 2; a version 1 file has none.
  const rawShapes = value.version >= 2 && value.shapes !== undefined ? value.shapes : []
  if (!Array.isArray(rawShapes)) return fail('"shapes" debe ser una lista.')
  if (rawShapes.length > LIMITS.shapes) return fail(`Hay más de ${LIMITS.shapes} figuras.`)
  const shapes = []
  for (let i = 0; i < rawShapes.length; i++) {
    const at = `Figura ${i + 1}`
    const raw = rawShapes[i]
    if (isObject(raw)) {
      if (typeof raw.id !== 'string' || raw.id === '' || raw.id.length > 64) return fail(`${at}: el identificador debe ser un texto de 1 a 64 caracteres.`)
      if (ids.has(raw.id)) return fail(`${at}: el identificador "${raw.id}" está repetido.`)
      ids.add(raw.id)
    }
    const result = validateShape(raw, at)
    if (result.error) return fail(result.error)
    shapes.push(result.shape)
  }

  let mermaid = ''
  if (value.mermaid !== undefined) {
    if (typeof value.mermaid !== 'string' || value.mermaid.length > LIMITS.mermaidLength) return fail(`"mermaid" debe ser un texto de hasta ${LIMITS.mermaidLength} caracteres.`)
    mermaid = value.mermaid
  }
  return { ok: true, doc: { background: value.background, strokes, shapes, mermaid } }
}

/** Parses pasted text. Never throws. */
export function parseProject(text) {
  if (typeof text !== 'string' || text.trim() === '') return fail('No hay nada que importar. Pega un proyecto en el cuadro.')
  if (text.length > LIMITS.projectBytes) return fail('El texto es demasiado grande para este panel (límite 200 KB).')
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    return fail(`No es JSON válido: ${err.message}`)
  }
  return validateProject(value)
}

// Committed items never change, so each one's JSON length is worked out once
// and the size of a whole drawing is a sum, not a new serialization.
const sizeMemo = new WeakMap()
function itemSize(item) {
  let n = sizeMemo.get(item)
  if (n === undefined) {
    n = JSON.stringify(item).length + 1
    sizeMemo.set(item, n)
  }
  return n
}

/** The length of the serialized project, to within a few characters. */
export function estimateSize(doc) {
  let n = 320 + JSON.stringify(doc.mermaid || '').length
  for (const s of doc.strokes) n += itemSize(s)
  for (const s of doc.shapes) n += itemSize(s)
  return n
}

/** True when the project would not fit in what the panel stores. */
export function tooBig(doc) {
  return estimateSize(doc) > LIMITS.projectBytes
}

