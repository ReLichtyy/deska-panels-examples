// Perf probe: measures board paint cost, held-piece loop, drag and bot-thinking main-thread blocking.
import { chromium } from 'playwright'
import { startTestHost } from './test-host.mjs'
import { leaveHome, point } from './browser-helpers.mjs'

const host = await startTestHost()
const browser = await chromium.launch()
const results = {}
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 720 }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    window.__draws = []
    const clear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'board') { const t = performance.now(); queueMicrotask(() => window.__draws.push(performance.now() - t)) }
      return clear.apply(this, args)
    }
  })
  await page.goto(host.url + '/?player=w')
  await page.locator('#app[aria-busy=false]').waitFor()
  await leaveHome(page, { bot: false })
  const chooser = page.locator('[data-side=w]')
  if (await chooser.isVisible().catch(() => false)) await chooser.click()

  // Long-task + frame observer installed in page.
  await page.evaluate(() => {
    window.__long = []
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration) }).observe({ type: 'longtask', buffered: true })
    window.__frames = (ms) => new Promise((res) => {
      const t = []; let last = performance.now(); const end = last + ms
      const f = (now) => { t.push(now - last); last = now; now < end ? requestAnimationFrame(f) : res(t) }
      requestAnimationFrame(f)
    })
  })
  const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, p50: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s.at(-1).toFixed(2) } }

  // 1) Held piece: continuous rAF loop. Measure frame intervals while CPU throttled 4x.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const e2 = await point(page, 'e2')
  await page.mouse.click(e2.x, e2.y)
  await page.evaluate(() => { window.__draws = [] })
  results.heldFrames = stats(await page.evaluate(() => window.__frames(2000)))
  results.heldDraws4xCPU = stats(await page.evaluate(() => window.__draws))
  results.selected = await page.evaluate(() => JSON.parse(window.render_game_to_text()).selected ?? null)
  await page.evaluate(() => { window.__draws = [] })

  // 2) Drag across the board.
  const a = await point(page, 'g1'), b = await point(page, 'f3')
  await page.mouse.click(5, 5)
  const dragFrames = page.evaluate(() => window.__frames(1500))
  await page.mouse.move(a.x, a.y); await page.mouse.down()
  for (let i = 0; i < 60; i++) await page.mouse.move(a.x + (b.x - a.x) * (i / 60) + Math.sin(i) * 10, a.y + (b.y - a.y) * (i / 60))
  await page.mouse.up()
  results.dragFrames = stats(await dragFrames)
  results.dragDraws4xCPU = stats(await page.evaluate(() => window.__draws))

  // 3) Hint (engine depth 4, full strength) — main thread blocking.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await page.evaluate(() => { window.__long = [] })
  const hintFrames = page.evaluate(() => window.__frames(2500))
  await page.locator('#hint').click()
  results.hintFrames = stats(await hintFrames)
  results.hintLongTasks = await page.evaluate(() => ({ count: window.__long.length, max: Math.max(0, ...window.__long), total: window.__long.reduce((s, x) => s + x, 0) }))

  // 4) Raw paint cost of one full board.draw, with and without the CSS drop-shadow.
  results.engineYield = await page.evaluate(async () => {
    const t0 = performance.now(); let n = 0
    while (n < 200) { await new Promise((r) => setTimeout(r, 0)); n++ }
    return { setTimeout0_x200_ms: +(performance.now() - t0).toFixed(1) }
  })
  // 5) Engine: wall time and longest main-thread block per search, midgame position.
  results.engine = await page.evaluate(async () => {
    const { chooseMove } = await import('./engine.js')
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 8'
    const out = {}
    for (const [label, opts] of [['bot1200', { depth: 3, timeMs: 1500 }], ['hint', { depth: 4, timeMs: 1200 }], ['bot2000', { depth: 5, timeMs: 2800 }]]) {
      let last = performance.now(), worst = 0, gaps = 0
      let running = true
      const mc = new MessageChannel()
      mc.port1.onmessage = () => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; gaps++; if (running) mc.port2.postMessage(0) }
      mc.port2.postMessage(0)
      const t0 = performance.now()
      const move = await chooseMove(fen, opts)
      running = false
      out[label] = { move, wallMs: +(performance.now() - t0).toFixed(0), longestBlockMs: +worst.toFixed(0) }
    }
    return out
  })
  // 6) Paint cost: board.draw per frame (no throttle), via held-piece loop timing in a long task observer.
  await cdp.send('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const sample = async (label, ms) => {
    const m0 = await metrics()
    await page.waitForTimeout(ms)
    const m1 = await metrics()
    const d = (k) => +(((m1[k] - m0[k]) * 1000) / (ms / 1000)).toFixed(1) // ms per second
    results[label] = { scriptMsPerSec: d('ScriptDuration'), taskMsPerSec: d('TaskDuration'), styleMsPerSec: d('RecalcStyleDuration'), layoutMsPerSec: d('LayoutDuration') }
  }
  await page.mouse.click(5, 5)
  await page.waitForTimeout(300)
  await sample('idle', 2000)
  const d2 = await point(page, 'd2')
  await page.mouse.click(d2.x, d2.y)
  await sample('heldPiece', 2000)
  results.canvas = await page.evaluate(() => [document.getElementById('board').width, document.getElementById('board').height])
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
  await host.close?.()
}
