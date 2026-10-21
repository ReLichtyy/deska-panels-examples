// Undo and redo over snapshots of the stroke list. Strokes are immutable, so a
// snapshot is just an array of references and costs almost nothing.

export function createHistory(limit = 200) {
  let past = []
  let future = []
  return {
    /** Call with the strokes as they were BEFORE a new action. Drops redo. */
    record(before) {
      past.push(before)
      if (past.length > limit) past.shift()
      future = []
    },
    /** Returns the previous strokes, or null when there is nothing to undo. */
    undo(current) {
      if (!past.length) return null
      future.push(current)
      return past.pop()
    },
    /** Returns the next strokes, or null when there is nothing to redo. */
    redo(current) {
      if (!future.length) return null
      past.push(current)
      return future.pop()
    },
    get canUndo() {
      return past.length > 0
    },
    get canRedo() {
      return future.length > 0
    },
    clear() {
      past = []
      future = []
    },
  }
}
