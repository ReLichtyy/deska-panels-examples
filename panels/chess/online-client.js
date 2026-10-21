import { newGame, moveFromUci, play, isOver } from './rules.js'

export class OnlineError extends Error {
  // `detail` is the server's own reason for a refusal (such as opponent_busy); it is never shown raw.
  constructor(code, detail = null) { super(code); this.name = 'OnlineError'; this.code = code; this.detail = detail }
}

export function apiOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new OnlineError('configuration') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.') ||
      /^[\d.]+$/.test(url.hostname)) throw new OnlineError('configuration')
  return url.origin
}

export function roomCode(value) {
  const code = String(value).trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new OnlineError('invalid_code')
  return code
}

// Validate and reconstruct the server's confirmed history before touching the board.
export function readRoom(data) {
  if (!data || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(data.id) ||
      typeof data.code !== 'string' || !/^[A-Z0-9]{6}$/.test(data.code) ||
      !['w', 'b'].includes(data.side) || !['waiting', 'active', 'finished'].includes(data.status) ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !Array.isArray(data.moves) || data.moves.length > 2000) throw new OnlineError('invalid_response')
  if (data.opponent !== undefined && data.opponent !== null && !validName(data.opponent)) throw new OnlineError('invalid_response')
  const games = [newGame()]
  for (const uci of data.moves) {
    const current = games.at(-1)
    if (isOver(current)) throw new OnlineError('invalid_response')
    const found = moveFromUci(current, uci)
    if (!found) throw new OnlineError('invalid_response')
    games.push(play(current, found.from, found.move))
  }
  if (data.status === 'waiting' && data.moves.length) throw new OnlineError('invalid_response')
  if (data.status === 'active' && isOver(games.at(-1))) throw new OnlineError('invalid_response')
  if (data.status === 'finished' && !isOver(games.at(-1))) throw new OnlineError('invalid_response')
  return { id: data.id, code: data.code, side: data.side, status: data.status,
    revision: data.revision, moves: [...data.moves], games, opponent: data.opponent ? data.opponent.normalize('NFC').trim() : null }
}

// Players come from the server as opaque ids plus a server-assigned alias. Deska gives us no
// name or email, and the alias is rendered as text only, so accept a strict character set.
const PLAYER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u

const validName = (value) => {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : ''
  return !!name && [...name].length <= 24 && PLAYER_NAME.test(name)
}

const PERSON_STATUS = ['available', 'playing', 'offline']
const readPerson = (p) => {
  if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(p.id) || !validName(p.name) || !PERSON_STATUS.includes(p.status)) {
    throw new OnlineError('invalid_response')
  }
  return { id: p.id, name: p.name.normalize('NFC').trim(), status: p.status }
}
const arrayOf = (value, max) => {
  if (!Array.isArray(value) || value.length > max) throw new OnlineError('invalid_response')
  return value
}
const idOk = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)

/** The home screen: who you are, the game to resume, recent rivals, challenges received and sent. */
export function readHome(data) {
  if (!data || !data.me || !idOk(data.me.id) || typeof data.me.shared !== 'boolean' || !validName(data.me.alias) ||
      (data.me.name !== null && !validName(data.me.name)) || !Number.isSafeInteger(data.total) || data.total < 0) {
    throw new OnlineError('invalid_response')
  }
  let room = null
  if (data.room !== null && data.room !== undefined) {
    const r = data.room
    if (!idOk(r.id) || !/^[A-Z0-9]{6}$/.test(r.code) || !['waiting', 'active'].includes(r.status) || !['w', 'b'].includes(r.side) ||
        !['w', 'b'].includes(r.turn) || !Number.isSafeInteger(r.moves) || r.moves < 0 ||
        (r.opponent !== null && !validName(r.opponent))) throw new OnlineError('invalid_response')
    room = { id: r.id, code: r.code, status: r.status, side: r.side, turn: r.turn, moves: r.moves, opponent: r.opponent }
  }
  return {
    me: { id: data.me.id, name: data.me.name, alias: data.me.alias, shared: data.me.shared },
    room,
    recent: arrayOf(data.recent, 20).map(readPerson),
    incoming: arrayOf(data.incoming, 20).map((c) => {
      if (!c || !idOk(c.id) || !Number.isFinite(c.at)) throw new OnlineError('invalid_response')
      return { id: c.id, from: readPerson(c.from), at: c.at }
    }),
    outgoing: arrayOf(data.outgoing, 10).map((c) => {
      if (!c || !idOk(c.id) || !['pending', 'accepted', 'declined'].includes(c.state) || !Number.isFinite(c.at) ||
          (c.roomId !== null && !idOk(c.roomId)) || (c.state === 'accepted') !== (c.roomId !== null)) throw new OnlineError('invalid_response')
      return { id: c.id, to: readPerson(c.to), state: c.state, roomId: c.roomId, at: c.at }
    }),
    total: data.total,
  }
}

/** Search results: at most ten people. */
export function readPeople(data) {
  return { players: arrayOf(data?.players, 10).map(readPerson) }
}

export function readPresence(data) {
  if (!data || !Array.isArray(data.players) || data.players.length > 100 ||
      !Number.isSafeInteger(data.total) || data.total < data.players.length || data.total > 1000000) {
    throw new OnlineError('invalid_response')
  }
  const seen = new Set()
  let selves = 0
  const players = data.players.map((player) => {
    const name = typeof player?.name === 'string' ? player.name.normalize('NFC').trim() : ''
    if (!player || typeof player.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(player.id) || seen.has(player.id) ||
        !name || [...name].length > 24 || !PLAYER_NAME.test(name) ||
        !['available', 'playing'].includes(player.status) || typeof player.self !== 'boolean') {
      throw new OnlineError('invalid_response')
    }
    seen.add(player.id)
    if (player.self) selves++
    return { id: player.id, name, status: player.status, self: player.self }
  })
  if (selves > 1) throw new OnlineError('invalid_response')
  players.sort((a, b) => (b.self - a.self) || (a.status === b.status ? 0 : a.status === 'available' ? -1 : 1) ||
    a.name.localeCompare(b.name, 'es'))
  return { players, total: data.total }
}

export function createOnlineClient({ sdk, apiUrl, fetcher = globalThis.fetch, onChange = () => {} }) {
  const origin = apiUrl ? apiOrigin(apiUrl) : null
  let generation = 0
  let controller = null
  let state = { phase: origin ? 'signed-out' : 'unconfigured', busy: false, room: null, error: null }
  const publish = (patch) => { state = { ...state, ...patch }; onChange(state) }
  const reset = (error = null) => {
    generation++
    controller?.abort()
    publish({ phase: origin ? 'signed-out' : 'unconfigured', busy: false, room: null, error })
  }

  async function request(path, body, signal, activeGeneration) {
    if (!origin) throw new OnlineError('configuration')
    if (!sdk.account?.token) throw new OnlineError('sdk_unavailable')
    const credentials = await sdk.account.token()
    if (signal.aborted || activeGeneration !== generation) throw new OnlineError('cancelled')
    if (typeof credentials?.token !== 'string' || !credentials.token) throw new OnlineError('invalid_session')
    const response = await fetcher(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    })
    if (!response.ok) {
      let detail = null
      try { const body = await response.json(); if (typeof body?.error === 'string' && /^[a-z_]{1,40}$/.test(body.error)) detail = body.error } catch { /* no body */ }
      throw new OnlineError(({ 401: 'not_signed_in', 403: 'permission_denied',
        404: 'room_not_found', 409: 'conflict', 429: 'rate_limited' })[response.status] || 'server_error', detail)
    }
    try { return await response.json() } catch { throw new OnlineError('invalid_response') }
  }

  async function run(work) {
    if (state.busy) throw new OnlineError('busy')
    const activeGeneration = generation
    const operation = new AbortController()
    controller = operation
    // The SDK has no cancellation API. Stop waiting after 15 s and ignore late answers.
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { operation.abort(); reject(new OnlineError('timeout')) }, 15000)
    })
    publish({ busy: true, error: null })
    try {
      const result = await Promise.race([work(operation.signal, activeGeneration), timeout])
      if (activeGeneration !== generation) throw new OnlineError('cancelled')
      return result
    } catch (error) {
      if (activeGeneration !== generation) throw new OnlineError('cancelled')
      const known = ['configuration', 'sdk_unavailable', 'invalid_session', 'invalid_response', 'declined',
        'not_focused', 'not_signed_in', 'permission_denied', 'host_error', 'room_not_found', 'conflict',
        'rate_limited', 'server_error', 'timeout', 'cancelled']
      const code = known.includes(error?.code) ? error.code : 'network_error'
      console.warn('Chess online:', code) // Never log SDK responses, headers, tokens, or raw errors.
      if (['not_signed_in', 'permission_denied', 'invalid_session'].includes(code)) reset(code)
      else publish({ error: code, phase: state.room ? 'disconnected' : state.phase })
      throw new OnlineError(code, error?.detail ?? null)
    } finally {
      clearTimeout(timer)
      if (activeGeneration === generation) { controller = null; publish({ busy: false }) }
    }
  }

  const acceptRoom = (data, previous = state.room) => {
    const room = readRoom(data)
    if (previous && (room.id !== previous.id || room.side !== previous.side || room.code !== previous.code ||
      room.revision < previous.revision || room.moves.length < previous.moves.length ||
      previous.moves.some((move, index) => room.moves[index] !== move) ||
      (room.revision === previous.revision && (room.moves.length !== previous.moves.length || room.status !== previous.status)) ||
      (previous.status !== 'waiting' && room.status === 'waiting'))) throw new OnlineError('invalid_response')
    return room
  }

  async function session(interactive) {
    await run(async (signal, epoch) => {
      if (!origin) throw new OnlineError('configuration')
      if (!sdk.account?.signIn) throw new OnlineError('sdk_unavailable')
      if (interactive) await sdk.account.signIn({ name: true }) // From the click. The name is optional: Deska asks, the person ticks it or not.
      const data = await request('/session', {}, signal, epoch)
      if (!data || data.ok !== true) throw new OnlineError('invalid_response')
    })
    publish({ phase: 'ready' })
  }

  async function loadRoom(path, body, previous, expectedMove) {
    const room = await run(async (signal, epoch) => {
      const received = acceptRoom(await request(path, body, signal, epoch), previous)
      if (expectedMove && (received.revision <= previous.revision || received.moves[previous.moves.length] !== expectedMove)) {
        throw new OnlineError('invalid_response')
      }
      return received
    })
    publish({ room, phase: room.status })
    return room
  }

  // Calls that run beside room traffic (the heartbeat, the home screen, search, challenges). They
  // never set `busy`: a slow list must not lock the sign-in, create or join controls, and a stale
  // answer is dropped after sign-out. `parse` validates the answer before anything uses it.
  async function background(path, body, parse) {
    if (!origin) throw new OnlineError('configuration')
    if (!['ready', 'waiting', 'active', 'finished', 'disconnected'].includes(state.phase)) throw new OnlineError('not_signed_in')
    const activeGeneration = generation
    const operation = new AbortController()
    const timer = setTimeout(() => operation.abort(), 10000)
    try {
      const data = await request(path, body, operation.signal, activeGeneration)
      if (activeGeneration !== generation) throw new OnlineError('cancelled')
      return parse(data)
    } catch (error) {
      if (activeGeneration !== generation) throw new OnlineError('cancelled')
      const known = ['configuration', 'sdk_unavailable', 'invalid_session', 'invalid_response', 'declined',
        'not_focused', 'not_signed_in', 'permission_denied', 'host_error', 'rate_limited', 'server_error', 'cancelled',
        'room_not_found', 'conflict']
      const code = operation.signal.aborted ? 'timeout' : known.includes(error?.code) ? error.code : 'network_error'
      console.warn('Chess online background:', code)
      if (['not_signed_in', 'permission_denied', 'invalid_session'].includes(code)) reset(code)
      throw new OnlineError(code, error?.detail ?? null)
    } finally { clearTimeout(timer) }
  }

  const presence = () => background('/presence', {}, readPresence)
  const okOnly = (data) => { if (data?.ok !== true) throw new OnlineError('invalid_response'); return true }
  const personId = (id) => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new OnlineError('invalid_response'); return id }

  return {
    get state() { return state },
    presence,
    home: () => background('/home', {}, readHome),
    search: (query) => background('/players/search', { query: String(query).trim() }, readPeople),
    challenge: (to) => background('/challenges', { to: personId(to), requestId: crypto.randomUUID() }, (data) => {
      if (typeof data?.id !== 'string' || data.state !== 'pending') throw new OnlineError('invalid_response')
      return data
    }),
    decline: (id) => background(`/challenges/${personId(id)}/decline`, {}, okOnly),
    cancel: (id) => background(`/challenges/${personId(id)}/cancel`, {}, okOnly),
    // Accepting starts the game at once: the answer is the room, entered like any other.
    accept: (id) => loadRoom(`/challenges/${personId(id)}/accept`, {}, null),
    signIn: () => session(true),
    restore: () => session(false),
    create: () => loadRoom('/rooms', { requestId: crypto.randomUUID() }, null),
    join: (code) => loadRoom('/rooms/join', { code: roomCode(code), requestId: crypto.randomUUID() }, null),
    resume: (id) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new OnlineError('invalid_response')
      return loadRoom(`/rooms/${id}`, undefined, null)
    },
    refresh: () => {
      if (!state.room) throw new OnlineError('no_room')
      return loadRoom(`/rooms/${state.room.id}`, undefined, state.room)
    },
    move: (uci) => {
      const room = state.room
      if (!room || state.phase !== 'active' || room.games.at(-1).turn !== room.side ||
          !moveFromUci(room.games.at(-1), uci)) throw new OnlineError('invalid_move')
      return loadRoom(`/rooms/${room.id}/moves`, { uci, revision: room.revision, requestId: crypto.randomUUID() }, room, uci)
    },
    disconnect: () => reset(),
    revoke: () => reset('permission_denied'),
  }
}
