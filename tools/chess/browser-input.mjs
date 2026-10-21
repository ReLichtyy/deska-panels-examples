// Browser checks for board input and rendering: sharpness at several pixel densities, dragging,
// analysis arrows, premoves against the bot, and notices. TEST service only (test-host.mjs).
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startTestHost } from './test-host.mjs'
import { clickSquare, drag, leaveHome, point, state, watchErrors } from './browser-helpers.mjs'

// A bot that answers from a script and waits while a gate is closed, so premove timing is exact.
const ENGINE_STUB = `
import { fromFEN, legalMoves, squareName } from './rules.js'
export const profileFor = () => ({})
export async function chooseMove(fen) {
  while (window.__botGate) await new Promise((resolve) => setTimeout(resolve, 20))
  if (window.__botScript && window.__botScript.length) return window.__botScript.shift()
  const game = fromFEN(fen)
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const piece = game.board[r][f]
    if (!piece || piece.color !== game.turn) continue
    const [move] = legalMoves(game, f, r)
    if (move) return squareName(f, r) + squareName(move.f, move.r) + (move.promotion || '')
  }
  return null
}`

const host = await startTestHost()
const browser = await chromium.launch()
const errors = []
const directory = new URL('../../test-results/chess/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
await mkdir(directory, { recursive: true })
let serial = 0
let shared = null
const close = (page) => (page.context() === shared ? page.close() : page.context().close())

async function open({ settings = {}, game, gate = false, dsf = 1, theme = 'dark', viewport = { width: 420, height: 600 } } = {}) {
  const player = `input${++serial}`
  host.stores.set(`/storage/${player}/settings`, { botEnabled: false, ...settings })
  if (game) host.stores.set(`/storage/${player}/game`, game)
  // One shared context for 1x pages keeps the number of open connections low on Windows.
  const context = dsf === 1 ? (shared ||= await browser.newContext({ viewport, deviceScaleFactor: 1 })) : await browser.newContext({ viewport, deviceScaleFactor: dsf })
  const page = await context.newPage()
  await page.setViewportSize(viewport)
  watchErrors(page, errors)
  await page.route('**/engine.js', (route) => route.fulfill({ contentType: 'text/javascript', body: ENGINE_STUB }))
  await page.addInitScript((closed) => { window.__botGate = closed; window.__botScript = [] }, gate)
  await page.goto(`${host.url}/?player=${player}&theme=${theme}`)
  await page.locator('#app[aria-busy=false]').waitFor()
  await leaveHome(page, { bot: game ? null : !!settings.botEnabled })
  return page
}

const startAs = async (page, side) => {
  await page.locator(`[data-side=${side}]`).click()
  await page.locator('#choose').waitFor({ state: 'hidden' })
}

// The exact device-pixel size the browser gives the canvas, from a ResizeObserver of our own.
const deviceBox = (page) => page.evaluate(() => new Promise((resolve) => {
  const canvas = document.getElementById('board')
  const observer = new ResizeObserver((entries) => {
    observer.disconnect()
    const box = entries[0].devicePixelContentBoxSize[0]
    resolve({ w: box.inlineSize, h: box.blockSize })
  })
  observer.observe(canvas, { box: 'device-pixel-content-box' })
}))

// Colors along the middle of the empty fourth rank: only the two square colors, no blended edges.
const rankColors = (page) => page.evaluate(() => {
  const canvas = document.getElementById('board')
  const { view } = JSON.parse(window.render_game_to_text())
  const ctx = canvas.getContext('2d')
  const y = Math.round((view.y + view.cell * 4.5) * view.scale)
  const x0 = Math.round(view.x * view.scale)
  const width = Math.round(view.cell * 8 * view.scale)
  const data = ctx.getImageData(x0, y, width, 1).data
  const seen = new Set()
  for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
  return [...seen]
})

try {
  // Sharpness ----------------------------------------------------------------------------------
  for (const dsf of [1, 1.25, 1.5, 2]) {
    const page = await open({ dsf })
    await startAs(page, 'w')
    for (const width of [null, '419.6px', '377.3px']) {
      if (width) await page.addStyleTag({ content: `#app { width: ${width} }` })
      await page.waitForTimeout(80)
      const box = await deviceBox(page)
      const { view } = await state(page)
      assert.equal(view.canvasWidth, box.w, `backing width at dsf ${dsf} ${width}`)
      assert.equal(view.canvasHeight, box.h, `backing height at dsf ${dsf} ${width}`)
      for (const key of ['x', 'y', 'cell']) {
        const device = view[key] * view.scale
        assert.ok(Math.abs(device - Math.round(device)) < 1e-6, `${key} on a device pixel at dsf ${dsf}: ${device}`)
      }
      assert.equal((await rankColors(page)).length, 2, `square edges unblended at dsf ${dsf} ${width}`)
    }
    await page.locator('#menu-button').click()
    await page.waitForTimeout(50)
    const previews = await page.evaluate(() => [...document.querySelectorAll('.preview')].map((c) => ({ width: c.width, css: c.clientWidth, dpr: devicePixelRatio })))
    for (const p of previews) assert.equal(p.width, Math.round(p.css * p.dpr), 'piece previews drawn at screen density')
    if (dsf === 2) await page.screenshot({ path: directory + '/hidpi-2x.png' })
    await close(page)
  }

  // Zoom changes while open, and a resize never shows an empty canvas.
  {
    const page = await open()
    await startAs(page, 'w')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 600, deviceScaleFactor: 1.5, mobile: false })
    await page.waitForFunction(() => devicePixelRatio === 1.5)
    await page.waitForTimeout(150)
    const box = await deviceBox(page)
    assert.equal((await state(page)).view.canvasWidth, box.w, 'backing follows a pixel density change')
    const blank = await page.evaluate(() => new Promise((resolve) => {
      const canvas = document.getElementById('board')
      const samples = []
      // Created after the panel's observer, so it runs after the panel has painted the new size.
      const observer = new ResizeObserver(() => {
        const pixel = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
        samples.push(pixel[3])
        if (samples.length >= 3) { observer.disconnect(); resolve(samples) }
      })
      observer.observe(canvas)
      let step = 0
      const grow = () => { document.getElementById('app').style.width = `${380 - step * 13}px`; if (++step < 3) requestAnimationFrame(grow) }
      requestAnimationFrame(grow)
    }))
    assert.ok(blank.every((alpha) => alpha === 255), `canvas painted during resize: ${blank}`)
    await close(page)
  }

  // Colors: Deska sends rgb(), and the default palette must still follow the accent ------------------------
  {
    const results = {}
    for (const format of ['hex', 'rgb']) {
      for (const theme of ['dark', 'light']) {
        const player = `colors-${format}-${theme}`
        host.stores.set(`/storage/${player}/settings`, { botEnabled: false })
        const context = await browser.newContext({ viewport: { width: 420, height: 600 } })
        const page = await context.newPage()
        watchErrors(page, errors)
        await page.goto(`${host.url}/?player=${player}&theme=${theme}&format=${format}`)
        await page.locator('#app[aria-busy=false]').waitFor()
        await leaveHome(page, { bot: false })
        await page.locator('[data-side=w]').click()
        await page.locator('#choose').waitFor({ state: 'hidden' })
        const tokens = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--deska-accent').trim())
        assert.equal(/^rgb\(/.test(tokens), format === 'rgb', `tokens arrive as ${format}: ${tokens}`)
        const palette = (await state(page)).palette
        assert.match(palette.dark, /^#[0-9a-f]{6}$/)
        assert.match(palette.light, /^#[0-9a-f]{6}$/)
        assert.match(palette.accent, /^#[0-9a-f]{6}$/)
        assert.equal(palette.dark, palette.accent, 'dark squares are the accent')
        assert.notEqual(palette.light, '#f7e9e3', 'light squares are a tint of the accent, not the old fallback')
        // Painted pixels: the dark and light squares are exactly those colors, and a held piece's marks are not NaN-colored.
        await clickSquare(page, 'e2')
        const pixels = await page.evaluate(() => {
          const t = JSON.parse(window.render_game_to_text())
          const ctx = document.getElementById('board').getContext('2d')
          const at = (name) => { const c = window.chess_square_point(name); const r = document.getElementById('board').getBoundingClientRect(); const d = ctx.getImageData(Math.round((c.x - r.left - t.view.cell * 0.38) * t.view.scale), Math.round((c.y - r.top - t.view.cell * 0.38) * t.view.scale), 1, 1).data; return '#' + [...d].slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('') }
          return { light: at('e4'), dark: at('d4') } // e4 is a light square, d4 a dark one (a1 is dark)
        })
        assert.deepEqual(pixels, { light: palette.light, dark: palette.dark }, `squares are painted in the palette colors (${format}, ${theme})`)
        results[`${format}-${theme}`] = { palette, pixels }
        await context.close()
      }
    }
    for (const theme of ['dark', 'light']) {
      assert.deepEqual(results[`rgb-${theme}`].palette, results[`hex-${theme}`].palette, `rgb() and hex give the same palette (${theme})`)
    }
  }

  // A dark accent (the person's own choice) still gives a visible interface ------------------------------------
  for (const theme of ['dark', 'light']) {
    const player = `dark-accent-${theme}`
    host.stores.set(`/storage/${player}/settings`, { botEnabled: false })
    const context = await browser.newContext({ viewport: { width: 420, height: 600 } })
    const page = await context.newPage()
    watchErrors(page, errors)
    await page.goto(`${host.url}/?player=${player}&theme=${theme}&format=rgb&accent=%230c434b`)
    await page.locator('#app[aria-busy=false]').waitFor()
    await leaveHome(page, { bot: false })
    await page.locator('[data-side=w]').click()
    const seen = await page.evaluate(() => ({
      ink: getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim(),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--deska-bg').trim(),
      palette: JSON.parse(window.render_game_to_text()).palette,
    }))
    assert.equal(seen.palette.dark, '#0c434b', 'the board uses the accent the person chose')
    const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const lum = (c) => c.reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i] * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), 0)
    const rgbToHex = (text) => '#' + text.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')
    const bg = seen.bg.startsWith('#') ? seen.bg : rgbToHex(seen.bg)
    const [hi, lo] = [lum(channels(seen.ink)), lum(channels(bg))].sort((x, y) => y - x)
    assert.ok((hi + 0.05) / (lo + 0.05) >= 3, `the accent as ink reads on the ${theme} ground: ${seen.ink} on ${bg}`)
    await context.close()
  }

  // Full board: an option that gives the whole panel to the board ----------------------------------------------
  {
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6']
    const saved = { side: 'w', start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves, cursor: moves.length }
    const sizeOf = async (fullBoard) => {
      const player = `full-${fullBoard}`
      host.stores.set(`/storage/${player}/settings`, { botEnabled: false, fullBoard })
      host.stores.set(`/storage/${player}/game`, saved)
      const context = await browser.newContext({ viewport: { width: 420, height: 420 } })
      const page = await context.newPage()
      watchErrors(page, errors)
      await page.goto(`${host.url}/?player=${player}`)
      await page.locator('#app[aria-busy=false]').waitFor()
      await leaveHome(page)
      await page.mouse.move(210, 210)
      return { page, context }
    }
    const normal = await sizeOf(false)
    const small = (await state(normal.page)).view.cell * 8
    assert.equal(await normal.page.locator('#bars-toggle').isVisible(), false, 'no button unless the option is on')
    await normal.context.close()
    const full = await sizeOf(true)
    const page = full.page
    const big = (await state(page)).view
    assert.ok(big.cell * 8 > small + 40, `the board is bigger with the option on: ${big.cell * 8} against ${small}`)
    assert.ok(big.cell * 8 >= 396, 'in a square panel the board is the whole panel')
    await page.waitForFunction(() => !JSON.parse(window.render_game_to_text()).layout.bars, null, { timeout: 9000 })
    assert.equal(await page.locator('#bars-toggle').isVisible(), true, 'the bars are away; a button brings them back')
    assert.equal(await page.locator('#undo').isVisible(), true, 'they are only transparent')
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('undo')).pointerEvents), 'none', 'hidden bars do not catch clicks meant for the board')
    await page.locator('#bars-toggle').click()
    assert.equal((await state(page)).layout.bars, true)
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('undo')).pointerEvents), 'auto')
    // A menu keeps them open; turning the option off from there restores the normal layout.
    await page.locator('#menu-button').click()
    await page.waitForTimeout(250)
    await page.locator('#full-board').uncheck()
    await page.waitForFunction(() => !JSON.parse(window.render_game_to_text()).layout.fullBoard)
    assert.equal(await page.locator('#bars-toggle').isVisible(), false)
    await page.waitForFunction((limit) => { const v = JSON.parse(window.render_game_to_text()).view; return v.cell * 8 <= limit }, small + 2, { timeout: 4000 })
    assert.ok((await state(page)).view.cell * 8 <= small + 2, 'back to the normal size')
    await page.screenshot({ path: directory + '/full-off.png' })
    await full.context.close()
  }

  // Dragging -----------------------------------------------------------------------------------
  {
    const page = await open()
    await startAs(page, 'w')
    const a = await point(page, 'e2')
    const b = await point(page, 'e4')
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 - 6, { steps: 4 })
    assert.deepEqual((await state(page)).drag, { from: 'e2', over: 'e3' })
    await page.screenshot({ path: directory + '/drag.png' })
    await page.mouse.move(b.x, b.y, { steps: 3 })
    await page.mouse.up()
    assert.deepEqual((await state(page)).moves, ['e2e4'])
    assert.deepEqual((await state(page)).lastMove, { from: 'e2', to: 'e4' })

    // Dropped outside the board: the piece goes back and is let go.
    const fen = (await state(page)).fen
    const box = await page.locator('#board').boundingBox()
    await drag(page, 'g8', { x: box.x + box.width + 40, y: box.y + 20 })
    assert.equal((await state(page)).fen, fen)
    assert.equal((await state(page)).selected, null)

    // A press that moves 2 px is still a click; click-click still plays.
    const g8 = await point(page, 'g8')
    await page.mouse.move(g8.x, g8.y)
    await page.mouse.down()
    await page.mouse.move(g8.x + 2, g8.y + 1)
    await page.mouse.up()
    assert.equal((await state(page)).selected, 'g8')
    await clickSquare(page, 'f6')
    assert.deepEqual((await state(page)).moves, ['e2e4', 'g8f6'])
    // Dropping a piece back on its own square keeps it held; pressing it again lets it go.
    await drag(page, 'd2', { x: (await point(page, 'd2')).x + 10, y: (await point(page, 'd2')).y - 8 })
    assert.equal((await state(page)).selected, 'd2')
    await clickSquare(page, 'd2')
    assert.equal((await state(page)).selected, null)
    await close(page)
  }
  {
    const page = await open({ game: { side: 'w', start: '7k/P7/8/8/8/8/8/7K w - - 0 1', moves: [], cursor: 0 } })
    await drag(page, 'a7', 'a8')
    await page.locator('#promotion').waitFor()
    await page.locator('[data-promotion=n]').click()
    assert.deepEqual((await state(page)).moves, ['a7a8n'])
    await close(page)
  }

  // Arrows and highlights ----------------------------------------------------------------------
  {
    const page = await open()
    await startAs(page, 'w')
    await page.evaluate(() => { window.__menus = []; window.addEventListener('contextmenu', (e) => window.__menus.push(e.defaultPrevented)) })
    await drag(page, 'e2', 'e4', { button: 'right' })
    assert.deepEqual((await state(page)).arrows, [{ from: 'e2', to: 'e4', brush: 'green' }])
    await drag(page, 'g1', 'f3', { button: 'right', modifiers: ['Shift'] })
    await drag(page, 'd1', 'h5', { button: 'right', modifiers: ['Alt'] })
    await drag(page, 'b1', 'c3', { button: 'right', modifiers: ['Control'] })
    assert.deepEqual((await state(page)).arrows.map((a) => a.brush), ['green', 'red', 'yellow', 'blue'])
    await clickSquare(page, 'e5', { button: 'right' })
    await clickSquare(page, 'd5', { button: 'right', modifiers: ['Shift'] })
    assert.deepEqual((await state(page)).highlights, [{ sq: 'e5', brush: 'green' }, { sq: 'd5', brush: 'red' }])
    assert.equal((await state(page)).moves.length, 0, 'the right button never moves a piece')
    assert.ok((await page.evaluate(() => window.__menus)).length > 0)
    assert.ok((await page.evaluate(() => window.__menus)).every(Boolean), 'no context menu over the board')
    await page.screenshot({ path: directory + '/arrows.png' })
    // Drawing the same arrow again removes it.
    await drag(page, 'e2', 'e4', { button: 'right' })
    assert.equal((await state(page)).arrows.length, 3)
    // A left click anywhere on the board clears the marks.
    await clickSquare(page, 'e5')
    assert.deepEqual((await state(page)).arrows, [])
    assert.deepEqual((await state(page)).highlights, [])
    // Playing a move clears them too.
    await drag(page, 'e2', 'e4', { button: 'right' })
    await clickSquare(page, 'd2'); await clickSquare(page, 'd4')
    assert.deepEqual((await state(page)).arrows, [])
    // The middle button does nothing.
    await clickSquare(page, 'e7', { button: 'middle' })
    assert.equal((await state(page)).selected, null)
    // A click that closes a sheet does not touch the board.
    await page.locator('#bot-button').click()
    await page.locator('#bot-sheet').waitFor()
    await clickSquare(page, 'a7') // left of the sheet
    assert.equal(await page.locator('#bot-sheet').isHidden(), true)
    assert.equal((await state(page)).selected, null)
    await close(page)
  }
  for (const palette of ['app', 'ocean', 'walnut', 'slate']) {
    for (const theme of ['dark', 'light']) {
      const page = await open({ settings: { palette }, theme })
      await startAs(page, 'w')
      await drag(page, 'e2', 'e4', { button: 'right' })
      await drag(page, 'g1', 'f3', { button: 'right', modifiers: ['Shift'] })
      await drag(page, 'f1', 'b5', { button: 'right', modifiers: ['Control'] })
      await drag(page, 'd1', 'h5', { button: 'right', modifiers: ['Alt'] })
      await clickSquare(page, 'd5', { button: 'right' })
      await page.mouse.move(5, 5)
      await page.screenshot({ path: `${directory}/arrows-${palette}-${theme}.png` })
      await close(page)
    }
  }

  // Premoves against the bot -------------------------------------------------------------------
  {
    const page = await open({ settings: { botEnabled: true }, gate: true })
    await startAs(page, 'w')
    await clickSquare(page, 'e2'); await clickSquare(page, 'e4')
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).thinking)
    await drag(page, 'g1', 'f3')
    assert.equal((await state(page)).selectionKind, 'move')
    await clickSquare(page, 'f1'); await clickSquare(page, 'c4')
    assert.deepEqual((await state(page)).premoves, ['g1f3', 'f1c4'])
    assert.deepEqual((await state(page)).moves, ['e2e4'], 'premoves wait for the turn')
    await page.mouse.move(5, 5)
    await page.screenshot({ path: directory + '/premove.png' })
    await page.evaluate(() => { window.__botScript = ['e7e5', 'b8c6', 'a7a6']; window.__botGate = false })
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).moves.join(' ') === 'e2e4 e7e5 g1f3 b8c6 f1c4', null, { timeout: 15000 })
    assert.deepEqual((await state(page)).premoves, [])
    await close(page)
  }
  {
    // A premove that is no longer legal cancels the rest of the chain and says so.
    const page = await open({ settings: { botEnabled: true }, gate: true })
    await startAs(page, 'w')
    await clickSquare(page, 'e2'); await clickSquare(page, 'e4')
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).thinking)
    await clickSquare(page, 'e4'); await clickSquare(page, 'e5')
    await clickSquare(page, 'd2'); await clickSquare(page, 'd4')
    assert.deepEqual((await state(page)).premoves, ['e4e5', 'd2d4'])
    await page.evaluate(() => { window.__botGate = true; window.__botScript = ['e7e5'] })
    await page.evaluate(() => { window.__botGate = false })
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).status?.text.includes('Premove no válida'), null, { timeout: 15000 })
    assert.deepEqual((await state(page)).premoves, [])
    assert.deepEqual((await state(page)).moves, ['e2e4', 'e7e5'])
    // Info notices close on their own after about 4 s.
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).status === null, null, { timeout: 5500 })
    // Queued premoves are cancelled by the right button and by a click on an empty square.
    await page.evaluate(() => { window.__botGate = true })
    await clickSquare(page, 'd2'); await clickSquare(page, 'd4')
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).thinking)
    await clickSquare(page, 'g1'); await clickSquare(page, 'f3')
    assert.deepEqual((await state(page)).premoves, ['g1f3'])
    await clickSquare(page, 'a5', { button: 'right' })
    assert.deepEqual((await state(page)).premoves, [])
    assert.deepEqual((await state(page)).highlights, [], 'the right click that cancels does not draw')
    await clickSquare(page, 'g1'); await clickSquare(page, 'f3')
    await clickSquare(page, 'a5')
    assert.deepEqual((await state(page)).premoves, [])
    await close(page)
  }
  {
    // Two people on one board never premove.
    const page = await open()
    await startAs(page, 'w')
    await clickSquare(page, 'e2'); await clickSquare(page, 'e4')
    await clickSquare(page, 'g1')
    assert.equal((await state(page)).selected, null)
    await close(page)
  }

  // Notices ------------------------------------------------------------------------------------
  {
    const page = await open()
    await page.route('**/storage/**', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.continue())
    await startAs(page, 'w')
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).status?.kind === 'error')
    await page.mouse.move(5, 5)
    await page.waitForTimeout(300)
    await page.screenshot({ path: directory + '/toast.png' })
    // The controls below the board stay usable while the notice is up.
    for (const id of ['undo', 'drawer-toggle', 'hint']) {
      const hit = await page.evaluate((target) => {
        const r = document.getElementById(target).getBoundingClientRect()
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button')?.id
      }, id)
      assert.equal(hit, id, `${id} is not covered`)
    }
    await page.locator('#drawer-toggle').click()
    assert.equal(await page.locator('#drawer-toggle').getAttribute('aria-expanded'), 'true')
    await page.locator('#status-close').click()
    assert.equal((await state(page)).status, null)
    await close(page)
  }

  // Beta tag ----------------------------------------------------------------------------------
  {
    const page = await open({ theme: 'light' })
    await startAs(page, 'w')
    assert.match(await page.locator('#online-button').textContent(), /Beta/)
    await page.locator('#online-button').click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: directory + '/beta.png' })
    await close(page)
  }

  assert.deepEqual(errors, [])
  console.log('PASS browser input: sharp canvas at 1/1.25/1.5/2x and live zoom, no blank resize, drag/drop, click-click, promotion by drag, arrows/highlights with 4 brushes, no context menu, sheet click, premove chain vs bot, invalid premove cancel, cancel by right/empty click, notices with X not covering controls, Beta tag.')
} catch (error) {
  console.error('Browser errors:', errors)
  throw error
} finally { await browser.close(); await host.close() }
