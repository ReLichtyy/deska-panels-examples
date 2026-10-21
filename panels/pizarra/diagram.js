// A small Mermaid compiler: text in, shapes out. It is not mermaid.js (which
// renders SVG and needs a bundle this panel cannot ship): it reads a subset of
// two diagram types and lays them out itself, as plain shapes on the sheet.
//
//   flowchart / graph   TD TB BT LR RL; nodes [] () ([]) (()) {} [[]] [()] {{}}
//                       [//] [\\] >]; links --> --- -.-> -.- ==> === with |label|
//                       or -- label -->; chains (A --> B --> C) and A & B --> C
//   sequenceDiagram     participant, actor, ->> -->> -> --> -x -), Note over,
//                       Note left of, Note right of
//
// Everything else is reported, never silently dropped: unsupported lines come
// back as warnings and unsupported diagram types as an error.
//
// compileMermaid(source) -> { ok, kind, shapes, errors, warnings, scale }
// where shapes are specs for createShape (no ids) and errors and warnings
// are { line, message }.

import { CANVAS, LIMITS, SHEET } from './model.js'
import { textMetrics } from './text.js'

const BASE = 20 // font size in layout units; the fit scales it
const PAD = 30
const MAX_NODES = 60
const MAX_EDGES = 150
const INK = '#1b1b1f'
const MUTED = '#8b8d98'
const ID = '[\\w\\u00C0-\\uFFFF]+'
const ID_START = new RegExp(`^${ID}`)

const UNSUPPORTED_TYPES = /^(classDiagram|erDiagram|stateDiagram(?:-v2)?|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4\w*|sankey-beta|xychart-beta|block-beta)\b/

// Source text ---------------------------------------------------------------------

/** Lines without comments, as { n, text } with 1-based line numbers. */
function sourceLines(source) {
  const out = []
  source.split(/\r?\n/).forEach((raw, i) => {
    const cut = raw.indexOf('%%')
    const text = (cut >= 0 ? raw.slice(0, cut) : raw).trim()
    if (text) out.push({ n: i + 1, text })
  })
  return out
}

/** Splits a line on ; outside quotes and brackets. */
function statements(text) {
  const out = []
  let depth = 0
  let quote = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quote = !quote
    else if (!quote) {
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1)
      else if (c === ';' && depth === 0) {
        out.push(text.slice(start, i))
        start = i + 1
      }
    }
  }
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}

function cleanLabel(raw) {
  return raw
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\n/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim()
}

// Flowchart ---------------------------------------------------------------------

const NODE_SHAPES = [
  { open: '((', close: '))', kind: 'ellipse' },
  { open: '([', close: '])', kind: 'rect', round: true },
  { open: '[[', close: ']]', kind: 'rect' },
  { open: '[(', close: ')]', kind: 'rect', round: true },
  { open: '{{', close: '}}', kind: 'rect', round: true },
  { open: '[/', close: '/]', kind: 'rect' },
  { open: '[\\', close: '\\]', kind: 'rect' },
  { open: '(', close: ')', kind: 'rect', round: true },
  { open: '[', close: ']', kind: 'rect' },
  { open: '{', close: '}', kind: 'diamond' },
  { open: '>', close: ']', kind: 'rect' },
]

// Text-in-link forms first ("-- text -->"), then the plain ones.
const LINKS = [
  { re: /^--\s+(.*?)\s+(-{2,}>|-{3,})/, arrow: (m) => m[2].endsWith('>'), style: 'solid', labeled: true },
  { re: /^==\s+(.*?)\s+(={2,}>|={3,})/, arrow: (m) => m[2].endsWith('>'), style: 'thick', labeled: true },
  { re: /^-\.\s+(.*?)\s+(\.+->|\.+-)/, arrow: (m) => m[2].endsWith('>'), style: 'dotted', labeled: true },
  { re: /^-\.+->/, arrow: () => true, style: 'dotted' },
  { re: /^-\.+-/, arrow: () => false, style: 'dotted' },
  { re: /^={2,}>/, arrow: () => true, style: 'thick' },
  { re: /^={3,}/, arrow: () => false, style: 'thick' },
  { re: /^-{2,}[xo>]/, arrow: () => true, style: 'solid' },
  { re: /^-{3,}/, arrow: () => false, style: 'solid' },
]

class FlowParser {
  constructor(report) {
    this.report = report
    this.nodes = new Map()
    this.edges = []
    this.line = 0
    this.warned = new Set()
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.report.warnings.push({ line: this.line, message })
  }

  node(id, def) {
    let n = this.nodes.get(id)
    if (!n) {
      n = { id, text: null, kind: 'rect', round: false, order: this.nodes.size }
      this.nodes.set(id, n)
    }
    if (def) {
      n.text = def.text
      n.kind = def.kind
      n.round = !!def.round
    }
    return n
  }

  parse(stmt, line) {
    this.line = line
    const kw = /^(subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr)\b/.exec(stmt)
    if (kw) {
      this.warnOnce(kw[1], `"${kw[1]}" no está soportado y se ignora.`)
      return
    }
    const s = stmt
    let i = 0
    const skip = () => {
      while (i < s.length && /\s/.test(s[i])) i++
    }
    const fail = (message) => this.report.errors.push({ line, message })

    const parseNode = () => {
      const m = ID_START.exec(s.slice(i))
      if (!m) return null
      const id = m[0]
      i += id.length
      let def = null
      const shape = NODE_SHAPES.find((d) => s.startsWith(d.open, i))
      if (shape) {
        const from = i + shape.open.length
        let content
        let end
        if (s[from] === '"') {
          const q = s.indexOf('"', from + 1)
          end = q < 0 ? -1 : s.indexOf(shape.close, q + 1)
          content = q < 0 ? '' : s.slice(from + 1, q)
        } else {
          end = s.indexOf(shape.close, from)
          content = end < 0 ? '' : s.slice(from, end)
        }
        if (end < 0) {
          fail(`Falta cerrar "${shape.open}" con "${shape.close}" en el nodo ${id}.`)
          return { id, broken: true }
        }
        i = end + shape.close.length
        def = { text: cleanLabel(content) || id, kind: shape.kind, round: shape.round }
      }
      const cls = /^:::[\w-]+/.exec(s.slice(i))
      if (cls) {
        i += cls[0].length
        this.warnOnce('class', 'Las clases (:::) no están soportadas y se ignoran.')
      }
      this.node(id, def)
      return { id }
    }

    const parseGroup = () => {
      const group = []
      for (;;) {
        skip()
        const n = parseNode()
        if (!n) return group.length ? group : null
        if (n.broken) return null
        group.push(n.id)
        skip()
        if (s[i] === '&') {
          i++
          continue
        }
        return group
      }
    }

    const parseLink = () => {
      const rest = s.slice(i)
      for (const def of LINKS) {
        const m = def.re.exec(rest)
        if (!m) continue
        i += m[0].length
        let label = def.labeled ? cleanLabel(m[1]) : ''
        const pipe = /^\s*\|([^|]*)\|/.exec(s.slice(i))
        if (pipe) {
          label = cleanLabel(pipe[1])
          i += pipe[0].length
        }
        return { arrow: def.arrow(m), style: def.style, label }
      }
      return null
    }

    const before = this.report.errors.length
    let prev = parseGroup()
    if (!prev) {
      // A broken node already said what is wrong; do not say it twice.
      if (this.report.errors.length === before) fail(`No se entiende: "${s.slice(i).slice(0, 40)}"`)
      return
    }
    for (;;) {
      skip()
      if (i >= s.length) break
      if (s.startsWith('<', i)) {
        fail('Las flechas con punta en ambos lados (<-->) no están soportadas.')
        return
      }
      const link = parseLink()
      if (!link) {
        fail(`No se entiende: "${s.slice(i).slice(0, 40)}"`)
        return
      }
      skip()
      const mark = this.report.errors.length
      const next = parseGroup()
      if (!next) {
        if (this.report.errors.length === mark) fail('Falta el nodo después de la flecha.')
        return
      }
      for (const from of prev) for (const to of next) this.edges.push({ from, to, ...link, line })
      prev = next
    }
  }
}

function nodeBox(n) {
  const label = n.text ?? n.id
  const m = textMetrics(label, BASE)
  if (n.kind === 'ellipse') {
    const d = Math.max(m.w * 1.3 + 16, m.h * 1.8 + 12, 56)
    return { w: d, h: d }
  }
  if (n.kind === 'diamond') return { w: Math.max(m.w * 1.9 + 30, 96), h: Math.max(m.h * 2 + 24, 64) }
  return { w: Math.max(m.w + 36, 84), h: Math.max(m.h + 24, 42) }
}

/** Distance factor along (dx, dy) from the node center to its outline. */
function boundaryT(box, kind, dx, dy) {
  const ax = Math.abs(dx) || 1e-9
  const ay = Math.abs(dy) || 1e-9
  if (kind === 'ellipse') return 1 / Math.hypot(dx / (box.w / 2), dy / (box.h / 2))
  if (kind === 'diamond') return 1 / (ax / (box.w / 2) + ay / (box.h / 2))
  return Math.min(box.w / 2 / ax, box.h / 2 / ay)
}

/** Layers, then order inside layers, then positions: the usual layered layout
 *  in a small form. Returns each node's center in layout units. */
function layoutFlow(g, dir) {
  const ids = [...g.nodes.keys()]
  const out = new Map(ids.map((id) => [id, []]))
  const inn = new Map(ids.map((id) => [id, []]))
  for (const e of g.edges) {
    if (e.from === e.to) continue
    out.get(e.from).push(e.to)
    inn.get(e.to).push(e.from)
  }

  // Break cycles: edges that close one are ignored for ranking.
  const state = new Map()
  const forward = new Map(ids.map((id) => [id, []]))
  const visit = (u) => {
    state.set(u, 1)
    for (const v of out.get(u)) {
      if (state.get(v) === 1) continue
      forward.get(u).push(v)
      if (!state.has(v)) visit(v)
    }
    state.set(u, 2)
  }
  for (const id of ids) if (!state.has(id)) visit(id)

  const rank = new Map(ids.map((id) => [id, 0]))
  const indeg = new Map(ids.map((id) => [id, 0]))
  for (const u of ids) for (const v of forward.get(u)) indeg.set(v, indeg.get(v) + 1)
  const queue = ids.filter((id) => indeg.get(id) === 0)
  while (queue.length) {
    const u = queue.shift()
    for (const v of forward.get(u)) {
      rank.set(v, Math.max(rank.get(v), rank.get(u) + 1))
      indeg.set(v, indeg.get(v) - 1)
      if (indeg.get(v) === 0) queue.push(v)
    }
  }

  const layers = []
  for (const id of ids) {
    const r = rank.get(id)
    while (layers.length <= r) layers.push([])
    layers[r].push(id)
  }

  // Order inside layers by the average position of the neighbours.
  const pos = new Map()
  const index = () => layers.forEach((layer) => layer.forEach((id, k) => pos.set(id, k)))
  index()
  const neighbours = (id, lower) => {
    const all = [...out.get(id), ...inn.get(id)]
    return all.filter((o) => (lower ? rank.get(o) < rank.get(id) : rank.get(o) > rank.get(id)))
  }
  const sweep = (layer, lower) => {
    const score = new Map()
    layer.forEach((id, k) => {
      const ns = neighbours(id, lower)
      score.set(id, ns.length ? ns.reduce((a, o) => a + pos.get(o), 0) / ns.length : k)
    })
    layer.sort((a, b) => score.get(a) - score.get(b))
  }
  for (let round = 0; round < 6; round++) {
    for (let r = 1; r < layers.length; r++) {
      sweep(layers[r], true)
      index()
    }
    for (let r = layers.length - 2; r >= 0; r--) {
      sweep(layers[r], false)
      index()
    }
  }

  // Positions on the main axis (layers) and the cross axis (inside a layer).
  const horizontal = dir === 'LR' || dir === 'RL'
  const box = new Map(ids.map((id) => [id, nodeBox(g.nodes.get(id))]))
  const main = (id) => (horizontal ? box.get(id).w : box.get(id).h)
  const cross = (id) => (horizontal ? box.get(id).h : box.get(id).w)
  const GAP_MAIN = 64
  const GAP_CROSS = 36

  const mainAt = []
  let m = 0
  for (const layer of layers) {
    const size = Math.max(...layer.map(main))
    mainAt.push(m + size / 2)
    m += size + GAP_MAIN
  }

  const crossPos = new Map()
  layers.forEach((layer) => {
    const total = layer.reduce((a, id) => a + cross(id), 0) + GAP_CROSS * (layer.length - 1)
    let c = -total / 2
    for (const id of layer) {
      crossPos.set(id, c + cross(id) / 2)
      c += cross(id) + GAP_CROSS
    }
  })

  // Pull nodes toward their neighbours without letting them overlap.
  for (let round = 0; round < 4; round++) {
    for (const layer of round % 2 ? [...layers].reverse() : layers) {
      const want = layer.map((id) => {
        const ns = [...out.get(id), ...inn.get(id)].filter((o) => o !== id)
        return ns.length ? ns.reduce((a, o) => a + crossPos.get(o), 0) / ns.length : crossPos.get(id)
      })
      let edge = -Infinity
      const placed = layer.map((id, k) => {
        const p = Math.max(want[k], edge + (edge === -Infinity ? 0 : GAP_CROSS) + cross(id) / 2)
        edge = p + cross(id) / 2
        return p
      })
      const shift = layer.reduce((a, id, k) => a + (want[k] - placed[k]), 0) / layer.length
      layer.forEach((id, k) => crossPos.set(id, placed[k] + shift))
    }
  }

  const centers = new Map()
  layers.forEach((layer, r) => {
    for (const id of layer) {
      let x = horizontal ? mainAt[r] : crossPos.get(id)
      let y = horizontal ? crossPos.get(id) : mainAt[r]
      if (dir === 'BT') y = -y
      if (dir === 'RL') x = -x
      centers.set(id, { x, y })
    }
  })
  return { centers, box }
}

function compileFlow(lines, dir, report) {
  const g = new FlowParser(report)
  for (const { n, text } of lines) for (const stmt of statements(text)) g.parse(stmt, n)
  if (g.nodes.size === 0) {
    if (!report.errors.length) report.errors.push({ line: 1, message: 'No hay nodos que dibujar.' })
    return []
  }
  if (g.nodes.size > MAX_NODES) {
    report.errors.push({ line: 1, message: `Hay ${g.nodes.size} nodos; el máximo es ${MAX_NODES}.` })
    return []
  }
  if (g.edges.length > MAX_EDGES) {
    report.errors.push({ line: 1, message: `Hay ${g.edges.length} enlaces; el máximo es ${MAX_EDGES}.` })
    return []
  }

  const { centers, box } = layoutFlow(g, dir)
  const specs = []
  for (const n of g.nodes.values()) {
    const c = centers.get(n.id)
    const b = box.get(n.id)
    specs.push({ kind: n.kind, x: c.x - b.w / 2, y: c.y - b.h / 2, w: b.w, h: b.h, fill: true, round: n.round, text: n.text ?? n.id, size: BASE, width: 2, color: INK })
  }

  const pairs = new Set(g.edges.map((e) => `${e.from}>${e.to}`))
  for (const e of g.edges) {
    if (e.from === e.to) {
      report.warnings.push({ line: e.line, message: `El enlace de ${e.from} a sí mismo no se dibuja.` })
      continue
    }
    const a = centers.get(e.from)
    const b = centers.get(e.to)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ta = boundaryT(box.get(e.from), g.nodes.get(e.from).kind, dx, dy)
    const tb = boundaryT(box.get(e.to), g.nodes.get(e.to).kind, dx, dy)
    const off = pairs.has(`${e.to}>${e.from}`) ? 9 : 0
    const nx = (-dy / len) * off
    const ny = (dx / len) * off
    const gap = e.arrow ? 2 : 0
    const p1 = [a.x + dx * ta + nx, a.y + dy * ta + ny]
    const p2 = [b.x - dx * tb + nx - (dx / len) * gap, b.y - dy * tb + ny - (dy / len) * gap]
    specs.push({
      kind: e.arrow ? 'arrow' : 'line',
      points: [p1, p2],
      dash: e.style === 'dotted',
      width: e.style === 'thick' ? 4 : 2,
      color: INK,
      text: e.label || undefined,
      size: e.label ? BASE * 0.85 : undefined,
    })
  }
  return specs
}

// Sequence diagram ---------------------------------------------------------------

const MESSAGE = new RegExp(`^(${ID})\\s*(-->>|->>|--x|-x|--\\)|-\\)|-->|->)\\s*[+-]?\\s*(${ID})\\s*:\\s*(.*)$`)
const PARTICIPANT = new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`, 'i')
const NOTE = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i
const SEQ_IGNORED = /^(autonumber|activate|deactivate|title|loop|alt|opt|par|else|end|rect|critical|break|and|option|box|create|destroy|link|links)\b/i

function compileSequence(lines, report) {
  const order = []
  const labels = new Map()
  const events = []
  const ensure = (id, label) => {
    if (!labels.has(id)) {
      labels.set(id, label ?? id)
      order.push(id)
    } else if (label) labels.set(id, label)
  }
  const warned = new Set()

  for (const { n, text } of lines) {
    for (const stmt of statements(text)) {
      let m = PARTICIPANT.exec(stmt)
      if (m) {
        ensure(m[2], m[3] ? cleanLabel(m[3]) : m[2])
        continue
      }
      m = MESSAGE.exec(stmt)
      if (m) {
        ensure(m[1])
        ensure(m[3])
        const arrow = m[2].endsWith('>') || m[2].endsWith(')') || m[2].endsWith('x')
        events.push({ type: 'message', from: m[1], to: m[3], arrow, dashed: m[2].startsWith('--'), text: cleanLabel(m[4]), line: n })
        continue
      }
      m = NOTE.exec(stmt)
      if (m) {
        const ids = m[2].split(',').map((s) => s.trim())
        for (const id of ids) ensure(id)
        events.push({ type: 'note', where: m[1].toLowerCase(), ids, text: cleanLabel(m[3]), line: n })
        continue
      }
      const kw = SEQ_IGNORED.exec(stmt)
      if (kw) {
        const key = kw[1].toLowerCase()
        if (!warned.has(key)) {
          warned.add(key)
          report.warnings.push({ line: n, message: `"${kw[1]}" no está soportado y se ignora.` })
        }
        continue
      }
      report.errors.push({ line: n, message: `No se entiende: "${stmt.slice(0, 40)}"` })
    }
  }
  if (order.length === 0) {
    if (!report.errors.length) report.errors.push({ line: 1, message: 'No hay participantes ni mensajes.' })
    return []
  }
  if (order.length > 12 || events.length > 80) {
    report.errors.push({ line: 1, message: 'Demasiado grande: hasta 12 participantes y 80 mensajes.' })
    return []
  }

  const head = order.map((id) => {
    const m = textMetrics(labels.get(id), BASE)
    return { id, w: Math.max(m.w + 36, 110), h: Math.max(m.h + 20, 42) }
  })
  const col = new Map(order.map((id, k) => [id, k]))
  const gaps = head.slice(1).map((h, k) => Math.max(150, (head[k].w + h.w) / 2 + 24))
  for (const ev of events) {
    if (ev.type !== 'message' || !ev.text) continue
    const a = Math.min(col.get(ev.from), col.get(ev.to))
    const b = Math.max(col.get(ev.from), col.get(ev.to))
    if (a === b) continue
    const need = (textMetrics(ev.text, BASE * 0.9).w + 28) / (b - a)
    for (let k = a; k < b; k++) gaps[k] = Math.max(gaps[k], need)
  }
  const x = [0]
  gaps.forEach((gp, k) => x.push(x[k] + gp))

  const specs = []
  const headH = Math.max(...head.map((h) => h.h))
  head.forEach((h, k) => {
    specs.push({ kind: 'rect', x: x[k] - h.w / 2, y: 0, w: h.w, h: headH, fill: true, text: labels.get(h.id), size: BASE, width: 2, color: INK })
  })

  let y = headH + 44
  const lifelineFrom = headH
  const small = BASE * 0.9
  for (const ev of events) {
    if (ev.type === 'message') {
      const x1 = x[col.get(ev.from)]
      const x2 = x[col.get(ev.to)]
      const label = ev.text ? textMetrics(ev.text, small) : null
      if (ev.from === ev.to) {
        specs.push({ kind: 'line', points: [[x1, y], [x1 + 38, y]], dash: ev.dashed, width: 2, color: INK })
        specs.push({ kind: 'line', points: [[x1 + 38, y], [x1 + 38, y + 24]], dash: ev.dashed, width: 2, color: INK })
        specs.push({ kind: ev.arrow ? 'arrow' : 'line', points: [[x1 + 38, y + 24], [x1 + 2, y + 24]], dash: ev.dashed, width: 2, color: INK })
        if (label) specs.push({ kind: 'text', x: x1 + 46, y: y + 12 - label.h / 2, text: ev.text, size: small, width: 1, color: INK })
        y += 64
      } else {
        specs.push({ kind: ev.arrow ? 'arrow' : 'line', points: [[x1, y], [x2, y]], dash: ev.dashed, width: 2, color: INK })
        if (label) specs.push({ kind: 'text', x: (x1 + x2) / 2 - label.w / 2, y: y - label.h - 5, text: ev.text, size: small, width: 1, color: INK })
        y += 54
      }
    } else {
      const m = textMetrics(ev.text, small)
      const w = Math.max(m.w + 28, 96)
      const h = m.h + 18
      const xs = ev.ids.map((id) => x[col.get(id)])
      let cx
      let bw = w
      if (ev.where === 'over') {
        const lo = Math.min(...xs)
        const hi = Math.max(...xs)
        cx = (lo + hi) / 2
        bw = Math.max(w, hi - lo + 40)
      } else if (ev.where === 'left of') cx = xs[0] - w / 2 - 14
      else cx = xs[0] + w / 2 + 14
      specs.push({ kind: 'rect', x: cx - bw / 2, y, w: bw, h, fill: true, text: ev.text, size: small, width: 1.5, color: INK })
      y += h + 26
    }
  }
  const bottom = y - 10
  head.forEach((h, k) => {
    specs.unshift({ kind: 'line', points: [[x[k], lifelineFrom], [x[k], bottom]], dash: true, width: 1.5, color: MUTED })
  })
  return specs
}

// Fit to the sheet --------------------------------------------------------------------

function specBounds(sp) {
  if (sp.points) {
    const xs = sp.points.map((p) => p[0])
    const ys = sp.points.map((p) => p[1])
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  if (sp.kind === 'text') {
    const m = textMetrics(sp.text, sp.size)
    return { x1: sp.x, y1: sp.y, x2: sp.x + m.w, y2: sp.y + m.h }
  }
  return { x1: sp.x, y1: sp.y, x2: sp.x + sp.w, y2: sp.y + sp.h }
}

/** Scales and centers the specs on the sheet. Up to 1.5x, down as far as needed. */
function fit(specs, report) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const sp of specs) {
    const b = specBounds(sp)
    x1 = Math.min(x1, b.x1)
    y1 = Math.min(y1, b.y1)
    x2 = Math.max(x2, b.x2)
    y2 = Math.max(y2, b.y2)
  }
  const w = Math.max(1, x2 - x1)
  const h = Math.max(1, y2 - y1)
  const scale = Math.min(1.5, (SHEET.width - 2 * PAD) / w, (SHEET.height - 2 * PAD) / h)
  if (scale < 0.5) report.warnings.push({ line: 1, message: `Diagrama grande: se redujo al ${Math.round(scale * 100)}%.` })
  const ox = (SHEET.width - w * scale) / 2 - x1 * scale
  const oy = (SHEET.height - h * scale) / 2 - y1 * scale
  let tiny = false
  const out = specs.map((sp) => {
    const next = { ...sp, width: Math.max(1, Math.round(sp.width * Math.min(scale, 1.3) * 10) / 10) }
    if (sp.points) next.points = sp.points.map((p) => [p[0] * scale + ox, p[1] * scale + oy])
    else {
      next.x = sp.x * scale + ox
      next.y = sp.y * scale + oy
      if (sp.w !== undefined) {
        next.w = sp.w * scale
        next.h = sp.h * scale
      }
    }
    if (sp.size !== undefined) {
      next.size = sp.size * scale
      if (next.size < LIMITS.sizeMin) {
        next.size = LIMITS.sizeMin
        tiny = true
      }
    }
    return next
  })
  if (tiny) report.warnings.push({ line: 1, message: 'El texto quedó muy pequeño; divide el diagrama en partes.' })
  return { specs: out, scale }
}

/** Moves compiled specs so their middle lands on (cx, cy), kept inside the
 *  canvas. The compiler lays out around the home page; this puts the result
 *  where the person is looking. */
export function placeAt(specs, cx, cy) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const sp of specs) {
    const b = specBounds(sp)
    x1 = Math.min(x1, b.x1)
    y1 = Math.min(y1, b.y1)
    x2 = Math.max(x2, b.x2)
    y2 = Math.max(y2, b.y2)
  }
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
  const dx = clamp(cx - (x1 + x2) / 2, CANVAS.x - x1, CANVAS.x + CANVAS.width - x2)
  const dy = clamp(cy - (y1 + y2) / 2, CANVAS.y - y1, CANVAS.y + CANVAS.height - y2)
  return specs.map((sp) => {
    if (sp.points) return { ...sp, points: sp.points.map((p) => [p[0] + dx, p[1] + dy]) }
    return { ...sp, x: sp.x + dx, y: sp.y + dy }
  })
}

// Entry point ---------------------------------------------------------------------------

export function compileMermaid(source) {
  const report = { errors: [], warnings: [] }
  const fail = (message, line = 1) => ({ ok: false, kind: null, shapes: [], errors: [{ line, message }, ...report.errors], warnings: report.warnings, scale: 1 })

  if (typeof source !== 'string' || source.trim() === '') return fail('Escribe un diagrama. Por ejemplo: flowchart TD, y debajo A --> B.')
  if (source.length > LIMITS.mermaidLength) return fail(`El texto supera ${LIMITS.mermaidLength} caracteres.`)
  const lines = sourceLines(source)
  if (!lines.length) return fail('Escribe un diagrama. Por ejemplo: flowchart TD, y debajo A --> B.')

  // Optional front matter and init directives are skipped with a warning.
  let at = 0
  while (at < lines.length && /^(---|%%\{|\{)/.test(lines[at].text)) at++
  const head = lines[at]
  if (!head) return fail('Falta el tipo de diagrama, por ejemplo: flowchart TD.')

  let kind
  let specs
  const flow = /^(flowchart|graph)(?:\s+(TD|TB|BT|RL|LR))?\s*;?$/i.exec(head.text)
  if (flow) {
    kind = 'flowchart'
    const dir = (flow[2] || 'TB').toUpperCase() === 'TD' ? 'TB' : (flow[2] || 'TB').toUpperCase()
    specs = compileFlow(lines.slice(at + 1), dir, report)
  } else if (/^sequenceDiagram\b/i.test(head.text)) {
    kind = 'sequence'
    specs = compileSequence(lines.slice(at + 1), report)
  } else {
    const other = UNSUPPORTED_TYPES.exec(head.text)
    return fail(
      other
        ? `El tipo "${other[1]}" no está soportado. Admite flowchart, graph y sequenceDiagram.`
        : `No se reconoce el tipo de diagrama: "${head.text.slice(0, 30)}". Admite flowchart, graph y sequenceDiagram.`,
      head.n,
    )
  }
  if (report.errors.length && !specs.length) return { ok: false, kind, shapes: [], errors: report.errors, warnings: report.warnings, scale: 1 }
  if (!specs.length) return fail('No hay nada que dibujar.')
  if (specs.length > LIMITS.shapes) return fail(`El diagrama necesita ${specs.length} figuras; el máximo es ${LIMITS.shapes}.`)
  const fitted = fit(specs, report)
  // Lines with a problem do not block the rest: they come back as errors but
  // the diagram still compiles, so ok means "something was produced".
  return { ok: true, kind, shapes: fitted.specs, errors: report.errors, warnings: report.warnings, scale: fitted.scale }
}

