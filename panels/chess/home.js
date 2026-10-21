// The home screen, shown every time the panel opens: continue a game, start one against the bot,
// and play people. The people part needs the online service; without it the rest still works.
//
// Names come from the server as plain text and are only ever put on the page with textContent.

import { drawMini } from './board.js'

const REFRESH_MS = 10000
const SEARCH_DELAY_MS = 400
const STATUS = { available: 'Conectado', playing: 'En partida', offline: 'Desconectado' }

// What went wrong, in words, from the error code and the server's own reason.
function explain(error) {
  const reasons = {
    active_room: 'Ya tienes una partida en curso. Continúala o termínala primero.',
    opponent_busy: 'Esa persona está en otra partida ahora mismo. Inténtalo luego.',
    player_not_found: 'Esa persona ya no está disponible.',
    challenge_not_found: 'Ese reto ya no existe.',
    too_many_pending: 'Hay demasiados retos pendientes. Espera a que respondan o cancela alguno.',
    bad_query: 'Escribe al menos tres letras del nombre.',
    self: 'No puedes retarte a ti mismo.',
  }
  if (error?.detail && reasons[error.detail]) return reasons[error.detail]
  return ({
    declined: 'Cancelaste el permiso. Puedes volver a intentarlo cuando quieras.',
    not_focused: 'Haz clic en el panel y vuelve a intentarlo.',
    not_signed_in: 'Inicia sesión en Deska y vuelve a entrar aquí.',
    permission_denied: 'Deska no autorizó el acceso. Revisa los permisos de este panel.',
    rate_limited: 'Demasiadas peticiones. Espera un minuto.',
    timeout: 'La petición tardó demasiado. Inténtalo de nuevo.',
    network_error: 'Se perdió la conexión. Inténtalo de nuevo.',
    server_error: 'El servidor no pudo completar la petición. Inténtalo más tarde.',
    invalid_response: 'El servidor envió algo que no se entiende. Se ha detenido.',
    conflict: 'No se pudo completar: algo cambió. Actualiza e inténtalo de nuevo.',
    room_not_found: 'No se encontró. Puede que ya no exista.',
  })[error?.code] || 'No se pudo completar la operación.'
}

const SVG = 'http://www.w3.org/2000/svg'
function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

// The bot's level as a number and a word: what 1200 means is not obvious to everyone.
function levelText(rating) {
  const word = rating < 700 ? 'Principiante' : rating < 1100 ? 'Casual' : rating < 1500 ? 'De club' : rating < 1800 ? 'Fuerte' : 'Experto'
  return `${rating} · ${word}`
}

const make = (tag, props = {}, ...children) => {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key in el && typeof value !== 'string') el[key] = value
    else el.setAttribute(key, value)
  }
  el.append(...children.filter(Boolean))
  return el
}

/**
 * app:       the #app element (everything else in it is made inert while the home is open).
 * online:    what mountOnline returns (client, signIn, resume, accept, toLocal, lastError).
 * configured: whether an online service is configured.
 * local:     () => { game, side, title, sub } | null, the local game that can be continued.
 * look:      () => { palette: { dark, light } } for the little boards.
 * actions:   { continueLocal, startBot, startTwo, openCode, hasGame, afterEnter }.
 */
export function mountHome({ sdk, app, online, configured, local, look, actions, settings }) {
  const $ = (id) => document.getElementById(id)
  const root = $('home')
  const state = { open: false, data: null, status: 'idle', note: '', busy: null, results: null, searching: false, signedIn: false }
  let timer = null
  let searchTimer = null
  let epoch = 0
  let visible = true
  let searchSeq = 0

  let noteTimer = null
  // A message about the last action; it clears itself so it never describes a situation that has passed.
  const note = (text) => {
    clearTimeout(noteTimer)
    state.note = text
    $('home-note').textContent = text
    if (text) noteTimer = setTimeout(() => note(''), 9000)
  }

  // The rest of the panel cannot be reached while the home is open. Only what was reachable is made
  // inert, so the things that were already inert (the closed drawer) stay that way when it closes.
  let covered = []
  function setInert(on) {
    if (on) {
      covered = [...app.children].filter((el) => el !== root && !el.inert)
      for (const el of covered) el.inert = true
    } else {
      for (const el of covered) el.inert = false
      covered = []
    }
  }

  // Lists ------------------------------------------------------------------------------------------

  // A person is a circle with their initial; a small mark on it says whether they are connected.
  const initial = (name) => [...name][0].toLocaleUpperCase('es')
  function avatar(person) {
    return make('span', { class: 'avatar', 'data-status': person.status, 'aria-hidden': 'true', text: initial(person.name) })
  }

  function personRow(person, buttons, subtitle) {
    return make('li', { class: 'home-row' },
      avatar(person),
      make('span', { class: 'home-row-text' },
        make('span', { class: 'home-row-title', text: person.name }),
        make('span', { class: 'home-row-sub', text: subtitle || STATUS[person.status] })),
      make('span', { class: 'home-row-actions' }, ...buttons))
  }

  function action(label, handler, { primary = false, pill = false, id = null, aria = null } = {}) {
    const button = make('button', { class: primary ? 'primary' : pill ? 'pill' : 'quiet', type: 'button', text: label })
    if (aria) button.setAttribute('aria-label', aria)
    button.disabled = state.busy !== null
    button.addEventListener('click', () => handler(button))
    if (id) button.dataset.id = id
    return button
  }

  const pendingTo = (id) => state.data?.outgoing.find((c) => c.to.id === id && c.state === 'pending')

  function challengeButton(person) {
    if (pendingTo(person.id)) {
      const sent = make('span', { class: 'home-row-sub', text: 'Reto enviado' })
      return sent
    }
    return action('Retar', () => challenge(person), { pill: true, aria: `Retar a ${person.name}` })
  }

  function renderContinue() {
    const list = $('home-continue-list')
    const rows = []
    const snapshot = local()
    if (snapshot) {
      const canvas = make('canvas', { class: 'home-mini', 'aria-hidden': 'true' })
      drawMini(canvas, snapshot.game, snapshot.side === 'b', look().palette)
      const button = make('button', { class: 'home-row home-continue', type: 'button' }, canvas,
        make('span', { class: 'home-row-text' },
          make('span', { class: 'home-row-title', text: snapshot.title }),
          make('span', { class: 'home-row-sub', text: snapshot.sub })),
        make('span', { class: 'home-go', text: 'Continuar', 'aria-hidden': 'true' }))
      button.addEventListener('click', () => { actions.continueLocal(); close(true) })
      rows.push(make('li', {}, button))
    }
    const room = state.data?.room
    if (room) {
      const waiting = room.status === 'waiting'
      const title = waiting ? `Sala ${room.code}` : `Contra ${room.opponent || 'rival'}`
      const sub = waiting ? 'Esperando rival' : `Online · Jugada ${Math.floor(room.moves / 2) + 1} · ${room.turn === room.side ? 'Tu turno' : 'Turno del rival'}`
      const button = make('button', { class: 'home-row home-continue', type: 'button' },
        make('span', { class: 'home-mini home-mini-online', 'aria-hidden': 'true' }, icon('user-circle')),
        make('span', { class: 'home-row-text' },
          make('span', { class: 'home-row-title', text: title }),
          make('span', { class: 'home-row-sub', text: sub })),
        make('span', { class: 'home-go', text: waiting ? 'Abrir' : 'Continuar', 'aria-hidden': 'true' }))
      button.addEventListener('click', () => enter(() => online.resume(room.id)))
      rows.push(make('li', {}, button))
    }
    list.replaceChildren(...rows)
    $('home-continue').hidden = rows.length === 0
  }

  function renderChallenges() {
    const data = state.data
    const incoming = (data?.incoming || []).map((c) => personRow(c.from, [
      action('Aceptar', () => accept(c), { primary: true, aria: `Aceptar el reto de ${c.from.name}` }),
      action('Rechazar', () => answer('decline', c), { aria: `Rechazar el reto de ${c.from.name}` }),
    ], 'Te retó'))
    const sent = (data?.outgoing || []).map((c) => {
      if (c.state === 'pending') {
        return personRow(c.to, [action('Cancelar', () => answer('cancel', c), { aria: `Cancelar el reto a ${c.to.name}` })], 'Esperando respuesta')
      }
      if (c.state === 'accepted') {
        return personRow(c.to, [action('Jugar', () => enter(() => online.resume(c.roomId)), { primary: true, aria: `Jugar con ${c.to.name}` })], 'Aceptó tu reto')
      }
      return personRow(c.to, [action('Quitar', () => answer('cancel', c), { aria: `Quitar el aviso de ${c.to.name}` })], 'Rechazó tu reto')
    })
    $('home-challenges-list').replaceChildren(...incoming, ...sent)
    $('home-challenges').hidden = incoming.length + sent.length === 0
  }

  function renderPeople() {
    const configuredNow = configured
    const signedIn = state.signedIn
    $('home-people-intro').hidden = signedIn
    $('home-signin').hidden = signedIn
    $('home-online').hidden = !signedIn
    if (!signedIn) {
      $('home-people-intro').textContent = configuredNow
        ? 'Juega con otras personas de Deska. Deska te pregunta si quieres compartir tu nombre; solo lo verán quienes usen Chess.'
        : 'Podrás jugar con otras personas cuando se conecte el servidor de partidas.'
      return
    }
    const me = state.data?.me
    $('home-unshared').hidden = !me || me.shared
    if (me && !me.shared) $('home-me').textContent = `Estás como ${me.alias}. Nadie puede buscarte por nombre.`
    const recent = (state.data?.recent || []).map((p) => personRow(p, [challengeButton(p)]))
    $('home-recent').replaceChildren(...recent)
    $('home-recent-title').hidden = recent.length === 0
    $('home-recent-empty').hidden = recent.length > 0 || state.status === 'loading' || (state.results?.length > 0)
    const results = state.results
    $('home-results').replaceChildren(...(results || []).map((p) => personRow(p, [challengeButton(p)])))
    $('home-search-note').textContent = state.searching ? 'Buscando…'
      : results && !results.length ? 'Nadie con ese nombre. Solo aparecen personas que compartieron su nombre.' : ''
  }

  function render() {
    $('home-close').hidden = !actions.hasGame()
    $('home-level').value = String(settings().botRating)
    $('home-level-output').value = levelText(settings().botRating)
    const me = state.signedIn ? state.data?.me : null
    $('home-who').hidden = !me
    if (me) {
      const name = me.name || me.alias
      $('home-who-name').textContent = name
      $('home-who-avatar').textContent = initial(name)
    }
    renderChallenges()
    renderContinue()
    renderPeople()
    const busy = state.busy !== null
    for (const id of ['home-close', 'home-code', 'home-share']) $(id).disabled = busy
    $('home-signin').disabled = busy || !configured
  }

  // Data -------------------------------------------------------------------------------------------

  async function refresh() {
    if (!state.open || !state.signedIn) { render(); return }
    const mine = ++epoch
    clearTimeout(timer)
    if (!state.data) state.status = 'loading'
    render()
    try {
      const data = await online.client.home()
      if (mine !== epoch) return
      state.data = data
      state.status = 'ready'
    } catch (error) {
      if (mine !== epoch || error.code === 'cancelled') return
      state.status = 'error'
      note(explain(error))
    }
    render()
    schedule()
  }

  function schedule() {
    clearTimeout(timer)
    if (state.open && visible && state.signedIn) timer = setTimeout(refresh, REFRESH_MS)
  }

  // Doing things ----------------------------------------------------------------------------------

  // One action at a time; the page says what happened, in words, at the top.
  async function run(work, done) {
    if (state.busy !== null) return
    state.busy = true
    note('')
    render()
    try { const result = await work(); if (done) done(result) } catch (error) {
      if (error.code !== 'cancelled') note(explain(error))
    } finally {
      state.busy = null
      await refresh()
    }
  }

  const enter = (start) => run(async () => {
    if (!(await start())) throw online.lastError || new Error('failed')
  }, () => close(true))

  const accept = (challengeRow) => enter(() => online.accept(challengeRow.id))

  const answer = (kind, challengeRow) => run(() => online.client[kind](challengeRow.id))

  const challenge = (person) => run(() => online.client.challenge(person.id), () => {
    note(person.status === 'offline'
      ? `Reto enviado a ${person.name}. Lo verá cuando abra Chess y queda pendiente 24 horas.`
      : `Reto enviado a ${person.name}.`)
  })

  async function search() {
    const query = $('home-search').value.trim()
    const mine = ++searchSeq
    clearTimeout(searchTimer)
    if ([...query].length < 3) { state.results = null; state.searching = false; renderPeople(); return }
    state.searching = true
    renderPeople()
    try {
      const found = await online.client.search(query)
      if (mine !== searchSeq) return
      state.results = found.players
    } catch (error) {
      if (mine !== searchSeq || error.code === 'cancelled') return
      state.results = null
      note(explain(error))
    }
    state.searching = false
    renderPeople()
  }

  // Open and close ----------------------------------------------------------------------------------

  function open() {
    if (state.open) return
    state.open = true
    note('')
    state.results = null
    $('home-search').value = ''
    root.hidden = false
    setInert(true)
    root.querySelector('h1').focus({ preventScroll: true })
    sync(online.client.state)
    refresh()
  }

  // Closing needs a board to go back to, unless a new game is being started (the board asks for a side).
  function close(force = false) {
    if (!state.open || (!force && !actions.hasGame())) return
    state.open = false
    epoch++
    clearTimeout(timer)
    clearTimeout(searchTimer)
    root.hidden = true
    setInert(false)
    $('home-button').focus({ preventScroll: true })
  }

  // The online session changed (signed in, out or revoked): show the right part of the screen.
  function sync(clientState) {
    const signedIn = ['ready', 'waiting', 'active', 'finished', 'disconnected'].includes(clientState.phase)
    if (signedIn === state.signedIn) { if (state.open) render(); return }
    state.signedIn = signedIn
    if (!signedIn) { state.data = null; state.results = null }
    if (state.open) { signedIn ? refresh() : render() }
  }

  // Wiring -------------------------------------------------------------------------------------------

  $('home-close').addEventListener('click', close)
  $('home-bot').addEventListener('click', () => { actions.startBot(); close(true) })
  $('home-two').addEventListener('click', () => { actions.startTwo(); close(true) })
  $('home-level').addEventListener('input', () => { $('home-level-output').value = levelText(Number($('home-level').value)) })
  $('home-level').addEventListener('change', () => actions.setLevel(Number($('home-level').value)))
  $('home-signin').addEventListener('click', () => run(() => online.signIn()))
  $('home-share').addEventListener('click', () => run(() => online.signIn()))
  $('home-code').addEventListener('click', () => { actions.openCode(); close(true) })
  $('home-search-form').addEventListener('submit', (event) => { event.preventDefault(); search() })
  $('home-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, SEARCH_DELAY_MS) })
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open && actions.hasGame()) { event.stopPropagation(); close() }
  })
  sdk.on('visibility', (v) => {
    visible = v.visible
    if (visible) { if (state.open) refresh() } else clearTimeout(timer)
  })

  return { open, close, sync, render, get isOpen() { return state.open } }
}
