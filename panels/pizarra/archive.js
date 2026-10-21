// The archive of past drawings: a short list of the last few, kept as small as
// it can be so it costs almost nothing of the 256 KB Deska gives the panel.
// Nothing here touches the DOM or the bridge.
//
// What makes an entry small:
//  - ids are dropped (they are made up again on restore);
//  - coordinates are whole numbers;
//  - strokes are thinned with Douglas-Peucker, coarser if the entry is still big;
//  - points are one flat list, colors lose their "#", empty parts are left out;
//  - the Mermaid text is kept only when short;
//  - the whole list has a fixed budget and the oldest entries go first.
//
// An entry looks like
//   { t: seconds, n: elements, b: "plain", s: [["1b1b1f", 4, [x, y, x, y, ...]]],
//     h: [shapes without id], m: "mermaid text" }
// and is checked again (validateProject) before it is ever put back on the board.

import { SHEET } from './model.js'
import { distToSegment } from './shapes.js'
import { FORMAT, VERSION } from './transfer.js'

export const ARCHIVE = Object.freeze({
  max: 5,
  budgetChars: 40000, // the whole list, as JSON
  entryShare: 0.6, // one entry may take at most this share of the budget
  keepMermaid: 1500,
})

const EPSILONS = [1.2, 3, 7]
const round = Math.round
const round1 = (n) => Math.round(n * 10) / 10

/** Douglas-Peucker on [[x, y], ...]: keeps the ends and every point that
 *  bends the line by more than `eps` sheet units. */
export function simplify(points, eps) {
  const n = points.length
  if (n < 3) return points.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let far = 0
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1])
      if (d > far) {
        far = d
        at = i
      }
    }
    if (at > 0 && far > eps) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

function compactShape(shape, eps) {
  const { id, ...rest } = JSON.parse(JSON.stringify(shape))
  void id
  if (rest.points) rest.points = rest.points.map((p) => [round(p[0]), round(p[1])])
  if (rest.rings) rest.rings = rest.rings.map((ring) => ring.map((p) => [round(p[0]), round(p[1])]))
  for (const k of ['x', 'y']) if (typeof rest[k] === 'number') rest[k] = round(rest[k])
  for (const k of ['w', 'h']) if (typeof rest[k] === 'number') rest[k] = Math.max(1, round(rest[k]))
  if (typeof rest.size === 'number') rest.size = round1(rest.size)
  if (typeof rest.width === 'number') rest.width = round1(rest.width)
  // A painted area is thinned like a stroke; a ring that would collapse is left whole.
  if (rest.rings) {
    rest.rings = rest.rings.map((ring) => {
      const thin = simplify(ring, eps)
      return thin.length >= 3 ? thin : ring
    })
  }
  return rest
}

/** The smallest form of a drawing: { t, n, b, s?, h?, m? }. */
export function compact(doc, eps, now) {
  const out = { t: Math.floor(now / 1000), n: doc.strokes.length + doc.shapes.length, b: doc.background }
  if (doc.strokes.length) {
    out.s = doc.strokes.map((s) => {
      // Whole numbers first, then thin: thinning what is already thinned gives the
      // same points back, so a restored drawing is recognized as the entry it came from.
      const flat = []
      for (const p of simplify(s.points.map((q) => [round(q[0]), round(q[1])]), eps)) flat.push(p[0], p[1])
      return [s.color.slice(1), round1(s.width), flat]
    })
  }
  if (doc.shapes.length) out.h = doc.shapes.map((s) => compactShape(s, eps))
  if (doc.mermaid && doc.mermaid.length <= ARCHIVE.keepMermaid) out.m = doc.mermaid
  return out
}

/** A project object for validateProject, made from an archived entry. It is
 *  lenient on purpose: whatever is wrong in the entry is for the validator to say. */
export function expand(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const strokes = (Array.isArray(entry.s) ? entry.s : []).map((e, i) => {
    const flat = Array.isArray(e) && Array.isArray(e[2]) ? e[2] : []
    const points = []
    for (let k = 0; k + 1 < flat.length; k += 2) points.push([flat[k], flat[k + 1]])
    // A dangling coordinate means the entry is damaged: let the validator say so.
    if (flat.length % 2) points.push([flat[flat.length - 1]])
    return { id: `a${i}`, color: `#${Array.isArray(e) ? e[0] : ''}`, width: Array.isArray(e) ? e[1] : 0, points }
  })
  const shapes = (Array.isArray(entry.h) ? entry.h : []).map((e, i) => (e && typeof e === 'object' && !Array.isArray(e) ? { ...e, id: `b${i}` } : e))
  return {
    format: FORMAT,
    version: VERSION,
    sheet: { width: SHEET.width, height: SHEET.height },
    background: entry.b,
    strokes,
    shapes,
    mermaid: typeof entry.m === 'string' ? entry.m : '',
  }
}

const sameDrawing = (a, b) => JSON.stringify({ ...a, t: 0 }) === JSON.stringify({ ...b, t: 0 })
const sizeOf = (value) => JSON.stringify(value).length

/** Puts `doc` at the front of `list` (newest first). Returns
 *  { list, added, reason }: reason is 'empty', 'same' or 'big' when nothing was
 *  added, and 'moved' when an older identical entry was brought to the front. */
export function pushEntry(list, doc, now) {
  if (!doc.strokes.length && !doc.shapes.length) return { list, added: false, reason: 'empty' }
  const cap = ARCHIVE.budgetChars * ARCHIVE.entryShare
  let entry = null
  for (const eps of EPSILONS) {
    entry = compact(doc, eps, now)
    if (sizeOf(entry) <= cap) break
  }
  if (sizeOf(entry) > cap) return { list, added: false, reason: 'big' }
  // Never twice: the same drawing as the newest changes nothing; the same as an
  // older one moves it to the front with a fresh time instead of adding a copy.
  const at = list.findIndex((e) => sameDrawing(e, entry))
  if (at === 0) return { list, added: false, reason: 'same' }
  if (at > 0) return { list: [entry, ...list.filter((_, i) => i !== at)], added: true, reason: 'moved' }
  const next = [entry, ...list].slice(0, ARCHIVE.max)
  while (next.length > 1 && sizeOf(next) > ARCHIVE.budgetChars) next.pop()
  return { list: next, added: true }
}

/** Is this stored value shaped like an archive entry at all? */
export function looksLikeEntry(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Number.isFinite(value.t) && Number.isFinite(value.n)
}
