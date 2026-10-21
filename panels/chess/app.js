/* Chess: a board on a canvas, a bot you tune, and a side you pick at the start.
 *
 * What this panel teaches:
 * - A game that survives a reload: the position is stored as a FEN after every move and the
 *   chosen side next to it, so a panel moved to a dock comes back where it was.
 * - Settings in deska.storage with a defaults-per-key read, so an older save never breaks a newer
 *   panel, and a failed save is said out loud.
 * - Heavy work with no workers: the bot's search runs on the page and yields between moves.
 * - A canvas that follows Deska's theme tokens, redraws on a theme change, and stops its
 *   animation frames while the panel is hidden or the person prefers reduced motion. */

import { captures, createBoard, drawCaptured, drawPreview, PIECE_SETS } from './board.js'
import { chooseMove, profileFor } from './engine.js'
import {
  fromFEN, isOver, legalMoves, moveFromUci, newGame, other, play, premoveTargets, premoveUci, projectPremoves,
  squareName, toFEN,
} from './rules.js'
import {
  appPalette, BRUSH_ALPHA, BRUSHES, brushFor, composite, HALO, HIGHLIGHT_ALPHA, normalizeColor, PALETTES, readableInk, tint, toHex,
  toggleArrow, toggleHighlight,
} from './marks.js'
import { mountOnline } from './online-ui.js'
import { initial, levelText, mountHome } from './home.js'
import { mountNewGame } from './new-game.js'
import { onlineConfig } from './online-config.js'

const $ = (id) => document.getElementById(id)
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
const SLIDE_MS = 220
const LIFT_MS = 140
// The bot waits a little, a different amount each time, so its answer feels like a person's.
const botDelay = () => 650 + Math.random() * 600

const DEFAULTS = Object.freeze({ palette: 'app', pieceSet: 'classic', coordinates: true, fullBoard: false, botEnabled: true, botRating: 1200 })

let settings = { ...DEFAULTS }
let game = newGame()
let side = 'w' // the person's color; the view and the bot follow it
let phase = 'choose' // choose | play | over
let selected = null
let moves = []
let hover = null
let thinking = false
let botToken = 0
let games = [game] // the position after each ply, from the start
let ucis = [] // the move between each pair of positions, as UCI text
let cursor = 0 // which of `games` is on the board
let hint = null // { from, to } while a suggestion is on the board
let hintBusy = false
let hintToken = 0
let resultDismissed = false
let slide = null // { moves: [{ from, to }], start } while a move is sliding
let selectedAt = 0
let visible = true
let frame = 0
let openSheet = null
let colors
let onlineMode = false
let onlineLocked = true
let onlineRoomId = null
let localGame = null
let pendingPromotion = null
let online = null
let pendingOnline = null // { uci, after } while the server confirms your online move
let home = null
let newGameCard = null // the new-game card: opponent, level, then color
let stash = null // a local game set aside while a new one is being started from the home screen
let onlineOpponent = null // the rival's alias, from the room
let myName = null // your shared name or alias once signed in, for the initial on your line
let onlineCode = null
let onlineStatus = 'waiting'
let selectionKind = 'move' // move | premove: what the held piece is choosing
let gesture = null // the pointer gesture on the board, see Input
let lastRightAt = 0
let arrows = [] // [{ from, to, brush }] drawn with the right button; only on screen
let highlights = [] // [{ f, r, brush }]
let premoves = [] // [{ from, to, uci }] queued while the other side moves
let premoveTimer = 0
let premoveToken = 0

const board = createBoard($('board'))

document.documentElement.classList.add('no-transitions')
const init = await deska.ready()
document.documentElement.classList.remove('no-transitions')
colors = readColors()

// Storage ---------------------------------------------------------------------------------

async function loadSettings() {
  try {
    const stored = await deska.storage.get('settings')
    const out = { ...DEFAULTS }
    if (stored && typeof stored === 'object') {
      if (stored.palette === 'app' || stored.palette in PALETTES) out.palette = stored.palette
      if (stored.pieceSet in PIECE_SETS) out.pieceSet = stored.pieceSet
      if (typeof stored.coordinates === 'boolean') out.coordinates = stored.coordinates
      if (typeof stored.fullBoard === 'boolean') out.fullBoard = stored.fullBoard
      if (typeof stored.botEnabled === 'boolean') out.botEnabled = stored.botEnabled
      if (Number.isInteger(stored.botRating) && stored.botRating >= 400 && stored.botRating <= 2000) out.botRating = stored.botRating
    }
    return out
  } catch (err) {
    showStatus(`No se pudieron leer tus ajustes. ${problemText(err)}`, 'error')
    return { ...DEFAULTS }
  }
}

async function loadGame() {
  let stored
  try {
    stored = await deska.storage.get('game')
  } catch (err) {
    showStatus(`No se pudo leer la partida. ${problemText(err)}`, 'error')
    return null
  }
  if (!stored || (stored.side !== 'w' && stored.side !== 'b')) return null
  try {
    // Older saves kept only the position (`fen`); newer ones keep the start and every move.
    const first = fromFEN(typeof stored.start === 'string' ? stored.start : stored.fen)
    const list = [first]
    const played = []
    for (const uci of Array.isArray(stored.moves) ? stored.moves : []) {
      const found = moveFromUci(list[list.length - 1], uci)
      if (!found) throw new Error(`Saved move ${uci} is not legal.`)
      list.push(play(list[list.length - 1], found.from, found.move))
      played.push(uci)
    }
    const at = Number.isInteger(stored.cursor) && stored.cursor >= 0 && stored.cursor < list.length ? stored.cursor : list.length - 1
    return { side: stored.side, games: list, ucis: played, cursor: at }
  } catch (err) {
    console.warn('Chess: the saved game could not be restored.', err)
    showStatus('No se pudo restaurar la partida guardada. Empieza una nueva.', 'error')
    return null
  }
}

async function save(key, value) {
  try {
    await deska.storage.set(key, value)
  } catch (err) {
    showStatus(`No se guardó. ${problemText(err)}`, 'error')
  }
}

const saveSettings = () => save('settings', settings)
const saveGame = () => onlineMode ? Promise.resolve() : save('game', { v: 2, side, start: toFEN(games[0]), moves: ucis, cursor })

function problemText(err) {
  const messages = {
    storage_full: 'El almacenamiento está lleno.',
    rate_limited: 'Demasiadas peticiones seguidas. Inténtalo en un momento.',
  }
  return (err && messages[err.code]) || `(${(err && err.code) || 'error desconocido'})`
}

// A notice over the top of the board, never over the controls below it. It closes with its X or
// Escape, and on its own after 4 s (info) or 8 s (error); pointing at it or focusing it pauses that.
let statusTimer = 0
let statusLeft = 0
let statusStarted = 0
const statusHeld = { pointer: false, focus: false }
function showStatus(text, kind = 'info') {
  const el = $('status')
  clearTimeout(statusTimer)
  if (!text) { hideStatus(); return }
  $('status-text').textContent = text
  el.className = `status is-${kind}`
  el.dataset.kind = kind
  el.hidden = false
  // Persistent live regions announce reliably; a container that just appeared may not.
  $(kind === 'error' ? 'alert' : 'announce').textContent = text
  statusLeft = kind === 'error' ? 8000 : 4000
  resumeStatus()
}
function resumeStatus() {
  clearTimeout(statusTimer)
  if ($('status').hidden || statusHeld.pointer || statusHeld.focus) return
  statusStarted = performance.now()
  statusTimer = setTimeout(hideStatus, statusLeft)
}
function pauseStatus() {
  if (!statusTimer) return
  clearTimeout(statusTimer)
  statusTimer = 0
  statusLeft = Math.max(1500, statusLeft - (performance.now() - statusStarted))
}
function hideStatus() {
  clearTimeout(statusTimer)
  statusTimer = 0
  const el = $('status')
  if (el.hidden) return
  const hadFocus = el.contains(document.activeElement)
  el.hidden = true
  statusHeld.pointer = false
  statusHeld.focus = false
  if (hadFocus) $('board').focus({ preventScroll: true })
}

// Full board -----------------------------------------------------------------------------------
//
// With the option on, the board takes the whole panel and the two bars float over it, hidden until
// asked for: the small button, a tap on a bar's edge, or a game that is not running. They put
// themselves away after a few seconds, unless a menu is open or the pointer is on them.

let barsTimer = 0
let barsHeld = false

function applyLayout() {
  const app = $('app')
  app.dataset.full = String(settings.fullBoard)
  if (!settings.fullBoard) { delete app.dataset.bars; clearTimeout(barsTimer) }
}

function openBars() {
  if (!settings.fullBoard) return
  $('app').dataset.bars = 'open'
  clearTimeout(barsTimer)
  barsTimer = setTimeout(closeBars, 4500)
}

function closeBars() {
  clearTimeout(barsTimer)
  // Not while a menu is open or the person is using them.
  if (barsHeld || openSheet || !$('new-game').hidden) { barsTimer = setTimeout(closeBars, 1500); return }
  if (document.activeElement && document.activeElement.closest('.bar, .foot')) document.activeElement.blur()
  delete $('app').dataset.bars
}

// Player lines --------------------------------------------------------------------------------
//
// The line above the board is the opponent's, the one below is yours. Each carries an avatar (an
// initial), a name, a note (the color, or the room code while waiting), what that side has captured
// and its material lead. Two people on one board are only colors, so their lines have no avatar.
// The turn line under the side to move is drawn by CSS from data-active.

// The lines line up with the board's edge, which the board measures.
function syncLayout() {
  $('app').style.setProperty('--board-left', `${board.view.x}px`)
}

const colorWord = (c) => (c === 'w' ? 'Blancas' : 'Negras')

function playerLines() {
  const top = other(side)
  const waiting = onlineMode && onlineStatus === 'waiting'
  let topName
  let topNote = colorWord(top)
  let topAvatar = null
  let bottomName = 'Tú'
  if (onlineMode) {
    topName = waiting ? 'Esperando rival' : onlineOpponent || 'Rival'
    if (!waiting) topAvatar = initial(topName)
    if (waiting) topNote = onlineCode
    else if (onlineLocked && online?.state.phase === 'disconnected') topNote = 'Sin conexión'
  } else if (settings.botEnabled) { topName = `Dex ${settings.botRating}`; topAvatar = 'D' }
  else { topName = colorWord(top); topNote = ''; bottomName = colorWord(side) }
  const you = bottomName === 'Tú'
  const lines = {
    top: { name: topName, note: topNote, code: waiting, avatar: topAvatar },
    bottom: { name: bottomName, note: you ? colorWord(side) : '', avatar: you ? initial(myName || bottomName) : null },
  }
  // What the side to move is doing says more than its color: thinking, or in check.
  const shown = shownGame()
  if (phase === 'play') {
    const mover = shown.turn === side ? 'bottom' : 'top'
    if (shown.status === 'check') { lines[mover].note = 'Jaque'; lines[mover].tone = 'danger' }
    else if (thinking && mover === 'top') lines.top.note = 'Pensando…'
  }
  return lines
}

function updatePlayers() {
  if (!colors) return
  const shown = shownGame()
  const lines = playerLines()
  const lost = captures(shown.board)
  const turn = shown.turn
  const active = phase === 'play' && !(onlineMode && onlineStatus === 'waiting')
  for (const position of ['top', 'bottom']) {
    const mine = position === 'bottom' ? side : other(side) // the color of this line
    const foe = other(mine)
    const line = lines[position]
    const avatar = $(`avatar-${position}`)
    avatar.textContent = line.avatar || ''
    avatar.hidden = !line.avatar
    $(`name-${position}`).textContent = line.name
    const note = $(`note-${position}`)
    note.textContent = line.note || ''
    note.toggleAttribute('data-code', !!line.code)
    note.dataset.tone = line.tone || ''
    // What this side captured is what the other color lost. Redrawn only when it would look different.
    const captured = $(`captured-${position}`)
    const look = { accent: colors.ink || colors.accent, bg: colors.bg }
    const key = [settings.pieceSet, lost[foe].join(''), foe, look.accent, look.bg, window.devicePixelRatio].join('|')
    if (captured.dataset.key !== key) {
      captured.dataset.key = key
      drawCaptured(captured, settings.pieceSet, lost[foe], foe === 'w', look)
    }
    const lead = lost.lead * (mine === 'w' ? 1 : -1)
    const material = $(`material-${position}`)
    material.textContent = lead > 0 ? `+${lead}` : ''
    material.setAttribute('aria-label', lead > 0 ? `Ventaja de ${lead} ${lead === 1 ? 'punto' : 'puntos'}` : '')
    $(`player-${position}`).dataset.active = String(active && turn === mine)
  }
}

// Colors and drawing ------------------------------------------------------------------------

// Deska writes its colors as rgb(); the board's math (tints, outline colors, contrast) needs '#rrggbb'.
// Anything normalizeColor cannot read goes through the browser's own parser (hsl, names, oklch...).
const probe = document.createElement('canvas').getContext('2d')
function toHexColor(value) {
  const direct = normalizeColor(value)
  if (direct || !value) return direct
  probe.fillStyle = '#010203'
  probe.fillStyle = value
  const parsed = probe.fillStyle // '#rrggbb' when opaque, 'rgba(...)' otherwise, unchanged when invalid
  return parsed === '#010203' ? null : normalizeColor(parsed)
}

function readColors() {
  const css = getComputedStyle(document.documentElement)
  const token = (name) => css.getPropertyValue(name).trim()
  const color = (name, fallback) => toHexColor(token(name)) || fallback
  const bg = color('--deska-bg', '#15171a')
  const accent = color('--deska-accent', '#ff7a5c')
  // The accent as a line or an icon on the panel's ground (which is the background tinted 4% toward it).
  const ink = readableInk(accent, toHex(composite(accent, 0.04, bg)))
  document.documentElement.style.setProperty('--accent-ink', ink)
  return {
    bg,
    label: color('--deska-text-secondary', '#979a9d'),
    danger: color('--deska-danger', '#e2604a'),
    success: color('--deska-success', '#34c77b'),
    font: token('--deska-font-ui') || 'system-ui, sans-serif',
    accent,
    ink,
  }
}

function boardColors() {
  return settings.palette === 'app' ? appPalette(colors.accent) : PALETTES[settings.palette]
}

function pulse(now) {
  return reduced.matches ? 1 : 0.625 + 0.375 * Math.sin((now / 1000) * Math.PI * 2 * 1.2)
}

const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

// The position on the board: your online move shows at once while the server confirms it.
const shownGame = () => (pendingOnline ? pendingOnline.after : game)
// While a piece slides or follows the pointer, the engine thinks in shorter slices.
const animating = () => (!!slide && performance.now() - slide.start < SLIDE_MS) || !!gesture?.dragging
const sameSq = (a, b) => a === b || (!!a && !!b && a.f === b.f && a.r === b.r)

function paint(now = performance.now()) {
  if (slide && now - slide.start >= SLIDE_MS) slide = null
  const shown = shownGame()
  const g = gesture
  const dragging = g && g.kind === 'left' && g.dragging && g.piece
  board.draw({
    game: shown,
    flipped: side === 'b',
    selected,
    moves,
    movesKind: selectionKind,
    hover: dragging ? pointerOver(g) : hover,
    colors: { ...colors, ...boardColors() },
    pieceSet: settings.pieceSet,
    coordinates: settings.coordinates,
    pulse: pulse(now),
    hint,
    slide: slide ? { moves: slide.moves, t: ease((now - slide.start) / SLIDE_MS) } : null,
    lift: selected && selectionKind === 'move' ? (reduced.matches ? 1 : ease((now - selectedAt) / LIFT_MS)) : 0,
    lastMove: phase !== 'choose' && shown.last ? shown.last : null,
    premoves,
    highlights: highlights.map((h) => ({ f: h.f, r: h.r, color: BRUSHES[h.brush] })),
    arrows: arrows.map((a) => ({ from: a.from, to: a.to, color: BRUSHES[a.brush] })),
    arrowDraft: g && g.kind === 'right' && g.to && !sameSq(g.from, g.to) ? { from: g.from, to: g.to, color: BRUSHES[g.brush] } : null,
    halo: HALO,
    brushAlpha: BRUSH_ALPHA,
    highlightAlpha: HIGHLIGHT_ALPHA,
    drag: dragging ? { from: g.from, piece: g.piece, x: g.x, y: g.y, hideOrigin: g.hideOrigin } : null,
  })
}

// One loop, only while the panel can be seen. It repaints for the blink of a held piece and
// for anything marked dirty, and sleeps otherwise.
function schedule() {
  if (frame || !visible) return
  frame = requestAnimationFrame(tick)
}

// The loop keeps going only while something moves: a held piece blinking and lifting, or a slide.
function tick(now) {
  frame = 0
  if (!visible) return
  paint(now)
  if (slide || (selected && !reduced.matches)) schedule()
}

const redraw = () => schedule()

deska.on('visibility', (state) => {
  visible = state.visible
  if (visible) { board.resize(); redraw() } else {
    cancelAnimationFrame(frame)
    frame = 0
    gesture = null
  }
})
deska.on('theme', () => {
  document.documentElement.classList.add('no-transitions')
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('no-transitions')))
  colors = readColors()
  syncSettingsUi()
  renderPreviews()
  updatePlayers()
  redraw()
})
// Painting inside the resize callback, before the browser shows the frame, means a resized
// canvas is never shown blank.
board.observe((why) => {
  syncLayout()
  if (visible && colors) paint()
  if (why === 'dpr') { renderPreviews(); updatePlayers() }
})
reduced.addEventListener('change', redraw)

// Game flow ----------------------------------------------------------------------------------

function startGame(choice) {
  if (onlineMode) return
  stash = null
  side = choice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : choice
  game = newGame()
  games = [game]
  ucis = []
  cursor = 0
  phase = 'play'
  slide = null
  botToken++
  thinking = false
  clearHint()
  resultDismissed = false
  clearSelection()
  clearPremoves()
  clearMarks()
  newGameCard?.close()
  showPhase()
  announceTitle()
  saveGame()
  redraw()
  const name = side === 'w' ? 'blancas' : 'negras'
  $('announce').textContent = `Juegas con las ${name}.`
  maybeBotMove()
}

function restart() {
  if (onlineMode) return
  botToken++
  thinking = false
  clearHint()
  resultDismissed = false
  phase = 'choose'
  clearSelection()
  clearPremoves()
  clearMarks()
  closeSheets()
  showPhase()
  $('choose').querySelector('button').focus({ preventScroll: true })
  announceTitle()
  deska.storage.remove('game').catch((err) => showStatus(`No se pudo borrar la partida. ${problemText(err)}`, 'error'))
  redraw()
}

function clearSelection() {
  selected = null
  moves = []
  selectionKind = 'move'
  pendingPromotion = null
  $('promotion').hidden = true
}

const clearMarks = () => { arrows = []; highlights = [] }

const botPlays = () => !onlineMode && settings.botEnabled && game.turn !== side

function describeMove(before, after, from, move) {
  const piece = before.board[from.r][from.f]
  const captured = !!before.board[move.r][move.f] || !!move.ep
  const who = piece.color === 'w' ? 'Blancas' : 'Negras'
  return `${who}: ${pieceName(piece.type)} de ${squareName(from.f, from.r)} a ${squareName(move.f, move.r)}${captured ? ', captura' : ''}${after.status === 'check' ? ', jaque' : ''}`
}

function applyMove(from, move, { animate = true } = {}) {
  const mover = game.turn
  const before = game
  const piece = game.board[from.r][from.f].type
  game = play(game, from, move)
  games = games.slice(0, cursor + 1)
  ucis = ucis.slice(0, cursor)
  ucis.push(uciOf(from, move, piece))
  games.push(game)
  cursor = games.length - 1
  clearHint()
  clearMarks()
  resultDismissed = false
  // The bot's move keeps a piece you are holding for a premove, now as a real move.
  if (mover === side) clearSelection()
  else reselect()
  slide = animate && !reduced.matches ? { moves: slideMoves(from, move), start: performance.now() } : null
  $('announce').textContent = describeMove(before, game, from, move)
  if (isOver(game)) { phase = 'over'; clearPremoves() }
  saveGame()
  showPhase()
  announceTitle()
  redraw()
  if (phase === 'play') {
    maybeBotMove()
    if (game.turn === side) schedulePremove()
  }
}

const uciOf = (from, move, piece) =>
  squareName(from.f, from.r) + squareName(move.f, move.r) + (piece === 'p' && (move.r === 0 || move.r === 7) ? (move.promotion || 'q') : '')

// With the bot on, only positions where it is the person's turn can be shown, so going back never
// lands where the bot would immediately move again.
function targetIndex(direction) {
  for (let i = cursor + direction; i >= 0 && i < games.length; i += direction) {
    if (!settings.botEnabled || games[i].turn === side) return i
  }
  return -1
}

function goTo(index) {
  if (onlineMode) return
  const movement = reduced.matches ? null : historySlideMoves(cursor, index)
  botToken++
  thinking = false
  cursor = index
  game = games[cursor]
  phase = isOver(game) ? 'over' : 'play'
  slide = movement?.length ? { moves: movement, start: performance.now() } : null
  clearHint()
  resultDismissed = false
  clearSelection()
  clearPremoves()
  clearMarks()
  $('announce').textContent = `Posición después de ${cursor} ${cursor === 1 ? 'jugada' : 'jugadas'}.`
  saveGame()
  showPhase()
  announceTitle()
  redraw()
  if (phase === 'play') maybeBotMove()
}

function updateNav() {
  const active = phase !== 'choose'
  $('undo').disabled = onlineMode || !active || targetIndex(-1) === -1
  $('redo').disabled = onlineMode || !active || targetIndex(1) === -1
  $('hint').disabled = onlineMode || !canMove() || (hintBusy && !hint)
  for (const id of ['bot-button', 'restart', 'again', 'result-colors', 'drawer-toggle']) $(id).disabled = onlineMode
  $('bot-button').hidden = onlineMode
  $('again').hidden = onlineMode
  $('result-colors').hidden = onlineMode
  $('result-local').hidden = !onlineMode
  $('hint').setAttribute('aria-pressed', String(!!hint))
  $('move-count').textContent = active ? `Jugada ${game.full}` : ''
}

function clearHint() {
  hintToken++
  hintBusy = false
  hint = null
  $('hint').removeAttribute('aria-busy')
}

// The hint is the engine at full strength, whatever level the bot plays at.
async function showHint() {
  if (onlineMode) return
  if (hint) { clearHint(); updateNav(); redraw(); return }
  if (!canMove() || hintBusy) return
  const token = ++hintToken
  hintBusy = true
  $('hint').setAttribute('aria-busy', 'true')
  updateNav()
  let uci = null
  try {
    uci = await chooseMove(toFEN(game), { depth: 4, timeMs: 1200, noise: 0, isCancelled: () => token !== hintToken, isBusy: animating })
  } catch (err) {
    console.error('Chess: the hint failed.', err)
  }
  if (token !== hintToken) return // the position changed while it thought
  hintBusy = false
  $('hint').removeAttribute('aria-busy')
  const found = uci && moveFromUci(game, uci)
  if (!found) {
    showStatus('No encontré una pista para esta posición.', 'info')
    updateNav()
    return
  }
  hint = { from: found.from, to: { f: found.move.f, r: found.move.r } }
  const piece = game.board[found.from.r][found.from.f].type
  $('announce').textContent = `Pista: ${pieceName(piece)} de ${squareName(found.from.f, found.from.r)} a ${squareName(found.move.f, found.move.r)}.`
  updateNav()
  redraw()
}

function slideMoves(from, move) {
  const out = [{ from: { f: from.f, r: from.r }, to: { f: move.f, r: move.r } }]
  if (move.castle) {
    const rookFrom = move.castle === 'K' ? 7 : 0
    const rookTo = move.castle === 'K' ? 5 : 3
    out.push({ from: { f: rookFrom, r: move.r }, to: { f: rookTo, r: move.r } })
  }
  return out
}

// Track the pieces that survive the history jump. With the bot on, navigation crosses two
// plies: a captured piece must reappear on its square, never slide as its capturer.
function historySlideMoves(start, end) {
  const origins = games[start].board.map((row, r) => row.map((piece, f) => piece ? { f, r } : null))
  const direction = end > start ? 1 : -1
  for (let i = start; i !== end; i += direction) {
    const before = direction > 0 ? i : i - 1
    const { from, move } = moveFromUci(games[before], ucis[before])
    for (const path of slideMoves(from, move)) {
      const source = direction > 0 ? path.from : path.to
      const target = direction > 0 ? path.to : path.from
      origins[target.r][target.f] = origins[source.r][source.f]
      origins[source.r][source.f] = null
    }
    if (direction > 0 && move.ep) origins[from.r][move.f] = null
  }
  const movement = []
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const from = origins[r][f]
    if (from && (from.f !== f || from.r !== r)) movement.push({ from, to: { f, r } })
  }
  return movement
}

const PIECE_NAMES = { k: 'rey', q: 'dama', r: 'torre', b: 'alfil', n: 'caballo', p: 'peón' }
const pieceName = (type) => PIECE_NAMES[type]

async function maybeBotMove() {
  if (phase !== 'play' || !botPlays() || thinking) return
  const token = ++botToken
  thinking = true
  announceTitle()
  const started = performance.now()
  let uci = null
  try {
    // A restart, a new game, undo or a settings change bumps the token: the engine drops the search.
    uci = await chooseMove(toFEN(game), { ...profileFor(settings.botRating), isCancelled: () => token !== botToken, isBusy: animating })
  } catch (err) {
    console.error('Chess: the bot failed.', err)
    if (token === botToken) {
      thinking = false
      showStatus('Dex falló y se desactivó. Puedes seguir jugando por ambos lados.', 'error')
      settings = { ...settings, botEnabled: false }
      syncSettingsUi()
      saveSettings()
      announceTitle()
    }
    return
  }
  const wait = Math.max(0, botDelay() - (performance.now() - started))
  await new Promise((resolve) => setTimeout(resolve, wait))
  if (token !== botToken) return // a restart, a new game or a settings change got there first
  thinking = false
  const found = uci && moveFromUci(game, uci)
  if (!found) {
    showStatus('Dex propuso una jugada no válida y se desactivó.', 'error')
    settings = { ...settings, botEnabled: false }
    syncSettingsUi()
    saveSettings()
    announceTitle()
    return
  }
  applyMove(found.from, found.move)
}

// Text the person reads --------------------------------------------------------------------

function setTurnIcon(name, tone = '') {
  const icon = $('turn-icon')
  const href = `#i-${name}`
  const changed = icon.firstElementChild.getAttribute('href') !== href
  icon.firstElementChild.setAttribute('href', href)
  icon.dataset.tone = tone
  if (changed && !reduced.matches) {
    icon.animate([{ scale: 0.5, opacity: 0.3 }, { scale: 1.2, opacity: 1 }, { scale: 1, opacity: 1 }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }
}

let sentTitle = null

function announceTitle() {
  let text
  let icon = 'horse'
  let tone = ''
  const check = game.status === 'check'
  if (phase === 'choose') { text = 'Nueva partida'; icon = 'crown-simple' } // the card below says "Elige tu color"
  else if (phase === 'over') { text = resultText().title; icon = resultText().icon }
  else if (onlineMode) {
    // Your move is on the board while the server confirms it, so the title already passes the turn.
    text = pendingOnline && online?.state.busy ? 'Turno de tu rival'
      : onlineLocked ? (online?.state.phase === 'waiting' ? 'Esperando rival' : online?.state.busy ? 'Sincronizando…' : 'Sin conexión')
      : game.turn === side ? 'Tu turno · Online' : 'Turno de tu rival'
    icon = 'user-circle'
  }
  else if (thinking) { text = 'Dex está pensando'; icon = 'robot' }
  else if (!settings.botEnabled) text = `Turno de ${game.turn === 'w' ? 'las blancas' : 'las negras'}${check ? ' (jaque)' : ''}`
  else if (game.turn === side) text = `Tu turno${check ? ' (jaque)' : ''}`
  else { text = 'Turno de Dex'; icon = 'robot' }
  if (check && phase === 'play') { icon = 'warning'; tone = 'danger' }
  $('turn').textContent = text
  $('dots').hidden = !thinking
  $('turn').closest('.turn').classList.toggle('is-thinking', thinking)
  setTurnIcon(icon, tone)
  updateNav()
  // The title goes to the host over a message, so only a new text is sent.
  if (text !== sentTitle) {
    sentTitle = text
    deska.setTitle(text).catch((err) => { sentTitle = null; console.warn('Chess: title update failed', err.code || 'host_error') })
  }
  $('board').setAttribute('aria-label', `Tablero de ajedrez. ${side === 'w' ? 'Blancas' : 'Negras'} abajo. ${text}.`)
  updatePlayers()
}

function resultText() {
  const moves = Math.ceil(cursor / 2)
  const length = `${moves} ${moves === 1 ? 'jugada' : 'jugadas'}`
  const versus = onlineMode ? (onlineOpponent ? ` Contra ${onlineOpponent}.` : ' Partida online.') : settings.botEnabled ? ` Dex ${settings.botRating}.` : ''
  if (game.status === 'checkmate') {
    const winner = other(game.turn)
    if (!onlineMode && !settings.botEnabled) {
      return { title: `Victoria de las ${winner === 'w' ? 'blancas' : 'negras'}`, detail: `Jaque mate en ${length}.`, icon: 'trophy', tone: 'win' }
    }
    const won = winner === side
    return {
      title: won ? 'Victoria' : 'Derrota',
      detail: `Jaque mate en ${length}.${versus}`,
      icon: won ? 'trophy' : 'flag-checkered',
      tone: won ? 'win' : 'lose',
    }
  }
  if (game.status === 'stalemate') return { title: 'Tablas', detail: `Rey ahogado en ${length}: no hay jugadas legales y no está en jaque.${versus}`, icon: 'handshake', tone: 'draw' }
  return { title: 'Tablas', detail: `${game.half >= 100 ? 'Cincuenta jugadas sin captura ni movimiento de peón.' : 'Solo quedan los reyes.'}${versus}`, icon: 'handshake', tone: 'draw' }
}

function showPhase() {
  $('app').dataset.phase = phase
  const choosing = $('choose').hidden && phase === 'choose'
  $('choose').hidden = phase !== 'choose'
  if (choosing) renderPreviews()
  $('result').hidden = phase !== 'over' || resultDismissed
  if (phase === 'over') {
    const { title, detail, icon, tone } = resultText()
    $('result-icon').dataset.tone = tone
    $('result-title').textContent = title
    $('result-detail').textContent = detail
    $('result-icon').firstElementChild.setAttribute('href', `#i-${icon}`)
  }
  $('board').toggleAttribute('inert', phase === 'choose')
}

// Input ---------------------------------------------------------------------------------------
//
// The left button picks and moves: click a piece then a square, or press a piece and drag it.
// While the other side is to move (the bot, or the rival online) the same gestures queue
// premoves instead. The right button draws: drag for an arrow, click for a square highlight;
// with premoves queued, it cancels them first. Marks are only on screen.

function canMove() {
  return phase === 'play' && !thinking && (onlineMode
    ? !onlineLocked && !pendingOnline && game.turn === side
    : !(settings.botEnabled && game.turn !== side))
}

// Premoves are for games against someone else: the bot or a rival online, never two people on one board.
function canPremove() {
  if (phase !== 'play' || canMove()) return false
  return onlineMode ? online?.state.phase === 'active' : settings.botEnabled && game.turn !== side
}

const inputMode = () => (canMove() ? 'move' : canPremove() ? 'premove' : null)
const premoveBoard = () => projectPremoves(shownGame().board, premoves)

function selectable(sq, mode) {
  const piece = mode === 'move' ? game.board[sq.r][sq.f] : premoveBoard()[sq.r][sq.f]
  return !!piece && piece.color === (mode === 'move' ? game.turn : side)
}

function select(sq, mode) {
  selected = { f: sq.f, r: sq.r }
  selectedAt = performance.now()
  selectionKind = mode
  moves = mode === 'move' ? legalMoves(game, sq.f, sq.r) : premoveTargets(premoveBoard(), sq.f, sq.r, game.castling)
}

// After the position or the turn changes under a held piece, keep it held if it can still act.
function reselect() {
  const sq = selected
  const mode = inputMode()
  if (sq && mode && selectable(sq, mode)) { pendingPromotion = null; $('promotion').hidden = true; select(sq, mode) }
  else clearSelection()
}

const isTarget = (sq) => moves.some((m) => sameSq(m, sq))

function commit(from, sq, { animate = true } = {}) {
  if (selectionKind === 'premove') { queuePremove(from, sq); return }
  const choices = moves.filter((m) => sameSq(m, sq))
  if (!choices.length) return
  if (choices[0].promotion) {
    pendingPromotion = { from, choices }
    $('promotion').hidden = false
    $('promotion').querySelector('button').focus()
    redraw()
    return
  }
  submitMove(from, choices[0], { animate })
}

async function submitMove(from, move, { animate = true, premove = false } = {}) {
  if (!canMove()) { clearSelection(); redraw(); return }
  if (!premove) clearPremoves()
  if (!onlineMode) { applyMove(from, move, { animate }); return }
  const uci = uciOf(from, move, game.board[from.r][from.f].type)
  pendingOnline = { uci, after: play(game, from, move) }
  clearSelection()
  clearMarks()
  slide = animate && !reduced.matches ? { moves: slideMoves(from, move), start: performance.now() } : null
  announceTitle()
  redraw()
  const ok = await online.move(uci)
  // A refused or lost move goes back; the notice above the board says why.
  if (!ok && pendingOnline?.uci === uci) {
    pendingOnline = null
    slide = null
    clearPremoves()
    announceTitle()
    redraw()
  }
}

// Premoves -------------------------------------------------------------------------------------

function queuePremove(from, to) {
  const uci = premoveUci(premoveBoard(), from, to)
  premoves = [...premoves, { from: { f: from.f, r: from.r }, to: { f: to.f, r: to.r }, uci }]
  clearSelection()
  $('announce').textContent = `Premove ${uci.slice(0, 2)} a ${uci.slice(2, 4)}. ${premoves.length} en cola.`
  redraw()
}

function clearPremoves(announce = false) {
  premoveToken++
  clearTimeout(premoveTimer)
  if (!premoves.length) return
  premoves = []
  if (selectionKind === 'premove') clearSelection()
  if (announce) $('announce').textContent = 'Premoves canceladas.'
}

// Runs the next premove once your turn has really come, after the other side's move finished sliding.
function schedulePremove() {
  if (!premoves.length) return
  clearTimeout(premoveTimer)
  const token = ++premoveToken
  premoveTimer = setTimeout(() => { if (token === premoveToken) runPremove() }, reduced.matches ? 0 : SLIDE_MS)
}

function runPremove() {
  if (!premoves.length || !canMove()) return
  const found = moveFromUci(game, premoves[0].uci)
  if (!found) {
    clearPremoves()
    showStatus('Premove no válida; se cancelaron las siguientes.', 'info')
    redraw()
    return
  }
  premoves = premoves.slice(1)
  if (gesture && gesture.kind === 'left') gesture = { kind: 'swallow', id: gesture.id }
  clearSelection()
  submitMove(found.from, found.move, { premove: true })
}

// Pointer --------------------------------------------------------------------------------------

const DRAG_PX = (type) => (type === 'mouse' ? 4 : 8)

function localPoint(event) {
  const rect = $('board').getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

const pointerSquare = (event) => { const p = localPoint(event); return board.squareAt(p.x, p.y, side === 'b') }
const pointerOver = (g) => board.squareAt(g.x, g.y, side === 'b')

function capture(event) {
  try { $('board').setPointerCapture(event.pointerId) } catch { /* the pointer is already gone */ }
}

function updateCursor(sq = hover) {
  const g = gesture
  const mode = !g && sq ? inputMode() : null
  $('board').style.cursor = g && g.kind === 'left' && g.dragging ? 'grabbing' : mode && selectable(sq, mode) ? 'grab' : ''
}

// Picking with a click or the keyboard: a target square plays, an own piece is held, anything
// else lets go of the piece and drops queued premoves.
function pick(sq) {
  const mode = inputMode()
  if (!mode || !sq) return
  if (selected && selectionKind === mode && isTarget(sq)) { commit(selected, sq); redraw(); return }
  if (sameSq(selected, sq)) clearSelection()
  else if (selectable(sq, mode)) select(sq, mode)
  else { clearSelection(); clearPremoves(true) }
  redraw()
}

const canvas = $('board')

canvas.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary) return
  if ($('app').dataset.bars === 'open' && !barsHeld) closeBars()
  gesture = null // a primary pointer pressing again means the last gesture's end never arrived
  if (openSheet) {
    // This click only closes the sheet; it does not touch the board.
    closeSheets()
    gesture = { kind: 'swallow', id: event.pointerId }
    capture(event)
    return
  }
  const sq = pointerSquare(event)
  hover = sq
  if (event.button === 0) {
    clearMarks()
    const mode = inputMode()
    if (mode && sq) {
      if (selected && selectionKind === mode && isTarget(sq)) { commit(selected, sq) }
      else if (selectable(sq, mode)) {
        const again = sameSq(selected, sq)
        if (!again) select(sq, mode)
        const p = localPoint(event)
        const pieces = mode === 'move' ? game.board : premoveBoard()
        gesture = {
          kind: 'left', id: event.pointerId, type: event.pointerType, x0: p.x, y0: p.y, x: p.x, y: p.y,
          from: { f: sq.f, r: sq.r }, piece: pieces[sq.r][sq.f], dragging: false, toggleOff: again,
          hideOrigin: mode === 'move',
        }
        capture(event)
      } else { clearSelection(); clearPremoves(true) }
    } else if (mode) { clearSelection(); clearPremoves(true) }
    redraw()
  } else if (event.button === 2) {
    lastRightAt = performance.now()
    if (premoves.length) {
      clearPremoves(true)
      clearSelection()
      gesture = { kind: 'swallow', id: event.pointerId }
    } else if (sq) {
      clearSelection()
      gesture = { kind: 'right', id: event.pointerId, from: sq, to: sq, brush: brushFor(event) }
    }
    if (gesture) capture(event)
    redraw()
  }
  updateCursor(sq)
})

canvas.addEventListener('pointermove', (event) => {
  const sq = pointerSquare(event)
  const moved = !sameSq(sq, hover)
  hover = sq
  const g = gesture
  if (g && g.id === event.pointerId) {
    if (g.kind === 'left') {
      // A second button pressed during a drag does not fire pointerdown: it cancels the drag.
      if (g.dragging && event.buttons & 2) {
        gesture = { kind: 'swallow', id: g.id }
        lastRightAt = performance.now()
        updateCursor(sq)
        redraw()
        return
      }
      const p = localPoint(event)
      g.x = p.x
      g.y = p.y
      if (!g.dragging && Math.hypot(p.x - g.x0, p.y - g.y0) > DRAG_PX(g.type)) {
        g.dragging = true
        g.toggleOff = false
        updateCursor(sq)
      }
      if (g.dragging) { redraw(); return }
    } else if (g.kind === 'right') {
      if (!sameSq(g.to, sq)) { g.to = sq; redraw() }
      return
    }
  }
  if (moved) redraw()
  if (!g) updateCursor(sq)
})

function finishGesture(event, cancelled) {
  const g = gesture
  if (!g || g.id !== event.pointerId) return
  gesture = null
  if (event.pointerType === 'touch') hover = null
  if (g.kind === 'right') {
    lastRightAt = performance.now()
    if (!cancelled && g.to) {
      if (sameSq(g.from, g.to)) highlights = toggleHighlight(highlights, { f: g.from.f, r: g.from.r, brush: g.brush })
      else arrows = toggleArrow(arrows, { from: g.from, to: g.to, brush: g.brush })
    }
  } else if (g.kind === 'left') {
    if (g.dragging) {
      const sq = cancelled ? null : pointerSquare(event)
      const held = selected && sameSq(selected, g.from)
      if (held && sq && !sameSq(sq, g.from) && isTarget(sq)) commit(g.from, sq, { animate: false })
      else if (!sameSq(sq, g.from)) clearSelection() // dropped off the board or on a square it cannot reach
    } else if (g.toggleOff && !cancelled) clearSelection()
  }
  updateCursor(hover)
  redraw()
}

canvas.addEventListener('pointerup', (event) => finishGesture(event, false))
canvas.addEventListener('pointercancel', (event) => finishGesture(event, true))
canvas.addEventListener('lostpointercapture', (event) => finishGesture(event, true))
canvas.addEventListener('pointerleave', () => { if (!gesture) { hover = null; updateCursor(null); redraw() } })
// The right button belongs to the board: no context menu over it, also when released just outside.
canvas.addEventListener('contextmenu', (event) => event.preventDefault())
document.addEventListener('contextmenu', (event) => {
  if (gesture?.kind === 'right' || performance.now() - lastRightAt < 300) event.preventDefault()
})

// Keyboard: arrows move a cursor over the squares, Enter or Space acts like a click, Escape lets
// go of what is held, one thing at a time.
canvas.addEventListener('keydown', (event) => {
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key]
  const flip = side === 'b' ? -1 : 1
  if (step) {
    event.preventDefault()
    const from = hover || { f: 3, r: side === 'w' ? 1 : 6 }
    hover = { f: Math.max(0, Math.min(7, from.f + step[0] * flip)), r: Math.max(0, Math.min(7, from.r + step[1] * flip)) }
    $('announce').textContent = squareName(hover.f, hover.r)
    redraw()
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    pick(hover)
  } else if (event.key === 'Escape' && (selected || premoves.length || arrows.length || highlights.length)) {
    event.stopPropagation()
    if (selected) clearSelection()
    else if (premoves.length) clearPremoves(true)
    else clearMarks()
    redraw()
  }
})
canvas.addEventListener('blur', () => { hover = null; redraw() })

// Controls and sheets -------------------------------------------------------------------------

function buildControls() {
  for (const button of document.querySelectorAll('[data-promotion]')) {
    button.addEventListener('click', () => {
      if (!pendingPromotion) return
      const { from, choices } = pendingPromotion
      const move = choices.find((m) => m.promotion === button.dataset.promotion)
      clearSelection()
      submitMove(from, move)
      redraw()
      $('board').focus()
    })
  }
  $('promotion-cancel').addEventListener('click', () => { clearSelection(); redraw(); $('board').focus() })
  for (const button of document.querySelectorAll('#choose .choice')) {
    button.addEventListener('click', () => startGame(button.dataset.side))
  }
  $('again').addEventListener('click', () => startGame(side))
  $('result-colors').addEventListener('click', restart)
  $('result-view').addEventListener('click', () => { resultDismissed = true; showPhase(); $('board').focus({ preventScroll: true }) })
  $('bars-toggle').addEventListener('click', openBars)
  for (const bar of document.querySelectorAll('.bar, .foot')) {
    bar.addEventListener('pointerenter', () => { barsHeld = true })
    bar.addEventListener('pointerleave', () => { barsHeld = false; if ($('app').dataset.bars === 'open') openBars() })
    bar.addEventListener('focusin', () => { if (settings.fullBoard) openBars() })
  }
  $('hint').addEventListener('click', showHint)
  $('undo').addEventListener('click', () => { const i = targetIndex(-1); if (i !== -1) goTo(i) })
  $('redo').addEventListener('click', () => { const i = targetIndex(1); if (i !== -1) goTo(i) })
  $('drawer-toggle').addEventListener('click', () => newGameCard.open(null, $('drawer-toggle')))
  $('restart').addEventListener('click', restart)

  for (const button of document.querySelectorAll('[data-piece-set]')) {
    button.addEventListener('click', () => change({ pieceSet: button.dataset.pieceSet }))
  }
  renderPreviews()
  for (const button of document.querySelectorAll('[data-palette]')) {
    button.addEventListener('click', () => change({ palette: button.dataset.palette }))
  }
  $('coordinates').addEventListener('change', () => change({ coordinates: $('coordinates').checked }))
  $('full-board').addEventListener('change', () => change({ fullBoard: $('full-board').checked }))
  $('bot-enabled').addEventListener('change', () => change({ botEnabled: $('bot-enabled').checked }))
  // Dragging the level only updates the labels; letting go saves it once.
  $('bot-rating').addEventListener('input', () => {
    settings = { ...settings, botRating: Number($('bot-rating').value) }
    $('bot-output').value = String(settings.botRating)
    $('bot-level').textContent = levelText(settings.botRating)
    $('bot-label').textContent = `Dex ${settings.botRating}`
  })
  $('bot-rating').addEventListener('change', () => change({ botRating: Number($('bot-rating').value) }))

  $('status-close').addEventListener('click', hideStatus)
  $('status').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); hideStatus() } })
  $('status').addEventListener('pointerenter', () => { statusHeld.pointer = true; pauseStatus() })
  $('status').addEventListener('pointerleave', () => { statusHeld.pointer = false; resumeStatus() })
  $('status').addEventListener('focusin', () => { statusHeld.focus = true; pauseStatus() })
  $('status').addEventListener('focusout', (event) => {
    if ($('status').contains(event.relatedTarget)) return
    statusHeld.focus = false
    resumeStatus()
  })
  $('reset-settings').addEventListener('click', () => change({ ...DEFAULTS }))

  const sheets = { 'bot-button': 'bot-sheet', 'menu-button': 'menu-sheet', 'online-button': 'online-sheet' }
  for (const [buttonId, sheetId] of Object.entries(sheets)) {
    $(buttonId).addEventListener('click', () => (openSheet === sheetId ? closeSheets() : showSheet(sheetId)))
  }
  for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', closeSheets)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && openSheet) closeSheets(true) })
  document.addEventListener('pointerdown', (event) => {
    if (openSheet && !event.target.closest('.sheet, .bar-actions')) closeSheets()
  })
}

function showSheet(id) {
  closeSheets()
  openSheet = id
  $(id).hidden = false
  if (id === 'menu-sheet') renderPreviews() // the samples are drawn at the size they are shown
  $(id === 'bot-sheet' ? 'bot-button' : id === 'online-sheet' ? 'online-button' : 'menu-button').setAttribute('aria-expanded', 'true')
  $(id).querySelector('h2').focus({ preventScroll: true })
}

function closeSheets(returnFocus = false) {
  if (!openSheet) return
  const trigger = $(openSheet === 'bot-sheet' ? 'bot-button' : openSheet === 'online-sheet' ? 'online-button' : 'menu-button')
  $(openSheet).hidden = true
  trigger.setAttribute('aria-expanded', 'false')
  openSheet = null
  if (returnFocus) trigger.focus({ preventScroll: true })
}

function change(patch) {
  if (onlineMode && ('botEnabled' in patch || 'botRating' in patch)) {
    patch = { ...patch, botEnabled: settings.botEnabled, botRating: settings.botRating }
  }
  const botBefore = settings.botEnabled
  settings = { ...settings, ...patch }
  syncSettingsUi()
  saveSettings()
  if (botBefore && !settings.botEnabled) { botToken++; thinking = false; clearPremoves(); if (selectionKind === 'premove') clearSelection() }
  if ('pieceSet' in patch) renderPreviews()
  announceTitle()
  redraw()
  if (!botBefore && settings.botEnabled) maybeBotMove()
}

// Samples of the piece styles and of the chosen style on the color buttons, in the theme's accent.
function renderPreviews() {
  const look = { accent: colors.ink || colors.accent, bg: colors.bg }
  for (const button of document.querySelectorAll('[data-piece-set]')) {
    drawPreview(button.querySelector('canvas'), button.dataset.pieceSet, undefined, look)
  }
  for (const button of document.querySelectorAll('.choice')) {
    const pieces = { w: [['k', true]], b: [['k', false]], random: [['n', true], ['n', false]] }[button.dataset.side || button.dataset.pick]
    drawPreview(button.querySelector('canvas'), settings.pieceSet, pieces, look)
  }
}

function syncSettingsUi() {
  const palettes = { app: { dark: colors.accent, light: tint(colors.accent, 0.86) }, ...PALETTES }
  for (const button of document.querySelectorAll('[data-palette]')) {
    const p = palettes[button.dataset.palette]
    const swatch = button.querySelector('.swatch')
    swatch.style.setProperty('--swatch-dark', p.dark)
    swatch.style.setProperty('--swatch-light', p.light)
    button.setAttribute('aria-pressed', String(button.dataset.palette === settings.palette))
  }
  for (const button of document.querySelectorAll('[data-piece-set]')) {
    button.setAttribute('aria-pressed', String(button.dataset.pieceSet === settings.pieceSet))
  }
  $('coordinates').checked = settings.coordinates
  $('full-board').checked = settings.fullBoard
  applyLayout()
  $('bot-enabled').checked = settings.botEnabled
  $('bot-rating').value = String(settings.botRating)
  $('bot-rating').disabled = !settings.botEnabled
  $('bot-output').value = String(settings.botRating)
  $('bot-level').textContent = settings.botEnabled ? levelText(settings.botRating) : 'Apagado'
  $('bot-label').textContent = settings.botEnabled ? `Dex ${settings.botRating}` : 'Dex apagado'
}

// Start ----------------------------------------------------------------------------------------

settings = await loadSettings()
const saved = await loadGame()
if (saved) {
  games = saved.games
  ucis = saved.ucis
  cursor = saved.cursor
  game = games[cursor]
  side = saved.side
  phase = isOver(game) ? 'over' : 'play'
}

buildControls()
syncSettingsUi()
board.resize()
syncLayout()
$('app').setAttribute('aria-busy', 'false')
showPhase()
announceTitle()
schedule()
if (phase === 'play') maybeBotMove()

online = mountOnline({ sdk: deska, init,
  onLock(locked, clear) {
    onlineLocked = locked
    if (onlineMode) {
      if (clear) { clearSelection(); clearPremoves() }
      else if (selected) reselect()
      announceTitle(); redraw()
      if (!locked) schedulePremove()
    }
  },
  onRoom(room) {
    // A room that grew by moves at the end of the same history is the game going on; anything
    // else (another room, a first load) replaces the board.
    const continues = onlineMode && onlineRoomId === room.id && room.moves.length >= ucis.length &&
      ucis.every((uci, i) => room.moves[i] === uci)
    const added = continues ? room.moves.length - ucis.length : 0
    const mine = added === 1 && pendingOnline?.uci === room.moves.at(-1)
    if (!onlineMode) { localGame = stash || { games, ucis, cursor, side, phase }; stash = null }
    onlineMode = true
    onlineRoomId = room.id
    onlineOpponent = room.opponent
    onlineCode = room.code
    onlineStatus = room.status
    pendingOnline = null
    botToken++; thinking = false; clearHint(); newGameCard?.close()
    const wasOver = phase === 'over'
    games = room.games; ucis = room.moves; cursor = games.length - 1; game = games[cursor]; side = room.side
    phase = room.status === 'finished' ? 'over' : 'play'
    if (!continues) {
      slide = null
      clearSelection(); clearPremoves(); clearMarks()
      resultDismissed = false
      $('announce').textContent = `Sala ${room.code}. ${room.status === 'waiting' ? 'Esperando rival.' : 'Partida actualizada.'}`
    } else if (added) {
      const before = games[games.length - 2]
      const found = moveFromUci(before, ucis.at(-1))
      if (!mine) {
        // The rival's move slides in like the bot's and is read out.
        slide = added === 1 && !reduced.matches ? { moves: slideMoves(found.from, found.move), start: performance.now() } : null
        $('announce').textContent = describeMove(before, game, found.from, found.move)
      }
      clearMarks()
      reselect()
    }
    if (phase === 'over') { clearPremoves(); if (!wasOver) resultDismissed = false }
    showPhase(); announceTitle(); redraw()
    if (phase === 'play' && game.turn === side) schedulePremove()
  },
  onLocal() {
    closeSheets(true)
    if (!onlineMode) return
    onlineMode = false
    onlineRoomId = null
    onlineOpponent = null
    pendingOnline = null
    ;({ games, ucis, cursor, side, phase } = localGame)
    game = games[cursor]; localGame = null; resultDismissed = false; slide = null
    clearSelection(); clearPremoves(); clearMarks(); showPhase(); announceTitle(); redraw(); maybeBotMove()
  },
  onNotice: (text, kind) => showStatus(text, kind),
  onState: (state) => home?.sync(state),
  // The home's folded Online heading says "Conectando…" or "Sin conexión" while signed out.
  onConnection: () => { if (home?.isOpen) home.render() },
})

// Home screen ----------------------------------------------------------------------------------
//
// Shown every time the panel opens: continue, start a game against the bot or on one board, and
// play people. Starting a game from it keeps the old one safe until a side is chosen.

function localSnapshot() {
  const src = stash || (onlineMode ? localGame : phase !== 'choose' ? { games, ucis, cursor, side, phase } : null)
  if (!src || !src.ucis.length) return null
  const g = src.games[src.cursor]
  const turn = isOver(g) ? 'Terminada' : settings.botEnabled ? (g.turn === src.side ? 'Tu turno' : 'Turno de Dex')
    : `Turno de las ${g.turn === 'w' ? 'blancas' : 'negras'}`
  return {
    game: g, side: src.side, bot: settings.botEnabled,
    title: settings.botEnabled ? `Contra Dex ${settings.botRating}` : 'Dos personas',
    short: settings.botEnabled ? 'Contra Dex' : 'Dos personas',
    sub: `Jugada ${g.full} · ${turn}`, moveNo: g.full,
  }
}

// Leaving the online room for a local game signs out on this screen; sign back in quietly, no sheet.
function leaveOnline() {
  if (!onlineMode) return
  online.toLocal()
  online.restore()
}

function continueLocal() {
  leaveOnline()
  if (stash && phase === 'choose') {
    ;({ games, ucis, cursor, side, phase } = stash)
    stash = null
    game = games[cursor]
    slide = null
    resultDismissed = false
    clearSelection(); clearPremoves(); clearMarks(); showPhase(); announceTitle(); redraw()
    maybeBotMove()
  }
}

function newLocalGame(bot) {
  leaveOnline()
  if (phase !== 'choose' && ucis.length) stash = { games, ucis, cursor, side, phase }
  botToken++
  thinking = false
  clearHint()
  resultDismissed = false
  phase = 'choose'
  clearSelection(); clearPremoves(); clearMarks(); closeSheets(); showPhase(); announceTitle(); redraw()
  change({ botEnabled: bot })
  $('choose').querySelector('button').focus({ preventScroll: true })
}

// The new-game card asks who to play and the color, then starts the game on the board.
newGameCard = mountNewGame({
  settings: () => settings,
  actions: {
    start(kind, choice) {
      newLocalGame(kind === 'bot')
      startGame(choice)
      if (home?.isOpen) home.close(true)
    },
    setLevel: (n) => change({ botRating: n }),
    renderChoices: renderPreviews,
    onToggle: (open) => $('drawer-toggle').setAttribute('aria-expanded', String(open)),
  },
})

home = mountHome({
  sdk: deska, app: $('app'), online, configured: !!onlineConfig.apiUrl, settings: () => settings,
  local: localSnapshot, look: () => ({ palette: boardColors() }),
  actions: {
    hasGame: () => phase !== 'choose',
    continueLocal,
    chooseNew: (kind, opener) => newGameCard.open(kind, opener),
    setMe: (name) => { if (name !== myName) { myName = name; updatePlayers() } },
    setLevel: (n) => change({ botRating: n }),
    openCode: () => showSheet('online-sheet'),
  },
})
$('home-button').addEventListener('click', () => home.open())
home.sync(online.client.state)
home.open()

const nameOf = (sq) => (sq ? squareName(sq.f, sq.r) : null)

// Text state for automated play-testing: what is on screen, in words.
window.render_game_to_text = () => {
  const shown = shownGame()
  const g = gesture
  return JSON.stringify({
    mode: onlineMode ? 'online' : settings.botEnabled ? 'bot' : 'local',
    phase, side, turn: game.turn, fen: toFEN(game), moves: ucis.slice(0, cursor), canMove: canMove(), thinking,
    selected: nameOf(selected), selectionKind,
    premoves: premoves.map((p) => p.uci),
    arrows: arrows.map((a) => ({ from: nameOf(a.from), to: nameOf(a.to), brush: a.brush })),
    highlights: highlights.map((h) => ({ sq: nameOf(h), brush: h.brush })),
    lastMove: shown.last ? { from: nameOf(shown.last.from), to: nameOf(shown.last.to) } : null,
    drag: g && g.kind === 'left' && g.dragging ? { from: nameOf(g.from), over: nameOf(pointerOver(g)) } : null,
    pending: pendingOnline?.uci || null,
    status: $('status').hidden ? null : { text: $('status-text').textContent, kind: $('status').dataset.kind },
    view: { x: board.view.x, y: board.view.y, cell: board.view.cell, scale: board.view.scale,
      canvasWidth: $('board').width, canvasHeight: $('board').height, cssWidth: $('board').getBoundingClientRect().width },
    players: playerLines(),
    layout: { fullBoard: settings.fullBoard, bars: $('app').dataset.bars === 'open' },
    palette: { ...boardColors(), accent: colors.accent },
    captured: (() => { const c = captures(shown.board); return { byWhite: c.b.join(''), byBlack: c.w.join(''), whiteLead: c.lead } })(),
    online: online?.state,
    coordinates: 'a1 bottom-left for white; board[rank][file], 0-based',
  })
}

/** Client coordinates of the center of a square such as 'e2', for tests. */
window.chess_square_point = (name) => {
  const rect = $('board').getBoundingClientRect()
  const c = board.squareCenter(name.charCodeAt(0) - 97, Number(name[1]) - 1, side === 'b')
  return { x: rect.left + c.x, y: rect.top + c.y }
}
