// The home screen, end to end: it opens every time, continue / new game, and playing people
// (search by shared name, challenge, accept, decline) against the real chess-server code in memory.
// TEST service only (test-host.mjs with core: true).
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startTestHost } from './test-host.mjs'
import { leaveHome, state, watchErrors } from './browser-helpers.mjs'

const host = await startTestHost(0, { core: true })
host.setName('ana', 'Ana Pérez')
host.setName('ben', 'Benjamín')
host.setName('dani', 'Daniela Pérez') // cris shares no name
const browser = await chromium.launch()
const errors = []
const directory = new URL('../../test-results/chess/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
await mkdir(directory, { recursive: true })

const MOVES = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']
const SAVED = { side: 'w', start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: MOVES, cursor: MOVES.length }

async function open(name, { theme = 'dark', size = { width: 420, height: 505 }, game, configured = true } = {}) {
  host.stores.set(`/storage/${name}/settings`, { botEnabled: true })
  if (game) host.stores.set(`/storage/${name}/game`, game)
  const page = await browser.newPage({ viewport: size })
  watchErrors(page, errors)
  await page.route('**/engine.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export const profileFor=()=>({});export async function chooseMove(){await new Promise(()=>{})}' }))
  if (!configured) await page.route('**/online-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export const onlineConfig = { apiUrl: null }' }))
  await page.goto(`${host.url}/?player=${name}&theme=${theme}`)
  await page.locator('#app[aria-busy=false]').waitFor()
  await page.locator('#home').waitFor({ state: 'visible' })
  return page
}
const signIn = async (page) => { await page.locator('#home-signin').click(); await page.locator('#home-online').waitFor({ state: 'visible' }) }
// The panel polls every 10 s; a visibility change refreshes at once, as it does when the person comes back.
const refresh = async (page) => {
  await page.evaluate(() => { window.__testEmit('visibility', { visible: false }); window.__testEmit('visibility', { visible: true }) })
  await page.waitForTimeout(150)
}
// Each row as its parts in reading order (title, detail, buttons), independent of layout and animation.
const rows = (page, selector) => page.locator(`${selector} .home-row`).evaluateAll((list) => list.map((row) =>
  [...row.querySelectorAll('.home-row-title, .home-row-sub, button')].map((el) => el.textContent.trim()).join(' ')))

try {
  // It opens every time, and the rest of the panel cannot be reached behind it --------------------------
  const a = await open('ana', { game: SAVED })
  assert.equal(await a.locator('#home-close').isVisible(), true, 'a game is waiting')
  assert.deepEqual(await rows(a, '#home-continue-list'), ['Contra Dex 1200 Jugada 4 · Tu turno'])
  assert.equal(await a.evaluate(() => document.querySelector('.match').inert), true)
  assert.equal(await a.evaluate(() => document.getElementById('drawer').inert), true)
  await a.screenshot({ path: directory + '/home-default.png' })
  await a.keyboard.press('Escape')
  await a.locator('#home').waitFor({ state: 'hidden' })
  assert.equal(await a.evaluate(() => document.getElementById('drawer').inert), true, 'the closed drawer stays closed')
  assert.equal((await state(a)).moves.length, 6)
  await a.reload()
  await a.locator('#home').waitFor({ state: 'visible' })
  assert.equal((await rows(a, '#home-continue-list')).length, 1, 'it opens again after a reload')

  // The menu button comes back to it from the board; "continue" returns to the same game ----------------
  await a.locator('#home-close').click()
  await a.locator('#home-button').click()
  await a.locator('#home').waitFor({ state: 'visible' })
  await a.locator('#home-continue-list .home-continue').click()
  await a.locator('#home').waitFor({ state: 'hidden' })
  assert.equal((await state(a)).moves.length, 6)

  // A new game keeps the old one until a side is chosen -------------------------------------------------
  await a.locator('#home-button').click()
  await a.locator('#home-bot').click()
  await a.locator('#choose').waitFor({ state: 'visible' })
  assert.equal((await state(a)).mode, 'bot')
  await a.locator('#home-button').click()
  assert.equal((await rows(a, '#home-continue-list')).length, 1, 'the game set aside is still offered')
  assert.equal(await a.locator('#home-close').isVisible(), false, 'nothing to go back to but a game or a new one')
  await a.locator('#home-continue-list .home-continue').click()
  assert.equal((await state(a)).moves.length, 6, 'continuing restores it')
  assert.equal((await state(a)).phase, 'play')
  await a.locator('#home-button').click()
  await a.locator('#home-two').click()
  await a.locator('[data-side=b]').click()
  assert.equal((await state(a)).mode, 'local')
  assert.deepEqual((await state(a)).moves, [])
  await a.locator('#home-button').click()
  assert.deepEqual(await rows(a, '#home-continue-list'), [], 'a game that has not started is not offered')
  await a.locator('#home-close').click()

  // Without a server the rest still works ---------------------------------------------------------------
  const off = await open('offline', { configured: false })
  assert.equal(await off.locator('#home-signin').isDisabled(), true)
  assert.match(await off.locator('#home-people-intro').textContent(), /cuando se conecte el servidor/)
  assert.equal(await off.locator('#home-close').isVisible(), false)
  await off.locator('#home-two').click()
  await off.locator('#choose').waitFor({ state: 'visible' })
  await off.close()

  // People ------------------------------------------------------------------------------------------------
  const ana = await open('ana', { game: SAVED })
  const ben = await open('ben', { theme: 'light' })
  const cris = await open('cris')
  const dani = await open('dani')
  for (const page of [ana, ben, cris, dani]) await signIn(page)
  assert.equal(await ana.locator('#home-who-name').textContent(), 'Ana Pérez', 'who you are, in the header')
  assert.equal(await ana.locator('#home-who-avatar').textContent(), 'A')
  assert.match(await cris.locator('#home-who-name').textContent(), /^\p{L}+ \p{L}+ \d\d$/u)
  assert.match(await cris.locator('#home-me').textContent(), /Nadie puede buscarte por nombre\.$/)
  assert.equal(await cris.locator('#home-share').isVisible(), true, 'offer to share the name')
  assert.equal(await ana.locator('#home-share').isVisible(), false)
  assert.equal(await ana.locator('#home-recent-empty').isVisible(), true)

  // Search: three letters at least, by name, and only people who shared theirs
  await ana.locator('#home-search').fill('be')
  await ana.waitForTimeout(600)
  assert.equal(await ana.locator('#home-results .home-row').count(), 0)
  await ana.locator('#home-search').fill('perez')
  await ana.locator('#home-results .home-row').first().waitFor()
  assert.deepEqual((await rows(ana, '#home-results')).map((t) => t.split(' ')[0]), ['Daniela'], 'not yourself')
  await ana.locator('#home-search').fill('cris')
  await ana.locator('#home-search-note').filter({ hasText: 'Nadie con ese nombre' }).waitFor()
  await ana.locator('#home-search').fill('benja')
  await ana.locator('#home-results .home-row').waitFor()
  await ana.screenshot({ path: directory + '/home-people.png' })

  // Challenge: sent, seen by the other, accepted; both in the same game --------------------------------
  await ana.locator('#home-results .home-row button').click()
  await ana.locator('#home-note').filter({ hasText: 'Reto enviado a Benjamín' }).waitFor()
  assert.deepEqual(await rows(ana, '#home-challenges-list'), ['Benjamín Esperando respuesta Cancelar'])
  assert.equal(await ana.locator('#home-results .home-row').first().innerText().then((t) => t.includes('Reto enviado')), true, 'no second challenge to the same person')
  await refresh(ben)
  await ben.locator('#home-challenges-list .home-row').waitFor()
  assert.deepEqual(await rows(ben, '#home-challenges-list'), ['Ana Pérez Te retó Aceptar Rechazar'])
  await ben.waitForTimeout(300)
  await ben.screenshot({ path: directory + '/home-challenge.png' })
  await ben.locator('#home-challenges-list button.primary').click()
  await ben.locator('#home').waitFor({ state: 'hidden' })
  const bt = await state(ben)
  assert.equal(bt.mode, 'online')
  assert.equal(bt.players.top.name, 'Ana Pérez')
  assert.equal(bt.phase, 'play')
  await refresh(ana)
  await ana.locator('#home-challenges-list .home-row').filter({ hasText: 'Aceptó tu reto' }).waitFor()
  await ana.locator('#home-challenges-list button.primary').click()
  await ana.locator('#home').waitFor({ state: 'hidden' })
  const at = await state(ana)
  assert.equal(at.mode, 'online')
  assert.equal(at.players.top.name, 'Benjamín')
  assert.notEqual(at.side, bt.side)
  await ana.waitForTimeout(300)
  await ana.screenshot({ path: directory + '/home-online-game.png' })

  // Back to the menu: the game in progress and the rival are there; the local game is still offered ------
  await ana.locator('#home-button').click()
  await ana.locator('#home-recent .home-row').first().waitFor()
  assert.deepEqual((await rows(ana, '#home-continue-list')).map((t) => t.split(' ').slice(0, 2).join(' ')), ['Contra Dex', 'Contra Benjamín'])
  assert.match((await rows(ana, '#home-recent'))[0], /^Benjamín (Conectado|En partida)/)
  await ana.waitForTimeout(300)
  await ana.screenshot({ path: directory + '/home-continue-online.png' })
  // Continuing the local game from here leaves the online one, and the session comes back quietly.
  await ana.locator('#home-continue-list .home-continue').first().click()
  assert.equal((await state(ana)).mode, 'bot')
  await ana.locator('#home-button').click()
  await ana.locator('#home-online').waitFor({ state: 'visible' })
  await ana.locator('#home-continue-list li').nth(1).waitFor()
  assert.equal((await rows(ana, '#home-continue-list')).length, 2, 'the online game can be resumed')
  await ana.locator('#home-continue-list .home-continue').nth(1).click()
  await ana.locator('#home').waitFor({ state: 'hidden' })
  assert.equal((await state(ana)).mode, 'online')

  // Decline and withdraw -----------------------------------------------------------------------------------
  await cris.locator('#home-search').fill('daniela')
  await cris.locator('#home-results .home-row button').click()
  await cris.locator('#home-challenges-list .home-row').waitFor()
  await refresh(dani)
  await dani.locator('#home-challenges-list .home-row').waitFor()
  await dani.locator('#home-challenges-list button.quiet').click()
  await dani.waitForFunction(() => document.getElementById('home-challenges').hidden)
  await refresh(cris)
  await cris.locator('#home-challenges-list .home-row').filter({ hasText: 'Rechazó tu reto' }).waitFor()
  await cris.locator('#home-challenges-list button.quiet').click()
  await cris.waitForFunction(() => document.getElementById('home-challenges').hidden)
  await cris.locator('#home-search').fill('daniela')
  await cris.locator('#home-results .home-row button').click()
  await cris.locator('#home-challenges-list button.quiet').click()
  await refresh(dani)
  await dani.waitForFunction(() => document.getElementById('home-challenges').hidden)

  // Sharing the name later makes them findable -----------------------------------------------------------------
  host.setName('cris', 'Cristina')
  await cris.locator('#home-share').click()
  await cris.waitForFunction(() => document.getElementById('home-who-name').textContent === 'Cristina')
  await ben.locator('#home-button').click()
  await ben.locator('#home-search').fill('crist')
  await ben.locator('#home-results .home-row').waitFor()

  // A server that is down says so, in words, and the rest of the screen keeps working -----------------------
  host.setOffline(true)
  await ben.locator('#home-search').fill('daniel')
  await ben.locator('#home-note').filter({ hasText: /conexión|servidor/ }).waitFor()
  assert.equal(await ben.locator('#home-bot').isEnabled(), true)
  host.setOffline(false)

  // Small panels --------------------------------------------------------------------------------------------------
  const small = await open('ben', { size: { width: 320, height: 440 } })
  await small.waitForTimeout(300)
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await small.screenshot({ path: directory + '/home-compact.png' })

  assert.deepEqual(errors, [])
  console.log('PASS home: opens every time, continue / new game keeps the old one, no server still plays, name search, challenge/accept/decline/cancel between real clients, resume online, server down.')
} catch (error) {
  console.error('Browser errors:', errors)
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error(await page.locator('#home-note').textContent().catch(() => ''), await page.evaluate(() => window.render_game_to_text?.()).catch(() => ''))
  }
  throw error
} finally { await browser.close(); await host.close() }
