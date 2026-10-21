---
name: Pizarra
description: Compact Spanish drawing panel with a full canvas and floating controls.
colors:
  active-dark: "#aaa2ff"
  active-bg-dark: "#403b67"
  active-light: "#5142ba"
  active-bg-light: "#e7e3ff"
  surface-fallback: "#232329"
  text-fallback: "#e4e4ea"
  muted-fallback: "#b4b4bf"
  border-fallback: "#393940"
  field-fallback: "#17171b"
  danger-fallback: "#e8757b"
  paper-dark: "#121214"
  paper-light: "#fbfaf6"
  canvas-muted-dark: "#a4a4ae"
  canvas-muted-light: "#62616a"
  dots-dark: "#474850"
  dots-light: "#b9b6ab"
  grid-dark: "#2a2b31"
  grid-light: "#dedbd0"
  selection-light: "#0b7bff"
typography:
  body:
    fontFamily: "var(--deska-font-ui, 'Segoe UI', sans-serif)"
    fontSize: "12px"
    lineHeight: 1.45
  label:
    fontFamily: "var(--deska-font-ui, 'Segoe UI', sans-serif)"
    fontSize: "11px"
  title:
    fontFamily: "var(--deska-font-ui, 'Segoe UI', sans-serif)"
    fontSize: "14px"
    fontWeight: 600
  code:
    fontFamily: "var(--deska-font-mono, monospace)"
    fontSize: "12px"
    lineHeight: 1.6
rounded:
  control: "6px"
  swatch: "5px"
  floating: "9px"
  bottom-group: "8px"
  dialog: "10px"
spacing:
  toolbar: "4px"
  small: "8px"
  panel: "12px"
  dialog: "18px"
components:
  button:
    rounded: "{rounded.control}"
    padding: "5px 9px"
  tool:
    rounded: "{rounded.control}"
    size: "36px"
    padding: "7px"
  floating-panel:
    rounded: "{rounded.floating}"
    padding: "12px"
  text-field:
    typography: "{typography.code}"
    rounded: "{rounded.control}"
    padding: "10px"
---

# Design System: Pizarra

## Overview

Pizarra is a Spanish drawing tool inside Deska. Its approved direction is a compact, Excalidraw-like editor: the canvas fills the panel, the drawing tools float above it, and settings appear when relevant. The document is the visual focus.

This specification applies only to `panels/pizarra`. `app.css`, `theme.js`, and `index.html` are the implementation sources. Deska supplies interface colors and fonts; the board has its own Auto, Claro, and Oscuro preferences. Existing drawing and storage behavior remains part of the panel contract.

## Colors

Violet marks selected tools, expanded controls, primary actions, focus, and selected swatches. The `active-*` and `active-bg-*` pairs follow the effective board mode.

Interface surface, foreground, secondary text, border, field background, and error colors resolve from `--deska-surface`, `--deska-text`, `--deska-text-secondary`, `--deska-border`, `--deska-bg`, and `--deska-danger`. Frontmatter entries ending in `fallback` document standalone CSS fallbacks; they do not override the host theme.

Paper, dots, and grid use their board-mode tokens. Light-board selection uses `selection-light`; dark-board selection uses `active-dark`. Changing board mode adapts displayed ink without rewriting stored drawing colors. Drawing swatches are document controls, not extra interface brand accents.

Empty-canvas welcome content and ordinary save-status text sit directly on paper and use `--canvas-muted`, resolved from the `canvas-muted-*` board-mode pair. This text follows the board, including when a light board appears inside a dark Deska theme. Text inside floating surfaces continues to use host foreground and secondary-text tokens.

## Typography

The interface uses the host UI stack and deliberately compact body and label roles. Menu titles use the title role. The JSON dialog title is a local larger heading (16px); it does not establish a website heading scale. Code and JSON fields use the host monospace stack.

The empty-canvas welcome uses a local heading (23px, weight 600, line-height 1.2), introduction (13px), body (12px), and footnote (11px). These sizes support first-use guidance without establishing a marketing-page hierarchy.

Toolbar shortcut hints are optional secondary cues (8px), hidden at narrow widths. They supplement accessible names and tooltips. Do not reduce their opacity. Canvas text sizes belong to the drawing document and are independent of interface typography.

## Layout

The canvas occupies the entire available width and height. There is no page scroll, content container, marketing header, or permanent sidebar. Floating surfaces scroll internally when necessary.

Desktop chrome has an outer inset (12px). The hamburger sits at the top left, the drawing toolbar is centered, and the style toggle sits at the top right. Selection, rectangle, diamond, ellipse, arrow, line, and text remain visible in the primary toolbar row. A trailing chevron reveals a secondary row for pen, eraser, fill, and sticky note. The contextual properties surface sits left beneath the toolbar (190px wide, top 96px). Zoom, undo/redo, and hand sit at the bottom left; save status sits at the bottom right.

The hamburger opens secondary tools: Mermaid code, process objects, project JSON, drawing history, and canvas preferences. Menu width is 244px; secondary sections are 330px; history is 280px. All constrain themselves to the available panel width. The JSON editor is centered with a maximum width (660px).

At 760px and below, outer insets shrink to 8px, the toolbar fits between corner controls, shortcut hints disappear, and save status moves above bottom controls. At 470px and below, the primary toolbar remains a single row using eight grid columns, including its chevron; left overlays start at 84px and the JSON editor uses a 10px inset. Expanding secondary tools moves contextual properties to 112px. Preserve access to controls without shrinking the canvas into a separate layout column.

First-use welcome guidance is centered directly on empty paper with no card background. Its width is `min(380px, calc(100% - 48px))`; its maximum height is `calc(100% - 140px)`, with internal scrolling for short panels. Existing drawing content is never covered by this welcome.

## Elevation & Depth

Floating surfaces use host surface color and restrained shadows to separate controls from the drawing. The shared floating shadow is `0 4px 16px rgb(0 0 0 / .16)`. Dialogs have stronger shadows; exact extensions live in `.impeccable/design.json`. Fields and swatches use borders. Selected buttons add an inset accent underline so state is not represented by fill alone.

Buttons transition background and text color over 120ms with ease-out. Reduced-motion preference removes transitions and animations. There is no decorative entrance motion.

## Shapes

Controls have compact rounded corners; floating panels use the larger floating radius. Bottom control groups and dialogs use their named radius roles. Icons are inline outline SVGs (17px, 1.5px stroke, round caps and joins). Avoid decorative illustrations in editor chrome.

## Components

- **Tool buttons:** icon-first, accessible Spanish names, shortcut tooltips, and `aria-pressed` selection. Desktop tools use the tool token; general buttons have a minimum hit box (32px). Hover adds a subtle foreground tint. Keyboard focus has a visible accent outline (2px, offset 3px).
- **More tools:** the chevron uses `aria-expanded`, rotates when open, and carries an accent indicator when a secondary tool is active. The extra row closes on tool selection, Escape, or an outside click. Text stays directly available in the primary row.
- **Contextual properties:** group stroke color, width, fill, corners, dash style, and text size by relevance to the current tool or selection. Palette swatches show both an outline and checkmark when selected. Keep selection deletion in this context.
- **Hamburger and secondary panels:** show Spanish action labels, use explicit open/closed state, and provide a return-to-menu action in secondary sections. Code, JSON, history, and preferences remain discoverable here.
- **Code and JSON fields:** bordered host-background textareas with monospace text, visible labels, and explicit compile/import/copy actions. Feedback appears near the operation.
- **Bottom controls:** compact zoom and undo/redo groups with tabular zoom numerals; unavailable actions visibly disable. Hand uses a compact tool button (32px) beside undo/redo, separated by a thin divider. Hand mode lasts for one drag, then restores the previously selected tool.
- **Empty-canvas welcome:** brief Spanish creation, editing, and panning guidance with an explicit start button (minimum height 36px, horizontal padding 18px). It disappears after the first tool choice or start action and never overlays a document containing items. There is no persistent per-tool subtitle beneath the toolbar.
- **Status and dialogs:** save feedback is quiet until an error needs action. Toasts use live status semantics; clearing the board uses a confirmation dialog. Errors retain readable host danger color.

## Do's and Don'ts

- **Do** preserve the full canvas, floating toolbar, and contextual left settings.
- **Do** use Deska tokens for interface chrome and keep board preferences separate.
- **Do** keep Spanish labels, visible keyboard focus, and programmatic control state.
- **Do** preserve existing drawing content and storage behavior during visual changes.
- **Don't** add website navigation, hero sections, dashboard cards, or promotional content to this panel.
- **Don't** substitute a permanent sidebar for the contextual floating surfaces.
- **Don't** treat screenshots or synthetic test drawings as default user content.
- **Don't** invent new brand colors, fonts, decorative motion, or a product identity for this scoped editor.
