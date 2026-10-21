// Prepare a distinct development package; never edit Deska's installed package/registry.
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiOrigin } from '../../panels/chess/online-client.js'

const args = process.argv.slice(2)
if (args.length !== 3) {
  console.error('Usage: node tools/chess/configure.mjs https://your-api-host https://your-site/privacy NEW_OUTPUT_FOLDER')
  process.exit(1)
}
const [api, privacy, output] = args
const apiUrl = apiOrigin(api)
const privacyUrl = new URL(privacy)
apiOrigin(privacyUrl.origin)
if (privacyUrl.username || privacyUrl.password || privacyUrl.hash || privacy.length > 2048) throw new Error('Invalid privacy URL')
const source = fileURLToPath(new URL('../../panels/chess/', import.meta.url))
const destination = resolve(output)
const manifest = JSON.parse(await readFile(join(source, 'panel.json'), 'utf8'))
Object.assign(manifest, {
  id: 'chess-online', name: 'Chess Online', version: '0.1.0',
  description: 'Ajedrez local y salas privadas con acceso mediante Deska.',
  author: 'Joshua · basado en Pasho', sdk: 4, permissions: ['account'],
  network: [new URL(apiUrl).hostname], account: { privacy: privacyUrl.href },
})
// Fails if the output already exists, so another panel can never be overwritten.
await mkdir(destination)
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && !['panel.json', 'online-config.js'].includes(entry.name)) {
    await copyFile(join(source, entry.name), join(destination, entry.name))
  }
}
await writeFile(join(destination, 'panel.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(destination, 'online-config.js'), `export const onlineConfig = Object.freeze(${JSON.stringify({ apiUrl })})\n`)
console.log(`Development panel prepared: ${destination}`)
console.log('Load this folder in Deska. The server must use the loaded folder\'s dev audience, not chess-online.')
