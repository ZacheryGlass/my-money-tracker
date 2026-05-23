---
version: alpha
name: MMT-design
description: A compact, theme-driven application designed for dense, data-first personal finance tracking. The default dark workbench uses near-black chrome surfaces around `#191A1B`, a darker content canvas at `#121314`, muted primary foreground text around `#bfbfbf`, secondary descriptive text around `#8C8C8C`, and a restrained blue action/focus system (`#297AA0` / `#3994BC`). The UI uses platform-native system fonts for application chrome and platform-specific monospace fonts for financial data displays. Panels are mostly square, divided by 1px borders, with subtle tokenized shadows on title bars, activity bars, tabs, floating widgets, and overlays. The design language is utilitarian, extensible, and optimized for multi-pane portfolio monitoring workflows rather than brand-forward visual expression.

colors:
  primary: "#297AA0"
  primary-active: "#2B7DA3"
  ink: "#bfbfbf"
  body: "#8C8C8C"
  body-strong: "#ededed"
  muted: "#8C8C8C"
  muted-soft: "#555555"
  hairline: "#2A2B2CFF"
  hairline-soft: "#2A2B2C"
  hairline-strong: "#333536"
  canvas: "#191A1B"
  canvas-soft: "#121314"
  surface-card: "#202122"
  surface-strong: "#242526"
  on-primary: "#ffffff"
  accent-focus: "#3994BC"
  accent-added: "#73c991"
  accent-syntax-blue: "#79c0ff"
  accent-modified: "#e5ba7d"
  accent-success: "#72C892"
  semantic-error: "#f48771"
  semantic-success: "#72C892"

typography:
  display-mega:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 26px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  display-lg:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: 0
  display-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  display-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  title-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  title-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  body-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  body-tracked:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  caption-uppercase:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.4px
    textTransform: uppercase
  code:
    fontFamily: "Consolas, 'Courier New', monospace"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: 0
  button:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0
  nav-link:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, Ubuntu, 'Droid Sans', sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 22px
    letterSpacing: 0

rounded:
  none: 0px
  xs: 2px
  sm: 3px
  md: 4px
  lg: 6px
  xl: 8px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 6px
  base: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  section: 48px

components:
  title-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.nav-link}"
    height: 35px
  command-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.nav-link}"
    rounded: "{rounded.md}"
    height: 22px
    borderColor: "{colors.hairline-strong}"
  activity-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    width: 48px
  side-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    borderColor: "{colors.hairline}"
  editor-tabs:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.body-sm}"
    borderColor: "{colors.hairline}"
  editor-tab-active:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    borderTopColor: "{colors.primary-active}"
  editor-pane:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.body-strong}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: 0
  panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    borderColor: "{colors.hairline}"
  status-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.body-sm}"
    height: 22px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 4px 8px
    height: auto
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 4px 8px
    height: auto
  button-tertiary-text:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.button}"
  quick-input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    borderColor: "{colors.hairline-strong}"
  list-row:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    padding: 0 8px
  list-row-active:
    backgroundColor: "#3994BC26"
    textColor: "{colors.body-strong}"
    typography: "{typography.body-md}"
  context-menu:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    borderColor: "{colors.hairline}"
  notification-toast:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    borderColor: "{colors.hairline}"
  hover-widget:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.none}"
    borderColor: "{colors.hairline}"
  terminal:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    padding: 0
  code-block:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
    padding: 8px
  text-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 4px 6px
    height: auto
  badge-pill:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 2px 6px
  scm-added:
    backgroundColor: transparent
    textColor: "{colors.semantic-success}"
    typography: "{typography.body-md}"
  scm-modified:
    backgroundColor: transparent
    textColor: "{colors.accent-modified}"
    typography: "{typography.body-md}"
  scm-deleted:
    backgroundColor: transparent
    textColor: "{colors.semantic-error}"
    typography: "{typography.body-md}"
  chat-input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    borderColor: "{colors.hairline-strong}"
  agents-panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    borderColor: "{colors.hairline}"
---

## Overview

My Money Tracker is a compact, theme-driven application for personal portfolio and finance tracking. The design is organized around resizable panes, keyboard-first command access, dense lists, an extensible content area, and a customizable theme system.

The default dark workbench uses **near-black application chrome** (`{colors.canvas}` — #191A1B) around a darker content canvas (`{colors.canvas-soft}` — #121314). Foreground text is intentionally muted, with primary UI text at `{colors.ink}` (#bfbfbf), secondary text at `{colors.body}` / `{colors.muted}` (#8C8C8C), and disabled or placeholder text at `{colors.muted-soft}` (#555555). The primary action color is a restrained blue (`{colors.primary}` — #297AA0), supported by a focus and selection blue around `#3994BC`.

The application shell uses platform-native system fonts. Financial data displays use platform-specific monospace defaults. On Windows, the default monospace stack is `Consolas, "Courier New", monospace` at 14px. The workbench chrome is significantly smaller and denser than typical web application UI, with 13px default interface text, 12px compact labels, 1px separators, 4px-radius controls, and mostly square panels.

The strongest visual signature is the **multi-pane workbench architecture**: title bar, command bar, activity bar, side bar, content tabs, content groups, bottom panel, auxiliary panels, status bar, quick input, context menus, hover widgets, and integrated terminal. The design language is utilitarian rather than decorative. Visual hierarchy comes from density, layout, borders, tokenized color, compact utility icons, and keyboard interaction.

**Key Characteristics:**
- Theme-driven desktop workbench, not a fixed single-palette application.
- Dark chrome: `{colors.canvas}` (#191A1B); editor: `{colors.canvas-soft}` (#121314).
- Compact 13px workbench UI type; 12px title/status/button details.
- Platform-native shell font; platform-specific monospace editor font.
- 48px activity bar; 35px custom title bar; 22px status bar.
- Mostly square panels with 1px borders.
- Buttons and inputs use 4px radius.
- Subtle shadows exist on title bars, activity bars, tabs, floating widgets, and overlays.
- Active states are expressed through borders, underlines, low-alpha fills, and compact accents.

## Colors

### Brand & Accent
- **Primary Action Blue** (`{colors.primary}` — #297AA0): Primary workbench buttons and prominent plugin/chat/agent actions.
- **Primary Active / Hover Blue** (`{colors.primary-active}` — #2B7DA3): Hover/active state for primary buttons.
- **Focus / Selection Blue** (`{colors.accent-focus}` — #3994BC): Focus borders, badges, active panel accents, and selection-tinted surfaces.

### Surface
- **Canvas** (`{colors.canvas}` — #191A1B): Main workbench chrome: title bar, activity bar, side bar, status bar, panel, and terminal background.
- **Canvas Soft** (`{colors.canvas-soft}` — #121314): Main editor background and active editor tab background.
- **Surface Card** (`{colors.surface-card}` — #202122): Floating widgets, quick input, notifications, menus, editor widgets, and hover surfaces.
- **Surface Strong** (`{colors.surface-strong}` — #242526): Line highlights, text block quotes, hover fills, and subtle elevated bands.

### Hairlines
- **Hairline** (`{colors.hairline}` — #2A2B2CFF): Standard 1px border between workbench parts.
- **Hairline Soft** (`{colors.hairline-soft}` — #2A2B2C): Subtle separators and menu dividers.
- **Hairline Strong** (`{colors.hairline-strong}` — #333536): Stronger input, button, command-bar, checkbox, and dropdown borders.

### Text
- **Ink** (`{colors.ink}` — #bfbfbf): Primary workbench foreground.
- **Body** (`{colors.body}` — #8C8C8C): Descriptive text, inactive labels, secondary UI copy.
- **Body Strong** (`{colors.body-strong}` — #ededed): Active list foreground and high-emphasis UI text.
- **Muted** (`{colors.muted}` — #8C8C8C): Inactive title/status/sidebar/tab text.
- **Muted Soft** (`{colors.muted-soft}` — #555555): Disabled text and placeholders.
- **On Primary** (`{colors.on-primary}` — #ffffff): Text on primary blue buttons and badges.

### Accent Slots
- **Focus Blue** (`{colors.accent-focus}` — #3994BC): Focus rings, badges, active panel accents, and selection states.
- **Added Green** (`{colors.accent-added}` — #73c991): Added/new-item decorations.
- **Syntax Blue** (`{colors.accent-syntax-blue}` — #79c0ff): Syntax/support/property accent.
- **Modified Gold** (`{colors.accent-modified}` — #e5ba7d): Modified and warning decorations.
- **Success Green** (`{colors.accent-success}` — #72C892): Editor gutter added/success accent.

### Semantic
- **Success** (`{colors.semantic-success}` — #72C892): Added/success indicators.
- **Error** (`{colors.semantic-error}` — #f48771): Error text, deleted decorations, notification error icons, validation errors.

## Typography

### Font Family
The workbench UI uses platform-specific system fonts, not a custom brand typeface.

- macOS: `-apple-system, BlinkMacSystemFont, sans-serif`
- Windows: `"Segoe WPC", "Segoe UI", sans-serif`
- Linux: `system-ui, "Ubuntu", "Droid Sans", sans-serif`

Code editor defaults are platform-specific:

- Windows: `Consolas, "Courier New", monospace`
- macOS: `Menlo, Monaco, "Courier New", monospace`
- Linux: `"Droid Sans Mono", monospace`

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-mega}` | 26px | 600 | 1.3 | 0 | Empty-state or welcome headline; rare |
| `{typography.display-lg}` | 20px | 600 | 1.35 | 0 | Settings/editor page heading; rare |
| `{typography.display-md}` | 16px | 600 | 1.4 | 0 | Section heading |
| `{typography.display-sm}` | 14px | 600 | 1.4 | 0 | Panel group title |
| `{typography.title-md}` | 13px | 600 | 1.4 | 0 | Sidebar titles, view headers |
| `{typography.title-sm}` | 12px | 600 | 1.4 | 0 | Compact labels, tab/sidebar emphasis |
| `{typography.body-md}` | 13px | 400 | 1.4 | 0 | Default workbench UI |
| `{typography.body-tracked}` | 13px | 400 | 1.4 | 0 | Same as body; no special tracking |
| `{typography.body-sm}` | 12px | 400 | 1.4 | 0 | Status bar, title bar, compact metadata |
| `{typography.caption}` | 11px | 400 | 1.4 | 0 | Small captions, compact helper text |
| `{typography.caption-uppercase}` | 11px | 600 | 1.4 | 0.4px | Section labels only when explicitly styled |
| `{typography.code}` | 14px | 400 | 1.35 | 0 | Code editor on Windows/Linux; 12px on macOS |
| `{typography.button}` | 12px | 400 | 16px | 0 | Text buttons |
| `{typography.nav-link}` | 12px | 400 | 22px | 0 | Title bar, command bar, menu items |

### Principles
- **Workbench UI is dense.** Default shell text is 13px, not 16px.
- **Large display type is rare.** It appears mainly in welcome, onboarding, empty-state, or settings-style surfaces.
- **No negative tracking.** The typography is utilitarian and system-native.
- **Editor typography is separate from workbench typography.**
- **Compact utility icons are central.** Workbench icons are generally 16px glyphs.

### Note on Font Substitutes
For accuracy, use OS-native UI fonts for chrome and a familiar monospace stack for editor surfaces. A custom sans-serif can be used in a derivative product, but it will reduce the native desktop feel.

## Layout

### Spacing System
- **Base unit:** 4px in controls; many workbench layouts use 2px, 4px, 6px, and 8px increments.
- **Tokens:** `{spacing.xxs}` 2px · `{spacing.xs}` 4px · `{spacing.sm}` 6px · `{spacing.base}` 8px · `{spacing.md}` 12px · `{spacing.lg}` 16px · `{spacing.xl}` 24px · `{spacing.xxl}` 32px · `{spacing.section}` 48px.
- **Section padding:** Not a primary desktop-workbench concept. Use 8–16px inside panels, 24–48px only for welcome/settings pages.

### Grid & Container
- The shell is divided into resizable workbench parts: title bar, activity bar, side bar, editor area, panel, auxiliary bar, and status bar.
- Activity bar default width is 48px.
- Custom title bar height is 35px when the command bar is visible.
- Status bar height is 22px.
- Editor groups and panels are split with draggable sashes.
- Side bar, panel, and auxiliary bar widths/heights are user-resizable and persisted.

### Whitespace Philosophy
Whitespace is functional and compressed. The interface prioritizes visible information density over spacious presentation. Panels often use 0–8px internal spacing, with larger padding reserved for welcome pages, settings views, plugin details, and empty states.

## Elevation & Depth

The workbench uses **borders plus subtle tokenized shadows**. Most primary parts are separated by 1px borders. Floating widgets and some parts use soft shadows.

| Level | Treatment | Use |
|---|---|---|
| Workbench chrome | `{colors.canvas}` (#191A1B) | Title bar, side bar, activity bar, panel, status bar |
| Editor canvas | `{colors.canvas-soft}` (#121314) | Code editor background and active tab |
| Floating surface | `{colors.surface-card}` (#202122) + border/shadow | Quick input, notifications, hover widgets, suggest widgets |
| Hairline border | 1px `{colors.hairline}` | Panel boundaries, tab borders, side bar border |
| Active accent | Top/bottom/side border in `{colors.primary-active}` or `{colors.accent-focus}` | Active tab, active panel title, focus ring |

### Decorative Depth
- **Title bar, activity bar, tabs, and floating widgets** may use subtle shadows.
- **Panel depth** is mostly expressed through borders and separate surface colors.
- **No heavy card shadows.** Shadows are functional, not decorative.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Panels, tabs, editor, menus, status bar |
| `{rounded.xs}` | 2px | Tiny affordances, compact inline UI |
| `{rounded.sm}` | 3px | Rare compact controls |
| `{rounded.md}` | 4px | Buttons, inputs, command bar |
| `{rounded.lg}` | 6px | Softer custom overlays if needed |
| `{rounded.xl}` | 8px | Optional custom app surfaces |
| `{rounded.pill}` | 9999px | Badges only |
| `{rounded.full}` | 9999px | Avatars/accounts only |

## Components

### Title Bar

**`title-bar`** — Background `{colors.canvas}`, text `{colors.muted}`, height 35px for the custom title bar. Contains window controls, menu/title actions, navigation controls, layout controls, and usually the command bar.

### Command Bar

**`command-bar`** — Compact search/navigation affordance inside the title bar. Background `{colors.canvas}`, border `{colors.hairline-strong}`, text `{colors.ink}`, height 22px, rounded `{rounded.md}`. It is centered and can shrink or compact depending on available width.

### Activity Bar

**`activity-bar`** — Vertical icon rail. Background `{colors.canvas}`, width 48px, icon color `{colors.ink}` when active and `{colors.muted}` when inactive. Active item is indicated through border/accent state, not a large filled pill.

### Side Bar

**`side-bar`** — Project/search/plugin/agent view container. Background `{colors.canvas}`, border `{colors.hairline}`, text `{colors.ink}`. Headers are compact and may use uppercase or title-styled labels depending on the view.

### Editor Tabs

**`editor-tabs`** — Background `{colors.canvas}` with inactive tab text `{colors.muted}`. Active tabs use `{colors.canvas-soft}`, text `{colors.ink}`, and a top active border in `{colors.primary-active}` / `{colors.accent-focus}`.

**`editor-tab-active`** — Active editor tab. Background `{colors.canvas-soft}`, foreground `{colors.ink}`, top border accent, no large radius.

### Editor Pane

**`editor-pane`** — Code editor surface. Background `{colors.canvas-soft}`, text `{colors.body-strong}`, typography `{typography.code}`. No card padding; editor gutters, line numbers, minimap, selections, scroll affordances, and widgets are theme-token-driven.

### Panel

**`panel`** — Bottom or side panel for terminal, output, logs, validation results, background tasks, etc. Background `{colors.canvas}`, border `{colors.hairline}`, title text `{colors.ink}` when active and `{colors.muted}` when inactive. Active panel title uses a blue underline/accent.

### Status Bar

**`status-bar`** — Background `{colors.canvas}`, height 22px, text `{colors.muted}`, font size 12px. Items are compact, horizontally grouped left and right, with hover backgrounds.

### Buttons

**`button-primary`** — Primary text button. Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.button}` (12px / 400 / 16px), padding 4px × 8px, rounded `{rounded.md}` (4px), border from theme token.

**`button-primary-active`** — Hover/active state. Background `{colors.primary-active}`.

**`button-secondary`** — Secondary button. Text uses `{colors.ink}`, hover background uses a low-alpha white/gray fill.

**`button-tertiary-text`** — Plain text or toolbar action. Background transparent, text `{colors.ink}`, hover background from toolbar/list hover token.

### Quick Input

**`quick-input`** — Quick action/search picker surface. Background `{colors.surface-card}`, text `{colors.ink}`, border `{colors.hairline-strong}`, compact rows, keyboard-focused selection. It is a floating overlay, not a page card.

### Lists and Trees

**`list-row`** — Project/search/settings/list row. Transparent by default, text `{colors.ink}` or `{colors.muted}`. Hover uses a low-alpha white background. Active/focused selection uses blue-tinted selection background.

**`list-row-active`** — Active/focused list row. Background `#3994BC26`, foreground `{colors.body-strong}`.

### Menus and Context Views

**`context-menu`** — Background `{colors.surface-card}`, text `{colors.ink}`, border `{colors.hairline}`. Menu selection uses blue-tinted background, not a filled brand color.

### Notifications and Hover Widgets

**`notification-toast`** — Floating notification surface. Background `{colors.surface-card}`, border `{colors.hairline}`, text `{colors.ink}`. Error/warning/info icons use semantic colors.

**`hover-widget`** — Editor hover/suggest/detail widget surface. Background `{colors.surface-card}`, border `{colors.hairline}`, text `{colors.ink}`. These surfaces sit above the editor but remain visually subdued.

### Terminal

**`terminal`** — Integrated terminal panel. Background `{colors.canvas}`, foreground `{colors.ink}`, typography `{typography.code}`. Terminal selection, cursor, and tab border are theme-token-driven.

### Code

**`code-block`** — Non-editor code block in markdown/settings/welcome surfaces. Background `{colors.surface-strong}`, text `{colors.ink}` in `{typography.code}`, rounded `{rounded.md}`, padding 8px.

### Forms & Tags

**`text-input`** — Input box. Background `{colors.canvas}`, text `{colors.ink}`, rounded `{rounded.md}` (4px), padding 4px × 6px, border `{colors.hairline-strong}`.

**`badge-pill`** — Small count/status badge. Background `{colors.primary-active}` or `{colors.accent-focus}`, text `{colors.on-primary}`, rounded `{rounded.pill}`, compact padding.

### Status Decorations

**`scm-added`** — Added/new-item decoration. Text `{colors.semantic-success}`.

**`scm-modified`** — Modified-item decoration. Text `{colors.accent-modified}`.

**`scm-deleted`** — Removed/conflict decoration. Text `{colors.semantic-error}`.

### Chat / Agents

**`chat-input`** — Chat or agent input surface. Background `{colors.surface-card}`, text `{colors.ink}`, border `{colors.hairline-strong}`, focused border blue.

**`agents-panel`** — Agents/chat panel surface. Background `{colors.canvas}`, text `{colors.ink}`, border `{colors.hairline}`. Accent tint uses `{colors.primary}`.

## Do's and Don'ts

### Do
- Treat the design as a **theme-driven workbench**, not a fixed single-palette application.
- Use `{colors.canvas}` for workbench chrome and `{colors.canvas-soft}` for the editor.
- Use compact 13px UI text and 12px detail text.
- Use platform-native fonts for shell UI.
- Use monospace editor fonts that match the platform.
- Use 1px borders heavily.
- Keep panels dense and mostly square.
- Use `{colors.primary}` sparingly for primary actions, badges, focus/accent states, and selected controls.
- Keep active states subtle: border, underline, tinted row, or low-alpha blue fill.
- Use compact 16px utility glyphs for workbench icons.

### Don't
- Don't design the shell like a marketing website.
- Don't use large decorative display type for core workbench UI.
- Don't make every panel a rounded card.
- Don't replace dense workbench parts with spacious content cards.
- Don't use drop shadows as the main separation mechanism.
- Don't make the primary blue behave like a marketing CTA color everywhere.
- Don't assume one hard-coded color palette across the whole product; users can change themes.
- Don't use decorative accent palettes for core system state unless those colors are theme-tokenized.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Minimum desktop | 400px window width / 270px height | Minimum viable window size. Many panes become impractical; prioritize editor, quick action palette, and essential navigation. |
| Narrow | < 700px | Collapse secondary/auxiliary panels, keep activity bar compact, hide nonessential title actions, allow tabs/panel headers to overflow or scroll. |
| Standard desktop | 700–1280px | Normal workbench shell: activity bar + side bar + editor + panel/status bar. |
| Wide desktop | > 1280px | Support side bar + editor groups + auxiliary/chat panel together. |
| Multi-monitor / large | > 1600px | Multiple editor groups, auxiliary bar, persistent chat/agents panel, larger terminal/output area. |

### Touch Targets
- The desktop workbench is optimized for keyboard/mouse, not mobile touch.
- Buttons are visually compact: default text button padding is 4px × 8px with 12px text.
- Status bar is 22px high.
- Activity bar icons sit in a 48px-wide rail.
- Increase touch targets only if touch use is a product requirement.

### Collapsing Strategy
- Workbench parts are resizable and hideable rather than responsive in the website sense.
- Side bar, panel, auxiliary bar, and status bar can be hidden.
- Command bar compacts inside the title bar.
- Tabs scroll/overflow rather than becoming large mobile tabs.
- Fullscreen or focused layouts may remove or hide chrome to prioritize editor focus.
- Narrow layouts should keep the editor central and treat all other panels as temporary drawers.

## Iteration Guide

1. Start with the workbench shell: title bar, activity bar, side bar, editor area, panel, status bar.
2. Keep the editor canvas distinct from the surrounding chrome.
3. Use 13px UI text and 12px compact detail text.
4. Use 4px radius for buttons and inputs; panels and tabs mostly stay square.
5. Use 1px borders before shadows.
6. Add shadows only for overlays, tabs, title/activity depth, or floating widgets.
7. Keep primary blue restrained.
8. Implement keyboard focus rings early; focus borders are core to the interaction model.
9. Design resize/sash behavior as a first-class layout feature.
10. Treat themes as data. Do not bake colors directly into components if tokenization is possible.
11. Keep iconography simple, monochrome, and utility-like.
12. Make menus, quick input, and the quick action palette highly functional before styling them heavily.

## Known Gaps

- The application is themeable; this spec pins a representative dark default rather than every possible theme.
- Exact colors change when the user changes the active color theme.
- Exact font family depends on platform and locale.
- Editor font size is 14px on Windows/Linux and 12px on macOS by default.
- Product icons, file icons, and utility glyph details are not fully enumerated here.
- Animation timings, sash drag behavior, panel persistence, and accessibility edge cases are out of scope.
- Brand marks, plugin ecosystem identity, and distribution-specific product branding are out of scope.