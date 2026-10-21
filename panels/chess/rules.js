// Chess rules: legal moves with king safety, castling, en passant, promotion selection, and the
// end of the game. Pure functions on plain objects, so the page and the tests share them.
//
// Coordinates: file 0..7 = a..h, rank 0..7 = 1..8. board[rank][file] = { type, color } | null,
// type is one of k q r b n p and color is 'w' or 'b'.

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const FILES = 'abcdefgh'
const BACK_RANK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]]

export const squareName = (f, r) => FILES[f] + (r + 1)
export const other = (color) => (color === 'w' ? 'b' : 'w')
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8

export function newGame() {
  return fromFEN(START_FEN)
}

/** Parses a FEN string. Throws on anything that is not a well-formed position. */
export function fromFEN(fen) {
  const parts = String(fen).trim().split(/\s+/)
  if (parts.length < 4) throw new Error('FEN needs at least four fields.')
  const rows = parts[0].split('/')
  if (rows.length !== 8) throw new Error('FEN needs eight ranks.')
  const board = Array.from({ length: 8 }, () => Array(8).fill(null))
  rows.forEach((row, i) => {
    const rank = 7 - i
    let file = 0
    for (const ch of row) {
      if (/[1-8]/.test(ch)) { file += Number(ch); continue }
      const type = ch.toLowerCase()
      if (!'kqrbnp'.includes(type) || file > 7) throw new Error('FEN has an unknown piece or a long rank.')
      board[rank][file++] = { type, color: ch === type ? 'b' : 'w' }
    }
    if (file !== 8) throw new Error('FEN rank does not add up to eight files.')
  })
  if (!['w', 'b'].includes(parts[1])) throw new Error('FEN side to move must be w or b.')
  const rights = parts[2]
  const ep = parts[3] === '-' ? null : { f: FILES.indexOf(parts[3][0]), r: Number(parts[3][1]) - 1 }
  if (ep && !inside(ep.f, ep.r)) throw new Error('FEN en passant square is not on the board.')
  const game = {
    board,
    turn: parts[1],
    castling: { wK: rights.includes('K'), wQ: rights.includes('Q'), bK: rights.includes('k'), bQ: rights.includes('q') },
    ep,
    half: Number(parts[4]) || 0,
    full: Number(parts[5]) || 1,
    last: null,
  }
  if (!findKing(board, 'w') || !findKing(board, 'b')) throw new Error('FEN needs a king for each side.')
  return finish(game)
}

export function toFEN(game) {
  const rows = []
  for (let r = 7; r >= 0; r--) {
    let row = ''
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const p = game.board[r][f]
      if (!p) { empty++; continue }
      if (empty) { row += empty; empty = 0 }
      row += p.color === 'w' ? p.type.toUpperCase() : p.type
    }
    rows.push(row + (empty || ''))
  }
  const c = game.castling
  const rights = (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '') || '-'
  const ep = game.ep ? squareName(game.ep.f, game.ep.r) : '-'
  return `${rows.join('/')} ${game.turn} ${rights} ${ep} ${game.half} ${game.full}`
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f]
      if (p && p.type === 'k' && p.color === color) return { f, r }
    }
  }
  return null
}

/** Is (f, r) attacked by a piece of color `by`? */
export function isAttacked(board, f, r, by) {
  const pawnRank = r - (by === 'w' ? 1 : -1)
  for (const df of [-1, 1]) {
    if (inside(f + df, pawnRank)) {
      const p = board[pawnRank][f + df]
      if (p && p.color === by && p.type === 'p') return true
    }
  }
  for (const [df, dr] of KNIGHT) {
    if (!inside(f + df, r + dr)) continue
    const p = board[r + dr][f + df]
    if (p && p.color === by && p.type === 'n') return true
  }
  for (const [df, dr] of KING) {
    if (!inside(f + df, r + dr)) continue
    const p = board[r + dr][f + df]
    if (p && p.color === by && p.type === 'k') return true
  }
  for (const [dirs, kind] of [[DIAG, 'b'], [ORTHO, 'r']]) {
    for (const [df, dr] of dirs) {
      let x = f + df
      let y = r + dr
      while (inside(x, y)) {
        const p = board[y][x]
        if (p) {
          if (p.color === by && (p.type === kind || p.type === 'q')) return true
          break
        }
        x += df
        y += dr
      }
    }
  }
  return false
}

// Moves that ignore whether the mover's own king ends up attacked.
function pseudoMoves(game, f, r) {
  const { board } = game
  const piece = board[r][f]
  const out = []
  const add = (tf, tr, extra) => {
    const move = { f: tf, r: tr, capture: !!board[tr][tf] || !!(extra && extra.ep), ...extra }
    if (piece.type === 'p' && (tr === 0 || tr === 7)) {
      for (const promotion of ['q', 'r', 'b', 'n']) out.push({ ...move, promotion })
    } else out.push(move)
  }

  if (piece.type === 'p') {
    const dir = piece.color === 'w' ? 1 : -1
    const startRank = piece.color === 'w' ? 1 : 6
    if (inside(f, r + dir) && !board[r + dir][f]) {
      add(f, r + dir)
      if (r === startRank && !board[r + 2 * dir][f]) add(f, r + 2 * dir, { double: true })
    }
    for (const df of [-1, 1]) {
      const tf = f + df
      const tr = r + dir
      if (!inside(tf, tr)) continue
      const target = board[tr][tf]
      if (target && target.color !== piece.color) add(tf, tr)
      else if (!target && game.ep && game.ep.f === tf && game.ep.r === tr) add(tf, tr, { ep: true })
    }
  } else if (piece.type === 'n' || piece.type === 'k') {
    for (const [df, dr] of piece.type === 'n' ? KNIGHT : KING) {
      const tf = f + df
      const tr = r + dr
      if (!inside(tf, tr)) continue
      const target = board[tr][tf]
      if (!target || target.color !== piece.color) add(tf, tr)
    }
    if (piece.type === 'k') {
      const home = piece.color === 'w' ? 0 : 7
      const foe = other(piece.color)
      if (r === home && f === 4 && !isAttacked(board, 4, home, foe)) {
        const rookAt = (x) => board[home][x] && board[home][x].type === 'r' && board[home][x].color === piece.color
        if (game.castling[`${piece.color}K`] && rookAt(7) && !board[home][5] && !board[home][6]
          && !isAttacked(board, 5, home, foe) && !isAttacked(board, 6, home, foe)) add(6, home, { castle: 'K' })
        if (game.castling[`${piece.color}Q`] && rookAt(0) && !board[home][1] && !board[home][2] && !board[home][3]
          && !isAttacked(board, 3, home, foe) && !isAttacked(board, 2, home, foe)) add(2, home, { castle: 'Q' })
      }
    }
  } else {
    const dirs = piece.type === 'b' ? DIAG : piece.type === 'r' ? ORTHO : DIAG.concat(ORTHO)
    for (const [df, dr] of dirs) {
      let x = f + df
      let y = r + dr
      while (inside(x, y)) {
        const target = board[y][x]
        if (!target) add(x, y)
        else {
          if (target.color !== piece.color) add(x, y)
          break
        }
        x += df
        y += dr
      }
    }
  }
  return out
}

function boardAfter(board, from, move) {
  const next = board.map((row) => row.slice())
  const piece = next[from.r][from.f]
  next[from.r][from.f] = null
  if (move.ep) next[from.r][move.f] = null
  if (move.castle) {
    const rookFrom = move.castle === 'K' ? 7 : 0
    const rookTo = move.castle === 'K' ? 5 : 3
    next[move.r][rookTo] = next[move.r][rookFrom]
    next[move.r][rookFrom] = null
  }
  const promotes = piece.type === 'p' && (move.r === 0 || move.r === 7)
  next[move.r][move.f] = promotes ? { type: move.promotion || 'q', color: piece.color } : piece
  return next
}

/** Legal moves of the piece on (f, r): [{ f, r, capture, ep?, castle?, double? }]. */
export function legalMoves(game, f, r) {
  const piece = game.board[r][f]
  if (!piece) return []
  return pseudoMoves(game, f, r).filter((move) => {
    const next = boardAfter(game.board, { f, r }, move)
    const king = findKing(next, piece.color)
    return king && !isAttacked(next, king.f, king.r, other(piece.color))
  })
}

function hasAnyMove(game, color) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = game.board[r][f]
      if (p && p.color === color && legalMoves(game, f, r).length) return true
    }
  }
  return false
}

function finish(game) {
  const king = findKing(game.board, game.turn)
  const check = isAttacked(game.board, king.f, king.r, other(game.turn))
  const can = hasAnyMove(game, game.turn)
  game.status = can ? (check ? 'check' : 'playing') : (check ? 'checkmate' : 'stalemate')
  game.king = king
  // Fifty-move rule and bare kings are the only draws handled besides stalemate.
  if (game.status === 'playing' || game.status === 'check') {
    if (game.half >= 100) game.status = 'draw'
    else if (onlyKings(game.board)) game.status = 'draw'
  }
  return game
}

function onlyKings(board) {
  return board.every((row) => row.every((p) => !p || p.type === 'k'))
}

export const isOver = (game) => ['checkmate', 'stalemate', 'draw'].includes(game.status)

/** Plays a legal move and returns the next game. `move` comes from legalMoves. */
export function play(game, from, move) {
  const piece = game.board[from.r][from.f]
  const target = game.board[move.r][move.f]
  const castling = { ...game.castling }
  if (piece.type === 'k') { castling[`${piece.color}K`] = false; castling[`${piece.color}Q`] = false }
  const corner = (f, r) => {
    if (r === 0 && f === 0) castling.wQ = false
    if (r === 0 && f === 7) castling.wK = false
    if (r === 7 && f === 0) castling.bQ = false
    if (r === 7 && f === 7) castling.bK = false
  }
  if (piece.type === 'r') corner(from.f, from.r)
  if (target) corner(move.f, move.r)
  return finish({
    board: boardAfter(game.board, from, move),
    turn: other(game.turn),
    castling,
    ep: move.double ? { f: move.f, r: (from.r + move.r) / 2 } : null,
    half: piece.type === 'p' || target || move.ep ? 0 : game.half + 1,
    full: game.full + (piece.color === 'b' ? 1 : 0),
    last: { from: { f: from.f, r: from.r }, to: { f: move.f, r: move.r }, piece: piece.type, capture: !!(target || move.ep) },
  })
}

// Premoves ---------------------------------------------------------------------------------------
// A premove is chosen while the opponent is to move, so the position it will meet is unknown.
// Targets are a superset of what could become legal: the opponent's pieces never block (they may
// move away), and a piece of one's own is included and stops a ray (it may be captured and then
// recaptured). The real legality is checked with moveFromUci when the turn comes.

/** Squares the piece on (f, r) could premove to: [{ f, r }]. */
export function premoveTargets(board, f, r, castling = {}) {
  const piece = board[r][f]
  if (!piece) return []
  const own = (x, y) => !!board[y][x] && board[y][x].color === piece.color
  const out = []
  const add = (x, y) => out.push({ f: x, r: y })
  if (piece.type === 'p') {
    const dir = piece.color === 'w' ? 1 : -1
    const startRank = piece.color === 'w' ? 1 : 6
    if (inside(f, r + dir) && !own(f, r + dir)) {
      add(f, r + dir)
      if (r === startRank && !own(f, r + 2 * dir)) add(f, r + 2 * dir)
    }
    for (const df of [-1, 1]) if (inside(f + df, r + dir)) add(f + df, r + dir)
  } else if (piece.type === 'n' || piece.type === 'k') {
    for (const [df, dr] of piece.type === 'n' ? KNIGHT : KING) if (inside(f + df, r + dr)) add(f + df, r + dr)
    const home = piece.color === 'w' ? 0 : 7
    if (piece.type === 'k' && f === 4 && r === home) {
      const rook = (x) => board[home][x] && board[home][x].type === 'r' && board[home][x].color === piece.color
      if (castling[`${piece.color}K`] && rook(7) && !own(5, home) && !own(6, home)) add(6, home)
      if (castling[`${piece.color}Q`] && rook(0) && !own(1, home) && !own(2, home) && !own(3, home)) add(2, home)
    }
  } else {
    const dirs = piece.type === 'b' ? DIAG : piece.type === 'r' ? ORTHO : DIAG.concat(ORTHO)
    for (const [df, dr] of dirs) {
      for (let x = f + df, y = r + dr; inside(x, y); x += df, y += dr) {
        add(x, y)
        if (own(x, y)) break
      }
    }
  }
  return out
}

/** The board after a premove, as it is expected to look: promotions become queens, castling moves the rook. */
export function applyPremove(board, from, to) {
  const next = board.map((row) => row.slice())
  const piece = next[from.r][from.f]
  if (!piece) return next
  next[from.r][from.f] = null
  if (piece.type === 'k' && Math.abs(to.f - from.f) === 2) {
    const rookFrom = to.f === 6 ? 7 : 0
    next[to.r][to.f === 6 ? 5 : 3] = next[to.r][rookFrom]
    next[to.r][rookFrom] = null
  }
  next[to.r][to.f] = piece.type === 'p' && (to.r === 0 || to.r === 7) ? { type: 'q', color: piece.color } : piece
  return next
}

/** UCI text for a premove; a pawn reaching the last rank asks for a queen. */
export function premoveUci(board, from, to) {
  const piece = board[from.r][from.f]
  return squareName(from.f, from.r) + squareName(to.f, to.r) + (piece && piece.type === 'p' && (to.r === 0 || to.r === 7) ? 'q' : '')
}

/** The board after every queued premove: queue is [{ from, to }]. */
export const projectPremoves = (board, queue) => queue.reduce((b, p) => applyPremove(b, p.from, p.to), board)

/** Finds the legal move for a UCI string such as e2e4 or e7e8q, or null. */
export function moveFromUci(game, uci) {
  if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null
  const from = { f: FILES.indexOf(uci[0]), r: Number(uci[1]) - 1 }
  const to = { f: FILES.indexOf(uci[2]), r: Number(uci[3]) - 1 }
  if (!inside(from.f, from.r) || !inside(to.f, to.r)) return null
  const piece = game.board[from.r][from.f]
  if (!piece || piece.color !== game.turn) return null
  const move = legalMoves(game, from.f, from.r).find((m) => m.f === to.f && m.r === to.r &&
    (m.promotion ? m.promotion === (uci[4] || 'q') : uci.length === 4))
  return move ? { from, move } : null
}

/** Number of leaf positions after `depth` plies; used to check the move generator. */
export function perft(game, depth) {
  if (depth === 0) return 1
  let total = 0
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = game.board[r][f]
      if (!p || p.color !== game.turn) continue
      for (const move of legalMoves(game, f, r)) {
        total += depth === 1 ? 1 : perft(play(game, { f, r }, move), depth - 1)
      }
    }
  }
  return total
}
