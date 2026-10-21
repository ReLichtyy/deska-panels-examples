# Pizarra

A compact whiteboard and diagram sketcher: freehand pen, a stroke eraser, lines, arrows, rectangles, circles, diamonds and text blocks, a small Mermaid compiler, base diagrams, and a project you copy and paste as JSON. It is not a Figma clone and the canvas is not infinite: it is a bounded 3 × 3 pages.

![Dark](../../docs/screenshots/preview/pizarra-dark.png)
![Light](../../docs/screenshots/preview/pizarra-light.png)

## What it teaches

- **Data first, canvas second.** The document is a list of strokes (`id`, `color`, `width`, `points`) and a list of shapes on a bounded canvas. The canvas element is only a picture of them, redrawn from data after every change and every resize. No PNG is ever the source of the document.
- **A small panel that gives the space to the sheet.** A floating top toolbar selects the tool without creating anything. Click or drag on the canvas to place it. The hamburger menu holds Mermaid code, process objects, JSON import/export, drawing history and canvas preferences. Contextual style controls show on the left; on compact panels their button opens them on demand. The bottom left holds zoom, undo, redo and the hand tool. Closed sections are hidden and inert. Selection is the initial tool.
- **A canvas bigger than the panel, still bounded.** The canvas is 3 × 3 pages of 1200 × 800 logical units, with the home page in the middle, so coordinates run from -1200 to 2400 across and -800 to 1600 down. The panel opens fitted to the home page; the other eight pages are reachable by moving, and you can draw and create anywhere on them. Zoom runs from 30% (the whole canvas) to 600% and pan live in the view, never in the document, and survive a resize. The canvas cannot be dragged out of reach, and the percentage button goes back to the home page. The hand tool is temporary: after one drag or a cancellation it returns to the previously active drawing tool. Pan with a drag in *Mover*, the wheel or a two-finger scroll, a middle- or right-button drag (the right button has no menu on the canvas and keeps the current tool), or Space plus a drag; zoom with the buttons or Ctrl/Cmd plus the wheel (a trackpad pinch sends the same).
- **Pointer Events done carefully.** One pointer at a time (the first primary pointer owns the interaction), pointer capture, and `pointercancel`, `lostpointercapture`, Escape, the panel being hidden and window blur all discard whatever is pending.
- **One way to change the document.** `state.commit()` records history, enforces the storage size limit and triggers saving, so every tool gets undo, redo and a clear redo stack for free.
- **Saving only what is confirmed.** The status says "Cambios sin guardar…", then "Guardando…", and "Guardado" only after `deska.storage.set` resolved for the latest revision. A failure shows its reason and a Reintentar link.
- **A diagram compiler with no dependencies.** `diagram.js` reads a subset of Mermaid and lays it out as ordinary shapes, so a compiled diagram is editable like anything you drew.
- **Import and export without a file API.** See below.

## Theme of the board

The panel around the board (bars, buttons, bubbles, lists) always follows Deska through its tokens. What *Ajustes* changes, under **Pizarra**, is the board itself: *Auto* follows Deska's mode (and follows it when it switches), *Claro* and *Oscuro* are the person's own, remembered under their own storage key. The paper and its frame change, near-neutral inks swap their lightness (black ink shows white on the dark paper and back), colored inks are lifted a little, and the suggested colors in the bubble are shown the same way. Only what is shown is adapted; the colors stored in the document never change, so switching loses nothing. *Fondo* (liso, puntos, cuadrícula) sits beside it, as buttons.

## First use

An empty canvas shows a short introduction to creating, editing and moving around, with an Empezar a dibujar button. Choosing any tool dismisses it for the session; the start button activates the pen. A loaded drawing is never covered by the welcome. Per-tool subtitles under the toolbar have been removed; accessible labels and hover titles remain.

## Text and font

Canvas text, notes and labels use Excalifont, the Excalidraw hand-drawn face, bundled unchanged in `fonts/` (SIL OFL 1.1, see `fonts/LICENSE.txt` and `fonts/PROVENANCE.md`) so it works offline with no network permission. Shapes and arrows place with a crosshair; the text tool shows a text cursor, and clicking puts a bare caret exactly where the text will be drawn, with no box around it. The field grows as you type.

## One-shot tools

Rectangle, diamond, circle, arrow, line, text and the process objects (notes included) place one item and then return to the tool that was in use before them: select, pen, eraser or fill. Back on select, the new shape comes back selected. Pick the tool again to place another.

## Contextual settings

Selecting a drawing tool or an existing item exposes its applicable controls: stroke color, custom color, width, box fill, rectangle corners, line dashes and text size. Unsupported settings are hidden. Changes to a selection are undoable; deselecting restores the tool's previous settings. On panels at most 760 pixels wide, open these controls with the settings button at the top right. The controls close when you touch the canvas, keeping the drawing space clear.

The top toolbar always shows selection, rectangle, diamond, ellipse, arrow, line and text. The trailing chevron expands a second row containing pen, eraser, paint bucket and sticky notes. It closes on selection, Escape or an outside click. The hand button sits beside undo/redo at the bottom. The menu and controls scroll within the panel.

## Tools

| Tool | Key | What it does |
| --- | --- | --- |
| Seleccionar | V | Pick a stroke or shape, drag to move, drag the square handle to resize (the two ends for lines), Enter or double click to edit text, Delete to remove. Changing color, width, fill or text size restyles the selection; the tools keep their own established values and get them back when the selection goes away. |
| Lápiz | P | Freehand. A click without movement draws a dot. |
| Borrador | E | Removes whole strokes and shapes. An empty shape is erased by its outline, so a stroke drawn inside a box can go without the box. Painted areas stay when a line drawn on them is erased. |
| Relleno | F | The paint bucket: one tap paints a whole closed area in the chosen color. On a block it paints the whole inside and the block stays one thing; on any other closed area (drawn by hand, or made of lines and blocks) it makes a painted area; a hole inside stays a hole. Tapping a painted area again recolors it, the same color takes it off, and an area that is not closed says so and changes nothing. |
| Línea, Flecha | L, A | Drag from one point to another. |
| Rectángulo, Círculo, Rombo | R, O, B | Drag to draw, or click for a standard size. *Relleno* tints the inside. |
| Texto | T | Click and type. Enter starts a new line; pressing anywhere outside the box (or Ctrl/Cmd+Enter) finishes it, Escape cancels. Four sizes. |

D goes back to drawing, M to moving, N arms a note for placement.

## Mermaid

This is **not mermaid.js**. That library renders SVG and is a large bundle, and a panel here has no network, no workers and no dependencies, so `diagram.js` is a compiler of its own for a subset:

- `flowchart` / `graph` with `TD`, `TB`, `BT`, `LR`, `RL`. Nodes `A`, `A[text]`, `A(text)`, `A([text])`, `A((text))`, `A{text}`, `A[[text]]`, `A[(text)]`, `A{{text}}`, `A[/text/]`, `A>text]`. Links `-->`, `---`, `-.->`, `-.-`, `==>`, `===` with `|label|` or `-- label -->`, chains (`A --> B --> C`) and `A & B --> C`.
- `sequenceDiagram` with `participant`, `actor`, `->>`, `-->>`, `->`, `-->`, `-x`, `-)`, self messages, and `Note over`, `Note left of`, `Note right of`.

Anything else is reported instead of silently dropped: unsupported lines (`subgraph`, `classDef`, `style`, `loop` and the like) come back as warnings, unsupported diagram types and syntax it cannot read come back as errors with their line number, and what can be drawn is drawn. Limits: 60 nodes, 150 links, 12 participants, 80 messages. The layout is a small layered one (ranks, ordering by neighbours, spacing) that scales the result to fit the sheet; it is not as polished as Mermaid's. A compile is one undo step and, with *Reemplazar el diagrama anterior*, replaces only the shapes it made earlier (tagged `group: "mermaid"`). The editor text is part of the project.

## Relleno (the bucket)

The drawing is vector, so the area is found on a throwaway raster: every line is drawn into it a little thicker (which closes the small gaps a hand leaves), the tapped point is flood-filled, the filled area is grown by a pixel so its edge lies under the lines that bound it, and its boundary is traced back into rings and thinned. What is stored is a small polygon (`kind: "fill"`, `rings`, even-odd so a ring inside another is a hole), never pixels. Painted areas are drawn first, under lines, blocks and labels; a block painted directly keeps one thing with `fillColor`. An area that touches the edge of the canvas is not closed and is refused. Painted areas can be selected, moved, recolored and deleted, and they are thinned again in the history archive.

## Speed and motion

Lines stay clear when the drawing is small on screen: nothing is drawn thinner than 1.5 screen pixels (thicker lines keep their width) and arrowheads keep a minimum size, so a 4-unit stroke at 30% zoom is a firm line and not half a pixel of grey. Stroke points are spaced by screen distance (about one pixel) instead of a fixed number of units, which keeps curves smooth at any zoom and stores fewer points at normal zoom.

What is already drawn is kept as an image while drawing, so a stroke in progress costs one blit plus the new stroke, not a redraw of everything; items outside the view are skipped; the box of every stroke and shape, the width of every label and the stored size of every item are worked out once (they never change after commit); and the eraser rules out most strokes by their box before looking at their points. Motion is small and purposeful: sections settle in, bubbles rise one after another and their popovers grow out of them, the Mover/Dibujar pill slides, new objects and compiled diagrams fade and grow in, messages slide, and a saved drawing flashes once. All of it is off under `prefers-reduced-motion`.

## Historial

The Historial de dibujos entry in the hamburger menu opens the last five drawings, each with a small preview, its age and its element count. Tap one to bring it back; *Guardar copia de este dibujo* keeps the current one without changing anything. The same drawing is never listed twice: an identical older entry moves to the front with a fresh time. A drawing goes into the list on its own when it is about to be replaced: *Limpiar*, an import, or a restore (restoring swaps, so the drawing on the board is archived first and nothing is lost by looking back).

It is kept as small as it can be, because the panel shares 256 KB with the drawing: ids are dropped, coordinates are whole numbers, strokes are thinned (Douglas-Peucker, coarser when an entry is still big), points are one flat list, and the Mermaid text is kept only when short. The whole list has a fixed budget (40,000 characters of JSON; one entry may use at most 60% of it) and the oldest entries go first. Entries are validated again before they are put back on the board, and a damaged one is dropped. It lives under its own storage key, so saving the drawing never rewrites it. A thinned stroke is slightly less smooth than the original.

## Procesos

*Objetos de proceso* in the hamburger menu holds the six basic diagram objects: inicio / fin, proceso, decisión, conector, flecha and nota. Choosing one activates placement; it creates nothing immediately. Click the canvas to place its standard size at that position, or drag to choose its bounds. The new object is selected and its label opens for typing. Existing elements stay untouched; move, resize and restyle the new item with *Seleccionar*. Notes also have a button in the toolbar disclosure and the N shortcut.

## Files

| File | Role |
| --- | --- |
| `model.js` | Constants and the stroke and shape factories. |
| `text.js` | Text measuring, with an estimate when there is no canvas. |
| `shapes.js` | Geometry: bounds, hit testing, move and resize. |
| `drawing.js` | Fit, zoom and pan, coordinate conversion, rendering from data. |
| `history.js` | Undo and redo over snapshots. |
| `transfer.js` | JSON export, import and validation. |
| `state.js` | Live state and the single `commit()`. |
| `input.js` | Pointer lifecycle: one active pointer, capture, cancel. |
| `tools.js` | What each tool does with the pointer, and operations on the selection. |
| `texteditor.js` | In-place text editing (there is no `prompt()` in the sandbox). |
| `diagram.js` | The Mermaid subset compiler. |
| `archive.js` | The compact form of a drawing, and the five-entry list with its budget. |
| `archivepanel.js` | The Historial button, its list, and its storage key. |
| `objects.js` | The six process object definitions and their pointer-positioned previews. |
| `mermaidpanel.js` | The Mermaid editor's wiring. |
| `app.js` | Interface, storage and wiring. |

## Project format

```json
{
  "format": "deska-pizarra",
  "version": 3,
  "sheet": { "width": 1200, "height": 800 },
  "canvas": { "x": -1200, "y": -800, "width": 3600, "height": 2400 },
  "background": "plain",
  "strokes": [{ "id": "abc", "color": "#1b1b1f", "width": 4, "points": [[200, 200], [233.3, 212.8]] }],
  "shapes": [
    { "id": "def", "kind": "rect", "color": "#1b1b1f", "width": 2, "x": 100, "y": 100, "w": 200, "h": 90, "fill": true, "text": "Idea", "size": 22 },
    { "id": "ghi", "kind": "arrow", "color": "#1b1b1f", "width": 2, "points": [[300, 145], [420, 145]], "text": "sí" }
  ],
  "mermaid": "flowchart TD\n  A --> B"
}
```

`kind` is `line`, `arrow`, `rect`, `ellipse`, `diamond`, `text` or `fill` (a painted area, with `rings`). Optional fields (`fill`, `fillColor`, `round`, `dash`, `text`, `size`, `group`) appear only when set. `background` is `plain`, `dots` or `grid`. Width is 1 to 40, everything lies inside the canvas (coordinates may be negative), ids are unique across strokes and shapes, colors are `#rrggbb`. Version 1 (strokes only) and version 2 (everything on the home page) projects still import. An import that breaks any rule changes nothing and says which rule.

## Permissions and hosts

- `clipboard-write`: the Copiar button in *Proyecto*. Nothing else needs a permission.
- No hosts, no network.

## What it could not do

- **PNG export.** Panels run with `sandbox="allow-scripts allow-forms"` and the bridge has no download or file method (`storage`, `setTitle`, `notify`, `openUrl`, `clipboard.write`, `extras.set`). The panel says so instead of offering a button that cannot work.
- **Export and import go through text.** Copiar writes the JSON with `clipboard.write` (up to 64 KB; larger projects must be selected and copied by hand). Importing means pasting into the box: the bridge cannot read the clipboard. `localStorage` is not used.
- **Size.** `deska.storage` holds 256 KB per package; the drawing stops accepting changes at 200 KB and says so.
- **Not persisted:** the chosen tool, color and width, the zoom and the pan reset on reload; undo history is not saved. The background and the Mermaid text are part of the document but not of undo.
- **Mermaid** covers the subset above, not the language: no subgraphs, styling, click handlers, other diagram types, or edge routing around nodes (links are straight).
- **Shapes** cannot be grouped, rotated or reordered, and text blocks do not wrap by themselves (use Enter for a new line).
- **Keyboard drawing** is not available; shortcuts exist for tools, history, selection and view.
- **To verify inside Deska itself:** the native color picker opened by the custom color input.

## Try it

```sh
npm run preview -- panels/pizarra
```

Then in Deska: Panel Library, Build a panel, Load a folder, and pick `panels/pizarra`.

## Regression checks

Run `node tools/test-pizarra.mjs` from the repository root. It launches the actual sandboxed preview host and checks activation without insertion, click/drag placement, selection and resizing, styles, notes, text, cancellation, undo/redo, pan/zoom, Mermaid, process objects, invalid JSON rejection, archive, clear/undo, storage reload, themes and compact layouts. Screenshots are written to `test-results/pizarra/`. `npm run check -- pizarra` also verifies loading and CSP/SDK behavior in both themes.

The installed `1.0.0` source was recovered from `%APPDATA%/Deska/panels/packages/pizarra/1.0.0`. The document format and storage keys remain unchanged.
