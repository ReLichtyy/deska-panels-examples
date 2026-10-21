# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People using Deska who want a quick chess game inside a panel: against a bot they tune, against themselves on one board, and, once the service is live, against another Deska user in a private room. Sessions are short and interrupted; the panel is small (about 420 x 505, resizable) and docked beside other work.

## Product Purpose

Play chess without leaving the desk. Success: a game is readable at a glance (whose turn, what was taken, what just moved), input is forgiving (click, drag, premoves, analysis arrows), and online play feels like playing a person, not filling in a form.

## Positioning

A chess board that lives in a Deska panel: follows the app's theme tokens, survives reloads, signs in with the Deska account and sends no name or email to its server.

## Capabilities and Constraints

- Colors, fonts and radii come from Deska's theme tokens; only the board squares and pieces are the panel's own colors. Anything else derives from the tokens (for example with `color-mix`).
- Online is Beta: the client is complete, the reference server is written (`chess-server/`) but nothing is deployed. Players are shown by a server-assigned alias.
- Not built: clocks, resign, draw offers, challenging a person from the connected list, chat.
- Panel sizes from about 320 x 420 up; the board is square and must not leave dead space at the default 420 x 505.

## Brand Commitments

Maker credit: based on Pasho's Chess example. The coral accent from Deska's theme is the panel's color; the "App" board palette is that accent.

## Evidence on Hand

Screenshots from `test-results/chess/`. No user research. No invented names: the aliases in tests are test fixtures.

## Product Principles

1. The board leads; everything else supports reading it.
2. State is never only color: text or shape repeats it.
3. Fail loudly and recoverably: a refused move goes back and says why.
4. Local play always works, signed in or not.

## Accessibility & Inclusion

Keyboard play, live announcements for each move, `prefers-reduced-motion` honored, contrast at least 4.5:1 for text.

<!-- Assumptions labeled: product facts above come from the repository, the README and this session's answers (scope: whole panel; feel: minimal premium; always show captured pieces). The interview was held in chat, not through the decision page. -->
