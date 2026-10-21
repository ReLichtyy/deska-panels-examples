// TEST ONLY: simulated Deska SDK and room service. Never deploy this server.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname, sep } from 'node:path'
import { moveFromUci, newGame, play, isOver } from '../../panels/chess/rules.js'

import { createService } from '../../chess-server/core.js'
import { AuthError } from '../../chess-server/auth.js'

// `core: true` serves /api with the real chess-server code (in memory) instead of the canned answers,
// for tests of the home screen, search and challenges. Tokens are the fake 'test-player-<name>' ones;
// host.setName(player, name) is the name that person "shared" with the panel in Deska's sign-in sheet.
export async function startTestHost(port = 0, { core = false, accent = null } = {}) {
  const names = new Map()
  const data = new Map()
  const coreService = core ? createService({
    now: () => Date.now(),
    log: { warn() {}, error: console.error },
    store: {
      get: async (key) => (data.has(key) ? structuredClone(data.get(key)) : undefined),
      put: async (key, value) => { data.set(key, structuredClone(value)) },
      delete: async (key) => data.delete(key),
      list: async (prefix) => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]),
    },
    verifier: async (header) => {
      const match = /^Bearer test-player-(\w+)$/.exec(header || '')
      if (!match) throw new AuthError('missing')
      return { sub: match[1], aud: 'test', dev: false, name: names.get(match[1]) }
    },
  }) : null
  const root = fileURLToPath(new URL('../../panels/chess/', import.meta.url))
  const themes = JSON.parse(await readFile(new URL('../preview/themes.json', import.meta.url), 'utf8'))
  const stores = new Map()
  let room = null, joined = false, offline = false
  const requests = []
  const lastSeen = new Map()
  const aliases = { w: 'Alfil Azul', b: 'Torre Roja' }
  // Other people the simulated service reports as online. Tests can replace them.
  let others = [
    { id: 'p_marisol', name: 'Marisol Vega', status: 'available', self: false },
    { id: 'p_tomas', name: 'Tomás Quiroga', status: 'playing', self: false },
    { id: 'p_lucia', name: 'Lucía Ferrer', status: 'available', self: false },
  ]
  let heldRead = null
  const hold = (matches) => {
    let release, arrived
    const pending = new Promise(resolve => { release = resolve })
    const observed = new Promise(resolve => { arrived = resolve })
    heldRead = { matches, pending, arrived }
    return { release, arrived: observed }
  }
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`
    const url = new URL(req.url, origin)
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store',
        'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'content-security-policy': `default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; connect-src ${origin}; font-src ${origin}; form-action 'none'; worker-src 'none'; sandbox allow-scripts allow-forms` })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }
    try {
      if (req.method === 'OPTIONS') return send(204, '')
      const body = async () => { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {} }
      if (heldRead && heldRead.matches(req, url)) {
        const held = heldRead; heldRead = null; held.arrived(); await held.pending
      }
      if (url.pathname === '/favicon.ico') return send(204, '')
      if (url.pathname === '/__deska/sdk.js') return send(200, `
        const params = new URLSearchParams(location.search);
        const player = params.get('player') || 'w';
        const theme = params.get('theme') === 'light' ? 'light' : 'dark';
        // Real Deska resolves every color to rgb() before sending it; ?format=rgb reproduces that.
        const asRgb = (value) => /^#[0-9a-f]{6}$/i.test(value) ? 'rgb(' + [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).join(', ') + ')' : value;
        const rgb = params.get('format') === 'rgb';
        for (const [key, value] of Object.entries(${JSON.stringify(themes)}[theme])) document.documentElement.style.setProperty(key, rgb ? asRgb(value) : value);
        // ?accent=#rrggbb (or the host's default) stands in for the person's own accent choice in Deska.
        const accent = params.get('accent') || ${JSON.stringify(accent)};
        if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
          const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
          const onAccent = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? '#14110f' : '#ffffff';
          for (const [key, value] of [['--deska-accent', accent], ['--deska-focus', accent], ['--deska-on-accent', onAccent]]) document.documentElement.style.setProperty(key, rgb ? asRgb(value) : value);
        }
        const listeners = {}; window.__testEmit = (event, data) => (listeners[event] || []).forEach(fn => fn(data));
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, options) => nativeFetch(typeof url === 'string' && url.startsWith('https://chess.example/') ? location.origin + '/api' + url.slice('https://chess.example'.length) : url, options);
        window.deska = {
          ready: async () => ({ panel: { id: 'dev-test', name: 'Chess TEST', dev: true }, permissions: [], visibility: { visible: true }, locale: 'es' }),
          on: (name, fn) => { (listeners[name] ||= []).push(fn); }, setTitle: async () => true,
          account: { signIn: async () => { window.__signedIn = true; window.__testEmit('account', { signedIn: true }); }, token: async () => ({ token: 'test-player-' + player }) },
          storage: {
            get: async key => (await nativeFetch('/storage/' + player + '/' + key)).json(),
            set: async (key, value) => { const response = await nativeFetch('/storage/' + player + '/' + key, { method: 'POST', body: JSON.stringify(value) }); if (!response.ok) throw new Error('storage'); },
            remove: async key => { await nativeFetch('/storage/' + player + '/' + key, { method: 'POST', body: 'null' }); }
          }
        };
      `, 'text/javascript')
      if (url.pathname === '/online-config.js') return send(200, "export const onlineConfig = { apiUrl: 'https://chess.example' }", 'text/javascript')
      if (url.pathname.startsWith('/storage/')) {
        if (req.method === 'POST') stores.set(url.pathname, await body())
        return send(200, stores.get(url.pathname) ?? null)
      }
      if (coreService && url.pathname.startsWith('/api/')) {
        if (offline) return send(503, {})
        let text = ''
        if (req.method === 'POST') for await (const chunk of req) text += chunk
        const answer = await coreService.handle(new Request(`${origin}${url.pathname.slice(4)}`, {
          method: req.method, body: req.method === 'POST' ? text : undefined,
          headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json' },
        }))
        return send(answer.status, await answer.json())
      }
      if (url.pathname.startsWith('/api/')) {
        if (offline) return send(503, {})
        const player = req.headers.authorization === 'Bearer test-player-w' ? 'w' : req.headers.authorization === 'Bearer test-player-b' ? 'b' : null
        if (!player) return send(401, {})
        requests.push({ path: url.pathname, method: req.method, player })
        if (url.pathname === '/api/session') return send(200, { ok: true })
        if (url.pathname === '/api/presence') {
          // Heartbeat: asking for the list marks the caller as connected for the next 90 s.
          lastSeen.set(player, Date.now())
          const mine = [...lastSeen].filter(([, at]) => Date.now() - at < 90000).map(([id]) => ({
            id: 'p_' + id, name: aliases[id], self: id === player, status: room?.status === 'active' ? 'playing' : 'available' }))
          const players = [...mine, ...others]
          return send(200, { players, total: players.length })
        }
        const data = await body()
        if (url.pathname === '/api/rooms' && req.method === 'POST') {
          if (room) return send(409, {})
          room = { id: 'test_room', code: 'ABC123', revision: 1, moves: [], status: 'waiting' }
        } else if (url.pathname === '/api/rooms/join') {
          if (!room || data.code !== room.code) return send(404, {})
          if (!joined) { joined = true; room.status = 'active'; room.revision++ }
        } else if (url.pathname === '/api/rooms/test_room/moves') {
          if (!room || room.status !== 'active' || data.revision !== room.revision) return send(409, {})
          let game = newGame()
          for (const uci of room.moves) { const found = moveFromUci(game, uci); game = play(game, found.from, found.move) }
          const found = moveFromUci(game, data.uci)
          if (game.turn !== player || !found) return send(409, {})
          game = play(game, found.from, found.move)
          room.moves.push(data.uci); room.revision++; room.status = isOver(game) ? 'finished' : 'active'
        } else if (url.pathname !== '/api/rooms/test_room') return send(404, {})
        return room ? send(200, { ...room, side: player, opponent: room.status === 'waiting' ? null : aliases[player === 'w' ? 'b' : 'w'] }) : send(404, {})
      }
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      if (!path.startsWith(resolve(root) + sep)) return send(404, {})
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
      if (!types[extname(path)]) return send(404, {})
      send(200, await readFile(path), types[extname(path)])
    } catch (error) { console.error('Test host:', error.message); if (!res.headersSent) send(500, {}) }
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, stores,
    holdRecovery: () => hold((req, url) => req.method === 'GET' && url.pathname === '/storage/w/online-room'),
    holdWhiteRefresh: () => hold((req, url) => req.method === 'GET' && url.pathname === '/api/rooms/test_room' && req.headers.authorization === 'Bearer test-player-w'),
    finishGame() { room.moves = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']; room.status = 'finished'; room.revision += 5 },
    setOthers(value) { others = value; lastSeen.clear() },
    setName(player, name) { names.set(player, name) },
    setOffline(value) { offline = value }, close: () => new Promise(resolve => server.close(resolve)) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // node tools/chess/test-host.mjs [port] [--core]
  // --core serves the real chess-server code in memory, with a few people who "shared" a name, so the
  // home screen can be tried by hand: open ?player=ana and ?player=ben in two tabs. Local only (127.0.0.1).
  const core = process.argv.includes('--core')
  const accent = process.argv.find((arg) => arg.startsWith('--accent='))?.slice(9) || null
  const host = await startTestHost(Number(process.argv.find((arg) => /^\d+$/.test(arg))) || 5195, { core, accent })
  if (core) {
    host.setName('ana', 'Ana Pérez'); host.setName('ben', 'Benjamín'); host.setName('dani', 'Daniela Pérez')
    console.log(`TEST ONLY Chess (real server code, in memory): ${host.url}/?player=ana   ${host.url}/?player=ben   ${host.url}/?player=cris (no shared name)`)
  } else console.log(`TEST ONLY Chess: ${host.url}`)
}
