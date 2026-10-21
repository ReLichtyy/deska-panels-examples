// Shared Playwright helpers for the chess panel. Geometry comes from the panel itself
// (window.chess_square_point), so the tests never copy the board's layout math.

export const state = (page) => page.evaluate(() => JSON.parse(window.render_game_to_text()))

export const point = (page, square) => page.evaluate((name) => window.chess_square_point(name), square)

export async function clickSquare(page, square, { modifiers = [], ...options } = {}) {
  const p = await point(page, square)
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(p.x, p.y, options)
  for (const key of modifiers) await page.keyboard.up(key)
}

/** Presses on one square, moves in steps and releases on another square or { x, y } point. */
export async function drag(page, from, to, { button = 'left', steps = 6, modifiers = [] } = {}) {
  const a = await point(page, from)
  const b = typeof to === 'string' ? await point(page, to) : to
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down({ button })
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up({ button })
  for (const key of modifiers) await page.keyboard.up(key)
}

/** Records page errors and console errors; ignores failed requests the test caused on purpose. */
export function watchErrors(page, errors, ignore = /503|500/) {
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (event) => {
    if (event.type() === 'error' && !ignore.test(event.text())) errors.push(event.text())
  })
}

/**
 * The home screen opens every time the panel does. Leaves it for the board: the X when a game is
 * waiting, otherwise a new game ({ bot: true } against the bot, by default on one board).
 */
export async function leaveHome(page, { bot = null } = {}) {
  await page.locator('#home').waitFor({ state: 'visible' })
  const close = page.locator('#home-close')
  if (bot === null && await close.isVisible()) await close.click()
  else await page.locator(bot ? '#home-bot' : '#home-two').click()
  await page.locator('#home').waitFor({ state: 'hidden' })
}
