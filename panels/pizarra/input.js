// Pointer lifecycle for the canvas. One pointer at a time: the first primary
// pointer to go down owns the interaction until it goes up or is cancelled,
// and every other pointer is ignored meanwhile.
//
// handlers.begin(point, event) -> boolean   start; return false to refuse (it decides
//                                    what to do with a point off the sheet)
// handlers.move(points)              one or more points, in order
// handlers.end(point)                the pointer was released
// handlers.cancel()                  the interaction was aborted: undo it
// handlers.locate(event) -> { x, y, inside }

export function attachInput(canvas, handlers) {
  let active = null

  function release(id) {
    try {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
    } catch {
      // Already released, or the pointer is gone: nothing to do.
    }
  }

  function finish(cancelled, event) {
    const id = active
    active = null
    release(id)
    if (cancelled) handlers.cancel()
    else handlers.end(handlers.locate(event))
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (active !== null) return
    if (!event.isPrimary) return
    // Left draws or selects; middle and right drag the canvas.
    if (event.pointerType === 'mouse' && event.button > 2) return
    const point = handlers.locate(event)
    event.preventDefault()
    // preventDefault also stops the browser from focusing the panel, which
    // would leave shortcuts (undo, delete) with the host after a mouse-only
    // edit. Focus the panel's document, not the canvas, so no focus ring shows.
    if (!document.hasFocus()) window.focus()
    if (!handlers.begin(point, event)) return
    active = event.pointerId
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Capture can fail for a pointer that just vanished; up/cancel still end it.
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    if (active === null) {
      if (event.isPrimary) handlers.hover?.(handlers.locate(event))
      return
    }
    if (event.pointerId !== active) return
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    handlers.move((events.length ? events : [event]).map((e) => handlers.locate(e)))
  })

  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== active) return
    finish(false, event)
  })

  canvas.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== active) return
    finish(true, event)
  })

  // Capture taken away without an up (element hidden, pointer lost): abort.
  canvas.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId !== active) return
    finish(true, event)
  })

  canvas.addEventListener('contextmenu', (event) => event.preventDefault())

  return {
    get active() {
      return active !== null
    },
    /** Aborts whatever is pending (Escape, panel hidden, a dialog opening). */
    cancel() {
      if (active === null) return
      finish(true, null)
    },
  }
}
