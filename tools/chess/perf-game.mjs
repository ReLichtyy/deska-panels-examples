// Perf probe: plays against the bot and records frame gaps while the person's move slides
// and the bot thinks. Usage: node tools/chess/perf-game.mjs [rating] [cpuThrottle]
import { chromium } from 'playwright'
import { startTestHost } from './test-host.mjs'
import { leaveHome, clickSquare, state } from './browser-helpers.mjs'

const rating = Number(process.argv[2] || 2000)
const throttle = Number(process.argv[3] || 2)
const host = await startTestHost()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 720 } })
  await page.goto(host.url + '/?player=w')
  await page.locator('#app[aria-busy=false]').waitFor()
  await leaveHome(page, { bot: true })
  const chooser = page.locator('[data-side=w]')
  if (await chooser.isVisible().catch(() => false)) await chooser.click()
  await page.locator('#bot-button').click()
  await page.evaluate((value) => {
    const input = document.getElementById('bot-rating')
    input.value = String(value)
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new Event('change'))
  }, rating)
  await page.locator('[aria-label="Cerrar Dex"]').click()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })

  // Records every frame gap until the bot has answered.
  const watch = () => page.evaluate(() => new Promise((resolve) => {
    const gaps = []
    let last = performance.now()
    const start = last
    const frame = (now) => {
      gaps.push(now - last)
      last = now
      const s = JSON.parse(window.render_game_to_text())
      if ((s.turn === 'w' && now - start > 300) || now - start > 8000) resolve({ gaps, ms: now - start })
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }))

  const tracing = process.argv.includes('--trace')
  if (tracing) await browser.startTracing(page, { categories: ['devtools.timeline', 'v8', 'disabled-by-default-devtools.timeline'] })
  const line = [['e2', 'e4'], ['g1', 'f3'], ['f1', 'c4'], ['d2', 'd3'], ['b1', 'c3'], ['c1', 'g5']]
  const all = []
  for (const [from, to] of line) {
    const s = await state(page)
    if (s.turn !== 'w') break
    const legal = await page.evaluate(([a, b]) => true, [from, to])
    const watching = watch()
    await clickSquare(page, from)
    await clickSquare(page, to)
    const { gaps, ms } = await watching
    const long = gaps.filter((g) => g > 50)
    all.push(...gaps)
    console.log(`${from}${to}: answer in ${ms.toFixed(0)} ms, worst frame ${Math.max(...gaps).toFixed(0)} ms, frames > 50 ms: ${long.length}`)
  }
  const sorted = all.sort((a, b) => a - b)
  console.log(`rating ${rating}, cpu x${throttle}: p50 ${sorted[sorted.length >> 1].toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms, max ${sorted.at(-1).toFixed(0)} ms`)
  console.log('moves', (await state(page)).moves.join(' '))
  if (tracing) {
    // The longest main-thread tasks, with what took the time inside each.
    const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents
    const main = events.find((e) => e.name === 'thread_name' && e.args.name === 'CrRendererMain')
    const onMain = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X')
    const tasks = onMain.filter((e) => e.name === 'RunTask' && e.dur > 40000).sort((a, b) => b.dur - a.dur).slice(0, 6)
    for (const task of tasks) {
      const inside = {}
      for (const e of onMain) {
        if (e === task || e.ts < task.ts || e.ts + e.dur > task.ts + task.dur) continue
        inside[e.name] = (inside[e.name] || 0) + e.dur / 1000
      }
      const top = Object.entries(inside).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')
      console.log(`task ${(task.dur / 1000).toFixed(0)} ms: ${top}`)
    }
  }
} finally {
  await browser.close()
  await host.close?.()
}
