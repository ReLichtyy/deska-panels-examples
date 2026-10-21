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

export function mountOnline({ sdk, init, onRoom, onLocal, onLock, onNotice = () => {}, onState = () => {} }) {
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
  const message = (text) => { $('online-message').textContent = text }
  const stopPoll = () => { pollGeneration++; clearTimeout(timer); timer = null }
  const client = createOnlineClient({ sdk, apiUrl: onlineConfig.apiUrl, onChange: render })

  // The lobby list shows at most this many rows; the server already caps what it sends.
  const PRESENCE_ROWS = 20
  const PRESENCE_MS = 30000
  const STATUS_LABEL = { available: 'Libre', playing: 'En partida' }

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
    if (!visible || !presenceRunning) return
    const epoch = presenceEpoch
    presenceTimer = setTimeout(() => refreshPresence(epoch), PRESENCE_MS)
  }

  async function refreshPresence(epoch = presenceEpoch) {
    if (!presenceRunning || epoch !== presenceEpoch || presenceInFlight === epoch) return
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
    if (signedIn && !presenceRunning) { presenceRunning = true; refreshPresence() }
    else if (!signedIn && presenceRunning) stopPresence()
    $('online-presence').hidden = !signedIn || !!state.room
    $('online-signin').hidden = signedIn
    $('online-signin').disabled = state.busy || !onlineConfig.apiUrl
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
    onLock(state.busy || state.phase !== 'active', !state.busy && state.phase !== 'active')
    if (state.error) message(MESSAGES[state.error] || 'No se pudo completar la operación.')
    else if (state.busy) message('Conectando…')
    else if (!onlineConfig.apiUrl) message(MESSAGES.configuration)
    else if (state.phase === 'signed-out') message('Usa tu cuenta de Deska para jugar con otra persona. No pedimos tu nombre ni tu correo.')
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

  function poll() {
    clearTimeout(timer)
    if (!visible || !['waiting', 'active'].includes(client.state.phase)) return
    const epoch = pollGeneration
    timer = setTimeout(async () => {
      if (client.state.busy) { poll(); return }
      const ok = await execute(async () => {
        const room = await client.refresh()
        // Visibility controls timers, not delivery of a confirmed snapshot.
        // The client cancels stale sessions itself when leaving/revoking access.
        await accept(room)
      }, { notify: true })
      if (ok && epoch === pollGeneration) poll()
    }, 5000)
  }

  const enter = (action, options) => execute(async () => { stopPoll(); await accept(await action()); poll() }, options)
  $('online-signin').addEventListener('click', () => { interacted = true; execute(() => client.signIn()) })
  $('online-create').addEventListener('click', () => enter(() => client.create()))
  $('online-join-form').addEventListener('submit', (event) => { event.preventDefault(); enter(() => client.join($('online-code').value)) })
  $('online-resume').addEventListener('click', () => enter(() => client.resume(lastRoom)))
  $('online-retry').addEventListener('click', () => enter(() => client.refresh()))
  const returnLocal = () => {
    interacted = true
    stopPoll(); client.disconnect(); applied = null; onLocal()
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
  })
  sdk.on('visibility', (state) => {
    visible = state.visible; stopPoll(); if (visible) poll()
    if (visible) refreshPresence(); else { clearTimeout(presenceTimer); presenceTimer = null }
  })
  // Opening the sheet shows a fresh list instead of waiting for the next heartbeat.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (!$('online-sheet').hidden && Date.now() - presenceAt > 5000) refreshPresence()
    }).observe($('online-sheet'), { attributes: true, attributeFilter: ['hidden'] })
  }

  render(client.state)
  async function restore() {
    try {
      const saved = await sdk.storage.get('online-room')
      if (interacted) return
      lastRoom = typeof saved === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(saved) ? saved : null
    } catch (error) {
      console.warn('Chess online: recovery unavailable', error.code || 'storage_error')
      message('No se pudo recuperar el acceso a tu última sala. Puedes unirte con su código.')
    }
    if (!interacted && client.state.phase === 'signed-out' && onlineConfig.apiUrl && init.permissions.includes('account')) await execute(() => client.restore())
    render(client.state)
  }
  restore()
  return {
    // For the home screen: the same client, so one session serves every screen.
    client,
    toLocal: returnLocal,
    signIn: () => { interacted = true; return client.signIn() },
    restore: () => execute(() => client.restore()),
    resume: (id) => enter(() => client.resume(id)),
    accept: (id) => enter(() => client.accept(id)),
    get roomId() { return client.state.room?.id || null },
    get lastError() { return lastError },
    move: (uci) => enter(() => client.move(uci), { notify: true }),
    get state() {
      return { phase: client.state.phase, busy: client.state.busy, room: client.state.room?.code || null,
        presence: { status: presence.status, total: presence.total,
          players: presence.players.map(({ name, status, self }) => ({ name, status, self })) } }
    },
  }
}
