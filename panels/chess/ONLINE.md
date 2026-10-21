# Chess Online (Beta) — estado de desarrollo

La interfaz marca Online como **Beta**: el cliente está completo, pero no hay servicio real desplegado.

El cliente está implementado. No hay un servidor de partidas desplegado ni un dominio configurado.
En esta carpeta `online-config.js` tiene `apiUrl: null`: el juego local funciona y el botón de acceso
online explica que falta conectar el servidor. No se simulan cuentas ni rivales en el panel.

## Probar dentro de Deska

Panel Library → Build a panel → Load a folder:

la carpeta `panels/chess` de este repositorio

Esta copia de desarrollo tiene su propio almacenamiento. La partida de la versión instalada no se
modifica ni se importa automáticamente. Los cambios de archivos se recargan en Deska.

La vista previa antigua del repositorio usa SDK 1; sirve para probar el juego y la pantalla online
sin configurar, pero no implementa las llamadas de cuenta del SDK 4.

## Activar el acceso real

Se necesitan un servicio HTTPS y una política de privacidad publicada. Desde la raíz del repositorio:

```powershell
node tools/chess/configure.mjs https://TU-SERVIDOR https://TU-SITIO/privacy <CARPETA-NUEVA>
```

Sustituye las URLs por las reales. El comando crea una carpeta nueva y rechaza sobrescribir una
existente. Declara SDK 4, permiso `account`, host de red y privacidad. Carga esa nueva carpeta en Deska.
Los ejemplos de prueba usan `.example` exclusivamente; nunca los uses para configurar un servicio real.

Una carpeta cargada recibe un `init.panel.id` propio (`dev-…`). El servidor de desarrollo debe aceptar
exactamente esa audiencia. No sirve usar `chess` o `chess-online` como audiencia del token de una carpeta.
El identificador `chess-online` es provisional; para publicar hay que registrar un identificador propio,
conservar la atribución a Pasho y pasar revisión de Deska. Editar el paquete instalado no autoriza login.

## Contrato del servidor

Hay una implementación de referencia en [`chess-server/`](../../chess-server/README.md) (Cloudflare Workers),
probada contra este cliente con tokens firmados de prueba. No está desplegada.

Todas las rutas reciben `Authorization: Bearer <token>` y devuelven JSON. El cliente obtiene el token
con `deska.account.token()` antes de cada petición y nunca lo guarda. No solicita nombre ni correo.
El servidor debe verificar firma ES256 usando las JWKS de Deska, `typ: JWT`, issuer, audiencia y
expiración; identificar al jugador por `sub`, no por datos enviados en el cuerpo. Rechazar tokens
`dev: true` en producción. Implementar límites de peticiones, persistencia y autorización por sala.

| Ruta | Entrada | Respuesta |
| --- | --- | --- |
| `POST /session` | `{}` | `{ "ok": true }` tras validar la identidad |
| `POST /rooms` | `{ requestId }` | Sala privada nueva; creador con blancas |
| `POST /rooms/join` | `{ code, requestId }` | Sala; segundo jugador con negras |
| `GET /rooms/:id` | — | Sala visible únicamente a sus participantes |
| `POST /rooms/:id/moves` | `{ uci, revision, requestId }` | Sala tras confirmar la jugada |
| `POST /presence` | `{}` | `{ players, total }`; también marca al solicitante como conectado |
| `POST /home` | `{}` | Pantalla de inicio (ver abajo); también marca al solicitante como conectado |
| `POST /players/search` | `{ query }` | `{ players: [{ id, name, status }] }`, máximo 10 |
| `POST /challenges` | `{ to, requestId }` | `{ id, state: "pending" }` |
| `POST /challenges/:id/accept` | `{}` | Sala ya activa (la acepta quien fue retado); los colores se sortean |
| `POST /challenges/:id/decline` | `{}` | `{ ok: true }` |
| `POST /challenges/:id/cancel` | `{}` | `{ ok: true }`; el que retó lo retira o descarta una respuesta |

Presencia: el panel llama a `/presence` al entrar, cada 30 s mientras esté visible y al abrir la hoja
Online; durante una partida no la llama, porque cada `GET /rooms/:id` también cuenta como latido. Una persona cuenta como conectada si hizo la llamada en los últimos ~90 s. Cada jugador es
`{ id, name, status, self }`: `id` opaco (`[A-Za-z0-9_-]{1,80}`), `name` alias asignado por el servidor
(1-24 caracteres: letras, números, espacio y `._'-`), `status` `available` o `playing`, `self` solo
`true` para el solicitante. Máximo 100 jugadores por respuesta; `total` es el recuento real. Deska no
entrega nombre ni correo: el alias lo genera o lo elige el usuario en tu servicio, nunca se toma del
token. No incluyas datos personales ni la sala de nadie. Aún no hay retos desde la lista.

Formato de sala (valores ilustrativos):

```json
{
  "id": "room_123",
  "code": "A7K2Q9",
  "side": "w",
  "status": "active",
  "revision": 2,
  "moves": ["e2e4"],
  "opponent": "Torre Roja 47"
}
```

`opponent` es el alias del otro jugador (opcional; `null` mientras se espera rival) con el mismo formato que los de `/presence`; el panel lo muestra en la línea del rival. `side` es el color del solicitante, calculado por el servidor. `status` es `waiting`, `active` o
`finished`. La partida siempre empieza en la posición estándar. `revision` crece cada vez que cambia
el estado, incluida la incorporación del rival. El historial es acumulativo y no se puede reescribir.
`finished` corresponde a un final reconocido por las reglas; este cliente todavía no ofrece rendición,
tablas pactadas, reloj, clasificación ni emparejamiento público.

Validar movimientos con las reglas en el servidor, comprobar turno y pertenencia, y actualizar de
forma atómica si coincide `revision`. Deduplicar escrituras por jugador + `requestId`; no consumir dos
veces una petición repetida. Generar códigos impredecibles y limitar intentos de unirse. Nunca confiar
en la validación del navegador. Antes de usar estas reglas en producción, completar repetición de
posiciones y casos de material insuficiente (ahora solo reyes), y acordar las reglas de tablas.

HTTP: `401` sesión inválida, `403` sin permiso, `404` sala inaccesible, `409` conflicto,
`429` límite. El panel detiene el juego ante errores; Reconectar vuelve a consultar el estado.
No reenvía jugadas automáticamente tras un timeout, porque el servidor pudo haberlas aplicado.
Si crear/unirse falla sin obtener una sala, el usuario puede volver a intentarlo o usar un código;
para recuperar una creación cuyo resultado se perdió, el backend debe devolver la sala pendiente
del jugador al repetir crear. La app conserva localmente solo el id de la última sala confirmada.

CORS: responder a `OPTIONS`, permitir origen `*`, métodos `GET, POST, OPTIONS` y cabeceras
`authorization, content-type`. El panel tiene origen opaco y no usa cookies. No redirigir peticiones
autenticadas a otro dominio. La sincronización consulta cada cinco segundos mientras el panel está
visible y se detiene al fallar; el límite de Deska es compartido entre paneles.

Antes de publicar, implementar eliminación de cuenta/datos y recepción de eventos firmados de
revocación/eliminación, declarar `account.events` y documentar la retención real en la política.
La UI escucha revocación de Deska y bloquea inmediatamente el tablero, pero no reemplaza los controles
de acceso del servidor.

Referencia: https://deska.dev/docs/panel-sign-in

## Pantalla de inicio, nombres y retos

Entrar es automático: no hay botón de entrar. Al abrir, el panel pide la sesión en silencio (`POST /session` con el token
de `deska.account.token()`). Si el servidor no responde, lo reintenta 3 veces (a los 15 s y a los 30 s) con una
cuenta atrás donde estarían las personas (`Nuevo intento en 12 s · 2 de 3`); agotados los intentos queda `Sin
conexión con el servidor` y un botón **Reintentar**. Si Deska rechaza el acceso (sin sesión, sin permiso, cancelado), no
reintenta solo: el botón **Conectar** abre la hoja de Deska, que solo puede abrirse desde un clic.

El panel abre siempre en un menú: continuar, partida nueva y jugar con personas. Para compartir el nombre usa
`deska.account.signIn({ name: true })`: Deska pregunta a la persona si comparte su nombre (casilla sin marcar
por defecto) y, si acepta, el token lleva `name`. Sin nombre se sigue usando el alias aleatorio.

- El servidor guarda como máximo un nombre de visualización limpio (letras, números, espacios y `._'-`, 24
  caracteres) y deja de mostrarlo si el token deja de traerlo. Ese nombre lo ven las otras personas que usan
  Chess: en la lista de conectados, en la sala y en la búsqueda. La política de privacidad debe decirlo.
- `POST /home` devuelve `{ me: { id, name|null, alias, shared }, room|null, recent, incoming, outgoing, total }`:
  `room` es la partida a retomar (`waiting` o `active`, con `opponent`, `side`, `turn`, `moves`); `recent` son los
  rivales anteriores con `status` `available` (conectado), `playing` u `offline`, los conectados primero;
  `incoming` los retos recibidos; `outgoing` los enviados con `state` `pending`, `accepted` (con `roomId`) o
  `declined`. El panel lo consulta cada 10 s con el menú abierto.
- Buscar solo encuentra a quien compartió su nombre: sin distinguir mayúsculas ni acentos, mínimo 3 letras,
  límite de 20 búsquedas por minuto. No es un directorio de Deska: solo existen las personas que ya entraron a Chess.
- Un reto queda pendiente 24 horas aunque la persona no esté conectada; la ve en su menú la próxima vez.
  Máximo 5 retos enviados pendientes y uno por persona. Aceptar crea la partida al instante (409 si alguno de los
  dos ya está jugando otra). Las respuestas de error llevan `{ "error": "<motivo>" }`, que el panel traduce.

## Verificación local

```powershell
node --test tools/chess/*.test.mjs
npm run check -- chess --no-shots
node tools/chess/browser-check.mjs
node tools/chess/browser-input.mjs
node tools/chess/browser-online-premove.mjs
node tools/chess/browser-home.mjs
```

Jugadas online: tu jugada se muestra al instante mientras el servidor la confirma; si la rechaza,
vuelve atrás y el aviso sobre el tablero explica el motivo. Las premoves online se envían una a una
y solo cuando ya llegó la jugada rival (el panel consulta la sala cada 1,5 s mientras mueve el rival, espaciando hasta 5 s si no hay cambios; cada 6 s en tu turno y cada 3 s esperando rival). La consulta de fondo nunca bloquea el tablero: tu jugada la cancela y una respuesta más vieja que la sala se descarta.

`tools/chess/test-host.mjs` es exclusivamente una simulación de pruebas, con identidades falsas.
**No es un backend desplegable ni autentica usuarios reales.** Las pruebas de navegador abren dos
paneles, crean/unen sala, intercambian jugadas, cortan/restablecen conexión y comprueban recuperación.
Las capturas quedan en `test-results/chess/`.
