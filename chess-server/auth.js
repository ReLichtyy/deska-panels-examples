// Verifies the token a panel gets from deska.account.token(), as described in
// https://deska.dev/docs/panel-sign-in: an ES256 JWT signed by Deska, checked against Deska's
// published keys, for this server's audience only. Web Crypto only, so it runs in Workers and Node.

export class AuthError extends Error {
  constructor(reason, detail) { super(reason); this.name = 'AuthError'; this.reason = reason; this.detail = detail }
}

export const DESKA_ISSUER = 'https://deska.dev'
export const DESKA_JWKS = 'https://deska.dev/.well-known/jwks.json'
const SKEW_S = 30
const KEY_REFETCH_MS = 60_000
const KEY_CACHE_MS = 10 * 60_000
const DEV_AUDIENCE = /^dev-[0-9a-f]{12}$/

const decoder = new TextDecoder()
const encoder = new TextEncoder()

function base64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new AuthError('malformed')
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function json(text) {
  try {
    const value = JSON.parse(decoder.decode(base64url(text)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw error instanceof AuthError ? error : new AuthError('malformed')
  }
}

/**
 * audiences:    package ids this server accepts for production tokens.
 * allowDev:     accept development tokens (dev: true) from loaded folders. Development servers only.
 * devAudiences: the folder keys (dev- plus twelve hex characters) whose development tokens are accepted.
 *               Pinned on purpose: any other developer's folder gets tokens too.
 * Returns verify(authorizationHeader) -> { sub, aud, dev, name? }; throws AuthError.
 */
export function createVerifier({
  audiences = [], allowDev = false, devAudiences = [], issuer = DESKA_ISSUER, jwksUrl = DESKA_JWKS,
  fetchJson = async (url) => { const response = await fetch(url, { redirect: 'error' }); if (!response.ok) throw new Error(`jwks ${response.status}`); return response.json() },
  now = Date.now,
} = {}) {
  const production = new Set(audiences)
  const development = new Set(allowDev ? devAudiences : [])
  for (const aud of development) if (!DEV_AUDIENCE.test(aud)) throw new Error(`Invalid development audience: ${aud}`)
  let keys = new Map() // kid -> CryptoKey
  let fetchedAt = 0
  let loading = null

  async function refresh() {
    // One fetch at a time, and not more than once a minute, so a stream of unknown key ids
    // cannot turn this server into a way to hammer deska.dev.
    if (loading) return loading
    if (now() - fetchedAt < KEY_REFETCH_MS && keys.size) return
    loading = (async () => {
      const set = await fetchJson(jwksUrl)
      if (!set || !Array.isArray(set.keys)) throw new Error('jwks malformed')
      const next = new Map()
      for (const jwk of set.keys) {
        if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.kid !== 'string') continue
        try {
          next.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
            { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']))
        } catch { /* an unusable key is skipped, not fatal */ }
      }
      keys = next
      fetchedAt = now()
    })().finally(() => { loading = null })
    return loading
  }

  async function keyFor(kid) {
    if (now() - fetchedAt > KEY_CACHE_MS) fetchedAt = 0
    if (!fetchedAt || !keys.has(kid)) {
      try { await refresh() } catch (error) { throw new AuthError('keys_unavailable', error.message) }
    }
    const key = keys.get(kid)
    if (!key) throw new AuthError('unknown_key')
    return key
  }

  return async function verify(authorization) {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization || '')
    if (!match || match[1].length > 4096) throw new AuthError('missing')
    const [head, body, signature] = match[1].split('.')
    const header = json(head)
    if (header.alg !== 'ES256' || header.typ !== 'JWT' || typeof header.kid !== 'string') throw new AuthError('header')
    const bytes = base64url(signature)
    if (bytes.length !== 64) throw new AuthError('signature')
    const key = await keyFor(header.kid)
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, encoder.encode(`${head}.${body}`))
    if (!valid) throw new AuthError('signature')

    const claims = json(body)
    const seconds = Math.floor(now() / 1000)
    if (claims.iss !== issuer) throw new AuthError('issuer')
    const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud
    if (typeof aud !== 'string') throw new AuthError('audience')
    if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < seconds) throw new AuthError('expired')
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf - SKEW_S > seconds)) throw new AuthError('not_yet_valid')
    if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat - SKEW_S > seconds)) throw new AuthError('not_yet_valid')
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 200) throw new AuthError('subject')

    const dev = claims.dev === true
    // A development token and a production token are different things: a dev token never passes
    // as production, and a production audience never passes a dev token.
    if (dev ? !development.has(aud) : !production.has(aud)) {
      throw new AuthError(dev ? 'dev_audience' : 'audience', aud) // the audience is not secret; it lets a developer pin theirs
    }
    // `name` exists only when the person chose to share it with this panel. It is data, not an identity: sub is.
    return { sub: claims.sub, aud, dev, name: typeof claims.name === 'string' ? claims.name : undefined }
  }
}
