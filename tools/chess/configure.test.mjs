import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('configuration creates an SDK 4 folder without overwriting source or an existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chess-config-test-'))
  const output = join(root, 'panel')
  const script = fileURLToPath(new URL('./configure.mjs', import.meta.url))
  const original = await readFile(new URL('../../panels/chess/panel.json', import.meta.url), 'utf8')
  const run = () => spawnSync(process.execPath, [script, 'https://chess.example', 'https://chess.example/privacy', output], { encoding: 'utf8' })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  const manifest = JSON.parse(await readFile(join(output, 'panel.json'), 'utf8'))
  assert.equal(manifest.sdk, 4)
  assert.deepEqual(manifest.permissions, ['account'])
  assert.deepEqual(manifest.network, ['chess.example'])
  assert.equal(manifest.account.privacy, 'https://chess.example/privacy')
  assert.equal(manifest.id, 'chess-online')
  assert.notEqual(run().status, 0)
  assert.equal(await readFile(new URL('../../panels/chess/panel.json', import.meta.url), 'utf8'), original)
})
