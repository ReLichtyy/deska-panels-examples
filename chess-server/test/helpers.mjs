// Test helpers: a stand-in for Deska's signing keys, so tokens are real ES256 JWTs but nothing
// touches deska.dev. TEST ONLY.
import { createVerifier } from '../auth.js'
import { createService } from '../core.js'

const encoder = new TextEncoder()
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64json = (value) => b64(encoder.encode(JSON.stringify(value)))

export async function makeIssuer(kid = 'key-1') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'ES256', use: 'sig' }
  return {
    kid, jwk, pair,
    async sign(claims, { header = {}, key = pair.privateKey } = {}) {
      const head = b64json({ alg: 'ES256', typ: 'JWT', kid, ...header })
      const body = b64json(claims)
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${head}.${body}`))
      return `${head}.${body}.${b64(signature)}`
    },
  }
}

export const AUD = 'chess-online'
export const DEV_AUD = 'dev-0123456789ab'

/** A clock tests can move. */
export function clock(start = Date.parse('2026-10-19T12:00:00Z')) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms } }
  return c
}

export function memoryStore() {
  const data = new Map()
  return {
    data,
    get: async (key) => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async (key) => data.delete(key),
    list: async (prefix) => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]),
  }
}

export async function setup({ verifierOptions = {}, time = clock() } = {}) {
  const issuer = await makeIssuer()
  const fetches = { count: 0 }
  const verifier = createVerifier({
    audiences: [AUD], now: time.now,
    fetchJson: async () => { fetches.count++; return { keys: [issuer.jwk] } },
    ...verifierOptions,
  })
  const store = memoryStore()
  const quiet = { warn() {}, error() {} }
  const service = createService({ store, verifier, now: time.now, log: quiet })
  const claims = (sub, extra = {}) => ({
    iss: 'https://deska.dev', aud: AUD, sub, iat: Math.floor(time.t / 1000), exp: Math.floor(time.t / 1000) + 30 * 86400, ...extra, // long enough for tests that move the clock by days
  })
  const token = async (sub, extra, options) => issuer.sign(claims(sub, extra), options)
  // A fetch-shaped function for one signed-in person, the shape the panel's client expects.
  const as = async (sub) => {
    const bearer = await token(sub)
    return (url, init = {}) => service.handle(new Request(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${bearer}` } }))
  }
  return { issuer, verifier, service, store, time, fetches, claims, token, as }
}

export const call = (service, method, path, { token, body } = {}) => service.handle(new Request(`https://chess.example${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}))

export const uuid = () => crypto.randomUUID()
