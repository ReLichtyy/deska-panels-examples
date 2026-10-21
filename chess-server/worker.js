// Cloudflare Worker entry. One Durable Object ("hub") owns all the rooms, so every change is
// applied one at a time with no extra locking. Configuration comes from wrangler.toml variables.
import { createService } from './core.js'
import { createVerifier } from './auth.js'

const list = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)

export class Hub {
  constructor(state, env) {
    const verifier = createVerifier({
      audiences: list(env.AUDIENCES),
      allowDev: env.ALLOW_DEV_TOKENS === 'true',
      devAudiences: list(env.DEV_AUDIENCES),
    })
    this.service = createService({
      verifier,
      store: {
        get: (key) => state.storage.get(key),
        put: (key, value) => state.storage.put(key, value),
        delete: (key) => state.storage.delete(key),
        list: async (prefix) => [...(await state.storage.list({ prefix }))],
      },
    })
  }

  fetch(request) { return this.service.handle(request) }
}

export default {
  fetch(request, env) {
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(request)
  },
}
