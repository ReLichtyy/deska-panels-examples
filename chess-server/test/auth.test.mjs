import test from 'node:test'
import assert from 'node:assert/strict'
import { AUD, DEV_AUD, makeIssuer, setup } from './helpers.mjs'
import { createVerifier } from '../auth.js'

const reason = async (promise) => { try { await promise; return null } catch (error) { return error.reason } }

test('a valid token gives the account subject and nothing else', async () => {
  const s = await setup()
  const verified = await s.verifier(`Bearer ${await s.token('acct-1')}`)
  assert.deepEqual(verified, { sub: 'acct-1', aud: AUD, dev: false, name: undefined })
  assert.equal((await s.verifier(`Bearer ${await s.token('acct-1', { name: 'Joshua' })}`)).name, 'Joshua')
})

test('missing, malformed and unsigned tokens are refused', async () => {
  const s = await setup()
  for (const header of [undefined, '', 'Bearer', 'Bearer a.b', 'Basic abc', 'Bearer a.b.c.d', `Bearer ${'x'.repeat(5000)}.a.b`]) {
    assert.equal(await reason(s.verifier(header)), 'missing')
  }
  const head = btoa(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'key-1' })).replace(/=+$/, '')
  const body = btoa(JSON.stringify(s.claims('x'))).replace(/=+$/, '')
  assert.equal(await reason(s.verifier(`Bearer ${head}.${body}.AAAA`)), 'header')
})

test('wrong algorithm, type or key id in the header are refused', async () => {
  const s = await setup()
  assert.equal(await reason(s.verifier(`Bearer ${await s.token('a', {}, { header: { alg: 'HS256' } })}`)), 'header')
  assert.equal(await reason(s.verifier(`Bearer ${await s.token('a', {}, { header: { typ: 'JOSE' } })}`)), 'header')
  assert.equal(await reason(s.verifier(`Bearer ${await s.token('a', {}, { header: { kid: 'other' } })}`)), 'unknown_key')
})

test('a token signed by another key, or altered after signing, is refused', async () => {
  const s = await setup()
  const stranger = await makeIssuer('key-1') // same key id, different key
  assert.equal(await reason(s.verifier(`Bearer ${await stranger.sign(s.claims('a'))}`)), 'signature')
  const [head, , signature] = (await s.token('a')).split('.')
  const forged = btoa(JSON.stringify(s.claims('admin'))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  assert.equal(await reason(s.verifier(`Bearer ${head}.${forged}.${signature}`)), 'signature')
})

test('issuer, audience, expiry, subject and not-before are enforced', async () => {
  const s = await setup()
  const t = Math.floor(s.time.t / 1000)
  const cases = [
    [{ iss: 'https://evil.example' }, 'issuer'],
    [{ aud: 'some-other-panel' }, 'audience'],
    [{ aud: undefined }, 'audience'],
    [{ exp: t - 120 }, 'expired'],
    [{ exp: undefined }, 'expired'],
    [{ sub: '' }, 'subject'],
    [{ sub: 'x'.repeat(201) }, 'subject'],
    [{ nbf: t + 3600 }, 'not_yet_valid'],
  ]
  for (const [extra, expected] of cases) assert.equal(await reason(s.verifier(`Bearer ${await s.token('a', extra)}`)), expected, JSON.stringify(extra))
  // A few seconds of clock skew is tolerated.
  assert.equal(await reason(s.verifier(`Bearer ${await s.token('a', { exp: t - 10 })}`)), null)
})

test('development tokens never pass as production, and need an allowed, pinned audience', async () => {
  const closed = await setup()
  assert.equal(await reason(closed.verifier(`Bearer ${await closed.token('a', { aud: DEV_AUD, dev: true })}`)), 'dev_audience')
  const open = await setup({ verifierOptions: { allowDev: true, devAudiences: [DEV_AUD] } })
  assert.equal((await open.verifier(`Bearer ${await open.token('a', { aud: DEV_AUD, dev: true })}`)).dev, true)
  // Someone else's folder key is refused, and the refused audience is reported for debugging.
  const other = await reason(open.verifier(`Bearer ${await open.token('a', { aud: 'dev-ffffffffffff', dev: true })}`))
  assert.equal(other, 'dev_audience')
  // A dev audience without dev: true is not a dev token, and is not a production audience either.
  assert.equal(await reason(open.verifier(`Bearer ${await open.token('a', { aud: DEV_AUD })}`)), 'audience')
  // A production token still works on a server that also allows development.
  assert.equal((await open.verifier(`Bearer ${await open.token('a')}`)).dev, false)
  assert.throws(() => createVerifier({ allowDev: true, devAudiences: ['chess-online'] }), /Invalid development audience/)
})

test('keys are cached, refetched for an unknown key id, and refetching is throttled', async () => {
  const s = await setup()
  await s.verifier(`Bearer ${await s.token('a')}`)
  await s.verifier(`Bearer ${await s.token('b')}`)
  assert.equal(s.fetches.count, 1)
  const unknown = await s.token('a', {}, { header: { kid: 'rotated' } })
  assert.equal(await reason(s.verifier(`Bearer ${unknown}`)), 'unknown_key')
  assert.equal(s.fetches.count, 1, 'no refetch inside a minute')
  s.time.advance(61_000)
  assert.equal(await reason(s.verifier(`Bearer ${unknown}`)), 'unknown_key')
  assert.equal(s.fetches.count, 2)
})

test('when Deska keys cannot be fetched the answer is "unavailable", not a pass', async () => {
  const s = await setup({ verifierOptions: { fetchJson: async () => { throw new Error('offline') } } })
  assert.equal(await reason(s.verifier(`Bearer ${await s.token('a')}`)), 'keys_unavailable')
})

test('a revoked key is dropped once the key cache expires', async () => {
  let keys
  const s = await setup({ verifierOptions: { fetchJson: async () => ({ keys }) } })
  keys = [s.issuer.jwk]
  const tok = await s.token('a', { exp: Math.floor(s.time.t / 1000) + 3600 })
  await s.verifier(`Bearer ${tok}`)
  keys = []
  s.time.advance(11 * 60_000)
  assert.equal(await reason(s.verifier(`Bearer ${tok}`)), 'unknown_key')
})
