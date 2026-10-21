---
version: 1
slug: "panels-chess-index-html"
primary_target: "panels/chess/index.html"
related_targets: []
---

## Visitor mode

Operate: a person plays a game inside a docked panel.

## Audience, job, constraints

Deska users, short interrupted sessions, panel about 420 x 505. Colors, fonts and radii come from Deska tokens; the panel owns only the board and pieces. Controls stay standard. Captured pieces are always visible (user choice). Online is Beta.

## Direction contract

THESIS: the board is an object set on a quiet ground, and the match is told in two thin lines, one above and one below it. The category default (icon + title bar over a full-bleed board with leftover dead space) is refused: that dead space becomes the two player lines.

OWN-WORLD: Deska's dark or light ground, with the shell tinted a few percent toward the accent so the board and its surround read as one object. Hairline 1px borders only. Rounded board (8px) with the coordinates inside. Tabular numerals for material and counts. Names in 600 weight, secondary text in the token's secondary color. Captured pieces drawn with the panel's own piece set at small size, overlapped like a hand of cards.

STORY: at a glance the person knows whose turn it is, who they are playing, what has been taken and who is ahead, and what moved last; then plays by click or drag.

FIRST VIEWPORT: 420 x 505. Slim toolbar (36px): Online (Beta), Bot, Appearance as standard compact buttons, right-aligned; left a quiet title only when the game is not running. Opponent line (34px) above the board, local line (34px) below, each: name, state text, captured pieces, material difference. Board fills the remaining square. Footer (40px): undo, hint, redo, move count, Partida. Signature move: the turn line, a 2px accent hairline under the line of the side to move that slides between the two lines when the turn passes (instant under reduced motion).

FORM: custom structure on standard controls; position 1 of 1: the direction was pinned by the user ("minimal premium"), so no roll was run. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
