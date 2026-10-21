import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BRUSHES, BRUSH_ALPHA, HALO, PALETTES, appPalette, brushFor, composite, contrast, normalizeColor, readableInk, tint, toggleArrow, toggleHighlight } from '../../panels/chess/marks.js'

const sq = (f, r) => ({ f, r })
test('drawing the same arrow again removes it; another brush recolors it', () => {
  let list = toggleArrow([], { from: sq(4, 1), to: sq(4, 3), brush: 'green' })
  assert.equal(list.length, 1)
  list = toggleArrow(list, { from: sq(4, 1), to: sq(4, 3), brush: 'red' })
  assert.deepEqual(list.map((a) => a.brush), ['red'])
  list = toggleArrow(list, { from: sq(6, 0), to: sq(5, 2), brush: 'green' })
  assert.equal(list.length, 2)
  list = toggleArrow(list, { from: sq(4, 1), to: sq(4, 3), brush: 'red' })
  assert.deepEqual(list.map((a) => a.brush), ['green'])
})
test('square highlights toggle the same way', () => {
  let list = toggleHighlight([], { ...sq(3, 3), brush: 'green' })
  list = toggleHighlight(list, { ...sq(3, 3), brush: 'blue' })
  assert.deepEqual(list, [{ f: 3, r: 3, brush: 'blue' }])
  assert.deepEqual(toggleHighlight(list, { ...sq(3, 3), brush: 'blue' }), [])
})
test('modifier keys pick the brush', () => {
  assert.equal(brushFor({}), 'green')
  assert.equal(brushFor({ shiftKey: true }), 'red')
  assert.equal(brushFor({ ctrlKey: true }), 'blue')
  assert.equal(brushFor({ metaKey: true }), 'blue')
  assert.equal(brushFor({ altKey: true }), 'yellow')
})
test('every brush reads against its halo, and the halo against every square of every palette', async () => {
  const themes = JSON.parse(await readFile(new URL('../preview/themes.json', import.meta.url), 'utf8'))
  const palettes = { ...PALETTES, ...Object.fromEntries(Object.entries(themes).map(([name, t]) => [`app-${name}`, appPalette(t['--deska-accent'])])) }
  const [, hr, hg, hb, ha] = HALO.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
  const haloHex = `#${[hr, hg, hb].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
  for (const [name, palette] of Object.entries(palettes)) {
    for (const square of [palette.light, palette.dark]) {
      const halo = composite(haloHex, Number(ha), square)
      const haloHexOn = `#${halo.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
      for (const [brush, color] of Object.entries(BRUSHES)) {
        const body = composite(color, BRUSH_ALPHA, haloHexOn)
        // The colored line is told apart from its own dark edge; the edge or the line is told apart from the square.
        assert.ok(contrast(body, halo) >= 2.5, `${brush} vs halo on ${name} ${square}: ${contrast(body, halo).toFixed(2)}`)
        const visible = Math.max(contrast(halo, square), contrast(composite(color, BRUSH_ALPHA, square), square))
        assert.ok(visible >= 2, `${brush} on ${name} ${square}: ${visible.toFixed(2)}`)
      }
    }
  }
})

test('rgb() colors from Deska and every other common form become #rrggbb', () => {
  for (const [input, expected] of [
    ['rgb(255, 122, 92)', '#ff7a5c'], ['rgb(255 122 92)', '#ff7a5c'], ['rgba(255, 122, 92, 0.5)', '#ff7a5c'],
    ['rgb(255 122 92 / 50%)', '#ff7a5c'], ['rgb(100%, 0%, 50%)', '#ff0080'], ['  RGB(1,2,3) ', '#010203'],
    ['#FF7A5C', '#ff7a5c'], ['#f7c', '#ff77cc'], ['#ff7a5c80', '#ff7a5c'], ['rgb(300, -5, 12.6)', '#ff000d'],
  ]) assert.equal(normalizeColor(input), expected, input)
  for (const bad of ['', 'coral', 'rgb(1, 2)', 'rgb(a, b, c)', '#12', '#12345', 'var(--x)', 'color-mix(in srgb, red, blue)', null, undefined, 42]) {
    assert.equal(normalizeColor(bad), null, String(bad))
  }
})

test('the default board palette follows the accent whatever form it arrives in', () => {
  const fromHex = appPalette('#ff7a5c')
  assert.deepEqual(appPalette('rgb(255, 122, 92)'), fromHex)
  assert.deepEqual(fromHex, { dark: '#ff7a5c', light: tint('#ff7a5c', 0.86) })
  assert.notEqual(appPalette('rgb(40, 120, 200)').light, '#f7e9e3', 'another accent gives another light square, not the old fixed one')
  assert.equal(tint('rgb(40, 120, 200)', 0.86), tint('#2878c8', 0.86))
  assert.equal(tint('not a color', 0.5), '#f7e9e3')
})

test('the accent as ink: kept when it reads on the ground, moved toward the readable end when it does not', () => {
  const dark = '#15171a'
  assert.equal(readableInk('#ff7a5c', dark), '#ff7a5c', 'coral reads on a dark ground')
  const teal = readableInk('#0c434b', dark)
  assert.notEqual(teal, '#0c434b')
  assert.ok(contrast(teal, dark) >= 3, `a dark teal accent is lightened to ${teal}`)
  assert.ok(contrast(readableInk('#ffe08a', '#e9e3d9'), '#e9e3d9') >= 3, 'a pale accent is darkened on a light ground')
  assert.equal(readableInk('#0c434b', '#e9e3d9'), '#0c434b', 'the same teal reads on a light ground')
  assert.equal(readableInk('rgb(12, 67, 75)', dark), teal, 'rgb() in, same ink out')
  assert.equal(readableInk('nonsense', dark), null)
})
