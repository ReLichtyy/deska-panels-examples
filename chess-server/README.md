# Chess Online server

The service behind Chess Online: private rooms, moves confirmed by the rules, and who is connected.
It implements the contract in [`panels/chess/ONLINE.md`](../panels/chess/ONLINE.md) and is written for
Cloudflare Workers with one Durable Object, but `core.js` and `auth.js` use only Web APIs, so another
host works the same way.

**Nothing here is deployed.** Putting it online is a step you take with your own account.

## Files

| File | Role |
| --- | --- |
| `auth.js` | Verifies the Deska token: ES256, `typ`, `kid` against `https://deska.dev/.well-known/jwks.json` (cached, refetched for an unknown `kid`, at most once a minute), `iss`, `aud`, `exp`, `sub`. |
| `core.js` | Routes, rooms, presence, rate limits. Takes a key-value store and a verifier; answers `Request` with `Response`. |
| `worker.js` | Cloudflare entry and the `Hub` Durable Object (one instance, so changes apply one at a time). |
| `wrangler.toml` | Configuration and the Durable Object migration. |
| `test/` | Auth, service, home (names, search, recent rivals, challenges) and a contract test where the panel's real client plays through this code. |

The rules come from `../panels/chess/rules.js`, the same file the panel uses, so the server and the
board can never disagree about what is legal. Keep that relative path when you move or bundle the server.

## Test (no network, no account)

```powershell
node --test chess-server/test/*.test.mjs
```

Tokens are real ES256 JWTs signed with a key made by the tests; Deska is not contacted.

## Deploy and connect

1. From this folder: `npx wrangler login`, then `npx wrangler deploy`. Cloudflare gives you
   `https://chess-online-server.<your-subdomain>.workers.dev`.
2. A privacy policy page on any https host (a GitHub Pages page works). Deska requires its address.
3. From the repository root, create the loaded folder:
   `node tools/chess/configure.mjs https://chess-online-server.<sub>.workers.dev https://<site>/privacy <CARPETA-NUEVA>`
4. In Deska: Panel Library, Build a panel, Load a folder, choose that folder.
5. Development tokens: a loaded folder signs in with development tokens whose audience is the folder's
   key (`dev-` plus 12 hex characters), not `chess-online`. Press "Entrar con Deska" once; the server
   rejects it and logs the audience (`npx wrangler tail`, line `auth rejected: dev_audience dev-...`).
   Put that value in `wrangler.toml` as `DEV_AUDIENCES`, set `ALLOW_DEV_TOKENS = "true"`, deploy again and
   sign in. Pinning the audience matters: any other developer's loaded folder also gets development tokens.
6. Publishing for everyone is a different path: Deska reviews every panel that signs people in, and the
   registered package id goes in `AUDIENCES` with `ALLOW_DEV_TOKENS = "false"`.

## What it stores and what it does not

- A player is `sha256(audience + subject)` truncated, never the raw `sub`; a random alias such as
  "Alfil Azul 42" is made for them. Email is never requested or kept.
- The name is optional and the person's choice: the panel asks Deska with `signIn({ name: true })` and the token
  carries `name` only if they ticked it. The server keeps a cleaned display name (letters, digits, spaces and
  `._'-`, 24 characters), follows the token (it is dropped when the token stops carrying it) and shows it to other
  players: in presence, in rooms, in recent rivals and in search. Search only finds people who shared a name
  (3 letters at least, 20 a minute). The privacy policy you publish must say this.
- Recent rivals (up to 20 ids per player) and challenges (24 hours, 5 sent at a time) are stored to feed the
  home screen.
- Rooms: code, both player ids, the move list, status, revision. Waiting rooms are dropped after a day,
  all rooms a week after their last change.
- Presence is memory only and expires after 90 s without a beat.
- Logs never contain tokens, bodies or headers. A rejected token logs only the reason (and the audience claim).

## Limits and open items

- Verified by tests: token checks, CORS, ownership, turn, legality, revision conflicts, repeated requests,
  expiry, rate limits (120 requests a minute per player, 10 joins, 10 rooms) and the panel client end to end.
- **Not verified:** the Cloudflare glue (`worker.js`, `wrangler.toml`, the migration) was only exercised
  with a simulated `state.storage`, not in the Workers runtime or with a real Deska token.
- Rules gaps inherited from `rules.js`: no threefold repetition or insufficient material beyond bare kings;
  no resign, draw offers or clocks.
- Before publishing: account deletion and the signed events Deska posts when someone revokes access
  (declare `events` in `panel.json`), and a choice of alias by the player. Deska says what the policy must contain.
