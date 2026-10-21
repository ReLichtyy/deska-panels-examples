# Design

The visual system of the Chess panel as built. Colors, fonts and radii come from Deska's theme tokens
(`--deska-*`); the panel owns only the board squares and the pieces. Direction: minimal premium.

## Thesis

The board is an object set on a quiet ground, and the match is told in two thin lines: the opponent's above
the board and yours below it. The category default (icon and title bar over a full-bleed board, with leftover
empty space) is replaced by those two lines, which use the room a square board always leaves in a rectangular panel.

## Ground and color

- Ground: `--ground` = `--deska-bg` mixed 4% toward `--deska-accent`. Dividers: `--line` = `--deska-border` mixed 9% toward the accent.
- One accent, Deska's (coral by default), used for the turn line, primary buttons, focus and the "App" board palette.
- Board palettes: App (accent on dark squares, a pale tint of it on light), Océano, Nogal, Pizarra (`marks.js`).
- Fixed marks that do not follow the palette: last move `#f2cf3a`, premoves `#6c63ff`, analysis brushes in `marks.js` (green, red, blue, yellow) over a dark halo.
- Contrast: brushes and halo are checked against every square of every palette in `tools/chess/marks.test.mjs`.

## Type

`--deska-font-ui` only. Header status 13px 600; names 13px 600 (active side in `--deska-text`, the other in `--deska-text-secondary`);
notes, material and counts 12px with tabular numerals; the room code in the note is 600 with 0.14em tracking and `user-select: all`.
Minimum functional text is 11px (the Beta tag).

## Shape and depth

- Radius: board 8-10px clip (`min(10, cell * 0.2)`); controls use `--deska-radius-small`; sheets `--deska-radius`; Beta tag is a pill (small control).
- Elevation is declared once: the board carries a soft shadow (`drop-shadow(0 6px 14px)` from `--deska-text` at 14%). Lines and dividers are hairlines (1px).

## Layout

Space is the constraint: a panel is small, so the board takes everything it can and the lines live in the bars it already has.
Portrait (default): the top bar is the opponent's line (name, note, captured pieces, material lead) with the Online (Beta), Bot and
Appearance icon buttons on the right; the footer is your line with undo, hint, redo and Partida on the right. Between them the board
stage is square, takes its height from its width and centers in what is left, with an even 8px gutter. At 420x505 the board is 400px.
The lines' content lines up with the board's left edge (`--board-left`, written by `syncLayout()`, at most 28px in).
Wide panels (aspect 8:5 or more, 520px and up): the board takes the height and the two bars become a column beside it
(opponent and buttons on top, you and the controls at the bottom). Under 350px the Partida label drops to its icon.
The turn text and "Jugada N" stay in the document for assistive technology but are not drawn.

## Home

Every time the panel opens it shows the home screen, a layer over everything else (the rest of the panel is made inert; the closed
drawer stays closed). It is a short column on the same ground: title and close (the X only when a board is waiting), then, in order of
urgency: Retos (received first, then sent, with their answers), Continuar (rows with a 56px mini board of the local game, drawn with
dots because drawn pieces blur at 7px, and an icon row for the online game), Nueva partida (Contra el bot as the one primary button, Dos
en un tablero beside it, and the bot level in one line), and Con personas (Beta): who you play as, "Tus rivales" with connected ones
first, a search by name, and a link to the private room with a code. Lists are hairline-separated rows, never cards. A connected person is
a filled accent dot plus the word "Conectado"; in a game is a hollow dot; away is a faint one. The title bar and the latest message stay
pinned while the lists scroll; messages clear after 9 seconds.

## Signature move: the turn line

A 2px accent line on the board-facing edge of the line of the side to move. It grows in from the edge (260ms, exponential ease-out)
and is instant under `prefers-reduced-motion`. State is never only the line: the header text and the live region say whose turn it is.

## Components

- Player line: name, note (color; "Pensando…" for the bot; "Jaque" in danger color; the room code while waiting; "Sin conexión"), captured pieces drawn at 20px with the active piece set and overlapped like a hand of cards, and a `+N` material lead.
- Chips and icon buttons: transparent, secondary text, 8% text-mix on hover, `scale(0.96)` on press.
- Sheets (Bot, Online, Appearance): `--deska-surface`, hairline border, one shadow.
- Notices: a small bar over the top of the board with an X; never over the footer.
- Online (Beta): a pill tag beside the name; the lobby list is rows of avatar initial, alias and a free/playing label.

## Motion

Pieces slide 220ms; the held piece lifts; the turn line grows in; sheets rise 160ms. All of it is off under `prefers-reduced-motion`.

## Known gaps

No clock, resign, draw offers or challenge-from-list. The waiting state is a code in the opponent's line and the Online sheet; it has no
dedicated board overlay yet. Narrow panels (under 340px) wrap the toolbar to two rows.
