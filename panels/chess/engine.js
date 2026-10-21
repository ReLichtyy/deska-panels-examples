// A small chess engine for the bot. A panel cannot run Stockfish: Deska's policy is
// worker-src 'none' and allows no WebAssembly, so the search runs on the page's own thread.
// It is an alpha-beta search (quiescence, check extension, a transposition table, killer and
// history move ordering) over a flat board. Weaker levels search less deep and add noise to each
// move's score, so they sometimes pick a worse move. The strength numbers are approximate, not measured Elo.
//
// Sharing the page's thread: the search keeps its own stack instead of recursing, so it can stop
// after a few milliseconds and pick up exactly where it was. Requests wait in a queue and run one
// at a time, in short slices, with the page free to paint between them; a request the page no
// longer wants is dropped at the next slice instead of searching on. Inside a search nothing is
// allocated per node (moves, undo records and scores live in typed arrays made once), so the
// garbage collector has nothing to stop the page for.

const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6
const VALUE = [0, 100, 320, 330, 500, 900, 0]
// Directions as flat (file, rank) pairs.
const KNIGHT_D = Int8Array.of(1, 2, 2, 1, 2, -1, 1, -2, -1, -2, -2, -1, -2, 1, -1, 2)
const KING_D = Int8Array.of(1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1)
const DIAG = Int8Array.of(1, 1, 1, -1, -1, 1, -1, -1)
const ORTHO = Int8Array.of(1, 0, -1, 0, 0, 1, 0, -1)
const ALL_D = Int8Array.of(...DIAG, ...ORTHO)
const INF = 1e6
const MATE = 100000
const MATE_BOUND = MATE - 1000 // scores beyond this are mates, counted in plies from the root
const TIMEOUT = Symbol('timeout')
const PAUSED = Symbol('paused')
const PUSHED = null // a node that could not be scored at once and is now on the stack

const MAX_PLY = 64
const MAX_MOVES = 256 // more than any position's pseudo-legal moves
const CHECK_EXTENSION_PLY = 10 // checks extend the search only this close to the root
const QUIESCE_PLY = 32 // captures are followed no deeper than this

// Slices of the page's thread, in ms. Shorter while something on the board is moving.
const SLICE_MS = 10
const BUSY_SLICE_MS = 4

// Move = from | to << 6 | flags << 12, always below 2^17
const F_DOUBLE = 1, F_EP = 2, F_CASTLE_K = 4, F_CASTLE_Q = 8, F_PROMO = 16
// Castling rights bits: white king side, white queen side, black king side, black queen side.
const CASTLE_MASK = new Int8Array(64).fill(15)
CASTLE_MASK[4] = 15 & ~3; CASTLE_MASK[0] = 15 & ~2; CASTLE_MASK[7] = 15 & ~1
CASTLE_MASK[60] = 15 & ~12; CASTLE_MASK[56] = 15 & ~8; CASTLE_MASK[63] = 15 & ~4

const LETTERS = { p: P, n: N, b: B, r: R, q: Q, k: K }

// Zobrist keys: 64 bits as two 32-bit halves. The low half picks the table slot, the high half
// confirms the position. Keys for a piece are at (piece + 6) * 64 + square, piece in -6..6.
const Z_CASTLE = 13 * 64
const Z_EP = Z_CASTLE + 16
const Z_SIDE = Z_EP + 8
const ZL = new Int32Array(Z_SIDE + 1)
const ZH = new Int32Array(Z_SIDE + 1)
{
  let s = 0x2545f491 // fixed seed: the same keys on every load
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0 }
  for (let i = 0; i < ZL.length; i++) { ZL[i] = next(); ZH[i] = next() }
}

const UNDO_SIZE = 512

class Position {
  constructor(fen) {
    const parts = fen.trim().split(/\s+/)
    this.b = new Int8Array(64)
    this.kings = new Int8Array(2) // index 0 white, 1 black
    parts[0].split('/').forEach((row, i) => {
      let f = 0
      for (const ch of row) {
        if (/[1-8]/.test(ch)) { f += Number(ch); continue }
        const type = LETTERS[ch.toLowerCase()]
        const sq = (7 - i) * 8 + f++
        const white = ch === ch.toUpperCase()
        this.b[sq] = white ? type : -type
        if (type === K) this.kings[white ? 0 : 1] = sq
      }
    })
    this.side = parts[1] === 'w' ? 1 : -1
    const rights = parts[2] || '-'
    this.castle = (rights.includes('K') ? 1 : 0) | (rights.includes('Q') ? 2 : 0) | (rights.includes('k') ? 4 : 0) | (rights.includes('q') ? 8 : 0)
    this.ep = !parts[3] || parts[3] === '-' ? -1 : (Number(parts[3][1]) - 1) * 8 + 'abcdefgh'.indexOf(parts[3][0])
    // The undo stack, one column per field.
    this.plies = 0
    this.uMove = new Int32Array(UNDO_SIZE)
    this.uCaptured = new Int8Array(UNDO_SIZE)
    this.uCastle = new Int8Array(UNDO_SIZE)
    this.uEp = new Int8Array(UNDO_SIZE)
    this.uLo = new Int32Array(UNDO_SIZE)
    this.uHi = new Int32Array(UNDO_SIZE)
    const [lo, hi] = this.computeHash()
    this.lo = lo
    this.hi = hi
  }

  /** The position's key from scratch; make and unmake keep this.lo and this.hi equal to it. */
  computeHash() {
    let lo = 0
    let hi = 0
    for (let sq = 0; sq < 64; sq++) {
      const v = this.b[sq]
      if (v !== 0) { lo ^= ZL[(v + 6) * 64 + sq]; hi ^= ZH[(v + 6) * 64 + sq] }
    }
    lo ^= ZL[Z_CASTLE + this.castle]; hi ^= ZH[Z_CASTLE + this.castle]
    if (this.ep >= 0) { lo ^= ZL[Z_EP + (this.ep & 7)]; hi ^= ZH[Z_EP + (this.ep & 7)] }
    if (this.side === -1) { lo ^= ZL[Z_SIDE]; hi ^= ZH[Z_SIDE] }
    return [lo, hi]
  }

  key(k) { this.lo ^= ZL[k]; this.hi ^= ZH[k] }

  flip(v, sq) { this.key((v + 6) * 64 + sq) }

  kingSquare(side) { return this.kings[side === 1 ? 0 : 1] }

  /** Does a slider of value `a` or `q` see (f, r) along `dirs`? */
  ray(f, r, dirs, a, q) {
    const b = this.b
    for (let i = 0; i < dirs.length; i += 2) {
      const df = dirs[i], dr = dirs[i + 1]
      let x = f + df, y = r + dr
      while (x >= 0 && x < 8 && y >= 0 && y < 8) {
        const v = b[y * 8 + x]
        if (v !== 0) {
          if (v === a || v === q) return true
          break
        }
        x += df; y += dr
      }
    }
    return false
  }

  /** Is `sq` attacked by `by` (1 white, -1 black)? */
  attacked(sq, by) {
    const b = this.b
    const f = sq & 7
    const r = sq >> 3
    const pr = r - by
    if (pr >= 0 && pr < 8) {
      if (f > 0 && b[pr * 8 + f - 1] === by * P) return true
      if (f < 7 && b[pr * 8 + f + 1] === by * P) return true
    }
    for (let i = 0; i < 16; i += 2) {
      const x = f + KNIGHT_D[i], y = r + KNIGHT_D[i + 1]
      if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === by * N) return true
    }
    for (let i = 0; i < 16; i += 2) {
      const x = f + KING_D[i], y = r + KING_D[i + 1]
      if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === by * K) return true
    }
    return this.ray(f, r, DIAG, by * B, by * Q) || this.ray(f, r, ORTHO, by * R, by * Q)
  }

  inCheck(side) { return this.attacked(this.kingSquare(side), -side) }

  /** Writes the pseudo-legal moves into `out` and returns how many; with `captures` only captures and promotions. */
  gen(out, captures = false) {
    let n = 0
    const b = this.b
    const side = this.side
    for (let sq = 0; sq < 64; sq++) {
      const piece = b[sq] * side
      if (piece <= 0) continue
      const f = sq & 7
      const r = sq >> 3
      if (piece === P) {
        const lastBefore = side === 1 ? 6 : 1
        const start = side === 1 ? 1 : 6
        const t = sq + 8 * side
        const promo = r === lastBefore ? F_PROMO : 0
        if (b[t] === 0) {
          if (!captures || promo) out[n++] = sq | (t << 6) | (promo << 12)
          if (!captures && r === start && b[t + 8 * side] === 0) out[n++] = sq | ((t + 8 * side) << 6) | (F_DOUBLE << 12)
        }
        for (let df = -1; df <= 1; df += 2) {
          const nf = f + df
          if (nf < 0 || nf > 7) continue
          const c = t + df
          if (b[c] * side < 0) out[n++] = sq | (c << 6) | (promo << 12)
          else if (c === this.ep) out[n++] = sq | (c << 6) | (F_EP << 12)
        }
      } else if (piece === N || piece === K) {
        const dirs = piece === N ? KNIGHT_D : KING_D
        for (let i = 0; i < 16; i += 2) {
          const x = f + dirs[i], y = r + dirs[i + 1]
          if (x < 0 || x > 7 || y < 0 || y > 7) continue
          const t = y * 8 + x
          const v = b[t] * side
          if (v > 0) continue
          if (captures && v === 0) continue
          out[n++] = sq | (t << 6)
        }
        if (piece === K && !captures) {
          const base = side === 1 ? 0 : 56
          if (sq === base + 4 && !this.attacked(sq, -side)) {
            const kingSide = side === 1 ? 1 : 4
            const queenSide = side === 1 ? 2 : 8
            if ((this.castle & kingSide) && b[base + 5] === 0 && b[base + 6] === 0 && b[base + 7] === side * R
              && !this.attacked(base + 5, -side) && !this.attacked(base + 6, -side)) out[n++] = sq | ((base + 6) << 6) | (F_CASTLE_K << 12)
            if ((this.castle & queenSide) && b[base + 1] === 0 && b[base + 2] === 0 && b[base + 3] === 0 && b[base] === side * R
              && !this.attacked(base + 3, -side) && !this.attacked(base + 2, -side)) out[n++] = sq | ((base + 2) << 6) | (F_CASTLE_Q << 12)
          }
        }
      } else {
        const dirs = piece === B ? DIAG : piece === R ? ORTHO : ALL_D
        for (let i = 0; i < dirs.length; i += 2) {
          const df = dirs[i], dr = dirs[i + 1]
          let x = f + df, y = r + dr
          while (x >= 0 && x < 8 && y >= 0 && y < 8) {
            const t = y * 8 + x
            const v = b[t] * side
            if (v > 0) break
            if (v < 0) { out[n++] = sq | (t << 6); break }
            if (!captures) out[n++] = sq | (t << 6)
            x += df; y += dr
          }
        }
      }
    }
    return n
  }

  make(m) {
    const b = this.b
    const side = this.side
    const from = m & 63
    const to = (m >> 6) & 63
    const flags = m >> 12
    const piece = b[from]
    const captured = b[to]
    const u = this.plies++
    this.uMove[u] = m
    this.uCaptured[u] = captured
    this.uCastle[u] = this.castle
    this.uEp[u] = this.ep
    this.uLo[u] = this.lo
    this.uHi[u] = this.hi
    this.flip(piece, from)
    b[from] = 0
    if (flags & F_EP) {
      const at = to - 8 * side
      this.uCaptured[u] = b[at]
      this.flip(b[at], at)
      b[at] = 0
    } else if (captured) this.flip(captured, to)
    const placed = flags & F_PROMO ? side * Q : piece
    b[to] = placed
    this.flip(placed, to)
    if (flags & F_CASTLE_K) { this.flip(b[to + 1], to + 1); b[to - 1] = b[to + 1]; b[to + 1] = 0; this.flip(b[to - 1], to - 1) }
    if (flags & F_CASTLE_Q) { this.flip(b[to - 2], to - 2); b[to + 1] = b[to - 2]; b[to - 2] = 0; this.flip(b[to + 1], to + 1) }
    if (piece === side * K) this.kings[side === 1 ? 0 : 1] = to
    const castle = this.castle & CASTLE_MASK[from] & CASTLE_MASK[to]
    if (castle !== this.castle) { this.key(Z_CASTLE + this.castle); this.key(Z_CASTLE + castle); this.castle = castle }
    if (this.ep >= 0) this.key(Z_EP + (this.ep & 7))
    this.ep = flags & F_DOUBLE ? from + 8 * side : -1
    if (this.ep >= 0) this.key(Z_EP + (this.ep & 7))
    this.key(Z_SIDE)
    this.side = -side
  }

  unmake() {
    const u = --this.plies
    const m = this.uMove[u]
    const b = this.b
    this.side = -this.side
    const side = this.side
    const from = m & 63
    const to = (m >> 6) & 63
    const flags = m >> 12
    const moved = flags & F_PROMO ? side * P : b[to]
    b[from] = moved
    if (flags & F_EP) { b[to] = 0; b[to - 8 * side] = this.uCaptured[u] } else b[to] = this.uCaptured[u]
    if (flags & F_CASTLE_K) { b[to + 1] = b[to - 1]; b[to - 1] = 0 }
    if (flags & F_CASTLE_Q) { b[to - 2] = b[to + 1]; b[to + 1] = 0 }
    if (moved === side * K) this.kings[side === 1 ? 0 : 1] = from
    this.castle = this.uCastle[u]
    this.ep = this.uEp[u]
    this.lo = this.uLo[u]
    this.hi = this.uHi[u]
  }

  /** Legal moves only, as a plain array (each one is made and unmade to test king safety). */
  legalMoves() {
    const buffer = new Int32Array(MAX_MOVES)
    const count = this.gen(buffer)
    const out = []
    for (let i = 0; i < count; i++) {
      const m = buffer[i]
      const mover = this.side
      this.make(m)
      if (!this.inCheck(mover)) out.push(m)
      this.unmake()
    }
    return out
  }
}

// Evaluation -----------------------------------------------------------------------------

/** Score from the side to move's point of view, in centipawns. */
function evaluate(pos) {
  const b = pos.b
  let score = 0
  let material = 0
  for (let sq = 0; sq < 64; sq++) {
    const v = b[sq]
    if (v === 0) continue
    const type = Math.abs(v)
    if (type !== P && type !== K) material += VALUE[type]
  }
  const endgame = material < 2600
  for (let sq = 0; sq < 64; sq++) {
    const v = b[sq]
    if (v === 0) continue
    const white = v > 0
    const type = Math.abs(v)
    const f = sq & 7
    const r = white ? sq >> 3 : 7 - (sq >> 3) // rank from the owner's side
    const center = Math.abs(f - 3.5) + Math.abs((sq >> 3) - 3.5) // 1 in the middle, 7 in a corner
    let s = VALUE[type]
    if (type === P) s += r * 6 + (r >= 2 && (f === 3 || f === 4) ? 12 : 0) + (r >= 5 ? r * 8 : 0)
    else if (type === N || type === B) s += 22 - center * 6
    else if (type === R) s += (r === 6 ? 14 : 0) + (f === 3 || f === 4 ? 4 : 0)
    else if (type === Q) s += endgame ? 0 : 6 - center
    else s += endgame ? 20 - center * 5 : (r === 0 ? 14 : -r * 14) + (r === 0 && (f <= 2 || f >= 6) ? 16 : 0)
    score += white ? s : -s
  }
  return pos.side === 1 ? score : -score
}

// Transposition table -----------------------------------------------------------------------

// One slot per low-key bucket, replaced when the new entry searched at least as deep or belongs
// to another position. Shared by every search: the bot and the hint often look at the same lines.
const TT_BITS = 18
const TT_MASK = (1 << TT_BITS) - 1
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3
const ttLo = new Int32Array(1 << TT_BITS)
const ttHi = new Int32Array(1 << TT_BITS)
const ttMove = new Int32Array(1 << TT_BITS)
const ttScore = new Int32Array(1 << TT_BITS)
const ttDepth = new Int8Array(1 << TT_BITS)
const ttFlag = new Uint8Array(1 << TT_BITS)

// Mate scores are stored relative to the node, so they stay right when the same position comes up at another ply.
const toTT = (score, ply) => (score > MATE_BOUND ? score + ply : score < -MATE_BOUND ? score - ply : score)
const fromTT = (score, ply) => (score > MATE_BOUND ? score - ply : score < -MATE_BOUND ? score + ply : score)

function ttStore(pos, depth, flag, score, move, ply) {
  const i = pos.lo & TT_MASK
  if (ttFlag[i] && ttHi[i] === pos.hi && ttLo[i] === pos.lo && ttDepth[i] > depth) return
  ttLo[i] = pos.lo
  ttHi[i] = pos.hi
  ttDepth[i] = depth
  ttFlag[i] = flag
  ttScore[i] = toTT(score, ply)
  ttMove[i] = move
}

// Search -----------------------------------------------------------------------------------

const SEARCH = 0, QUIESCE = 1

/**
 * How promising a move looks before searching it: the table's move, captures (most valuable
 * victim, least valuable attacker), promotions, the two killers of this ply, then quiet moves by history.
 */
function moveScore(b, m, ttBest, killers, history, ply) {
  if (m === ttBest) return 2000000
  const from = m & 63
  const to = (m >> 6) & 63
  const flags = m >> 12
  const victim = b[to] < 0 ? -b[to] : b[to]
  if (victim || flags & F_EP) return 1000000 + 10 * VALUE[victim || P] - VALUE[b[from] < 0 ? -b[from] : b[from]]
  if (flags & F_PROMO) return 900000
  if (killers) {
    if (m === killers[ply * 2]) return 800000
    if (m === killers[ply * 2 + 1]) return 799999
  }
  return history ? Math.min(history[from * 64 + to], 700000) : 0
}

/**
 * One alpha-beta search from a node, on an explicit stack so `run` can stop when its slice is
 * over and continue on the next call. Scores are negamax: each node's from its side to move.
 * Moves are picked best-first one at a time, so a cutoff skips sorting the rest.
 */
class Search {
  constructor(pos, deadline) {
    this.pos = pos
    this.deadline = deadline
    this.nodes = 0
    this.steps = 0
    this.killers = new Int32Array(MAX_PLY * 2)
    this.history = new Int32Array(64 * 64)
    this.stack = Array.from({ length: MAX_PLY }, () => ({
      kind: SEARCH, depth: 0, alpha: 0, beta: 0, alpha0: 0, ply: 0, i: 0, count: 0, best: 0, bestMove: 0, legal: 0, inCheck: false, current: 0,
      moves: new Int32Array(MAX_MOVES), scores: new Int32Array(MAX_MOVES),
    }))
    this.top = -1
    this.value = undefined // a score waiting to be handed to the frame on top
  }

  start(depth, alpha, beta, ply) {
    this.top = -1
    const r = this.enter(depth, alpha, beta, ply)
    this.value = r === PUSHED ? undefined : r
  }

  /** Fills a frame's move list and scores. */
  load(f, captures, ttBest) {
    const b = this.pos.b
    f.count = this.pos.gen(f.moves, captures)
    const killers = captures ? null : this.killers
    const history = captures ? null : this.history
    for (let i = 0; i < f.count; i++) f.scores[i] = moveScore(b, f.moves[i], ttBest, killers, history, f.ply)
    f.i = 0
  }

  /** A full-width node: a score at once (table hit), or PUSHED. */
  enter(depth, alpha, beta, ply) {
    const pos = this.pos
    this.nodes++
    if (this.top >= MAX_PLY - 2) return evaluate(pos)
    const inCheck = pos.inCheck(pos.side)
    if (inCheck && ply < CHECK_EXTENSION_PLY) depth++
    if (depth <= 0) return this.enterQuiesce(alpha, beta, ply)
    const i = pos.lo & TT_MASK
    let ttBest = 0
    if (ttFlag[i] && ttLo[i] === pos.lo && ttHi[i] === pos.hi) {
      ttBest = ttMove[i]
      if (ttDepth[i] >= depth) {
        const score = fromTT(ttScore[i], ply)
        const flag = ttFlag[i]
        if (flag === TT_EXACT || (flag === TT_LOWER && score >= beta) || (flag === TT_UPPER && score <= alpha)) return score
      }
    }
    const f = this.stack[++this.top]
    f.kind = SEARCH
    f.depth = depth
    f.alpha = alpha
    f.alpha0 = alpha
    f.beta = beta
    f.ply = ply
    f.best = -INF
    f.bestMove = 0
    f.legal = 0
    f.inCheck = inCheck
    this.load(f, false, ttBest)
    return PUSHED
  }

  /** A captures-only node: the static score when standing pat is enough, otherwise PUSHED. */
  enterQuiesce(alpha, beta, ply) {
    const pos = this.pos
    this.nodes++
    const stand = evaluate(pos)
    if (ply > QUIESCE_PLY || this.top >= MAX_PLY - 2 || stand >= beta) return stand
    if (stand > alpha) alpha = stand
    const f = this.stack[++this.top]
    f.kind = QUIESCE
    f.alpha = alpha
    f.beta = beta
    f.ply = ply
    this.load(f, true, 0)
    if (f.count === 0) { this.top--; return alpha }
    return PUSHED
  }

  /** Scores the frame on top, records it, and pops it. */
  finish(f) {
    this.top--
    if (f.kind === QUIESCE) return f.alpha
    if (f.legal === 0) return f.inCheck ? -MATE + f.ply : 0
    const flag = f.best <= f.alpha0 ? TT_UPPER : f.best >= f.beta ? TT_LOWER : TT_EXACT
    ttStore(this.pos, f.depth, flag, f.best, f.bestMove, f.ply)
    return f.best
  }

  /** Searches until done (returns the score) or until `sliceEnd` (returns PAUSED). Throws TIMEOUT past the deadline. */
  run(sliceEnd) {
    const pos = this.pos
    let value = this.value
    this.value = undefined
    while (this.top >= 0) {
      if ((++this.steps & 63) === 0) {
        const now = performance.now()
        if (now > this.deadline) throw TIMEOUT
        if (now > sliceEnd) { this.value = value; return PAUSED }
      }
      const f = this.stack[this.top]
      if (value !== undefined) {
        // A child finished: take its score back into this frame.
        const score = -value
        value = undefined
        pos.unmake()
        if (score > f.best) { f.best = score; f.bestMove = f.current }
        if (score > f.alpha) f.alpha = score
        if (f.alpha >= f.beta) {
          const m = f.current
          if (f.kind === SEARCH && !pos.b[(m >> 6) & 63] && !((m >> 12) & (F_EP | F_PROMO))) {
            const k = f.ply * 2
            if (this.killers[k] !== m) { this.killers[k + 1] = this.killers[k]; this.killers[k] = m }
            this.history[(m & 63) * 64 + ((m >> 6) & 63)] += f.depth * f.depth
          }
          value = this.finish(f)
          continue
        }
      }
      const moves = f.moves
      const scores = f.scores
      while (f.i < f.count) {
        // Bring the best remaining move to position i.
        let pick = f.i
        for (let j = f.i + 1; j < f.count; j++) if (scores[j] > scores[pick]) pick = j
        const m = moves[pick]
        moves[pick] = moves[f.i]; scores[pick] = scores[f.i]
        moves[f.i] = m
        f.i++
        const mover = pos.side
        pos.make(m)
        if (pos.inCheck(mover)) { pos.unmake(); continue }
        f.legal++
        f.current = m
        const r = f.kind === QUIESCE
          ? this.enterQuiesce(-f.beta, -f.alpha, f.ply + 1)
          : this.enter(f.depth - 1, -f.beta, -f.alpha, f.ply + 1)
        if (r !== PUSHED) value = r
        break
      }
      // No child pushed and none scored: every move is tried.
      if (value === undefined && this.stack[this.top] === f) value = this.finish(f)
    }
    return value
  }
}

// Public API -------------------------------------------------------------------------------

const squareText = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 3) + 1)
const toUci = (m) => squareText(m & 63) + squareText((m >> 6) & 63) + (((m >> 12) & F_PROMO) ? 'q' : '')
const gaussian = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())

// A message, not setTimeout(0): chained timeouts are clamped to 4 ms each, which spent more of
// the time budget waiting than searching. In Node the port only holds the process open while a
// search is queued.
const channel = new MessageChannel()
const waiting = []
channel.port1.onmessage = () => waiting.shift()?.()
channel.port1.unref?.()
const yieldToMessages = () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0) })
// Messages alone can starve timers, the page's own setTimeouts included, so now and then the
// queue steps aside through a timer too.
const TIMER_EVERY_MS = 50
let lastTimer = 0
function yieldToPage() {
  const now = performance.now()
  if (now - lastTimer < TIMER_EVERY_MS) return yieldToMessages()
  lastTimer = now
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** What a rating asks of the search: depth, time, and how much noise blurs each score. */
export function profileFor(rating) {
  const elo = Math.max(400, Math.min(2000, rating))
  const noise = elo >= 1800 ? 0 : Math.round(300 * ((1800 - elo) / 1400) ** 1.3)
  const depth = elo < 700 ? 1 : elo < 1100 ? 2 : elo < 1500 ? 3 : elo < 1900 ? 4 : 5
  return { depth, noise, timeMs: elo >= 1900 ? 2800 : 1500 }
}

/**
 * One request, from the root: iterative deepening over the legal moves, a step at a time.
 * `step` returns PAUSED, or the chosen move as UCI (null when there is none).
 */
class Think {
  constructor(fen, { depth, timeMs, noise, rng }) {
    this.pos = new Position(fen)
    this.root = this.pos.legalMoves()
    this.maxDepth = depth
    this.timeMs = timeMs
    this.noise = noise
    this.rng = rng
    this.events = []
  }

  begin() {
    // The clock starts when the request leaves the queue, not when it joined it.
    this.search = new Search(this.pos, performance.now() + this.timeMs)
    const b = this.pos.b
    this.ordered = this.root.slice().sort((x, y) => moveScore(b, y, 0, null, null, 0) - moveScore(b, x, 0, null, null, 0))
    this.depth = 1
    this.index = 0
    this.current = []
    this.best = -INF
    this.results = null // [{ m, score }] of the last depth that finished
    this.inChild = false
  }

  step(sliceEnd) {
    if (this.root.length === 0) return null
    if (this.root.length === 1) return toUci(this.root[0])
    const pos = this.pos
    const search = this.search
    try {
      for (;;) {
        if (!this.inChild) {
          if (this.index === this.ordered.length) {
            // A depth is complete: keep it, report it, and go one deeper.
            this.results = this.current
            this.ordered = this.current.slice().sort((a, b) => b.score - a.score).map((x) => x.m)
            this.events.push({ depth: this.depth, move: toUci(this.ordered[0]), score: this.best, nodes: search.nodes })
            if (this.best > MATE - 100 || this.depth >= this.maxDepth) return this.pick()
            this.depth++
            this.index = 0
            this.current = []
            this.best = -INF
          }
          pos.make(this.ordered[this.index])
          // With noise every move needs a true score; without it, a narrowed window is enough.
          search.start(this.depth - 1, -INF, this.noise ? INF : -this.best, 1)
          this.inChild = true
        }
        const value = search.run(sliceEnd)
        if (value === PAUSED) return PAUSED
        pos.unmake()
        this.inChild = false
        const score = -value
        this.current.push({ m: this.ordered[this.index++], score })
        if (score > this.best) this.best = score
        if (performance.now() > sliceEnd) return PAUSED
      }
    } catch (error) {
      if (error !== TIMEOUT) throw error
      while (pos.plies) pos.unmake()
      return this.pick()
    }
  }

  pick() {
    if (!this.results) return toUci(this.ordered[0])
    let pick = this.results[0]
    let pickScore = -INF
    for (const entry of this.results) {
      const blurred = Math.abs(entry.score) > MATE - 200 ? entry.score : entry.score + (this.noise ? gaussian(this.rng) * this.noise : 0)
      if (blurred > pickScore) { pick = entry; pickScore = blurred }
    }
    return toUci(pick.m)
  }
}

// The queue: requests run one at a time, first come first served, a slice per page task.
const queue = []
let pumping = false

async function pump() {
  if (pumping) return
  pumping = true
  channel.port1.ref?.()
  try {
    while (queue.length) {
      await yieldToPage()
      const job = queue[0]
      if (job.isCancelled()) { queue.shift(); job.resolve(null); continue }
      let result
      try {
        if (!job.started) { job.started = true; job.think.begin() }
        result = job.think.step(performance.now() + (job.isBusy() ? BUSY_SLICE_MS : SLICE_MS))
        for (const event of job.think.events.splice(0)) job.onProgress?.(event)
      } catch (error) {
        queue.shift()
        job.reject(error)
        continue
      }
      if (result !== PAUSED) { queue.shift(); job.resolve(result) }
    }
  } finally {
    pumping = false
    channel.port1.unref?.()
  }
}

/**
 * Picks a move for the side to move in `fen`. Resolves to a UCI string, or null when the side has
 * no legal move or the request was cancelled. Requests queue and share the page's thread in slices:
 * `isCancelled()` is asked before every slice (true drops the request), `isBusy()` asks for shorter
 * slices while something on screen animates, and `onProgress({ depth, move, score, nodes })` hears
 * each depth as it completes.
 */
export function chooseMove(fen, {
  depth = 3, timeMs = 1500, noise = 0, rng = Math.random, isCancelled = () => false, isBusy = () => false, onProgress = null,
} = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ think: new Think(fen, { depth, timeMs, noise, rng }), isCancelled, isBusy, onProgress, resolve, reject, started: false })
    pump()
  })
}

/** Leaf count after `depth` plies, for checking the move generator. With `checkHash`, also checks the incremental key at every node. */
export function perft(fen, depth, { checkHash = false } = {}) {
  const pos = new Position(fen)
  const walk = (d) => {
    if (checkHash) {
      const [lo, hi] = pos.computeHash()
      if (lo !== pos.lo || hi !== pos.hi) throw new Error(`hash mismatch after ${Array.from(pos.uMove.subarray(0, pos.plies), toUci).join(' ')}`)
    }
    if (d === 0) return 1
    let total = 0
    for (const m of pos.legalMoves()) {
      if (d === 1 && !checkHash) { total++; continue }
      pos.make(m)
      total += walk(d - 1)
      pos.unmake()
    }
    return total
  }
  return walk(depth)
}
