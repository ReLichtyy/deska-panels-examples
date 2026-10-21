import test from 'node:test'
import assert from 'node:assert/strict'
import { call, setup, uuid } from './helpers.mjs'
import { readPresence, readRoom } from '../../panels/chess/online-client.js'

async function twoPlayers(options) {
  const s = await setup(options)
  const white = await s.token('acct-white')
  const black = await s.token('acct-black')
  const create = async () => (await call(s.service, 'POST', '/rooms', { token: white, body: { requestId: uuid() } })).json()
  const join = (code, token = black) => call(s.service, 'POST', '/rooms/join', { token, body: { code, requestId: uuid() } })
  const move = (room, uci, token, extra = {}) => call(s.service, 'POST', `/rooms/${room.id}/moves`,
    { token, body: { uci, revision: room.revision, requestId: uuid(), ...extra } })
  return { s, white, black, create, join, move }
}

test('CORS: preflight and every answer allow the panel\'s opaque origin, without credentials', async () => {
  const s = await setup()
  const preflight = await call(s.service, 'OPTIONS', '/rooms')
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/)
  const denied = await call(s.service, 'POST', '/session', { body: {} })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('access-control-allow-origin'), '*')
  assert.equal(denied.headers.get('access-control-allow-credentials'), null)
  assert.equal(denied.headers.get('cache-control'), 'no-store')
})

test('without a valid token nothing is served, and the error never echoes the token', async () => {
  const s = await setup()
  for (const [method, path] of [['POST', '/session'], ['POST', '/presence'], ['POST', '/rooms'], ['GET', '/rooms/abc']]) {
    const response = await call(s.service, method, path, { token: 'a.b.c' })
    assert.equal(response.status, 401, path)
    assert.ok(!(await response.text()).includes('a.b.c'))
  }
  assert.equal((await call(s.service, 'GET', '/nothing', { token: await s.token('a') })).status, 404)
  assert.equal((await call(s.service, 'GET', '/rooms', { token: await s.token('a') })).status, 405)
})

test('a room replays through the panel\'s own client validation, from both seats', async () => {
  const { s, white, black, create, join, move } = await twoPlayers()
  const made = await create()
  assert.equal(readRoom(made).status, 'waiting')
  assert.equal(made.side, 'w')
  assert.match(made.code, /^[A-Z0-9]{6}$/)
  const joined = await (await join(made.code.toLowerCase())).json()
  assert.equal(readRoom(joined).status, 'active')
  assert.equal(joined.side, 'b')
  assert.ok(joined.revision > made.revision)
  const afterWhite = await (await move(joined, 'e2e4', white)).json()
  assert.deepEqual(readRoom(afterWhite).moves, ['e2e4'])
  const alias = /^\p{L}+ \p{L}+ \d\d$/u
  assert.equal(made.opponent, null)
  assert.match(joined.opponent, alias, 'black sees the white player alias')
  const seenByWhite = await (await call(s.service, 'GET', `/rooms/${made.id}`, { token: white })).json()
  assert.match(seenByWhite.opponent, alias, 'white sees the black player alias')
  const seenByBlack = await (await call(s.service, 'GET', `/rooms/${made.id}`, { token: black })).json()
  assert.equal(seenByBlack.side, 'b')
  assert.deepEqual(readRoom(seenByBlack).moves, ['e2e4'])
})

test('only the right player, on the right turn, with a legal move and the current revision, can move', async () => {
  const { s, white, black, create, join, move } = await twoPlayers()
  const made = await create()
  const room = await (await join(made.code)).json()
  const stranger = await s.token('acct-stranger')
  assert.equal((await move(room, 'e2e4', stranger)).status, 404, 'a stranger cannot play')
  assert.equal((await call(s.service, 'GET', `/rooms/${made.id}`, { token: stranger })).status, 404, 'a stranger cannot look')
  assert.equal((await move(room, 'e7e5', black)).status, 409, 'not black\'s turn')
  assert.equal((await move(room, 'e2e5', white)).status, 409, 'illegal move')
  assert.equal((await move(room, 'e2e4garbage', white)).status, 409, 'malformed move')
  assert.equal((await move(room, 'e2e4', white, { revision: room.revision + 1 })).status, 409, 'stale or future revision')
  assert.equal((await move(room, 'e2e4', white, { requestId: 'short' })).status, 400)
  const ok = await move(room, 'e2e4', white)
  assert.equal(ok.status, 200)
  assert.equal((await move(room, 'd2d4', white)).status, 409, 'the old revision is refused after a move')
})

test('a repeated request is answered once: no double move, no error', async () => {
  const { white, create, join, move } = await twoPlayers()
  const room = await (await join((await create()).code)).json()
  const requestId = uuid()
  const first = await (await move(room, 'e2e4', white, { requestId })).json()
  const again = await move(room, 'e2e4', white, { requestId })
  assert.equal(again.status, 200)
  const second = await again.json()
  assert.deepEqual(second.moves, ['e2e4'])
  assert.equal(second.revision, first.revision)
})

test('creating again returns the room still waiting; joining your own room is harmless', async () => {
  const { white, create, join } = await twoPlayers()
  const first = await create()
  const second = await create()
  assert.equal(second.id, first.id)
  assert.equal((await join(first.code, white)).status, 200)
})

test('a full room, an unknown code and a bad code reveal nothing', async () => {
  const { s, create, join } = await twoPlayers()
  const made = await create()
  await join(made.code)
  const third = await s.token('acct-third')
  assert.equal((await join(made.code, third)).status, 404)
  assert.equal((await join('ZZZZZZ', third)).status, 404)
  assert.equal((await join('../x', third)).status, 400)
})

test('a player in a running game cannot start or join another one', async () => {
  const { s, white, create, join } = await twoPlayers()
  const made = await create()
  await join(made.code)
  assert.equal((await call(s.service, 'POST', '/rooms', { token: white, body: { requestId: uuid() } })).status, 409)
  const other = await s.token('acct-other')
  const second = await (await call(s.service, 'POST', '/rooms', { token: other, body: { requestId: uuid() } })).json()
  assert.equal((await join(second.code, white)).status, 409)
})

test('a finished game is final, and its players can start another', async () => {
  const { s, white, black, create, join, move } = await twoPlayers()
  let room = await (await join((await create()).code)).json()
  for (const [uci, token] of [['f2f3', white], ['e7e5', black], ['g2g4', white], ['d8h4', black]]) {
    room = await (await move(room, uci, token)).json()
  }
  assert.equal(readRoom(room).status, 'finished')
  assert.equal((await move(room, 'a2a3', white)).status, 409)
  assert.equal((await call(s.service, 'POST', '/rooms', { token: white, body: { requestId: uuid() } })).status, 200)
})

test('presence lists who is connected: you first, free before playing, aliases only, TTL honoured', async () => {
  const { s, white, black, create, join } = await twoPlayers()
  const asWhite = async () => readPresence(await (await call(s.service, 'POST', '/presence', { token: white, body: {} })).json())
  let list = await asWhite()
  assert.deepEqual([list.total, list.players.length, list.players[0].self], [1, 1, true])
  await call(s.service, 'POST', '/presence', { token: black, body: {} })
  list = await asWhite()
  assert.equal(list.total, 2)
  assert.equal(list.players[0].self, true)
  assert.ok(list.players.every((p) => /^[\p{L}]+ [\p{L}]+ \d\d$/u.test(p.name)), 'server-made aliases')
  assert.ok(!JSON.stringify(list).includes('acct-'), 'no account id leaves the server')
  await join((await create()).code)
  list = await asWhite()
  assert.deepEqual(list.players.map((p) => p.status), ['playing', 'playing'])
  s.time.advance(120_000)
  list = await asWhite()
  assert.equal(list.total, 1, 'people who stopped beating drop off after 90 s')
})

test('limits: oversized bodies, bad JSON and request floods are stopped', async () => {
  const { s, white, create } = await twoPlayers()
  const big = await call(s.service, 'POST', '/rooms', { token: white, body: { requestId: uuid(), pad: 'x'.repeat(3000) } })
  assert.equal(big.status, 413)
  const bad = await s.service.handle(new Request('https://chess.example/rooms', { method: 'POST', headers: { authorization: `Bearer ${white}` }, body: '{nope' }))
  assert.equal(bad.status, 400)
  await create()
  let limited = 0
  for (let i = 0; i < 130; i++) {
    if ((await call(s.service, 'POST', '/presence', { token: white, body: {} })).status === 429) limited++
  }
  assert.ok(limited > 0, 'a flood gets 429')
  s.time.advance(61_000)
  assert.equal((await call(s.service, 'POST', '/presence', { token: white, body: {} })).status, 200)
})

test('old rooms expire: a waiting room after a day, others after a week', async () => {
  const { s, white, black, create, join } = await twoPlayers()
  const waiting = await create()
  s.time.advance(25 * 3600_000)
  assert.equal((await call(s.service, 'GET', `/rooms/${waiting.id}`, { token: white })).status, 404)
  assert.equal((await join(waiting.code)).status, 404)
  const room = await (await join((await create()).code)).json()
  s.time.advance(6 * 24 * 3600_000)
  assert.equal((await call(s.service, 'GET', `/rooms/${room.id}`, { token: black })).status, 200)
  s.time.advance(2 * 24 * 3600_000)
  assert.equal((await call(s.service, 'GET', `/rooms/${room.id}`, { token: black })).status, 404)
})

test('two simultaneous moves on one revision: exactly one wins', async () => {
  const { white, create, join, move } = await twoPlayers()
  const room = await (await join((await create()).code)).json()
  const results = await Promise.all([move(room, 'e2e4', white), move(room, 'd2d4', white)])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
})
