# Changelog

## 1.1.0

- Canvas text, notes and labels use Excalifont, Excalidraw's hand-drawn face, bundled in `fonts/` so it works offline.
- Text is typed in place: a bare caret at the click point, no box, and the field grows as you type.
- On Auto, the default ink, quiet canvas labels and the control accent come from Deska's theme tokens.
- Right-button drag pans the canvas like the middle button, keeping the current tool and selection.
- Rectangle, diamond, circle, arrow, line, text and process objects (notes included) place once, then return to the previous tool.
- The hand stays armed until another tool, the hand button again or Escape.
- Selection box and group edits: drag over empty paper to select several items, and Ctrl/Cmd + A selects everything.
- First-use welcome on an empty canvas; per-tool subtitles removed.

The document format and storage keys are unchanged, so drawings from 1.0.0 load as they are.

## 1.0.0

- First release.
