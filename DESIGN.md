---
version: alpha
name: MMT-design
description: A dark, financially-tuned single-page web application for personal portfolio tracking. The design uses a near-black base surface at `#06080A`, layered card surfaces rising through `#0F1216` and `#161B22`, crisp white primary text (`#FFFFFF`), softened secondary text (`#E2E8F0`), and an electric teal accent system (`#00FFCC`). The UI pairs DM Sans for interface chrome with IBM Plex Mono for financial figures. Cards use generous 16px radii, subtle glow shadows, and gradient overlays. The design language is luxurious and data-dense, optimized for at-a-glance portfolio comprehension rather than utilitarian tooling.

colors:
  accent: "#00FFCC"
  accent-hover: "#33FFD6"
  accent-muted: "rgba(0, 255, 204, 0.1)"
  accent-subtle: "rgba(0, 255, 204, 0.05)"
  ink: "#FFFFFF"
  body: "#E2E8F0"
  body-muted: "#94A3B8"
  canvas: "#06080A"
  surface: "#0F1216"
  surface-2: "#161B22"
  surface-3: "#1F242C"
  overlay: "rgba(0, 0, 0, 0.75)"
  on-accent: "#06080A"
  gain: "#10B981"
  gain-bg: "rgba(16, 185, 129, 0.1)"
  loss: "#F43F5E"
  loss-bg: "rgba(244, 63, 94, 0.1)"
  hairline: "#1E293B"
  hairline-hover: "#334155"
  hairline-focus: "#00FFCC"
  input-bg: "#0D1117"
  input-border: "#1E293B"
  glass-bg: "rgba(15, 18, 22, 0.7)"
  glass-border: "rgba(255, 255, 255, 0.05)"
  chart-1: "#00FFCC"
  chart-2: "#3B82F6"
  chart-3: "#8B5CF6"
  chart-4: "#F59E0B"
  chart-5: "#EC4899"
  chart-6: "#06B6D4"
  chart-7: "#F97316"
  chart-8: "#84CC16"
  tooltip-bg: "#1C2230"
  tooltip-border: "#2A3347"
  tooltip-text: "#E8ECF1"
  tooltip-label: "#8B95A5"

typography:
  display-hero:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 3.5rem
    fontWeight: 800
    lineHeight: 1
    letterSpacing: -0.02em
  display-lg:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 1.875rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.01em
  display-md:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 1.25rem
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0
  title-md:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  body-md:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0.01em
  body-sm:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  label:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 0.75rem
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.1em
    textTransform: uppercase
  money:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: clamp(1.75rem, 4vw, 2.5rem)
    fontWeight: 700
    lineHeight: 1
    letterSpacing: -0.02em
  money-sm:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  nav-link:
    fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif"
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0

rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 24px
  pill: 9999px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  section: 64px

components:
  sidebar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.body}"
    typography: "{typography.nav-link}"
    width: 260px
    widthCollapsed: 80px
    borderColor: "{colors.hairline}"
  sidebar-item:
    backgroundColor: transparent
    textColor: "{colors.body}"
    typography: "{typography.nav-link}"
    rounded: "{rounded.lg}"
    padding: 12px
  sidebar-item-active:
    backgroundColor: "{colors.accent-muted}"
    textColor: "{colors.accent}"
    accentBorder: "4px solid {colors.accent}"
  metric-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.money}"
    rounded: "{rounded.xl}"
    borderColor: "{colors.hairline}"
    padding: 24px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    borderColor: "{colors.hairline}"
    padding: 24px
  glass-card:
    backgroundColor: "{colors.glass-bg}"
    borderColor: "{colors.glass-border}"
    rounded: "{rounded.xl}"
    backdropFilter: "blur(12px)"
  chart-tooltip:
    backgroundColor: "{colors.tooltip-bg}"
    textColor: "{colors.tooltip-text}"
    labelColor: "{colors.tooltip-label}"
    borderColor: "{colors.tooltip-border}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 8px 16px
    fontWeight: 500
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    shadow: "0 0 20px rgba(0, 255, 204, 0.15)"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.body}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    borderColor: "{colors.hairline}"
  text-input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    borderColor: "{colors.input-border}"
    padding: 8px 12px
  table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    headerColor: "{colors.body-muted}"
    rounded: "{rounded.xl}"
    borderColor: "{colors.hairline}"
  login-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    borderColor: "{colors.hairline}"
    maxWidth: 448px
  mobile-overlay:
    backgroundColor: "rgba(0, 0, 0, 0.6)"
    backdropFilter: "blur(4px)"
---

## Overview

My Money Tracker is a personal portfolio dashboard built as a single-page web application. The design is organized around a collapsible sidebar, metric cards, data tables, and interactive charts, all rendered in a dark, financially-tuned aesthetic called **Dark Terminal Luxe**.

The default palette uses a **near-black base** (`{colors.canvas}` -- #06080A) with layered card surfaces stepping up through `{colors.surface}` (#0F1216), `{colors.surface-2}` (#161B22), and `{colors.surface-3}` (#1F242C). Primary text is crisp white (`{colors.ink}` -- #FFFFFF), secondary text is a warm slate (`{colors.body}` -- #E2E8F0), and tertiary labels use `{colors.body-muted}` (#94A3B8). The accent is an electric teal (`{colors.accent}` -- #00FFCC) used sparingly for active states, focus rings, primary buttons, and chart highlights.

The interface uses two typefaces: **DM Sans** for all UI chrome (navigation, labels, headings, body text) and **IBM Plex Mono** for financial figures (portfolio values, currency amounts, percentages). This pairing creates a clear visual distinction between navigational context and numerical data.

Cards use generous **16px border radii**, subtle 1px borders, and glow shadows on hover. Animations are handled through Framer Motion with spring-based transitions. The overall feel is luxurious and data-dense -- closer to a Bloomberg terminal reimagined with modern web aesthetics than a typical fintech app.

**Key Characteristics:**
- Dark-mode-only financial dashboard, single color theme.
- Near-black base: `{colors.canvas}` (#06080A); card surfaces: `{colors.surface}` (#0F1216).
- DM Sans for UI text; IBM Plex Mono for monetary values.
- Electric teal accent (#00FFCC) used for interactive elements and data highlights.
- 16px card radii, 8px input/button radii, generous padding.
- Sidebar navigation with collapsible/expanded states and mobile drawer.
- Semantic gain (#10B981) / loss (#F43F5E) color pair throughout.
- Framer Motion spring animations for page transitions and card interactions.
- Recharts-based data visualization with an 8-color chart palette.

## Colors

### Accent
- **Accent Teal** (`{colors.accent}` -- #00FFCC): Primary buttons, active nav items, focus rings, chart primary color, and interactive highlights.
- **Accent Hover** (`{colors.accent-hover}` -- #33FFD6): Hover state for primary buttons and interactive accents.
- **Accent Muted** (`{colors.accent-muted}` -- rgba(0, 255, 204, 0.1)): Active nav item backgrounds, subtle tinted fills.
- **Accent Subtle** (`{colors.accent-subtle}` -- rgba(0, 255, 204, 0.05)): Faint background washes and hover tints.

### Surface
- **Canvas** (`{colors.canvas}` -- #06080A): Page background, login background.
- **Surface** (`{colors.surface}` -- #0F1216): Cards, sidebar, tables, primary content containers.
- **Surface 2** (`{colors.surface-2}` -- #161B22): Hover states, icon containers, secondary elevated elements.
- **Surface 3** (`{colors.surface-3}` -- #1F242C): Tertiary elevation, user avatar backgrounds, collapse toggles.
- **Overlay** (`{colors.overlay}` -- rgba(0, 0, 0, 0.75)): Modal backdrops, mobile sidebar overlay.

### Text
- **Ink** (`{colors.ink}` -- #FFFFFF): Primary text, headings, monetary values.
- **Body** (`{colors.body}` -- #E2E8F0): Secondary text, nav labels, descriptions.
- **Body Muted** (`{colors.body-muted}` -- #94A3B8): Tertiary text, timestamps, table headers, placeholder content.
- **On Accent** (`{colors.on-accent}` -- #06080A): Text on accent-colored buttons and badges.

### Semantic
- **Gain** (`{colors.gain}` -- #10B981): Positive returns, upward trends, success states.
- **Gain Background** (`{colors.gain-bg}` -- rgba(16, 185, 129, 0.1)): Subtle fill behind gain indicators.
- **Loss** (`{colors.loss}` -- #F43F5E): Negative returns, downward trends, error states, destructive actions.
- **Loss Background** (`{colors.loss-bg}` -- rgba(244, 63, 94, 0.1)): Subtle fill behind loss indicators, error message backgrounds.

### Borders
- **Hairline** (`{colors.hairline}` -- #1E293B): Standard card and sidebar borders, grid lines.
- **Hairline Hover** (`{colors.hairline-hover}` -- #334155): Hover-state borders, scrollbar thumb hover.
- **Hairline Focus** (`{colors.hairline-focus}` -- #00FFCC): Focus ring color for inputs and interactive elements.

### Glass
- **Glass Background** (`{colors.glass-bg}` -- rgba(15, 18, 22, 0.7)): Frosted glass card background.
- **Glass Border** (`{colors.glass-border}` -- rgba(255, 255, 255, 0.05)): Subtle white border for glass surfaces.

### Chart Palette
An 8-color sequence for multi-series charts and allocation donuts:
1. `{colors.chart-1}` (#00FFCC) -- Teal (primary)
2. `{colors.chart-2}` (#3B82F6) -- Blue
3. `{colors.chart-3}` (#8B5CF6) -- Purple
4. `{colors.chart-4}` (#F59E0B) -- Amber
5. `{colors.chart-5}` (#EC4899) -- Pink
6. `{colors.chart-6}` (#06B6D4) -- Cyan
7. `{colors.chart-7}` (#F97316) -- Orange
8. `{colors.chart-8}` (#84CC16) -- Lime

## Typography

### Font Families
- **UI Chrome:** `'DM Sans', system-ui, -apple-system, sans-serif` -- All navigation, headings, labels, body text, and buttons.
- **Financial Figures:** `'IBM Plex Mono', monospace` -- Portfolio values, currency amounts, percentages, and numerical table data. Applied via the `.font-money` utility class.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-hero}` | 3.5rem | 800 | 1 | -0.02em | Hero portfolio value on dashboard; rare |
| `{typography.display-lg}` | 1.875rem | 700 | 1.2 | -0.01em | Page headings, login title |
| `{typography.display-md}` | 1.25rem | 700 | 1.3 | 0 | Section headings, card group titles |
| `{typography.title-md}` | 1rem | 600 | 1.4 | 0 | Sidebar nav items, form section titles |
| `{typography.body-md}` | 0.875rem | 400 | 1.6 | 0.01em | Default body text, descriptions, form labels |
| `{typography.body-sm}` | 0.75rem | 400 | 1.4 | 0 | Table cells, timestamps, compact metadata |
| `{typography.label}` | 0.75rem | 700 | 1.4 | 0.1em | Metric card labels, section dividers (uppercase) |
| `{typography.money}` | clamp(1.75rem, 4vw, 2.5rem) | 700 | 1 | -0.02em | Primary financial figures in metric cards |
| `{typography.money-sm}` | 0.75rem | 400 | 1.4 | 0 | Inline monetary values, chart tooltips, table figures |
| `{typography.nav-link}` | 1rem | 600 | 1.4 | 0 | Sidebar navigation items |

### Principles
- **Two-typeface system.** DM Sans for reading; IBM Plex Mono for scanning numbers. Never mix.
- **Financial figures use the `.font-money` class.** This applies IBM Plex Mono with tight negative letter-spacing.
- **Labels are uppercase.** Metric card labels, section dividers, and sidebar section headers use `{typography.label}` -- 12px, bold, 0.1em tracking, uppercase.
- **Base font size is 110%.** Set on `<html>` to improve readability at standard viewing distances.
- **Body line-height is 1.6.** More generous than typical dense UIs, optimized for the dashboard's card-based layout.

## Layout

### Spacing System
- **Base unit:** 4px increments, with 8px as the most common internal padding unit.
- **Tokens:** `{spacing.xs}` 4px, `{spacing.sm}` 8px, `{spacing.md}` 12px, `{spacing.base}` 16px, `{spacing.lg}` 24px, `{spacing.xl}` 32px, `{spacing.2xl}` 48px, `{spacing.section}` 64px.
- **Card padding:** 24px (`{spacing.lg}`) is standard for metric cards and content cards.
- **Component gaps:** 6px between nav items; 16-24px between card grid items.

### Grid & Container
- The shell is a horizontal flex layout: sticky sidebar + scrollable main content area.
- Sidebar default width is 260px expanded, 80px collapsed (icon-only mode).
- Mobile sidebar is a 280px overlay drawer with backdrop blur.
- Main content uses responsive CSS grid: 1 column on mobile, 2-4 columns for metric cards on desktop.
- Dashboard metric cards use `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`.
- Tables span full width within their containing card.
- Maximum content width is unconstrained -- content fills available space.

### Whitespace Philosophy
Whitespace is generous compared to dense tooling UIs. Cards have 24px internal padding, metric cards use vertical stacking with 16px gaps between label and value. The design prioritizes visual breathing room and scannable hierarchy over raw information density. Each card is a self-contained data unit with clear internal structure.

## Elevation & Depth

The design uses **borders plus glow shadows** rather than traditional drop shadows. Surfaces are distinguished primarily by background color stepping, with borders providing edge definition.

| Level | Treatment | Use |
|---|---|---|
| Page canvas | `{colors.canvas}` (#06080A) | Page background, login backdrop |
| Primary surface | `{colors.surface}` (#0F1216) + 1px border | Cards, sidebar, tables |
| Elevated surface | `{colors.surface-2}` (#161B22) | Hover fills, icon containers, sidebar footer |
| Tertiary surface | `{colors.surface-3}` (#1F242C) | Avatar backgrounds, collapse controls |
| Glass surface | `{colors.glass-bg}` + blur(12px) + glass border | Special overlay cards |
| Hover glow | `0 0 20px rgba(0, 255, 204, 0.12)` | Interactive card hover state |
| Focus ring | `0 0 0 2px rgba(0, 255, 204, 0.15)` | Input focus state |

### Decorative Depth
- **Metric cards** use a left accent border (4px, color-coded by value sentiment) and a subtle directional gradient from the accent glow color.
- **Interactive cards** gain a teal border and glow shadow on hover (`shadow-glow`).
- **Glass cards** use `backdrop-filter: blur(12px)` with a faint white border for frosted-glass effect.
- **Login page** uses a radial gradient emanating from center-top to create a subtle teal ambient glow on the base canvas.
- **No heavy box shadows.** Depth is expressed through surface color, border accents, and soft glow rather than elevated shadow layers.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Not used in standard components |
| `{rounded.sm}` | 4px | Compact inline elements |
| `{rounded.md}` | 8px | Buttons, inputs, form controls, scrollbar thumbs |
| `{rounded.lg}` | 12px | Nav items, sidebar buttons, icon containers |
| `{rounded.xl}` | 16px | Cards, tables, metric cards, modals |
| `{rounded.2xl}` | 24px | Large decorative containers |
| `{rounded.pill}` | 9999px | Active nav indicator pill, badges, sparkline dots |
| `{rounded.full}` | 9999px | User avatar, chart legend dots |

## Components

### Sidebar

**`sidebar`** -- Vertical navigation rail. Background `{colors.surface}`, right border `{colors.hairline}`, text `{colors.body}`. Contains app logo/title header (h-16), scrollable nav section, user profile footer, and collapse toggle. Expanded width 260px; collapsed width 80px (icon-only with tooltips). Lucide React icons at 22px.

**`sidebar-item`** -- Nav row. Transparent background, text `{colors.body}`, rounded `{rounded.lg}`, padding 12px. Hover: background `{colors.surface-2}`, text `{colors.ink}`. Icon scales to 110% on hover.

**`sidebar-item-active`** -- Active nav row. Background `{colors.accent-muted}`, text `{colors.accent}`, with a 4px-wide × 28px-tall accent pill on the left edge (animated via Framer Motion `layoutId`). Icon uses `strokeWidth: 2.5` (vs 2 for inactive).

### Section Dividers
In expanded sidebar, sections (ANALYTICS, PLANNING) use uppercase `{typography.label}` in `{colors.body}`. In collapsed mode, sections render as a horizontal hairline rule.

### Metric Cards

**`metric-card`** -- Primary financial KPI display. Background `{colors.surface}` with a left accent border (4px, color-coded: gain green, loss red, accent teal, or default hairline). Contains an uppercase label (`{typography.label}`), optional change indicator with trend arrow, an icon in a rounded container (`{colors.surface-2}`), and the primary value in `{typography.money}` using `.font-money`.

Card includes a decorative oversized icon watermark (120px, 4% opacity) in the bottom-right corner that scales and rotates on hover. A gloss gradient overlay fades in on hover. Entire card lifts 5px on hover (Framer Motion `whileHover`).

### Cards

**`card`** -- Standard content container. Background `{colors.surface}`, 1px border `{colors.hairline}`, rounded `{rounded.xl}` (16px). Transition: `all 0.3s cubic-bezier(0.4, 0, 0.2, 1)`.

**`card-interactive`** -- Clickable card variant. On hover: border transitions to `{colors.accent}`, gains glow shadow `0 0 20px rgba(0, 255, 204, 0.12)`.

**`glass-card`** -- Frosted glass variant. Background `{colors.glass-bg}`, `backdrop-filter: blur(12px)`, 1px border `{colors.glass-border}`, rounded `{rounded.xl}`.

### Charts

All charts use Recharts with a shared theme from `chartTheme.js`.

- **Grid lines:** `{colors.hairline}` (#1E293B), dashed (3px dash, 3px gap).
- **Axis text:** `{colors.body-muted}` area (#525D6E), 11px, no tick lines.
- **Axis lines:** `{colors.hairline}` (#1E293B).
- **Area fills:** Linear gradient from color at 25% opacity to transparent, defined via `areaGradient()` helper.
- **Chart palette:** 8-color sequence starting with accent teal, applied in order to chart series.

**`chart-tooltip`** -- Custom tooltip surface. Background `{colors.tooltip-bg}` (#1C2230), 1px border `{colors.tooltip-border}` (#2A3347), rounded `{rounded.md}`, padding 12px, shadow-xl. Date/label in `{colors.tooltip-label}` (#8B95A5) at 12px. Values in `{colors.tooltip-text}` (#E8ECF1) using `font-mono`. Each series gets a colored 8px dot indicator.

### Tables

Tables use TanStack Table for sorting and interaction. Header text in `{colors.body-muted}`, row text in `{colors.body}`, contained within a `card` wrapper. Monetary values in table cells use `.font-money`. Rows may have hover highlights at `{colors.surface-2}`.

### Buttons

**`button-primary`** -- Background `{colors.accent}`, text `{colors.on-accent}`, font-weight 500, rounded `{rounded.md}` (8px), padding 8px x 16px. Hover: background `{colors.accent-hover}`, glow shadow. Disabled: 50% opacity, `cursor-not-allowed`. Minimum touch target: 44px height on mobile.

**`button-secondary`** -- Background `{colors.surface-2}`, text `{colors.body}`, 1px border `{colors.hairline}`, rounded `{rounded.md}`. Hover: border `{colors.hairline-hover}`.

### Forms & Inputs

**`text-input`** -- Background `{colors.input-bg}` (#0D1117), 1px border `{colors.input-border}`, text `{colors.ink}`, rounded `{rounded.md}` (8px), padding 8px x 12px. Focus: border `{colors.hairline-focus}` (#00FFCC), `box-shadow: 0 0 0 2px rgba(0, 255, 204, 0.15)`, no outline. Transition: `all 0.2s ease`. Minimum height 44px on mobile for touch targets.

**Labels** use `{typography.body-md}` at font-weight 500 in `{colors.body}`.

### Login

**`login-card`** -- Centered card (`max-width: 448px`) on the base canvas with a radial teal gradient wash behind it (`rgba(0, 212, 170, 0.06)` ellipse at 50% 30%). Card uses standard `.card` styles. Title in `{typography.display-lg}`, subtitle in `{typography.body-md}` / `{colors.body}`. Primary submit button spans full width with glow shadow.

Error messages use `{colors.loss}` text on `{colors.loss-bg}` background with a `{colors.loss}/20` border, rounded `{rounded.lg}`.

### Allocation Donut

Donut chart using the 8-color chart palette. Center label shows total or selected segment value in `.font-money`. Legend uses colored dots (8px, full-rounded) with labels in `{typography.body-sm}`.

### SparkLine

Compact inline area chart for trend visualization within cards. Uses `areaGradient()` with the primary accent color. No axes or labels -- pure shape communication.

### Mobile Drawer

On mobile (< 768px), the sidebar becomes a slide-in drawer from the left edge (280px wide). Backdrop is `{colors.overlay}` with `backdrop-filter: blur(4px)`. Drawer animates with spring physics (`damping: 25, stiffness: 200`). Hamburger menu icon in the top bar triggers open/close.

## Do's and Don'ts

### Do
- Use `{colors.canvas}` for page background and `{colors.surface}` for all content cards.
- Use DM Sans for all UI text and IBM Plex Mono (`.font-money`) exclusively for financial figures.
- Use the gain/loss color pair consistently: green (#10B981) for positive, red (#F43F5E) for negative.
- Use 16px border radius for cards and containers; 8px for buttons and inputs.
- Use subtle glow shadows (`rgba(0, 255, 204, 0.12)`) rather than heavy box shadows.
- Keep the accent teal restrained: active states, focus rings, primary buttons, chart highlights. Not everywhere.
- Use uppercase tracking-wide labels for metric card titles and section dividers.
- Use Framer Motion spring animations for layout transitions and interactive feedback.
- Use the 8-color chart palette in order; start with accent teal for the primary series.
- Apply left accent borders on metric cards to encode value sentiment at a glance.

### Don't
- Don't use IBM Plex Mono for non-financial text (labels, descriptions, navigation).
- Don't use the accent teal as a large background fill. It is a highlight color, not a surface color.
- Don't flatten the surface hierarchy. The 4-step background scale (canvas > surface > surface-2 > surface-3) creates depth.
- Don't use heavy drop shadows. Depth comes from surface color stepping and glow effects.
- Don't make cards square. The 16px radius is core to the visual identity.
- Don't use bright white (#FFFFFF) for secondary or tertiary text. Reserve it for `{colors.ink}` (primary) only.
- Don't mix the gain and loss colors outside their semantic meaning (positive/negative financial values and trends).
- Don't skip the `.font-money` class on financial figures. The typeface distinction is a key design signal.
- Don't use light mode or provide a light theme toggle. The design is dark-mode-only.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 640px | Sidebar hidden, hamburger menu, single-column metric cards, stacked layout, 44px touch targets |
| Small tablet | 640-767px | 2-column metric card grid, sidebar still drawer-based |
| Tablet | 768-1023px | Sidebar visible (collapsed icon-only mode), 2-column cards |
| Desktop | 1024-1279px | Sidebar expanded, 3-column metric cards, full table layouts |
| Wide desktop | >= 1280px | 4-column metric cards, spacious chart displays |

### Touch Targets
- All interactive elements enforce a 44px minimum touch target on mobile.
- Inputs use `min-h-[44px]` and `touch-manipulation` to prevent iOS zoom.
- Nav items have 12px vertical padding for comfortable mobile tapping.
- Buttons match the 44px minimum on mobile viewports.

### Collapsing Strategy
- Sidebar collapses from 260px expanded to 80px icon-only on desktop; becomes a drawer overlay on mobile.
- Metric card grid reduces columns: 4 > 3 > 2 > 1 as viewport narrows.
- Tables remain full-width and gain horizontal scroll on narrow viewports.
- Charts resize fluidly within their card containers using Recharts' `ResponsiveContainer`.
- Page transitions and card hover animations are preserved across all breakpoints.

## Animation

The application uses **Framer Motion** for all meaningful UI animation.

| Element | Animation | Timing |
|---|---|---|
| Page content | Fade in + slide up 20px | 0.4-0.5s, cubic-bezier(0.4, 0, 0.2, 1) |
| Metric cards | Fade in + slide up 15px | 0.4s per card, staggered |
| Card hover | Lift 5px (translateY) | 0.2s |
| Card tap | Scale to 0.98 | Instant |
| Active nav pill | Spring layout animation | stiffness: 300, damping: 30 |
| Sidebar expand/collapse | Width animation | Framer Motion `animate` |
| Mobile drawer | Slide from left, spring | damping: 25, stiffness: 200 |
| Mobile backdrop | Opacity fade | Standard exit transition |
| Subtle pulse | Opacity 1 > 0.8 > 1 | 3s infinite ease-in-out |
| Float | translateY 0 > -10px > 0 | 6s infinite ease-in-out |

## Iteration Guide

1. Start with the sidebar + main content shell. Get the collapsed/expanded/mobile drawer states working first.
2. Build the metric card grid with the left accent border and `.font-money` value display.
3. Establish the card component with proper border radius, border color, and hover glow.
4. Wire up the chart theme (grid, axes, tooltip, gradient fills) before building individual charts.
5. Apply the gain/loss color pair to all financial change indicators consistently.
6. Use the `{typography.label}` style (uppercase, tracked, bold) for all metric labels and section headers.
7. Implement focus rings (`{colors.hairline-focus}` + glow box-shadow) on all interactive elements.
8. Add Framer Motion animations last -- cards should look correct without animation before adding motion.
9. Test the 4-step surface hierarchy (canvas > surface > surface-2 > surface-3) to ensure each level is visually distinct.
10. Verify `.font-money` is applied to every financial figure and nowhere else.

## Known Gaps

- The application is dark-mode-only; no light theme is defined or planned.
- Chart colors are hardcoded in `chartTheme.js`, not driven by CSS custom properties.
- Tooltip styles (`TOOLTIP_STYLE`) are JS constants, not CSS variables.
- The 8-color chart palette may need extension for views with more than 8 data series.
- Exact Framer Motion spring constants may vary by component; the values above are representative defaults.
- Icon sizing and stroke weights are not fully tokenized; Lucide icons default to 22px/2 stroke in nav, 24px/2.5 in cards.
- Scrollbar styling uses WebKit-specific pseudo-elements; Firefox scrollbar theming is not implemented.
- Font loading strategy (DM Sans, IBM Plex Mono) is not specified here; assumed via Google Fonts or local hosting.
