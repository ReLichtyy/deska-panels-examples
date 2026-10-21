import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseMove, perft } from '../../panels/chess/engine.js'

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'
const MIDGAME = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 8'

test('engine move generator matches the reference perft counts', () => {
  assert.equal(perft('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 4), 197281)
  assert.equal(perft(KIWIPETE, 3), 97862)
  assert.equal(perft('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4), 43238)
  // Positions with underpromotions differ on purpose: the engine only promotes to a queen.
})

test('the incremental position key always equals the key computed from scratch', () => {
  // Castling, en passant, promotions and captures all change the key.
  perft(KIWIPETE, 3, { checkHash: true })
  perft('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, { checkHash: true })
  perft('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, { checkHash: true })
})

test('finds a mate in one, a free queen and a mate in two', async () => {
  assert.equal(await chooseMove('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', { depth: 3 }), 'a1a8')
  assert.equal(await chooseMove('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1', { depth: 3 }), 'd2d5')
  // 1. Qd8+ Rxd8 2. Rxd8#: the queen is given up to open the back rank.
  assert.equal(await chooseMove('2r3k1/5ppp/8/8/8/8/3Q1PPP/3R2K1 w - - 0 1', { depth: 4 }), 'd2d8')
})

test('no legal move resolves to null; one legal move is returned at once', async () => {
  assert.equal(await chooseMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), null)
  assert.equal(await chooseMove('k7/8/1QK5/8/8/8/8/8 b - - 0 1'), null)
  assert.equal(await chooseMove('7k/8/8/8/8/8/6q1/7K w - - 0 1'), 'h1g2')
})

test('reports each finished depth, in order', async () => {
  const events = []
  await chooseMove(MIDGAME, { depth: 4, timeMs: 5000, onProgress: (e) => events.push(e) })
  assert.deepEqual(events.map((e) => e.depth), [1, 2, 3, 4])
  for (const e of events) assert.match(e.move, /^[a-h][1-8][a-h][1-8]q?$/)
})

test('a cancelled request stops at the next slice and lets the next one run', async () => {
  let cancel = false
  const started = performance.now()
  const first = chooseMove(MIDGAME, { depth: 9, timeMs: 20000, isCancelled: () => cancel })
  const second = chooseMove('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', { depth: 3 })
  setTimeout(() => { cancel = true }, 50)
  assert.equal(await first, null)
  assert.equal(await second, 'a1a8')
  assert.ok(performance.now() - started < 1500, 'the cancelled search kept running')
})

test('the search never holds the thread for long', async () => {
  let worst = 0
  let last = performance.now()
  let running = true
  const ping = () => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
    if (running) setImmediate(ping)
  }
  setImmediate(ping)
  await chooseMove(MIDGAME, { depth: 6, timeMs: 1500 })
  running = false
  assert.ok(worst < 60, `longest block ${worst.toFixed(0)} ms`)
})
