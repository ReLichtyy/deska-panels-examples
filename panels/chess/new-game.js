// The new-game card: who to play (Dex or two people on one board), Dex's level, then the color.
// The Partida button under the board opens it at the first step; the home screen's cards open it
// straight at the color, with the opponent already chosen. Choosing a color starts the game.

import { levelText } from './home.js'

/**
 * settings: () => the current settings ({ botRating }).
 * actions:  { start(kind, side), setLevel(n), renderChoices(), onToggle(open) }.
 */
export function mountNewGame({ settings, actions }) {
  const $ = (id) => document.getElementById(id)
  const root = $('new-game')
  let kind = null // 'bot' | 'two' once the opponent is chosen
  let from = null // what had focus, to go back to it

  function showLevel(rating) {
    $('new-game-level-output').value = levelText(rating)
    $('new-game-bot-level').textContent = `Nivel ${rating}`
  }

  function step(next) {
    kind = next
    const choosing = kind !== null
    $('new-game-modes').hidden = choosing
    $('new-game-colors').hidden = !choosing
    $('new-game-title-text').textContent = choosing ? 'Elige tu color' : 'Nueva partida'
    $('new-game-sub').textContent = !choosing ? 'Contra quién juegas'
      : kind === 'bot' ? `Contra Dex · ${settings().botRating}` : 'Dos en un tablero'
    if (choosing) actions.renderChoices()
    root.querySelector(choosing ? '#new-game-colors .choice' : '#new-game-bot').focus({ preventScroll: true })
  }

  /** Opens the card: at the color when the opponent is given ('bot' | 'two'), otherwise at the opponent. */
  function open(opponent = null, opener = document.activeElement) {
    from = opener
    showLevel(settings().botRating)
    $('new-game-level').value = String(settings().botRating)
    root.hidden = false
    actions.onToggle(true)
    step(opponent)
  }

  function close() {
    if (root.hidden) return
    root.hidden = true
    kind = null
    actions.onToggle(false)
    from?.focus?.({ preventScroll: true })
  }

  function choose(side) {
    const opponent = kind
    root.hidden = true
    kind = null
    actions.onToggle(false)
    actions.start(opponent, side)
  }

  $('new-game-bot').addEventListener('click', () => step('bot'))
  $('new-game-two').addEventListener('click', () => step('two'))
  for (const button of root.querySelectorAll('#new-game-colors .choice')) button.addEventListener('click', () => choose(button.dataset.pick))
  $('new-game-cancel').addEventListener('click', close)
  root.addEventListener('click', (event) => { if (event.target === root) close() })
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } })
  $('new-game-level').addEventListener('input', () => showLevel(Number($('new-game-level').value)))
  $('new-game-level').addEventListener('change', () => actions.setLevel(Number($('new-game-level').value)))

  return { open, close, get isOpen() { return !root.hidden } }
}
