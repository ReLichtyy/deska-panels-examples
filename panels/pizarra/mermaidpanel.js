// The Mermaid editor. Compiling turns the text into
// shapes through commit(), so it is one undo step like any other edit.

import { LIMITS, createShape } from './model.js'
import { compileMermaid, placeAt } from './diagram.js'
import { viewCenter } from './drawing.js'
import { announce, commit, state, view } from './state.js'

const GROUP = 'mermaid'
const $ = (id) => document.getElementById(id)

const EXAMPLE = 'flowchart TD\n  A[Idea] --> B{¿Claro?}\n  B -->|Sí| C[Dibujar]\n  B -->|No| A'

/** Compiles `source` and puts the result on the sheet. Returns the compiler's
 *  result with ok false when nothing was inserted. */
export function compileInto(source, replace) {
  const result = compileMermaid(source)
  if (!result.ok) return result
  const kept = replace ? state.doc.shapes.filter((s) => s.group !== GROUP) : state.doc.shapes
  if (kept.length + result.shapes.length > LIMITS.shapes) {
    return { ...result, ok: false, errors: [{ line: 1, message: `No caben ${result.shapes.length} figuras más (el máximo es ${LIMITS.shapes}).` }, ...result.errors] }
  }
  // The diagram appears where the person is looking, not only on the home page.
  const here = viewCenter(view)
  const created = placeAt(result.shapes, here.x, here.y).map((spec) => createShape({ ...spec, group: GROUP }))
  state.doc.mermaid = source
  const inserted = commit({ shapes: [...kept, ...created] })
  if (inserted) announce(created.map((shape) => shape.id))
  return { ...result, ok: inserted }
}

function line(parent, className, text) {
  const li = document.createElement('li')
  li.className = className
  li.textContent = text
  parent.append(li)
}

/** Shows only what needs attention: each error and warning with its line. */
function showResult(result) {
  const out = $('mermaid-result')
  out.replaceChildren()
  // A success says nothing: the diagram appearing is the answer.
  if (!result.ok && !result.errors.length) line(out, 'is-error', 'No se pudo insertar el diagrama.')
  for (const e of result.errors) line(out, 'is-error', `Línea ${e.line}: ${e.message}`)
  for (const w of result.warnings) line(out, 'is-warn', `Línea ${w.line}: ${w.message}`)
}

export function syncMermaidPanel() {
  const box = $('mermaid-src')
  box.value = state.doc.mermaid || ''
  box.placeholder = EXAMPLE
}

export function initMermaidPanel({ touch, afterInsert }) {
  const box = $('mermaid-src')
  box.placeholder = EXAMPLE

  const run = (source) => {
    const result = compileInto(source, true)
    showResult(result)
    if (result.ok) afterInsert()
    return result
  }

  box.addEventListener('input', () => {
    state.doc.mermaid = box.value.slice(0, LIMITS.mermaidLength)
    touch()
  })
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      run(box.value)
    }
  })
  $('mermaid-compile').addEventListener('click', () => run(box.value))
}
