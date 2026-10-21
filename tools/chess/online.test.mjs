import test from 'node:test'
import assert from 'node:assert/strict'
import { apiOrigin, roomCode, readRoom, readPresence, createOnlineClient } from '../../panels/chess/online-client.js'

const snapshot = (extra = {}) => ({ id: 'room_1', code: 'ABC123', side: 'w', status: 'active', revision: 1, moves: [], ...extra })
function harness() {
  const calls = [], events = []
  let next = { ok: true }, status = 200, tokens = 0, signedIn = 0
  const sdk = { account: { signIn: async () => { signedIn++ }, token: async () => { tokens++; return { token: 'test-only-not-a-real-token' } } } }
  const client = createOnlineClient({ sdk, apiUrl: 'https://chess.example', onChange: (s) => events.push(s),
    fetcher: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(next), { status }) } })
  return { client, calls, events, sdk, get tokens() { return tokens }, get signedIn() { return signedIn },
    reply(value, code = 200) { next = value; status = code } }
}
test('only HTTPS origins without credentials or ports may receive tokens', () => {
  for (const value of ['http://chess.example', 'https://user:pass@chess.example', 'https://chess.example:444', 'https://chess.example/path', 'https://127.0.0.1', null]) {
    assert.throws(() => apiOrigin(value))
  }
  assert.equal(apiOrigin('https://chess.example/'), 'https://chess.example')
  assert.equal(roomCode(' abc123 '), 'ABC123')
  assert.throws(() => roomCode('../bad'))
})
test('sign-in and each request use Deska tokens in headers only', async () => {
  const h = harness()
  await h.client.signIn()
  h.reply(snapshot({ status: 'waiting' }))
  await h.client.create()
  assert.equal(h.signedIn, 1)
  assert.equal(h.tokens, 2)
  assert.equal(h.calls[0].url, 'https://chess.example/session')
  assert.equal(h.calls[0].options.credentials, 'omit')
  assert.equal(h.calls[0].options.redirect, 'error')
  assert.match(h.calls[0].options.headers.authorization, /^Bearer /)
  assert.ok(JSON.parse(h.calls[1].options.body).requestId)
  assert.ok(!JSON.stringify(h.client.state).includes('test-only'))
})
test('room replay rejects malformed, illegal, post-game and inconsistent histories', () => {
  assert.equal(readRoom(snapshot({ moves: ['e2e4', 'e7e5'] })).games.length, 3)
  for (const data of [snapshot({ moves: ['e2e5'] }), snapshot({ status: 'waiting', moves: ['e2e4'] }),
    snapshot({ status: 'finished' }), snapshot({ side: 'x' }), snapshot({ revision: -1 }),
    snapshot({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4', 'a2a3'], status: 'finished' })]) {
    assert.throws(() => readRoom(data), { code: 'invalid_response' })
  }
})
test('moves are confirmed by the service and include revision and idempotency key', async () => {
  const h = harness()
  h.reply(snapshot()); await h.client.join('ABC123')
  h.reply(snapshot({ revision: 2, moves: ['e2e4'] }))
  await h.client.move('e2e4')
  const sent = JSON.parse(h.calls.at(-1).options.body)
  assert.equal(sent.uci, 'e2e4'); assert.equal(sent.revision, 1); assert.ok(sent.requestId)
  assert.deepEqual(h.client.state.room.moves, ['e2e4'])
  assert.throws(() => h.client.move('e7e5'), { code: 'invalid_move' })
})
test('failed moves preserve the confirmed board, lock play, and are never replayed automatically', async () => {
  const h = harness()
  h.reply(snapshot()); await h.client.join('ABC123')
  h.reply({ error: 'not_your_turn' }, 409)
  await assert.rejects(h.client.move('e2e4'), { code: 'conflict', detail: 'not_your_turn' })
  assert.deepEqual(h.client.state.room.moves, [])
  assert.equal(h.client.state.phase, 'disconnected')
  assert.equal(h.calls.length, 2)
  h.reply(snapshot({ revision: 2, moves: ['e2e4'] }))
  await h.client.refresh()
  assert.equal(h.client.state.phase, 'active')
})
test('rollback or player reassignment from service locks the room', async () => {
  const h = harness()
  h.reply(snapshot({ revision: 3, moves: ['e2e4', 'e7e5'] })); await h.client.join('ABC123')
  h.reply(snapshot({ revision: 4, moves: [] }))
  await assert.rejects(h.client.refresh(), { code: 'invalid_response' })
  assert.equal(h.client.state.room.moves.length, 2)
})
test('unauthorized responses clear session and room', async () => {
  const h = harness()
  h.reply(snapshot()); await h.client.join('ABC123')
  h.reply({}, 401)
  await assert.rejects(h.client.refresh(), { code: 'not_signed_in' })
  assert.equal(h.client.state.room, null)
  assert.equal(h.client.state.phase, 'signed-out')
})
test('move acknowledgements must confirm the requested move and a newer revision', async () => {
  for (const response of [snapshot(), snapshot({ revision: 2, moves: ['d2d4'] })]) {
    const h = harness()
    h.reply(snapshot()); await h.client.join('ABC123')
    h.reply(response)
    await assert.rejects(h.client.move('e2e4'), { code: 'invalid_response' })
    assert.equal(h.client.state.phase, 'disconnected')
    assert.deepEqual(h.client.state.room.moves, [])
  }
})
test('revocation while token is pending prevents any network request', async () => {
  const h = harness()
  let resolve
  h.sdk.account.token = () => new Promise((r) => { resolve = r })
  const pending = h.client.join('ABC123')
  h.client.revoke()
  resolve({ token: 'test-only' })
  await assert.rejects(pending, { code: 'cancelled' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.client.state.room, null)
})
test('disabled configuration never opens a Deska sign-in sheet', async () => {
  let called = false
  const client = createOnlineClient({ sdk: { account: { signIn() { called = true } } }, apiUrl: null })
  await assert.rejects(client.signIn(), { code: 'configuration' })
  assert.equal(called, false)
})
const person = (extra = {}) => ({ id: 'p_1', name: 'Marisol Vega', status: 'available', self: false, ...extra })
test('presence lists are validated, deduplicated and ordered self, free, playing, then name', () => {
  const list = readPresence({ total: 4, players: [person({ id: 'p_2', name: 'Tomás Quiroga', status: 'playing' }),
    person({ id: 'p_3', name: 'Ana' }), person(), person({ id: 'p_4', name: 'Zoe', self: true, status: 'playing' })] })
  assert.deepEqual(list.players.map((p) => p.name), ['Zoe', 'Ana', 'Marisol Vega', 'Tomás Quiroga'])
  for (const data of [null, { players: [], total: -1 }, { players: [person()], total: 0 },
    { players: [person(), person()], total: 2 }, { players: [person({ status: 'away' })], total: 1 },
    { players: [person({ name: '<img src=x>' })], total: 1 }, { players: [person({ name: 'a\u202eb' })], total: 1 },
    { players: [person({ name: 'x'.repeat(25) })], total: 1 }, { players: [person({ self: 'yes' })], total: 1 },
    { players: [person({ self: true }), person({ id: 'p_2', self: true })], total: 2 }]) {
    assert.throws(() => readPresence(data), { code: 'invalid_response' })
  }
})
test('presence uses the token, does not lock the client, and drops answers after sign-out', async () => {
  const h = harness()
  await h.client.signIn()
  h.reply({ total: 1, players: [person({ self: true })] })
  const list = await h.client.presence()
  assert.equal(list.total, 1)
  assert.equal(h.calls.at(-1).url, 'https://chess.example/presence')
  assert.match(h.calls.at(-1).options.headers.authorization, /^Bearer /)
  assert.equal(h.client.state.busy, false)
  let release
  h.sdk.account.token = () => new Promise((r) => { release = r })
  const pending = h.client.presence()
  h.client.disconnect()
  release({ token: 'test-only' })
  await assert.rejects(pending, { code: 'cancelled' })
  await assert.rejects(h.client.presence(), { code: 'not_signed_in' })
})
test('presence 401 signs the client out and malformed lists leave it signed in', async () => {
  const h = harness()
  await h.client.signIn()
  h.reply({ total: 'x', players: [] })
  await assert.rejects(h.client.presence(), { code: 'invalid_response' })
  assert.equal(h.client.state.phase, 'ready')
  h.reply({}, 401)
  await assert.rejects(h.client.presence(), { code: 'not_signed_in' })
  assert.equal(h.client.state.phase, 'signed-out')
})
