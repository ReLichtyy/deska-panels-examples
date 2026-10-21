// Process tools create one ordinary, editable shape at the pointer position.
import { CANVAS, createShape } from './model.js'
import { boxFromDrag } from './shapes.js'
import { state, view } from './state.js'
const NOTE_COLOR = '#825900'

export const PROCESS_OBJECTS = Object.freeze([
  { id: 'terminal', name: 'Inicio / Fin', spec: { kind: 'rect', w: 200, h: 80, round: true, fill: true, text: 'Inicio' } },
  { id: 'process', name: 'Proceso', spec: { kind: 'rect', w: 200, h: 90, fill: true, text: 'Proceso' } },
  { id: 'decision', name: 'Decisión', spec: { kind: 'diamond', w: 240, h: 130, fill: true, text: '¿Condición?' } },
  { id: 'connector', name: 'Conector', spec: { kind: 'ellipse', w: 84, h: 84, fill: true, text: 'A' } },
  { id: 'arrow', name: 'Flecha', spec: { kind: 'arrow', length: 200 } },
  { id: 'note', name: 'Nota', spec: { kind: 'rect', w: 230, h: 100, fill: true, text: 'Nota', color: NOTE_COLOR } },
])

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** A preview or committed object. No insertion happens until pointer release. */
export function processShape(id, start, end = null) {
  const def = PROCESS_OBJECTS.find((o) => o.id === id)
  if (!def) return null
  const spec = def.spec
  const f = clamp(1 / view.zoom, 0.4, 3)
  const style = { color: state.color, width: state.width, fill: state.fill, round: state.round, dash: state.dash }
  if (spec.kind === 'arrow') {
    const finish = end || { x: clamp(start.x + spec.length * f, CANVAS.x, CANVAS.x + CANVAS.width), y: start.y }
    return createShape({ kind: 'arrow', points: [[start.x, start.y], [finish.x, finish.y]], ...style })
  }
  const box = end ? boxFromDrag(start, end) : { x: start.x, y: start.y, w: spec.w * f, h: spec.h * f }
  const w = Math.max(1, box.w)
  const h = Math.max(1, box.h)
  return createShape({ ...spec, ...style, x: clamp(box.x, CANVAS.x, CANVAS.x + CANVAS.width - w), y: clamp(box.y, CANVAS.y, CANVAS.y + CANVAS.height - h), w, h, size: clamp(state.textSize * f, 8, 120) })
}
