// Online premoves and move feedback between two panels. TEST service only (test-host.mjs).
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startTestHost } from './test-host.mjs'
import { clickSquare, leaveHome, state, watchErrors } from './browser-helpers.mjs'

const host = await startTestHost()
const browser = await chromium.launch()
const errors = []
const directory = new URL('../../test-results/chess/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
await mkdir(directory, { recursive: true })
// Waits for a condition on the panel's text state.
const until = (page, predicate) => page.waitForFunction(predicate, null, { timeout: 12000 })
const movePosts = (player) => host.requests.filter((r) => r.player === player && r.path === '/api/rooms/test_room/moves')

try {
  const context = await browser.newContext({ viewport: { width: 420, height: 600 } })
  const white = await context.newPage()
  const black = await context.newPage()
  for (const page of [white, black]) watchErrors(page, errors)

  await white.goto(host.url + '/?player=w')
  await white.locator('#app[aria-busy=false]').waitFor(); await leaveHome(white)
  assert.match(await white.locator('#online-button').textContent(), /Beta/)
  await white.locator('#online-button').click()
  await white.locator('#online-signin').click()
  await white.locator('#online-create').click()
  await white.locator('#online-code-display').filter({ hasText: 'ABC123' }).waitFor()
  // Waiting: the opponent's line says so and carries the code to share.
  assert.deepEqual((await state(white)).players.top, { name: 'Esperando rival', note: 'ABC123', code: true })
  await white.waitForTimeout(300)
  await white.screenshot({ path: directory + '/online-waiting.png' })
  await white.locator('[aria-label="Cerrar online"]').click()

  await black.goto(host.url + '/?player=b')
  await black.locator('#app[aria-busy=false]').waitFor(); await leaveHome(black)
  await black.locator('#online-button').click()
  await black.locator('#online-signin').click()
  await black.locator('#online-code').fill('ABC123')
  await black.locator('#online-join').click()
  await black.locator('#online-room-status').filter({ hasText: 'Partida en curso' }).waitFor()
  await black.locator('[aria-label="Cerrar online"]').click()

  // Both lines name the people: you as "Tú" with your color, the rival by alias.
  await until(white, () => JSON.parse(window.render_game_to_text()).players.top.name === 'Torre Roja')
  assert.deepEqual((await state(white)).players, { top: { name: 'Torre Roja', note: 'Negras', code: false }, bottom: { name: 'Tú', note: 'Blancas' } })
  assert.deepEqual((await state(black)).players.top, { name: 'Alfil Azul', note: 'Blancas', code: false })

  // White moves, then queues a premove while black thinks: nothing is sent yet.
  await until(white, () => { const s = JSON.parse(window.render_game_to_text()); return s.canMove })
  await clickSquare(white, 'e2'); await clickSquare(white, 'e4')
  await until(white, () => { const s = JSON.parse(window.render_game_to_text()); return s.moves.length === 1 && !s.pending })
  await clickSquare(white, 'f1'); await clickSquare(white, 'c4')
  assert.deepEqual((await state(white)).premoves, ['f1c4'])
  assert.equal(movePosts('w').length, 1, 'a premove is not sent before its turn')
  await white.screenshot({ path: directory + '/online-premove.png' })

  // Black sees white's move slide in, read out and marked as the last move.
  await until(black, () => { const s = JSON.parse(window.render_game_to_text()); return s.moves.length === 1 })
  assert.deepEqual((await state(black)).lastMove, { from: 'e2', to: 'e4' })
  assert.match(await black.locator('#announce').textContent(), /Blancas: peón de e2 a e4/)
  await until(black, () => { const s = JSON.parse(window.render_game_to_text()); return s.canMove })
  await clickSquare(black, 'e7'); await clickSquare(black, 'e5')

  // White's premove goes out only after black's move has arrived.
  await until(white, () => { const s = JSON.parse(window.render_game_to_text()); return s.moves.join(' ') === 'e2e4 e7e5 f1c4' })
  const order = host.requests.filter((r) => r.path === '/api/rooms/test_room/moves').map((r) => r.player)
  assert.deepEqual(order, ['w', 'b', 'w'])
  assert.deepEqual((await state(white)).premoves, [])

  // A move refused by an outage goes back and the notice shows over the board, sheet closed.
  await until(black, () => { const s = JSON.parse(window.render_game_to_text()); return s.canMove })
  host.setOffline(true)
  await clickSquare(black, 'g8'); await clickSquare(black, 'f6')
  await until(black, () => { const s = JSON.parse(window.render_game_to_text()); return s.status && s.status.kind === 'error' && !s.pending })
  assert.deepEqual((await state(black)).moves, ['e2e4', 'e7e5', 'f1c4'])
  assert.ok((await state(black)).fen.includes('rnbqkbnr/pppp1ppp'), 'the refused move went back')
  assert.equal(await black.locator('#online-sheet').isHidden(), true)
  await black.waitForTimeout(300)
  await black.screenshot({ path: directory + '/online-error.png' })
  host.setOffline(false)

  assert.deepEqual(errors, [])
  console.log('PASS online premove: queued without sending, sent after the rival move, rival move announced with last-move mark, refused move reverted with a visible notice, Beta tag. TEST service only.')
} catch (error) {
  console.error('Browser errors:', errors)
  throw error
} finally { await browser.close(); await host.close() }
