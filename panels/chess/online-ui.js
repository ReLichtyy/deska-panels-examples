import { createOnlineClient } from './online-client.js'
import { onlineConfig } from './online-config.js'

const MESSAGES = {
  configuration: 'El modo online estará disponible cuando se conecte el servidor de partidas.',
  sdk_unavailable: 'Esta vista no admite el acceso con Deska. Usa una versión compatible y carga la carpeta del panel.',
  declined: 'Acceso cancelado. Puedes continuar jugando en local.',
  not_focused: 'Haz clic en el panel y vuelve a entrar.',
  not_signed_in: 'Inicia sesión en Deska y vuelve a entrar aquí.',
  permission_denied: 'Deska no autorizó el acceso. Revisa los permisos de este panel.',
  invalid_session: 'La sesión no es válida. Vuelve a entrar con Deska.',
  host_error: 'Deska no pudo completar el acceso. Inténtalo de nuevo.',
  invalid_code: 'Escribe los seis caracteres del código de sala.',
  room_not_found: 'No se encontró la sala o ya no tienes acceso a ella.',
  conflict: 'La sala cambió. Pulsa Reconectar para obtener la última posición.',
  rate_limited: 'Demasiadas peticiones. Espera un minuto antes de reconectar.',
  timeout: 'La petición tardó demasiado. Reconecta para comprobar si se completó.',
  network_error: 'Se perdió la conexión. Reconecta antes de seguir jugando.',
  server_error: 'El servidor no pudo completar la petición. Inténtalo más tarde.',
  invalid_response: 'El servidor envió una partida incompatible. Se ha detenido la sincronización.',
  invalid_move: 'Espera tu turno y elige una jugada legal.',
  busy: 'Espera a que termine la sincronización.',
}

export function mountOnline({ sdk, init, onRoom, onLocal, onLock, onNotice = () => {}, onState = () => {}, onConnection = () => {} }) {
  const $ = (id) => document.getElementById(id)
  let timer = null
  let visible = init.visibility?.visible !== false
  let lastRoom = null
  let applied = null
  let pollGeneration = 0
  let interacted = false
  let presence = { status: 'idle', players: [], total: 0 }
  let presenceTimer = null
  let presenceRunning = false
  let presenceEpoch = 0
  let presenceInFlight = -1
  let presenceAt = 0
  let lockKey = '' // what the board last heard through onLock
  // The way in is automatic. connection.state: unconfigured | connecting | waiting (a countdown to
  // the next attempt) | offline (the attempts ran out) | blocked (Deska refused; only a click can ask
  // again) | connected.
  let connection = { state: onlineConfig.apiUrl ? 'connecting' : 'unconfigured', attempt: 0, retryAt: 0, reason: null }
  let connectTimer = null
  let countdownTimer = null
  const message = (text) => { $('online-message').textContent = text }
  const stopPoll = () => { pollGeneration++; clearTimeout(timer); timer = null }
  const client = createOnlineClient({ sdk, apiUrl: onlineConfig.apiUrl, onChange: render })

  // The lobby list shows at most this many rows; the server already caps what it sends.
  const PRESENCE_ROWS = 20
  const PRESENCE_MS = 30000
  const STATUS_LABEL = { available: 'Libre', playing: 'En partida' }

  // Room sync: often while the rival is to move, easing off while nothing happens; less often on
  // your own turn, when only a lost connection can change anything; steadily while waiting for a rival.
  // Reaching the service: three attempts, 15 s and then 30 s apart, then offline until the person asks again.
  const CONNECT_ATTEMPTS = 3
  const CONNECT_WAIT_MS = [15000, 30000]
  const CONNECT_TRANSIENT = ['network_error', 'timeout', 'server_error', 'rate_limited']
  // Refusals that only Deska's own sign-in sheet can undo, and that sheet opens only from a click.
  const CONNECT_CONSENT = ['declined', 'not_signed_in', 'permission_denied', 'invalid_session', 'not_focused']
  const CONNECT_REASONS = {
    declined: 'Cancelaste el acceso. Pulsa Conectar cuando quieras jugar online.',
    not_signed_in: 'Inicia sesión en Deska y pulsa Conectar.',
    permission_denied: 'Deska no dio acceso a este panel. Pulsa Conectar para pedirlo.',
    invalid_session: 'La sesión de Deska caducó. Pulsa Conectar.',
    not_focused: 'Haz clic en el panel y pulsa Conectar.',
    sdk_unavailable: MESSAGES.sdk_unavailable,
  }
  const POLL_WAITING_MS = 3000
  const POLL_RIVAL_MS = 1500
  const POLL_RIVAL_MAX_MS = 5000
  const POLL_RIVAL_GROWTH = 1.3
  const POLL_MINE_MS = 6000
  let rivalDelay = POLL_RIVAL_MS

  // /presence is also the heartbeat that shows you as connected, so it runs while signed in and
  // visible, sheet open or not. In a room it stops: the server counts each room sync as a beat.
  const sheetOpen = () => !$('online-sheet').hidden
  const inRoom = () => !!client.state.room && ['waiting', 'active'].includes(client.state.phase)
  const wantPresence = () => presenceRunning && visible && !inRoom()

  function renderPresence() {
    const list = $('presence-list')
    const loading = presence.status === 'loading'
    const rows = presence.players.slice(0, PRESENCE_ROWS).map((player) => {
      const row = document.createElement('li')
      row.className = 'presence-row'
      row.dataset.status = player.status
      const avatar = document.createElement('span')
      avatar.className = 'presence-avatar'
      avatar.setAttribute('aria-hidden', 'true')
      avatar.textContent = [...player.name][0].toLocaleUpperCase('es')
      const name = document.createElement('span')
      name.className = 'presence-name'
      name.textContent = player.name
      if (player.self) {
        const self = document.createElement('span')
        self.className = 'presence-self'
        self.textContent = ' (tú)'
        name.append(self)
      }
      const status = document.createElement('span')
      status.className = 'presence-status'
      status.textContent = STATUS_LABEL[player.status]
      row.append(avatar, name, status)
      return row
    })
    if (loading) {
      for (let i = 0; i < 3; i++) {
        const row = document.createElement('li')
        row.className = 'presence-row is-skeleton'
        row.setAttribute('aria-hidden', 'true')
        row.append(document.createElement('span'), document.createElement('span'))
        rows.push(row)
      }
    }
    list.replaceChildren(...rows)
    list.setAttribute('aria-busy', String(loading))
    const total = presence.total
    $('presence-count').textContent = presence.status === 'idle' || loading ? '' : `${total} ${total === 1 ? 'conectado' : 'conectados'}`
    const others = presence.players.filter((player) => !player.self).length
    $('presence-note').textContent = presence.status === 'error'
      ? (presence.players.length ? 'No se pudo actualizar la lista. Se muestra la última recibida.' : 'No se pudo cargar la lista de jugadores.')
      : presence.status === 'ready' && !others ? 'Ahora mismo no hay nadie más. Crea una sala y comparte el código.'
      : presence.status === 'ready' && total > rows.length ? `Mostrando ${rows.length} de ${total}.` : ''
  }

  function stopPresence() {
    presenceEpoch++
    clearTimeout(presenceTimer)
    presenceTimer = null
    presenceRunning = false
    presence = { status: 'idle', players: [], total: 0 }
    renderPresence()
  }

  function schedulePresence() {
    clearTimeout(presenceTimer)
    presenceTimer = null
    if (!wantPresence()) return
    const epoch = presenceEpoch
    presenceTimer = setTimeout(() => refreshPresence(epoch), PRESENCE_MS)
  }

  async function refreshPresence(epoch = presenceEpoch) {
    if (!wantPresence() || epoch !== presenceEpoch || presenceInFlight === epoch) return
    presenceInFlight = epoch
    if (presence.status === 'idle') { presence = { ...presence, status: 'loading' }; renderPresence() }
    try {
      const data = await client.presence()
      if (epoch !== presenceEpoch) return
      presence = { status: 'ready', ...data }
      presenceAt = Date.now()
    } catch (error) {
      if (error.code === 'cancelled' || epoch !== presenceEpoch) return
      presence = { ...presence, status: 'error' }
    } finally {
      if (presenceInFlight === epoch) presenceInFlight = -1
    }
    renderPresence()
    schedulePresence()
  }

  function render(state) {
    onState(state)
    const signedIn = ['ready', 'waiting', 'active', 'finished', 'disconnected'].includes(state.phase)
    if (signedIn && connection.state !== 'connected') setConnection({ state: 'connected', attempt: 0, retryAt: 0, reason: null })
    if (signedIn && !presenceRunning) { presenceRunning = true; refreshPresence() }
    else if (!signedIn && presenceRunning) stopPresence()
    // Out of a room again (finished, disconnected): the heartbeat takes over from the room sync.
    else if (wantPresence() && !presenceTimer && presenceInFlight === -1) schedulePresence()
    $('online-presence').hidden = !signedIn || !!state.room
    $('online-rooms').hidden = !signedIn || !!state.room
    $('online-room').hidden = !state.room
    $('online-resume').hidden = !signedIn || !!state.room || !lastRoom
    for (const id of ['online-create', 'online-join', 'online-code', 'online-resume', 'online-retry']) $(id).disabled = state.busy
    $('online-retry').hidden = !state.room || state.phase !== 'disconnected'
    $('online-sheet').setAttribute('aria-busy', String(state.busy))
    $('online-label').textContent = state.room ? `Sala ${state.room.code}` : 'Online'
    $('online-code-display').textContent = state.room?.code || ''
    $('online-room-status').textContent = state.room
      ? `${state.room.side === 'w' ? 'Juegas con blancas' : 'Juegas con negras'} · ${state.phase === 'waiting' ? 'Esperando rival' : state.phase === 'finished' ? 'Partida terminada' : state.phase === 'disconnected' ? 'Sin conexión' : 'Partida en curso'}` : ''
    // The board repaints and retitles on onLock, so it hears only what changes its text or its lock.
    const locked = state.busy || state.phase !== 'active'
    const clear = !state.busy && state.phase !== 'active'
    const key = `${locked}|${clear}|${state.phase}|${state.busy}`
    if (key !== lockKey) { lockKey = key; onLock(locked, clear) }
    // Signed out, the connection block says what is going on; the message line stays for the rest.
    if (!onlineConfig.apiUrl) message(MESSAGES.configuration)
    else if (state.phase === 'signed-out') message('')
    else if (state.error) message(MESSAGES[state.error] || 'No se pudo completar la operación.')
    else if (state.busy) message('Conectando…')
    else if (state.phase === 'waiting') message('Comparte el código con tu rival para que se una desde su panel.')
    else message('')
  }

  // `notify` also shows the failure over the board, for actions taken with the sheet closed:
  // moves and the background sync.
  let lastError = null // the error of the last failed action, for screens that explain it themselves
  async function execute(action, { notify = false } = {}) {
    lastError = null
    try { await action(); return true } catch (error) {
      lastError = error
      if (error.code !== 'cancelled') {
        console.warn('Chess online action:', error.code || 'unexpected')
        const text = MESSAGES[error.code] || 'No se pudo completar la operación.'
        message(text)
        if (notify) onNotice(text, 'error')
      }
      return false
    }
  }

  async function accept(room) {
    if (applied !== `${room.id}:${room.revision}`) {
      applied = `${room.id}:${room.revision}`
      onRoom(room)
    }
    if (lastRoom !== room.id) {
      lastRoom = room.id
      try { await sdk.storage.set('online-room', room.id) } catch (error) {
        console.warn('Chess online: room recovery storage failed', error.code || 'storage_error')
        message('La partida está conectada, pero no se pudo guardar el acceso para recuperarla al abrir el panel.')
      }
    }
  }

  function pollDelay() {
    const { phase, room } = client.state
    if (phase === 'waiting') return POLL_WAITING_MS
    return room && room.games.at(-1).turn !== room.side ? rivalDelay : POLL_MINE_MS
  }

  function poll(delay = pollDelay()) {
    clearTimeout(timer)
    if (!visible || !['waiting', 'active'].includes(client.state.phase)) return
    const epoch = pollGeneration
    timer = setTimeout(async () => {
      let room = null
      const ok = await execute(async () => {
        // Visibility controls timers, not delivery of a confirmed snapshot.
        // The client cancels stale sessions itself when leaving/revoking access.
        room = await client.sync()
        if (room) await accept(room)
      }, { notify: true })
      // An action took the lane: it schedules the next sync itself. A real failure stops here,
      // with the room disconnected and Reconectar offered, as before.
      if (!ok || epoch !== pollGeneration) return
      rivalDelay = room ? POLL_RIVAL_MS : Math.min(POLL_RIVAL_MAX_MS, rivalDelay * POLL_RIVAL_GROWTH)
      poll()
    }, delay)
  }

  const enter = (action, options) => execute(async () => {
    stopPoll()
    await accept(await action())
    rivalDelay = POLL_RIVAL_MS // after your move, the answer is what you wait for
    poll()
  }, options)
  for (const id of ['home-connect', 'online-connect']) {
    $(id)?.querySelector('.connect-retry').addEventListener('click', () => connect({ manual: true }))
  }
  $('online-create').addEventListener('click', () => enter(() => client.create()))
  $('online-join-form').addEventListener('submit', (event) => { event.preventDefault(); enter(() => client.join($('online-code').value)) })
  $('online-resume').addEventListener('click', () => enter(() => client.resume(lastRoom)))
  $('online-retry').addEventListener('click', () => enter(() => client.refresh()))
  // Leaving the room drops the session with it; the way back in is automatic, as on entry.
  const returnLocal = () => {
    interacted = true
    stopPoll(); client.disconnect(); applied = null; onLocal()
    reconnect()
  }
  $('online-local').addEventListener('click', returnLocal)
  $('result-local').addEventListener('click', returnLocal)
  sdk.on('account', ({ signedIn }) => {
    // Deska also emits true after successful consent. It must not cancel signIn().
    if (signedIn) return
    interacted = true
    stopPoll()
    client.revoke()
    applied = null
    // Signed out in Deska: no automatic attempts; Conectar asks again.
    setConnection({ state: 'blocked', attempt: 0, retryAt: 0, reason: 'not_signed_in' })
  })
  sdk.on('visibility', (state) => {
    // Coming back, the room is checked at once: the rival may have moved while the panel was hidden.
    visible = state.visible; stopPoll(); if (visible) poll(0)
    // Hidden, the countdown and the next attempt wait; back, a due attempt runs at once.
    if (visible) connectLater(); else { clearTimeout(connectTimer); connectTimer = null }
    setConnection({})
    if (visible) refreshPresence(); else { clearTimeout(presenceTimer); presenceTimer = null }
  })
  // Opening the sheet shows a fresh list instead of waiting for the next heartbeat.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (sheetOpen() && Date.now() - presenceAt > 5000) refreshPresence()
    }).observe($('online-sheet'), { attributes: true, attributeFilter: ['hidden'] })
  }

  render(client.state)
  // Connection -----------------------------------------------------------------------------------
  //
  // Shown where the people would be (the home's Online section and the online sheet): connecting,
  // a countdown to the next attempt, or offline with a button once the attempts ran out.

  function setConnection(patch) {
    connection = { ...connection, ...patch }
    clearInterval(countdownTimer)
    countdownTimer = null
    // The countdown ticks once a second, only while it is on screen.
    if (connection.state === 'waiting' && visible) countdownTimer = setInterval(paintConnection, 1000)
    paintConnection()
    onConnection(connection)
  }

  function paintConnection() {
    const c = connection
    const left = Math.max(0, Math.ceil((c.retryAt - Date.now()) / 1000))
    const title = c.state === 'connecting' ? 'Conectando…' : c.state === 'blocked' ? 'Sin conectar' : 'Sin conexión con el servidor'
    const sub = c.state === 'connecting' ? (c.attempt > 1 ? `Intento ${c.attempt} de ${CONNECT_ATTEMPTS}` : 'Entrando con tu cuenta de Deska')
      : c.state === 'waiting' ? `Nuevo intento en ${left} s · ${c.attempt + 1} de ${CONNECT_ATTEMPTS}`
      : c.state === 'offline' ? `No respondió en ${CONNECT_ATTEMPTS} intentos. Puedes jugar en local mientras tanto.`
      : CONNECT_REASONS[c.reason] || MESSAGES[c.reason] || 'No se pudo entrar. Pulsa Conectar para volver a intentarlo.'
    for (const id of ['home-connect', 'online-connect']) {
      const box = $(id)
      if (!box) continue
      box.hidden = c.state === 'connected' || c.state === 'unconfigured'
      box.dataset.state = c.state
      box.querySelector('.connect-title').textContent = title
      box.querySelector('.connect-sub').textContent = sub
      const retry = box.querySelector('.connect-retry')
      retry.hidden = c.state !== 'offline' && c.state !== 'blocked'
      retry.textContent = c.state === 'blocked' ? 'Conectar' : 'Reintentar'
    }
  }

  function connectLater() {
    clearTimeout(connectTimer)
    connectTimer = null
    if (connection.state === 'waiting' && visible) connectTimer = setTimeout(() => connect(), Math.max(0, connection.retryAt - Date.now()))
  }

  // `manual` is the button: a fresh round of attempts and, when Deska refused, its sign-in sheet.
  async function connect({ manual = false } = {}) {
    clearTimeout(connectTimer)
    connectTimer = null
    if (!onlineConfig.apiUrl || connection.state === 'connecting' && connection.attempt && !manual) return
    if (client.state.phase !== 'signed-out') return setConnection({ state: 'connected', attempt: 0, retryAt: 0, reason: null })
    if (client.state.busy) { connectTimer = setTimeout(() => connect({ manual }), 500); return }
    const attempt = (manual ? 0 : connection.attempt) + 1
    const consent = manual && CONNECT_CONSENT.includes(connection.reason)
    setConnection({ state: 'connecting', attempt, retryAt: 0 })
    let code = null
    try { await (consent ? client.signIn() : client.restore()) } catch (error) { code = error?.code || 'network_error' }
    if (code === 'cancelled') return // signed out or left meanwhile; that path set the state
    if (!code) return setConnection({ state: 'connected', attempt: 0, reason: null })
    if (!CONNECT_TRANSIENT.includes(code)) return setConnection({ state: 'blocked', reason: code }) // refused, not unreachable
    if (attempt >= CONNECT_ATTEMPTS) return setConnection({ state: 'offline', reason: code })
    setConnection({ state: 'waiting', reason: code, retryAt: Date.now() + CONNECT_WAIT_MS[attempt - 1] })
    connectLater()
  }

  // A fresh, quiet round: after leaving a room, or when the app asks.
  function reconnect() {
    if (connection.state === 'connecting' || client.state.phase !== 'signed-out') return
    connection = { ...connection, attempt: 0 }
    connect()
  }

  async function restore() {
    // Getting in does not wait for the saved room: that only feeds the Recuperar button.
    if (client.state.phase === 'signed-out' && onlineConfig.apiUrl) connect()
    try {
      const saved = await sdk.storage.get('online-room')
      if (interacted) return
      lastRoom = typeof saved === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(saved) ? saved : null
    } catch (error) {
      console.warn('Chess online: recovery unavailable', error.code || 'storage_error')
      message('No se pudo recuperar el acceso a tu última sala. Puedes unirte con su código.')
    }
    render(client.state)
  }
  paintConnection()
  restore()
  return {
    // For the home screen: the same client, so one session serves every screen.
    client,
    toLocal: returnLocal,
    signIn: () => { interacted = true; return client.signIn() },
    restore: () => reconnect(),
    get connection() { return { ...connection } },
    resume: (id) => enter(() => client.resume(id)),
    accept: (id) => enter(() => client.accept(id)),
    get roomId() { return client.state.room?.id || null },
    get lastError() { return lastError },
    move: (uci) => enter(() => client.move(uci), { notify: true }),
    get state() {
      return { phase: client.state.phase, busy: client.state.busy, room: client.state.room?.code || null,
        connection: { state: connection.state, attempt: connection.attempt, reason: connection.reason },
        presence: { status: presence.status, total: presence.total,
          players: presence.players.map(({ name, status, self }) => ({ name, status, self })) } }
    },
  }
}
