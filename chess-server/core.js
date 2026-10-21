// The Chess Online service: private rooms, confirmed moves, who is connected, people you can find
// and challenge. The contract is panels/chess/ONLINE.md. This file knows nothing about Cloudflare or
// Node: it takes a key-value store and a token verifier, and answers Request with Response, so the
// Worker and the tests run the very same code.
//
// Never trust the browser: identity comes from the verified token, and every move is checked with the
// same rules the panel uses (panels/chess/rules.js) for the turn, the legality and the revision.

import { isOver, moveFromUci, newGame, play } from '../panels/chess/rules.js'
import { AuthError } from './auth.js'

const MAX_BODY = 2048
const MAX_MOVES = 2000 // the client refuses longer histories
const PRESENCE_TTL_MS = 90_000
const PRESENCE_LIST = 100
const WAITING_TTL_MS = 24 * 3600_000
const ROOM_TTL_MS = 7 * 24 * 3600_000
const CHALLENGE_TTL_MS = 24 * 3600_000
const MAX_OUTGOING = 5
const MAX_INCOMING = 20
const MAX_RECENT = 20
const SEARCH_RESULTS = 10
const SEARCH_SCAN = 5000
const REQUEST_MEMORY = 40
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, none easy to confuse
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/

const PIECES = ['Peón', 'Caballo', 'Alfil', 'Torre', 'Dama', 'Rey']
const COLORS = ['Azul', 'Rojo', 'Verde', 'Ámbar', 'Violeta', 'Turquesa', 'Coral', 'Índigo']

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

const CORS = {
  'access-control-allow-origin': '*', // the panel's origin is opaque ("null") and it sends no cookies
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
}
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), {
  status,
  headers: { ...CORS, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 204 ? {} : { 'content-type': 'application/json' }) },
})

function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)) }
const toBase64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function playerIdOf({ aud, sub }) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${aud}\n${sub}`))
  return `p_${[...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function makeAlias() {
  const [a, b, c] = randomBytes(3)
  return `${PIECES[a % PIECES.length]} ${COLORS[b % COLORS.length]} ${10 + (c % 90)}`
}

function makeCode() {
  return Array.from(randomBytes(6), (b) => CODE_ALPHABET[b & 31]).join('')
}

/**
 * The name a person chose to share with the panel, reduced to what other players may see:
 * letters, digits, spaces and . _ ' -, at most 24 characters, starting with a letter or digit.
 * Anything else (symbols, direction marks, emoji) is dropped. null when nothing usable is left.
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null
  const kept = raw.normalize('NFC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim()
  const name = [...kept].slice(0, 24).join('').trim()
  return /^[\p{L}\p{N}]/u.test(name) ? name : null
}

// Names compare without case or accents, so "jose" finds "José".
const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** A sliding window per key. */
function limiter(max, windowMs, now) {
  const hits = new Map()
  return (key) => {
    const t = now()
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs)
    if (recent.length >= max) { hits.set(key, recent); return false }
    recent.push(t)
    hits.set(key, recent)
    if (hits.size > 5000) for (const [k, list] of hits) if (!list.some((at) => t - at < windowMs)) hits.delete(k)
    return true
  }
}

/**
 * store:    { get(key), put(key, value), delete(key), list(prefix) -> [[key, value], ...] }, async,
 *           values are plain JSON-able objects.
 * verifier: async (authorizationHeader) -> { sub, aud, dev, name? }, throws AuthError (see auth.js).
 */
export function createService({ store, verifier, now = Date.now, log = console }) {
  const presence = new Map() // playerId -> { playing, at }; memory only, it refills on the next beat
  const anyRequest = limiter(120, 60_000, now)
  const joins = limiter(10, 60_000, now)
  const creates = limiter(10, 60_000, now)
  const searches = limiter(20, 60_000, now)
  const challenges = limiter(10, 60_000, now)
  // One request changes state at a time. The room, the code index and the player record are written
  // together, and two writers must never interleave between their reads and writes.
  let chain = Promise.resolve()
  const exclusive = (work) => {
    const run = chain.then(work, work)
    chain = run.catch(() => {})
    return run
  }

  async function readBody(request) {
    if (request.method === 'GET') return {}
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new HttpError(413, 'too_large')
    const text = await request.text()
    if (text.length > MAX_BODY) throw new HttpError(413, 'too_large')
    try {
      const body = text ? JSON.parse(text) : {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
      return body
    } catch { throw new HttpError(400, 'bad_json') }
  }

  const requestId = (body) => {
    if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw new HttpError(400, 'bad_request_id')
    return body.requestId
  }

  const shown = (player) => player.name || player.alias

  async function getPlayer(identity) {
    const id = await playerIdOf(identity)
    let player = await store.get(`player:${id}`)
    const name = cleanName(identity.name)
    if (!player) {
      player = { id, alias: makeAlias(), name, roomId: null, recent: [], createdAt: now() }
      await store.put(`player:${id}`, player)
    } else if ((player.name ?? null) !== name) {
      // Follows the token: when the person stops sharing the name, it stops being shown.
      player.name = name
      await store.put(`player:${id}`, player)
    }
    return player
  }

  const playerById = async (id) => (typeof id === 'string' && ID.test(id) ? store.get(`player:${id}`) : undefined)

  async function getRoom(id) {
    if (typeof id !== 'string' || !ID.test(id)) return null
    const room = await store.get(`room:${id}`)
    if (!room) return null
    const age = now() - room.updatedAt
    if (age > ROOM_TTL_MS || (room.status === 'waiting' && now() - room.createdAt > WAITING_TTL_MS)) {
      await dropRoom(room)
      return null
    }
    return room
  }

  async function dropRoom(room) {
    await store.delete(`room:${room.id}`)
    await store.delete(`code:${room.code}`)
  }

  const sideOf = (room, player) => (room.white === player.id ? 'w' : room.black === player.id ? 'b' : null)
  // `opponent` is the other player's display name (null while waiting), so the panel can name who you play.
  const view = (room, player) => ({
    id: room.id, code: room.code, side: sideOf(room, player), status: room.status,
    revision: room.revision, moves: room.moves,
    opponent: (room.white === player.id ? room.blackName : room.whiteName) ?? null,
  })

  function setPlaying(playerId, playing) {
    const entry = presence.get(playerId)
    if (entry) entry.playing = playing
  }

  // online / playing / offline, from the heartbeat, for any player.
  function statusOf(id) {
    const entry = presence.get(id)
    if (!entry || now() - entry.at > PRESENCE_TTL_MS) return 'offline'
    return entry.playing ? 'playing' : 'available'
  }
  const person = (p) => ({ id: p.id, name: shown(p), status: statusOf(p.id) })

  const replay = (moves) => {
    let game = newGame()
    for (const uci of moves) {
      const found = moveFromUci(game, uci)
      if (!found) throw new Error(`stored move ${uci} is not legal`)
      game = play(game, found.from, found.move)
    }
    return game
  }

  async function remember(a, b) {
    // Whoever you have played with is who the home screen offers first.
    for (const [me, other] of [[a, b], [b, a]]) {
      const fresh = await store.get(`player:${me.id}`)
      fresh.recent = [{ id: other.id, at: now() }, ...(fresh.recent || []).filter((r) => r.id !== other.id)].slice(0, MAX_RECENT)
      await store.put(`player:${me.id}`, fresh)
      me.recent = fresh.recent
    }
  }

  // Routes --------------------------------------------------------------------------------------

  async function session() {
    return { ok: true }
  }

  function beat(player, room) {
    const t = now()
    presence.set(player.id, { playing: !!room && room.status === 'active', at: t })
    for (const [id, entry] of presence) if (t - entry.at > PRESENCE_TTL_MS) presence.delete(id)
  }

  async function heartbeat(player) {
    const room = player.roomId ? await getRoom(player.roomId) : null
    beat(player, room)
    const others = []
    for (const [id] of presence) if (id !== player.id) { const p = await playerById(id); if (p) others.push(p) }
    others.sort((a, b) => shown(a).localeCompare(shown(b), 'es'))
    const list = [player, ...others.slice(0, PRESENCE_LIST - 1)]
    return {
      total: presence.size,
      players: list.map((p) => ({ id: p.id, name: shown(p), status: statusOf(p.id) === 'playing' ? 'playing' : 'available', self: p.id === player.id })),
    }
  }

  async function createRoom(player, body) {
    requestId(body)
    if (!creates(player.id)) throw new HttpError(429, 'rate_limited')
    const current = player.roomId ? await getRoom(player.roomId) : null
    // Repeating "create" returns the room still waiting, so a lost answer costs nothing.
    if (current && current.status === 'waiting' && current.white === player.id) return view(current, player)
    if (current && current.status === 'active') throw new HttpError(409, 'active_room')
    let code
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = makeCode()
      if (!(await store.get(`code:${candidate}`))) { code = candidate; break }
    }
    if (!code) throw new HttpError(503, 'try_again')
    const t = now()
    const room = { id: toBase64url(randomBytes(16)), code, white: player.id, whiteName: shown(player), black: null, blackName: null,
      moves: [], status: 'waiting', revision: 1, createdAt: t, updatedAt: t, requests: [] }
    await store.put(`room:${room.id}`, room)
    await store.put(`code:${code}`, room.id)
    player.roomId = room.id
    await store.put(`player:${player.id}`, player)
    setPlaying(player.id, false)
    return view(room, player)
  }

  // Frees a player for a new game: an active game blocks (409), a room still waiting is dropped.
  async function freeForGame(player) {
    const own = player.roomId ? await getRoom(player.roomId) : null
    if (own && own.status === 'active') throw new HttpError(409, 'active_room')
    if (own && own.status === 'waiting') await dropRoom(own)
  }

  async function joinRoom(player, body) {
    requestId(body)
    if (!joins(player.id)) throw new HttpError(429, 'rate_limited')
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new HttpError(400, 'bad_code')
    const id = await store.get(`code:${code}`)
    const room = id ? await getRoom(id) : null
    if (!room) throw new HttpError(404, 'room_not_found')
    if (sideOf(room, player)) return view(room, player) // joining your own room again is a no-op
    if (room.status !== 'waiting' || room.black) throw new HttpError(404, 'room_not_found') // a full room does not reveal itself
    await freeForGame(player)
    room.black = player.id
    room.blackName = shown(player)
    room.status = 'active'
    room.revision++
    room.updatedAt = now()
    await store.put(`room:${room.id}`, room)
    player.roomId = room.id
    await store.put(`player:${player.id}`, player)
    const host = await playerById(room.white)
    if (host) await remember(host, player)
    setPlaying(room.white, true)
    setPlaying(player.id, true)
    return view(room, player)
  }

  async function readRoom(player, id) {
    const room = await getRoom(id)
    if (!room || !sideOf(room, player)) throw new HttpError(404, 'room_not_found') // strangers learn nothing
    return view(room, player)
  }

  async function move(player, id, body) {
    const rid = requestId(body)
    const room = await getRoom(id)
    const side = room && sideOf(room, player)
    if (!room || !side) throw new HttpError(404, 'room_not_found')
    // The same request again (a retry after a lost answer) is answered with the room as it is now.
    if (room.requests.some(([who, seen]) => who === player.id && seen === rid)) return view(room, player)
    if (room.status !== 'active') throw new HttpError(409, 'not_active')
    if (!Number.isSafeInteger(body.revision) || body.revision !== room.revision) throw new HttpError(409, 'revision')
    if (room.moves.length >= MAX_MOVES) throw new HttpError(409, 'too_long')
    const game = replay(room.moves)
    if (game.turn !== side) throw new HttpError(409, 'not_your_turn')
    const found = moveFromUci(game, body.uci)
    if (!found) throw new HttpError(409, 'illegal_move')
    const next = play(game, found.from, found.move)
    room.moves.push(body.uci)
    room.revision++
    room.status = isOver(next) ? 'finished' : 'active'
    room.updatedAt = now()
    room.requests = [...room.requests, [player.id, rid]].slice(-REQUEST_MEMORY)
    await store.put(`room:${room.id}`, room)
    if (room.status === 'finished') { setPlaying(room.white, false); setPlaying(room.black, false) }
    return view(room, player)
  }

  // Home: people, search and challenges -----------------------------------------------------------

  async function loadChallenge(id) {
    const challenge = typeof id === 'string' && ID.test(id) ? await store.get(`challenge:${id}`) : undefined
    if (!challenge) return null
    const t = now()
    const expired = challenge.state === 'pending' ? t - challenge.createdAt > CHALLENGE_TTL_MS : t - (challenge.decidedAt ?? challenge.createdAt) > CHALLENGE_TTL_MS
    if (expired) { await dropChallenge(challenge); return null }
    return challenge
  }

  async function dropChallenge(challenge) {
    await store.delete(`challenge:${challenge.id}`)
    await store.delete(`chin:${challenge.to}:${challenge.id}`)
    await store.delete(`chout:${challenge.from}:${challenge.id}`)
  }

  async function challengesOf(prefix) {
    const found = []
    for (const [, id] of await store.list(prefix)) {
      const challenge = await loadChallenge(id)
      if (challenge) found.push(challenge)
    }
    return found.sort((a, b) => b.createdAt - a.createdAt)
  }

  async function home(player) {
    const room = player.roomId ? await getRoom(player.roomId) : null
    beat(player, room)
    const resume = room && (room.status === 'waiting' || room.status === 'active')
      ? { id: room.id, code: room.code, status: room.status, side: sideOf(room, player), opponent: view(room, player).opponent,
        turn: room.moves.length % 2 === 0 ? 'w' : 'b', moves: room.moves.length }
      : null
    const recent = []
    for (const { id } of player.recent || []) {
      const other = await playerById(id)
      if (other) recent.push(person(other))
    }
    // People who are connected come first, then the most recent opponent.
    const order = { available: 0, playing: 1, offline: 2 }
    recent.sort((a, b) => order[a.status] - order[b.status])
    const incoming = []
    for (const c of (await challengesOf(`chin:${player.id}:`)).filter((c) => c.state === 'pending')) {
      const from = await playerById(c.from)
      if (from) incoming.push({ id: c.id, from: person(from), at: c.createdAt })
    }
    const outgoingAll = []
    for (const c of await challengesOf(`chout:${player.id}:`)) {
      const to = await playerById(c.to)
      if (!to) { await dropChallenge(c); continue }
      let state = c.state
      let roomId = null
      if (state === 'accepted') {
        const r = await getRoom(c.roomId)
        if (!r || r.status === 'finished') { await dropChallenge(c); continue } // the game it started is over
        roomId = r.id
      }
      outgoingAll.push({ challenge: c, view: { id: c.id, to: person(to), state, roomId, at: c.createdAt } })
    }
    // Accepted and pending challenges always stay visible; old declined ones beyond the 10-row cap are retired.
    const stateOrder = { accepted: 0, pending: 1, declined: 2 }
    outgoingAll.sort((a, b) => stateOrder[a.view.state] - stateOrder[b.view.state] || b.view.at - a.view.at)
    for (const extra of outgoingAll.slice(10)) await dropChallenge(extra.challenge)
    const outgoing = outgoingAll.slice(0, 10).map((x) => x.view)
    return {
      me: { id: player.id, name: player.name, alias: player.alias, shared: !!player.name },
      room: resume, recent, incoming, outgoing, total: presence.size,
    }
  }

  async function search(player, body) {
    if (!searches(player.id)) throw new HttpError(429, 'rate_limited')
    const raw = typeof body.query === 'string' ? body.query.normalize('NFC').trim() : ''
    if ([...raw].length < 3 || [...raw].length > 24) throw new HttpError(400, 'bad_query')
    const needle = fold(raw)
    const found = []
    // Only people who chose to share their name can be found by it. The scan is capped.
    for (const [, other] of (await store.list('player:')).slice(0, SEARCH_SCAN)) {
      if (other.id === player.id || !other.name || !fold(other.name).includes(needle)) continue
      found.push(person(other))
    }
    const order = { available: 0, playing: 1, offline: 2 }
    found.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'es'))
    return { players: found.slice(0, SEARCH_RESULTS) }
  }

  async function challenge(player, body) {
    requestId(body)
    if (!challenges(player.id)) throw new HttpError(429, 'rate_limited')
    const target = await playerById(body.to)
    if (!target) throw new HttpError(404, 'player_not_found')
    if (target.id === player.id) throw new HttpError(400, 'self')
    const mine = await challengesOf(`chout:${player.id}:`)
    const pending = mine.filter((c) => c.state === 'pending')
    // Challenging the same person twice is one challenge.
    const existing = pending.find((c) => c.to === target.id)
    if (existing) return { id: existing.id, state: 'pending' }
    if (pending.length >= MAX_OUTGOING) throw new HttpError(409, 'too_many_pending')
    if ((await challengesOf(`chin:${target.id}:`)).filter((c) => c.state === 'pending').length >= MAX_INCOMING) throw new HttpError(409, 'too_many_pending')
    const c = { id: toBase64url(randomBytes(12)), from: player.id, to: target.id, state: 'pending', createdAt: now(), roomId: null }
    await store.put(`challenge:${c.id}`, c)
    await store.put(`chin:${target.id}:${c.id}`, c.id)
    await store.put(`chout:${player.id}:${c.id}`, c.id)
    return { id: c.id, state: 'pending' }
  }

  async function answerChallenge(player, id, action) {
    const c = await loadChallenge(id)
    if (!c) throw new HttpError(404, 'challenge_not_found')
    if (action === 'cancel') {
      // The sender withdraws it, or dismisses an answer they have seen.
      if (c.from !== player.id) throw new HttpError(404, 'challenge_not_found')
      await dropChallenge(c)
      return { ok: true }
    }
    if (c.to !== player.id || c.state !== 'pending') throw new HttpError(404, 'challenge_not_found')
    if (action === 'decline') {
      c.state = 'declined'
      c.decidedAt = now()
      await store.put(`challenge:${c.id}`, c)
      await store.delete(`chin:${player.id}:${c.id}`)
      return { ok: true }
    }
    // Accept: a game starts at once, with the colors drawn. Check both players before dropping any waiting room.
    const challenger = await playerById(c.from)
    if (!challenger) { await dropChallenge(c); throw new HttpError(404, 'challenge_not_found') }
    const ownRoom = player.roomId ? await getRoom(player.roomId) : null
    if (ownRoom && ownRoom.status === 'active') throw new HttpError(409, 'active_room')
    const challengerRoom = challenger.roomId ? await getRoom(challenger.roomId) : null
    if (challengerRoom && challengerRoom.status === 'active') throw new HttpError(409, 'opponent_busy')
    const code = await freeCode()
    if (ownRoom && ownRoom.status === 'waiting') await dropRoom(ownRoom)
    if (challengerRoom && challengerRoom.status === 'waiting') await dropRoom(challengerRoom)
    const [first, second] = randomBytes(1)[0] & 1 ? [challenger, player] : [player, challenger]
    const t = now()
    const room = { id: toBase64url(randomBytes(16)), code, white: first.id, whiteName: shown(first), black: second.id,
      blackName: shown(second), moves: [], status: 'active', revision: 2, createdAt: t, updatedAt: t, requests: [] }
    await store.put(`room:${room.id}`, room)
    await store.put(`code:${room.code}`, room.id)
    for (const p of [player, challenger]) {
      const fresh = await store.get(`player:${p.id}`)
      fresh.roomId = room.id
      await store.put(`player:${p.id}`, fresh)
      p.roomId = room.id
    }
    await remember(challenger, player)
    c.state = 'accepted'
    c.roomId = room.id
    c.decidedAt = t
    await store.put(`challenge:${c.id}`, c)
    await store.delete(`chin:${player.id}:${c.id}`)
    setPlaying(player.id, true)
    setPlaying(challenger.id, true)
    return view(room, player)
  }

  async function freeCode() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = makeCode()
      if (!(await store.get(`code:${candidate}`))) return candidate
    }
    throw new HttpError(503, 'try_again')
  }

  // Dispatch ------------------------------------------------------------------------------------

  async function handle(request) {
    if (request.method === 'OPTIONS') return reply(204)
    try {
      const url = new URL(request.url)
      const path = url.pathname
      const parts = path.split('/').filter(Boolean)
      const route = path === '/session' ? 'session' : path === '/presence' ? 'presence' : path === '/home' ? 'home'
        : path === '/players/search' ? 'search' : path === '/challenges' ? 'challenge' : path === '/rooms' ? 'create'
        : path === '/rooms/join' ? 'join'
        : parts.length === 2 && parts[0] === 'rooms' ? 'room'
        : parts.length === 3 && parts[0] === 'rooms' && parts[2] === 'moves' ? 'move'
        : parts.length === 3 && parts[0] === 'challenges' && ['accept', 'decline', 'cancel'].includes(parts[2]) ? 'answer' : null
      if (!route) throw new HttpError(404, 'not_found')
      const method = route === 'room' ? 'GET' : 'POST'
      if (request.method !== method) throw new HttpError(405, 'method_not_allowed')

      let identity
      try { identity = await verifier(request.headers.get('authorization')) } catch (error) {
        if (!(error instanceof AuthError)) throw error
        // The reason is enough to debug a setup. The token itself is never logged.
        log.warn('auth rejected:', error.reason, error.detail ?? '')
        throw new HttpError(error.reason === 'keys_unavailable' ? 503 : 401, 'unauthorized')
      }
      const body = await readBody(request)
      return await exclusive(async () => {
        const player = await getPlayer(identity)
        if (!anyRequest(player.id)) throw new HttpError(429, 'rate_limited')
        const result = route === 'session' ? await session(player)
          : route === 'presence' ? await heartbeat(player)
          : route === 'home' ? await home(player)
          : route === 'search' ? await search(player, body)
          : route === 'challenge' ? await challenge(player, body)
          : route === 'answer' ? await answerChallenge(player, parts[1], parts[2])
          : route === 'create' ? await createRoom(player, body)
          : route === 'join' ? await joinRoom(player, body)
          : route === 'room' ? await readRoom(player, parts[1])
          : await move(player, parts[1], body)
        return reply(200, result)
      })
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: error.code })
      log.error('chess server error:', error?.message || 'unknown') // never the request, the token or the body
      return reply(500, { error: 'server_error' })
    }
  }

  return { handle }
}
