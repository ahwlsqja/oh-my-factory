# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-10-19
- Primary product surfaces: CLI first; optional local, read-only operations dashboard.
- Evidence reviewed: `README.md`, `README.ko.md`, `docs/README.md`, `package.json`, `src/goal`, `src/work`, and `src/decision`. No existing browser UI, design tokens, screenshots, or brand assets were present.
- Approved direction: issue #36; an operations control room with persistent goal context, rather than a chat interface. This document governs the dashboard; existing protocol specifications continue to govern factory behavior.

## Brand

- Personality: precise, quiet, practical, transparent about uncertainty.
- Trust signals: local/read-only labeling, verified ledger revision, refresh timestamp, explicit unavailable and withheld states.
- Avoid: chat bubbles, decorative charts, fabricated activity, celebratory approval states, external fonts and services.

## Product goals

- Goals: help a developer identify blocked goals, last disclosed gap buckets, open work, human attention, evidence status, and recent ledger activity.
- Non-goals: mutation, approval, execution, merging, terminal replacement, raw metric exploration, and exposing private state.
- Success signals: a user can select a goal, identify its current condition, and distinguish trustworthy evidence from missing information without leaving the overview.

## Personas and jobs

- Primary personas: a developer supervising a local OMF repository and a reviewer inspecting its operational state.
- User jobs: see what is running; understand which goal or work item needs attention; inspect the provenance and limits of reported evidence.
- Key contexts of use: a desktop next to a terminal; narrow laptop windows; occasional mobile-width inspection.

## Information architecture

- Primary navigation: persistent goal list with a local ID filter; overview and selected-goal details share one screen.
- Core routes/screens: one dashboard at a random capability URL; no arbitrary filesystem or item routes.
- Content hierarchy: local/read-only identity → snapshot health and overview counts → selected goal and last disclosed gap → workboard and human attention → evidence → recent ledger events.

## Design principles

- Show provenance before interpretation: ledger verification and current snapshot revision remain visible.
- Keep decisions separate: an evidence recommendation, evidence integrity, and human approval are independent facts.
- Prefer honest absence: unavailable history is a clear empty state, never an inferred curve or invented baseline. Disclosed direction/size history is labeled as disclosures with event/time provenance; it is not a numeric trend.
- Tradeoffs: IDs and fixed vocabulary preserve privacy at the cost of richer titles; bounded lists preserve responsiveness and disclose truncation.

## Visual language

- Color: warm neutral canvas, charcoal text, indigo selection; restrained amber attention and red error states. Text always names status.
- Typography: system sans-serif for reading, system monospace for IDs, counts, and ledger revisions.
- Spacing/layout rhythm: 4 px base; 16–24 px card spacing; 240 px navigation rail; generous main content padding.
- Shape/radius/elevation: thin borders, 10–14 px radii, minimal shadow; one consistent panel vocabulary.
- Motion: none required; native scrolling only.
- Imagery/iconography: typographic OMF mark, simple CSS status dots and separators; no external assets.

## Components

- Existing components to reuse: none; reuse the repository's dependency-free TypeScript build.
- New/changed components: app shell, goal selector, stat cards, status pills, current-gap summary, workboard rows, human-attention rows, evidence fact groups, ledger timeline, empty/error notice.
- Variants and states: neutral, attention, error, loading, empty, unavailable, truncated, withheld, and verified ledger source.
- Token/component ownership: CSS custom properties in `src/ui/page.ts`; no parallel component framework or token package.

## Accessibility

- Target standard: WCAG 2.2 AA design intent.
- Keyboard/focus behavior: skip link, native buttons and labeled inputs; visible focus rings; selected goal uses `aria-pressed`; refresh does not move focus.
- Contrast/readability: readable system text; muted text remains legible; status has words in addition to color.
- Screen-reader semantics: header, navigation, main, named sections, lists, descriptive controls, and a polite refresh-status region.
- Reduced motion and sensory considerations: no animation, no flashing, no reliance on hover or color.

## Responsive behavior

- Supported breakpoints/devices: desktop from 1100 px, compact layout below 1100 px, stacked shell below 720 px.
- Layout adaptations: two-column detail panels collapse to one; navigation becomes a bounded horizontal-width section above content; counts wrap.
- Touch/hover differences: controls have at least 40 px height; all information is visible without hover.

## Interaction states

- Loading: neutral notice while retrieving the initial snapshot; refresh button indicates an active request.
- Empty: explain that no goals, work, events, evidence, or human requests are available; never insert sample content.
- Error: distinguish uninitialized, corrupt ledger, unavailable state, interrupted fetch, and unavailable or invalid local URL; allow read-only retry.
- Success: display the time of the successful fetch and the verified snapshot revision, without implying goal completion.
- Disabled: refresh is disabled only while fetching; selected-goal details are absent when no goal exists.
- Offline/slow network: retain the last snapshot with a clear stale warning; abort a request after a bounded timeout; optional 15-second polling runs only when selected and the tab is visible.

## Content voice

- Tone: concise and factual; explain uncertainty without blame.
- Terminology: goal, work item, needs human, evidence, ledger, last disclosed gap, recommendation, integrity, approval.
- Microcopy rules: human-readable enum labels; IDs rendered literally; no raw errors, paths, titles, objectives, notes, commands, actors, scenario content, or metric names, units, and values.

## Implementation constraints

- Framework/styling system: vanilla DOM APIs and plain CSS embedded as exported TypeScript strings; external same-origin script and stylesheet; no new dependencies.
- Design-token constraints: system light/dark preference and CSS variables; no external fonts, icons, or CDN.
- Performance constraints: bounded server projection, one snapshot request, no background execution; optional 15-second read polling.
- Compatibility constraints: Node 22 build and current evergreen browsers; all data enters through `textContent`/DOM node construction, never HTML interpolation; strict CSP has no inline script or event handlers.
- Test/screenshot expectations: executable client-script tests cover hostile IDs and failure states; parent integration runs server and browser QA at desktop/mobile widths. No claim of measured visual accessibility until checked.

## Open questions

- [ ] Historical numeric metric contract / future protocol work / numerical trends remain unavailable; only authenticated current-contract disclosure buckets can be shown.
- [ ] Broader localized UI / future product decision / the initial dashboard uses concise English; Korean CLI documentation links to the same guide.
