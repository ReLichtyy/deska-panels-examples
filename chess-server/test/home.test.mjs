import test from 'node:test'
import assert from 'node:assert/strict'
import { call, setup, uuid } from './helpers.mjs'
import { cleanName } from '../core.js'
import { readRoom } from '../../panels/chess/online-client.js'

// People with tokens; a name only when they chose to share it with the panel.
async function people(names = { ana: 'Ana Pérez', ben: 'Benjamín', cris: undefined }) {
  const s = await setup()
  const out = { s }
  for (const [key, name] of Object.entries(names)) out[key] = await s.token(`acct-${key}`, name ? { name } : {})
  out.post = async (path, token, body = {}) => { const r = await call(s.service, 'POST', path, { token, body }); return { status: r.status, body: await r.json() } }
  out.home = async (token) => (await out.post('/home', token)).body
  out.id = async (token) => (await out.home(token)).me.id
  return out
}

test('names: only letters, digits, spaces and . _ \' - survive, at most 24 characters', () => {
  assert.equal(cleanName('  Ana   Pérez '), 'Ana Pérez')
  assert.equal(cleanName('Zoë <script>alert(1)</script>'), 'Zoë scriptalert1script')
  assert.equal(cleanName('a‮b'), 'ab')
  assert.equal(cleanName('x'.repeat(40)).length, 24)
  assert.equal(cleanName('😀😀'), null)
  assert.equal(cleanName('-leading'), null)
  assert.equal(cleanName(42), null)
})

test('a shared name is what others see; without one, the alias; it follows the token', async () => {
  const p = await people()
  assert.deepEqual((await p.home(p.ana)).me, { id: await p.id(p.ana), name: 'Ana Pérez', alias: (await p.home(p.ana)).me.alias, shared: true })
  const cris = (await p.home(p.cris)).me
  assert.deepEqual([cris.name, cris.shared], [null, false])
  assert.match(cris.alias, /^\p{L}+ \p{L}+ \d\d$/u)
  const list = await (await call(p.s.service, 'POST', '/presence', { token: p.cris, body: {} })).json()
  assert.deepEqual(list.players.map((x) => x.name).sort(), [cris.alias, 'Ana Pérez'].sort())
  // The same person without the name in the token (stopped sharing) goes back to the alias.
  const again = await p.s.token('acct-ana')
  assert.equal((await p.home(again)).me.name, null)
})

test('search finds only people who shared a name, without case or accents, never yourself', async () => {
  const p = await people({ ana: 'Ana Pérez', ben: 'Benjamín', cris: undefined, pere: 'Pedro Perez' })
  await p.home(p.ben); await p.home(p.cris); await p.home(p.pere)
  const find = async (token, query) => (await p.post('/players/search', token, { query }))
  assert.deepEqual((await find(p.ana, 'perez')).body.players.map((x) => x.name), ['Pedro Perez'])
  assert.deepEqual((await find(p.cris, 'PÉREZ')).body.players.map((x) => x.name).sort(), ['Ana Pérez', 'Pedro Perez'])
  assert.deepEqual((await find(p.ana, 'benja')).body.players.map((x) => x.name), ['Benjamín'])
  assert.deepEqual((await find(p.ben, 'ben')).body.players, [], 'not yourself')
  assert.equal((await find(p.ana, 'cris')).body.players.length, 0, 'alias-only people cannot be found by name')
  assert.equal((await find(p.ana, 'ab')).status, 400)
  assert.equal((await find(p.ana, 'x'.repeat(30))).status, 400)
  const hit = (await find(p.cris, 'ben')).body.players[0]
  assert.deepEqual(Object.keys(hit).sort(), ['id', 'name', 'status'], 'no account data leaves the server')
})

test('search is rate limited', async () => {
  const p = await people()
  let limited = 0
  for (let i = 0; i < 25; i++) if ((await p.post('/players/search', p.ana, { query: 'ben' })).status === 429) limited++
  assert.ok(limited > 0)
})

test('a game makes you each other\'s recent rival; connected rivals come first', async () => {
  const p = await people({ ana: 'Ana', ben: 'Benjamín', cris: 'Cristina' })
  const room = await (await call(p.s.service, 'POST', '/rooms', { token: p.ana, body: { requestId: uuid() } })).json()
  await call(p.s.service, 'POST', '/rooms/join', { token: p.ben, body: { code: room.code, requestId: uuid() } })
  const room2 = await (await call(p.s.service, 'POST', '/rooms', { token: p.cris, body: { requestId: uuid() } })).json()
  assert.deepEqual((await p.home(p.ana)).recent.map((r) => r.name), ['Benjamín'])
  assert.deepEqual((await p.home(p.ben)).recent.map((r) => r.name), ['Ana'])
  // Cris joins Ana's world later; once the first game is over Ana can play her.
  for (const [uci, token] of [['f2f3', p.ana], ['e7e5', p.ben], ['g2g4', p.ana], ['d8h4', p.ben]]) {
    const r = await (await call(p.s.service, 'GET', `/rooms/${room.id}`, { token })).json()
    await call(p.s.service, 'POST', `/rooms/${room.id}/moves`, { token, body: { uci, revision: r.revision, requestId: uuid() } })
  }
  await call(p.s.service, 'POST', '/rooms/join', { token: p.ana, body: { code: room2.code, requestId: uuid() } })
  const recent = (await p.home(p.ana)).recent
  assert.deepEqual(recent.map((r) => r.name).sort(), ['Benjamín', 'Cristina'])
  p.s.time.advance(120_000) // Ben stopped beating
  await p.home(p.ana)
  await p.home(p.cris)
  const sorted = (await p.home(p.ana)).recent
  assert.equal(sorted[0].name, 'Cristina', 'connected first')
  assert.equal(sorted.at(-1).status, 'offline')
})

test('home offers the game in progress to resume, and nothing once it is over', async () => {
  const p = await people()
  assert.equal((await p.home(p.ana)).room, null)
  const room = await (await call(p.s.service, 'POST', '/rooms', { token: p.ana, body: { requestId: uuid() } })).json()
  assert.deepEqual((await p.home(p.ana)).room, { id: room.id, code: room.code, status: 'waiting', side: 'w', opponent: null, turn: 'w', moves: 0 })
  await call(p.s.service, 'POST', '/rooms/join', { token: p.ben, body: { code: room.code, requestId: uuid() } })
  const resume = (await p.home(p.ben)).room
  assert.deepEqual([resume.status, resume.side, resume.opponent], ['active', 'b', 'Ana Pérez'])
})

test('challenges: sent, seen by the other, repeated once, never to yourself or a stranger id', async () => {
  const p = await people()
  const [ana, ben] = [await p.id(p.ana), await p.id(p.ben)]
  const sent = await p.post('/challenges', p.ana, { to: ben, requestId: uuid() })
  assert.equal(sent.status, 200)
  assert.equal((await p.post('/challenges', p.ana, { to: ben, requestId: uuid() })).body.id, sent.body.id)
  const incoming = (await p.home(p.ben)).incoming
  assert.deepEqual(incoming.map((c) => [c.id, c.from.name]), [[sent.body.id, 'Ana Pérez']])
  assert.deepEqual((await p.home(p.ana)).outgoing.map((c) => [c.to.name, c.state]), [['Benjamín', 'pending']])
  assert.equal((await p.post('/challenges', p.ana, { to: ana, requestId: uuid() })).status, 400)
  assert.equal((await p.post('/challenges', p.ana, { to: 'p_nobody', requestId: uuid() })).status, 404)
  assert.equal((await p.post('/challenges', p.ana, { to: '../x', requestId: uuid() })).status, 404)
  assert.equal((await p.post('/challenges', p.ana, { to: ben })).status, 400, 'a request id is required')
})

test('accepting starts a game at once for both, with the colors drawn; the sender can enter it', async () => {
  const p = await people()
  const ben = await p.id(p.ben)
  const sent = await p.post('/challenges', p.ana, { to: ben, requestId: uuid() })
  const accepted = await p.post(`/challenges/${sent.body.id}/accept`, p.ben)
  assert.equal(accepted.status, 200)
  const mine = readRoom(accepted.body)
  assert.equal(mine.status, 'active')
  assert.equal(accepted.body.opponent, 'Ana Pérez')
  const theirs = (await p.home(p.ana))
  assert.equal(theirs.room.status, 'active')
  assert.notEqual(theirs.room.side, accepted.body.side)
  assert.deepEqual(theirs.outgoing.map((c) => [c.state, c.roomId]), [['accepted', accepted.body.id]])
  assert.deepEqual((await p.home(p.ben)).incoming, [])
  assert.deepEqual((await p.home(p.ben)).recent.map((r) => r.name), ['Ana Pérez'])
  // Both can move in it, white first.
  const whiteToken = accepted.body.side === 'w' ? p.ben : p.ana
  const played = await call(p.s.service, 'POST', `/rooms/${accepted.body.id}/moves`, { token: whiteToken, body: { uci: 'e2e4', revision: 2, requestId: uuid() } })
  assert.equal(played.status, 200)
})

test('declining tells the sender; the sender can withdraw or dismiss; strangers cannot touch it', async () => {
  const p = await people()
  const ben = await p.id(p.ben)
  const sent = await p.post('/challenges', p.ana, { to: ben, requestId: uuid() })
  assert.equal((await p.post(`/challenges/${sent.body.id}/accept`, p.cris)).status, 404)
  assert.equal((await p.post(`/challenges/${sent.body.id}/decline`, p.cris)).status, 404)
  assert.equal((await p.post(`/challenges/${sent.body.id}/cancel`, p.ben)).status, 404, 'the receiver cannot cancel it')
  assert.equal((await p.post(`/challenges/${sent.body.id}/decline`, p.ben)).status, 200)
  assert.deepEqual((await p.home(p.ben)).incoming, [])
  assert.deepEqual((await p.home(p.ana)).outgoing.map((c) => c.state), ['declined'])
  assert.equal((await p.post(`/challenges/${sent.body.id}/accept`, p.ben)).status, 404, 'a declined challenge cannot be accepted')
  assert.equal((await p.post(`/challenges/${sent.body.id}/cancel`, p.ana)).status, 200)
  assert.deepEqual((await p.home(p.ana)).outgoing, [])
  const again = await p.post('/challenges', p.ana, { to: ben, requestId: uuid() })
  assert.equal((await p.post(`/challenges/${again.body.id}/cancel`, p.ana)).status, 200)
  assert.deepEqual((await p.home(p.ben)).incoming, [], 'withdrawn before it was answered')
})

test('limits: five pending per person, a game in progress blocks accepting, expiry after a day', async () => {
  const names = { ana: 'Ana', t1: 'Tres Uno', t2: 'Tres Dos', t3: 'Tres Tres', t4: 'Tres Cuatro', t5: 'Tres Cinco', t6: 'Tres Seis' }
  const p = await people(names)
  const ids = {}
  for (const k of Object.keys(names)) ids[k] = await p.id(p[k])
  for (const k of ['t1', 't2', 't3', 't4', 't5']) assert.equal((await p.post('/challenges', p.ana, { to: ids[k], requestId: uuid() })).status, 200)
  assert.equal((await p.post('/challenges', p.ana, { to: ids.t6, requestId: uuid() })).status, 409)
  // t1 starts another game, then cannot accept.
  const room = await (await call(p.s.service, 'POST', '/rooms', { token: p.t1, body: { requestId: uuid() } })).json()
  await call(p.s.service, 'POST', '/rooms/join', { token: p.t2, body: { code: room.code, requestId: uuid() } })
  const mine = (await p.home(p.ana)).outgoing.find((c) => c.to.name === 'Tres Uno')
  assert.equal((await p.post(`/challenges/${mine.id}/accept`, p.t1)).status, 409)
  // The sender gets into a game: the receiver cannot start one with them.
  const other = (await p.home(p.ana)).outgoing.find((c) => c.to.name === 'Tres Tres')
  const room2 = await (await call(p.s.service, 'POST', '/rooms', { token: p.ana, body: { requestId: uuid() } })).json()
  await call(p.s.service, 'POST', '/rooms/join', { token: p.t6, body: { code: room2.code, requestId: uuid() } })
  assert.equal((await p.post(`/challenges/${other.id}/accept`, p.t3)).status, 409, 'opponent_busy')
  p.s.time.advance(25 * 3600_000)
  assert.deepEqual((await p.home(p.ana)).outgoing, [])
  assert.deepEqual((await p.home(p.t3)).incoming, [])
})

test('an accepted challenge disappears from the sender once its game is over', async () => {
  const p = await people()
  const ben = await p.id(p.ben)
  const sent = await p.post('/challenges', p.ana, { to: ben, requestId: uuid() })
  const room = (await p.post(`/challenges/${sent.body.id}/accept`, p.ben)).body
  const [white, black] = room.side === 'w' ? [p.ben, p.ana] : [p.ana, p.ben]
  let revision = room.revision
  for (const [uci, token] of [['f2f3', white], ['e7e5', black], ['g2g4', white], ['d8h4', black]]) {
    const r = await call(p.s.service, 'POST', `/rooms/${room.id}/moves`, { token, body: { uci, revision, requestId: uuid() } })
    revision = (await r.json()).revision
  }
  assert.deepEqual((await p.home(p.ana)).outgoing, [])
  assert.equal((await p.home(p.ana)).room, null)
})

test('failed accept preserves waiting room and outgoing list stays within client cap', async () => {
  const names = { p: 'Pablo', c: 'Carla', d: 'Diego' }
  for (let i = 0; i < 12; i++) names['f' + i] = 'Amigo ' + i
  const p = await people(names)
  const ids = {}
  for (const k of Object.keys(names)) ids[k] = await p.id(p[k])
  const ch = await p.post('/challenges', p.c, { to: ids.p, requestId: uuid() })
  const waiting = (await (await call(p.s.service, 'POST', '/rooms', { token: p.p, body: { requestId: uuid() } })).json())
  const busyRoom = (await (await call(p.s.service, 'POST', '/rooms', { token: p.d, body: { requestId: uuid() } })).json())
  await call(p.s.service, 'POST', '/rooms/join', { token: p.c, body: { code: busyRoom.code, requestId: uuid() } })
  const failed = await p.post(`/challenges/${ch.body.id}/accept`, p.p)
  assert.equal(failed.status, 409)
  assert.equal(failed.body.error, 'opponent_busy')
  assert.equal((await p.home(p.p)).room?.id, waiting.id, 'waiting room is untouched when accept fails')
  for (const round of [[0, 5], [5, 10], [10, 12]]) {
    p.s.time.advance(61_000)
    for (let i = round[0]; i < round[1]; i++) {
      const sent = await p.post('/challenges', p.p, { to: ids['f' + i], requestId: uuid() })
      await p.post(`/challenges/${sent.body.id}/decline`, p['f' + i])
    }
  }
  const h = await p.home(p.p)
  assert.equal(h.outgoing.length, 10, 'outgoing challenges never exceed the 10-row client limit')
})
