import test from 'node:test'
import assert from 'node:assert/strict'
import { newGame, fromFEN, toFEN, START_FEN, moveFromUci, play, perft, premoveTargets, applyPremove, premoveUci, projectPremoves, squareName } from '../../panels/chess/rules.js'

test('standard move generation remains correct', () => {
  assert.equal(perft(newGame(), 4), 197281)
  assert.equal(perft(fromFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 3), 97862)
  assert.equal(toFEN(newGame()), START_FEN)
})
test('network move text refuses trailing garbage and invalid promotions', () => {
  for (const uci of ['e2e4garbage', 'e2e4q', 'e2e5', 'a9a8', 'E2E4', null]) assert.equal(moveFromUci(newGame(), uci), null)
})
test('all four promotions produce the requested piece and roundtrip in history', () => {
  for (const promotion of ['q', 'r', 'b', 'n']) {
    const game = fromFEN('7k/P7/8/8/8/8/8/7K w - - 0 1')
    const found = moveFromUci(game, `a7a8${promotion}`)
    assert.ok(found)
    const result = play(game, found.from, found.move)
    assert.equal(result.board[7][0].type, promotion)
    assert.equal(fromFEN(toFEN(result)).board[7][0].type, promotion)
  }
})
test('old promotion saves without suffix still mean queen', () => {
  const game = fromFEN('7k/P7/8/8/8/8/8/7K w - - 0 1')
  assert.equal(moveFromUci(game, 'a7a8').move.promotion, 'q')
})

const names = (list) => list.map((s) => squareName(s.f, s.r)).sort()
const at = (name) => ({ f: name.charCodeAt(0) - 97, r: Number(name[1]) - 1 })
test('premove pawn targets: one or two ahead unless an own piece is in the way, both diagonals always', () => {
  assert.deepEqual(names(premoveTargets(newGame().board, 4, 1)), ['d3', 'e3', 'e4', 'f3'])
  const blocked = fromFEN('4k3/8/8/8/8/4N3/4P3/4K3 w - - 0 1').board
  assert.deepEqual(names(premoveTargets(blocked, 4, 1)), ['d3', 'f3'])
  // A rival piece in front may move away, so it does not block.
  const rival = fromFEN('4k3/8/8/8/8/4n3/4P3/4K3 w - - 0 1').board
  assert.deepEqual(names(premoveTargets(rival, 4, 1)), ['d3', 'e3', 'e4', 'f3'])
})
test('premove rays pass through rival pieces and stop on (and include) an own piece', () => {
  const board = fromFEN('4k3/8/8/p7/8/8/P7/R3K3 w - - 0 1').board
  const rook = names(premoveTargets(board, 0, 0))
  assert.ok(rook.includes('a2'))
  assert.ok(!rook.includes('a3'))
  assert.deepEqual(names(premoveTargets(fromFEN('4k3/8/8/p7/8/8/8/R3K3 w - - 0 1').board, 0, 0)).filter((s) => s[0] === 'a'),
    ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
  const knight = names(premoveTargets(newGame().board, 6, 0))
  assert.deepEqual(knight, ['e2', 'f3', 'h3'])
})
test('premove castling needs the right and the rook, and moves the rook in the projection', () => {
  const game = fromFEN('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1')
  const king = names(premoveTargets(game.board, 4, 0, game.castling))
  assert.ok(king.includes('g1') && king.includes('c1'))
  assert.ok(!names(premoveTargets(game.board, 4, 0, {})).includes('g1'))
  const after = applyPremove(game.board, at('e1'), at('g1'))
  assert.equal(after[0][6].type, 'k')
  assert.equal(after[0][5].type, 'r')
  assert.equal(after[0][7], null)
})
test('premove promotion asks for a queen and chains project on top of each other', () => {
  const board = fromFEN('7k/P7/8/8/8/8/8/K7 w - - 0 1').board
  assert.equal(premoveUci(board, at('a7'), at('a8')), 'a7a8q')
  assert.equal(applyPremove(board, at('a7'), at('a8'))[7][0].type, 'q')
  const chain = projectPremoves(newGame().board, [{ from: at('e2'), to: at('e4') }, { from: at('e4'), to: at('e5') }])
  assert.equal(chain[4][4].type, 'p')
  assert.equal(chain[1][4], null)
})
test('a queued premove that is no longer legal is refused by the real rules', () => {
  // White queued e2e4 then e4e5; black answered e7e5, so e4e5 is blocked.
  let game = newGame()
  for (const uci of ['e2e4', 'e7e5']) { const m = moveFromUci(game, uci); game = play(game, m.from, m.move) }
  assert.equal(moveFromUci(game, 'e4e5'), null)
})
