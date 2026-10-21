// The panel's real client (panels/chess/online-client.js) talking to this service in-process.
// If the contract in ONLINE.md and the client ever drift apart, this is the test that breaks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineClient } from '../../panels/chess/online-client.js'
import { setup } from './helpers.mjs'

async function person(s, sub) {
  const bearer = await s.token(sub)
  const sdk = { account: { signIn: async () => {}, token: async () => ({ token: bearer }) } }
  const fetcher = (url, init) => s.service.handle(new Request(url, init))
  return createOnlineClient({ sdk, apiUrl: 'https://chess.example', fetcher })
}

test('two real clients play a game to checkmate through the service', async () => {
  const s = await setup()
  const white = await person(s, 'acct-w')
  const black = await person(s, 'acct-b')
  await white.signIn()
  await black.signIn()
  const room = await white.create()
  assert.equal(white.state.phase, 'waiting')
  await black.join(room.code)
  assert.equal(black.state.phase, 'active')
  await white.refresh()
  assert.equal(white.state.phase, 'active')
  for (const [client, uci] of [[white, 'f2f3'], [black, 'e7e5'], [white, 'g2g4'], [black, 'd8h4']]) {
    await client.move(uci)
    // The other side catches up with its own refresh, as the panel's poll does.
    await (client === white ? black : white).refresh()
  }
  assert.equal(white.state.phase, 'finished')
  assert.equal(black.state.phase, 'finished')
  assert.deepEqual(white.state.room.moves, ['f2f3', 'e7e5', 'g2g4', 'd8h4'])
  assert.deepEqual(black.state.room.moves, white.state.room.moves)
})

test('the client sees presence, and a recovered room by id', async () => {
  const s = await setup()
  const white = await person(s, 'acct-w')
  const black = await person(s, 'acct-b')
  await white.signIn(); await black.signIn()
  await black.presence()
  const list = await white.presence()
  assert.equal(list.total, 1 + 1)
  const room = await white.create()
  const sameAccount = await person(s, 'acct-w')
  await sameAccount.signIn()
  await sameAccount.resume(room.id)
  assert.equal(sameAccount.state.room.code, room.code)
})

test('a rejected token signs the client out instead of leaving it half connected', async () => {
  const s = await setup()
  const sdk = { account: { signIn: async () => {}, token: async () => ({ token: 'a.b.c' }) } }
  const client = createOnlineClient({ sdk, apiUrl: 'https://chess.example', fetcher: (url, init) => s.service.handle(new Request(url, init)) })
  await assert.rejects(client.signIn(), { code: 'not_signed_in' })
  assert.equal(client.state.phase, 'signed-out')
})

async function named(s, sub, name) {
  const bearer = await s.token(sub, name ? { name } : {})
  const asked = []
  const sdk = { account: { signIn: async (options) => { asked.push(options) }, token: async () => ({ token: bearer }) } }
  const client = createOnlineClient({ sdk, apiUrl: 'https://chess.example', fetcher: (url, init) => s.service.handle(new Request(url, init)) })
  await client.signIn()
  return { client, asked }
}

test('signing in asks Deska for the name, and the person decides whether to share it', async () => {
  const s = await setup()
  const { asked } = await named(s, 'acct-a', 'Ana Pérez')
  assert.deepEqual(asked, [{ name: true }])
})

test('find someone by name, challenge them, accept, and both clients are in the same game', async () => {
  const s = await setup()
  const ana = (await named(s, 'acct-a', 'Ana Pérez')).client
  const ben = (await named(s, 'acct-b', 'Benjamín')).client
  const before = await ben.home()
  assert.deepEqual([before.me.name, before.me.shared, before.room, before.recent], ['Benjamín', true, null, []])
  const found = await ana.search('benja')
  assert.deepEqual(found.players.map((p) => p.name), ['Benjamín'])
  await ana.challenge(found.players[0].id)
  const incoming = (await ben.home()).incoming
  assert.deepEqual(incoming.map((c) => c.from.name), ['Ana Pérez'])
  await ben.accept(incoming[0].id)
  assert.equal(ben.state.phase, 'active')
  assert.equal(ben.state.room.opponent, 'Ana Pérez')
  const sent = (await ana.home()).outgoing[0]
  assert.equal(sent.state, 'accepted')
  await ana.resume(sent.roomId)
  assert.equal(ana.state.room.opponent, 'Benjamín')
  assert.notEqual(ana.state.room.side, ben.state.room.side)
  assert.deepEqual((await ana.home()).recent.map((p) => p.name), ['Benjamín'])
})

test('a refusal carries the server reason, so the panel can say what happened', async () => {
  const s = await setup()
  const ana = (await named(s, 'acct-a', 'Ana')).client
  await assert.rejects(ana.challenge('p_unknown'), (error) => error.code === 'room_not_found' && error.detail === 'player_not_found')
  await assert.rejects(ana.search('ab'), (error) => error.detail === 'bad_query')
})

test('a malformed home or search answer is refused instead of drawn', async () => {
  const s = await setup()
  const bearer = await s.token('acct-a')
  const sdk = { account: { signIn: async () => {}, token: async () => ({ token: bearer }) } }
  let next = {}
  const client = createOnlineClient({ sdk, apiUrl: 'https://chess.example', fetcher: async () => new Response(JSON.stringify(next)) })
  await client.signIn().catch(() => {})
  next = { ok: true }
  await client.signIn()
  for (const bad of [{}, { me: {} }, { me: { id: 'p_1', name: '<b>x</b>', alias: 'Alfil Azul 42', shared: true }, recent: [], incoming: [], outgoing: [], total: 1 }]) {
    next = bad
    await assert.rejects(client.home(), { code: 'invalid_response' })
  }
  next = { players: Array.from({ length: 11 }, (_, i) => ({ id: `p_${i}`, name: 'Ana', status: 'offline' })) }
  await assert.rejects(client.search('ana'), { code: 'invalid_response' })
  next = { me: { id: 'p_1', name: null, alias: 'Alfil Azul 42', shared: false }, room: null, recent: [], incoming: [], outgoing: [], total: 1 }
  assert.equal((await client.home()).me.shared, false)
})
