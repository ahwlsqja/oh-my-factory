/** Static assets served beneath the session capability URL; no remote assets or build pipeline. */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <title>OMF · Operations</title>
  <link rel="stylesheet" href="./style.css">
  <script src="./app.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">Skip to operations</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Workspace navigation">
      <a class="brand" href="./" aria-label="OMF operations home"><span class="brand-mark">omf</span><span>oh-my-factory<span class="brand-subtitle">OPERATIONS</span></span></a>
      <div class="workspace-label"><span class="local-dot" aria-hidden="true"></span> Local workspace <span class="readonly-tag">READ ONLY</span></div>
      <nav aria-label="Goals">
        <div class="rail-heading"><h2>Goals</h2><span id="goal-count" class="count">—</span></div>
        <label class="sr-only" for="goal-filter">Filter goals by ID</label>
        <input id="goal-filter" type="search" placeholder="Filter by goal ID…" autocomplete="off" spellcheck="false">
        <div id="goal-list" class="goal-list"><p class="empty">Loading goals…</p></div>
      </nav>
      <div class="rail-footer"><span class="footer-mark" aria-hidden="true">◫</span><p>The terminal stays in control.<br><span>This view never changes factory state.</span></p></div>
    </aside>
    <main id="main" tabindex="-1">
      <header class="page-header">
        <div><p class="eyebrow">FACTORY / OBSERVABILITY</p><h1>Operations overview</h1><p class="subtitle">Your goals, work, and the evidence behind them.</p></div>
        <div class="refresh-controls"><label class="poll-label"><input id="auto-refresh" type="checkbox"> Refresh every 15s</label><button id="refresh" type="button" class="refresh-button">Refresh</button></div>
      </header>
      <div class="snapshot-meta"><span id="refresh-status" role="status" aria-live="polite">Connecting to the local factory…</span><span id="revision" class="mono">Revision unavailable</span></div>
      <div id="notice" class="notice" hidden></div>
      <section aria-label="Factory overview" id="overview" class="stats"></section>
      <section id="goal-section" aria-labelledby="selected-goal" hidden>
        <div class="section-heading goal-heading"><div><p class="eyebrow">SELECTED GOAL</p><h2 id="selected-goal" class="mono"></h2></div><div id="goal-status" class="pills"></div></div>
        <div id="goal-warnings" class="goal-warnings"></div>
        <div class="detail-grid">
          <section class="panel" aria-labelledby="gap-title"><div class="panel-heading"><h3 id="gap-title">Last disclosed gap</h3><span class="section-number">01</span></div><div id="gap"></div></section>
          <section class="panel" aria-labelledby="history-title"><div class="panel-heading"><h3 id="history-title">Disclosure history</h3><span class="section-number">02</span></div><div id="history"></div></section>
          <section class="panel" aria-labelledby="work-title"><div class="panel-heading"><h3 id="work-title">Workboard</h3><span id="work-count" class="count"></span></div><div id="workboard"></div></section>
          <section class="panel" aria-labelledby="human-title"><div class="panel-heading"><h3 id="human-title">Needs human</h3><span id="human-count" class="count"></span></div><div id="needs-human"></div></section>
          <section class="panel full-width" aria-labelledby="evidence-title"><div class="panel-heading"><div><h3 id="evidence-title">Evidence</h3><p class="panel-description">Recorded recommendations only. Report details stay in the CLI.</p></div><span class="section-number">03</span></div><div id="evidence"></div></section>
        </div>
      </section>
      <section id="timeline-section" class="panel timeline-panel" aria-labelledby="timeline-title" hidden><div class="panel-heading"><div><h3 id="timeline-title">Ledger activity</h3><p class="panel-description">Recent events for the selected goal and workspace.</p></div><span class="readonly-tag">VERIFIED SOURCE</span></div><div id="timeline"></div></section>
      <footer class="page-footer"><span>OMF · Local observation</span><span>Decisions and actions happen in your terminal.</span></footer>
      <noscript><p class="notice">JavaScript is needed to load this read-only view. Use the OMF CLI to inspect factory state.</p></noscript>
    </main>
  </div>
</body>
</html>`;

export const UI_CSS = `
:root {
  color-scheme:light dark;
  --canvas:#f7f8fa;
  --surface:#fff;
  --rail:#fbfbfc;
  --text:#20242e;
  --muted:#626b7b;
  --line:#e4e7ed;
  --accent:#4f46c8;
  --accent-soft:#efedfc;
  --attention:#916006;
  --attention-bg:#fff7e7;
  --danger:#b33d3d;
  --danger-bg:#fff0f0;
  --soft:#f4f5f8;
  --radius:12px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size:14px;
}
* {
  box-sizing:border-box;
}
body {
  margin:0;
  background:var(--canvas);
  color:var(--text);
  line-height:1.5;
}
button,input {
  font:inherit;
}
button,a,input {
  -webkit-tap-highlight-color:transparent;
}
button {
  cursor:pointer;
}
button:disabled {
  cursor:wait;
  opacity:.65;
}
button:focus-visible,a:focus-visible,input:focus-visible {
  outline:3px solid var(--accent);
  outline-offset:3px;
}
button,input {
  border:1px solid var(--line);
  border-radius:7px;
}
button {
  color:var(--text);
  background:var(--surface);
}
h1,h2,h3,p {
  margin:0;
}
h1 {
  font-size:29px;
  line-height:1.2;
  letter-spacing:-1px;
  font-weight:650;
}
h2 {
  font-size:20px;
  letter-spacing:-.5px;
}
h3 {
  font-size:14px;
  font-weight:650;
}
ul,ol {
  list-style:none;
  margin:0;
  padding:0;
}
a {
  color:inherit;
  text-decoration:none;
}
[hidden] {
  display:none!important;
}
.mono {
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  overflow-wrap:anywhere;
}
.sr-only {
  position:absolute;
  width:1px;
  height:1px;
  overflow:hidden;
  clip-path:inset(50%);
  white-space:nowrap;
}
.skip {
  position:fixed;
  top:-60px;
  left:16px;
  z-index:5;
  background:var(--surface);
  padding:12px;
  border:2px solid var(--accent);
}
.skip:focus {
  top:12px;
}
.app-shell {
  display:grid;
  grid-template-columns:242px minmax(0,1fr);
  min-height:100vh;
}
.sidebar {
  position:sticky;
  top:0;
  height:100vh;
  border-right:1px solid var(--line);
  background:var(--rail);
  padding:30px 20px;
  display:flex;
  flex-direction:column;
  min-width:0;
}
.brand {
  display:flex;
  align-items:center;
  gap:11px;
  font-size:14px;
  font-weight:650;
  letter-spacing:-.25px;
}
.brand-mark {
  display:grid;
  place-items:center;
  width:39px;
  height:39px;
  background:var(--text);
  color:var(--surface);
  border-radius:10px;
  font-family:ui-monospace,monospace;
  font-size:16px;
  font-weight:700;
  letter-spacing:-1.5px;
}
.brand-subtitle {
  display:block;
  font-size:9px;
  letter-spacing:2px;
  color:var(--muted);
  font-weight:600;
  margin-top:2px;
}
.workspace-label {
  display:flex;
  align-items:center;
  gap:7px;
  font-size:10px;
  color:var(--muted);
  margin:28px 0 37px;
}
.local-dot {
  width:6px;
  height:6px;
  border-radius:50%;
  background:var(--accent);
}
.readonly-tag {
  font-size:9px;
  letter-spacing:.8px;
  font-weight:650;
  color:var(--muted);
  border:1px solid var(--line);
  border-radius:4px;
  padding:3px 5px;
  white-space:nowrap;
}
.workspace-label .readonly-tag {
  margin-left:auto;
  font-size:8px;
  letter-spacing:.3px;
}
.rail-heading {
  display:flex;
  align-items:center;
  justify-content:space-between;
  margin:0 4px 13px;
}
.rail-heading h2 {
  font-size:12px;
  letter-spacing:0;
}
.count {
  font-size:11px;
  font-family:ui-monospace,monospace;
  color:var(--muted);
  background:var(--soft);
  padding:2px 7px;
  border-radius:5px;
}
#goal-filter {
  width:100%;
  height:40px;
  padding:0 10px;
  background:var(--surface);
  color:var(--text);
  font-size:12px;
  margin-bottom:12px;
}
#goal-filter::placeholder {
  color:var(--muted);
}
.goal-list {
  display:grid;
  gap:5px;
  max-height:calc(100vh - 335px);
  overflow:auto;
  padding:3px;
}
.goal-button {
  text-align:left;
  width:100%;
  padding:12px 10px;
  min-height:64px;
  border-color:transparent;
  background:transparent;
  border-radius:8px;
}
.goal-button[aria-pressed=true] {
  background:var(--accent-soft);
  border-color:color-mix(in srgb,var(--accent) 20%,transparent);
}
.goal-id {
  font-size:12px;
  font-weight:650;
  display:block;
  overflow-wrap:anywhere;
}
.goal-sub {
  display:flex;
  align-items:center;
  gap:6px;
  margin-top:5px;
  font-size:10px;
  color:var(--muted);
}
.goal-button[aria-pressed=true] .goal-id {
  color:var(--accent);
}
.rail-footer {
  margin-top:auto;
  display:flex;
  gap:9px;
  padding-top:24px;
  font-size:10px;
  line-height:1.7;
  color:var(--muted);
}
.rail-footer span:not(.footer-mark) {
  font-size:9px;
}
.footer-mark {
  font-size:20px;
  color:var(--muted);
}
main {
  max-width:1510px;
  width:100%;
  margin:0 auto;
  padding:39px 42px 22px;
  min-width:0;
}
.page-header {
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:20px;
}
.eyebrow {
  font-size:9px;
  letter-spacing:1.6px;
  font-weight:650;
  color:var(--muted);
  margin-bottom:10px;
}
.subtitle {
  font-size:12px;
  color:var(--muted);
  margin-top:9px;
}
.refresh-controls {
  display:flex;
  align-items:center;
  gap:15px;
}
.poll-label {
  display:flex;
  min-height:40px;
  gap:7px;
  align-items:center;
  font-size:10px;
  color:var(--muted);
  white-space:nowrap;
}
.poll-label input {
  accent-color:var(--accent);
  width:14px;
  height:14px;
}
.refresh-button {
  padding:10px 15px;
  font-size:11px;
  font-weight:600;
  min-height:40px;
  box-shadow:0 1px 2px #00000005;
}
.snapshot-meta {
  display:flex;
  justify-content:space-between;
  gap:12px;
  font-size:10px;
  color:var(--muted);
  margin-top:24px;
  padding-bottom:20px;
  border-bottom:1px solid var(--line);
  flex-wrap:wrap;
}
.snapshot-meta .mono {
  font-size:9px;
}
.notice {
  margin-top:20px;
  border:1px solid var(--line);
  border-left:3px solid var(--attention);
  background:var(--attention-bg);
  border-radius:7px;
  padding:13px 16px;
  font-size:12px;
}
.notice.error {
  background:var(--danger-bg);
  border-left-color:var(--danger);
}
.notice strong {
  display:block;
  margin-bottom:3px;
}
.notice p+p {
  margin-top:5px;
}
.stats {
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:16px;
  margin-top:25px;
  margin-bottom:32px;
}
.stat-card {
  background:var(--surface);
  border:1px solid var(--line);
  border-radius:var(--radius);
  padding:18px 20px;
}
.stat-label {
  font-size:10px;
  color:var(--muted);
}
.stat-value {
  display:block;
  font-size:29px;
  line-height:1.2;
  font-weight:600;
  letter-spacing:-1px;
  margin:9px 0 7px;
  font-variant-numeric:tabular-nums;
}
.stat-foot {
  font-size:9px;
  color:var(--muted);
}
.stat-card.attention .stat-value {
  color:var(--attention);
}
.section-heading {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:15px;
}
.goal-heading {
  margin-bottom:18px;
}
.goal-heading .eyebrow {
  margin-bottom:6px;
}
.goal-heading h2 {
  font-size:21px;
}
.pills {
  display:flex;
  gap:7px;
  flex-wrap:wrap;
  justify-content:flex-end;
}
.pill {
  display:inline-flex;
  align-items:center;
  border:1px solid var(--line);
  border-radius:5px;
  background:var(--soft);
  padding:4px 8px;
  font-size:10px;
  line-height:1.35;
  overflow-wrap:anywhere;
}
.pill.attention {
  color:var(--attention);
  background:var(--attention-bg);
  border-color:color-mix(in srgb,var(--attention) 20%,transparent);
}
.pill.danger {
  color:var(--danger);
  background:var(--danger-bg);
  border-color:color-mix(in srgb,var(--danger) 20%,transparent);
}
.pill.accent {
  color:var(--accent);
  background:var(--accent-soft);
  border-color:color-mix(in srgb,var(--accent) 15%,transparent);
}
.goal-warnings:not(:empty) {
  margin-bottom:16px;
  padding:12px 15px;
  background:var(--attention-bg);
  border-radius:7px;
  font-size:11px;
  color:var(--attention);
}
.detail-grid {
  display:grid;
  grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);
  gap:18px;
}
.panel {
  border:1px solid var(--line);
  background:var(--surface);
  border-radius:var(--radius);
  padding:20px 22px;
  min-width:0;
}
.panel-heading {
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:14px;
  margin-bottom:20px;
}
.section-number {
  font-family:ui-monospace,monospace;
  font-size:10px;
  color:var(--muted);
}
.panel-description {
  color:var(--muted);
  font-size:10px;
  margin-top:5px;
}
.full-width {
  grid-column:1/-1;
}
.empty {
  color:var(--muted);
  font-size:11px;
  line-height:1.8;
  padding:10px 0;
}
.gap-value {
  font-size:26px;
  font-weight:550;
  letter-spacing:-.8px;
  margin-bottom:6px;
}
.gap-detail {
  font-size:11px;
  color:var(--muted);
}
.gap-note {
  font-size:10px;
  color:var(--muted);
  margin-top:18px;
  padding-top:13px;
  border-top:1px solid var(--line);
}
.history-list {
  display:grid;
  gap:12px;
}
.history-row {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:11px;
}
.history-row time {
  font-size:9px;
  color:var(--muted);
  text-align:right;
}
.history-label {
  display:flex;
  gap:7px;
  align-items:center;
}
.history-dot {
  width:6px;
  height:6px;
  border-radius:50%;
  background:var(--accent);
  flex-shrink:0;
}
.data-list {
  display:grid;
}
.data-row {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:12px 0;
  border-bottom:1px solid var(--line);
}
.data-row:first-child {
  padding-top:0;
}
.data-row:last-child {
  border-bottom:0;
  padding-bottom:0;
}
.row-title {
  font-size:11px;
  font-weight:550;
  overflow-wrap:anywhere;
}
.row-subtitle {
  font-size:9px;
  color:var(--muted);
  margin-top:5px;
}
.row-facts {
  display:flex;
  gap:6px;
  align-items:center;
  flex-wrap:wrap;
  justify-content:flex-end;
}
.human-marker {
  display:inline-block;
  width:6px;
  height:6px;
  border-radius:50%;
  background:var(--attention);
  margin-right:7px;
}
.evidence-list {
  display:grid;
  gap:16px;
}
.evidence-row {
  display:grid;
  grid-template-columns:minmax(100px,1fr) minmax(110px,1fr) minmax(140px,1.25fr) minmax(110px,1fr);
  gap:14px;
  padding-top:16px;
  border-top:1px solid var(--line);
  align-items:start;
}
.evidence-row:first-child {
  padding-top:0;
  border:0;
}
.fact-label {
  display:block;
  font-size:9px;
  letter-spacing:.3px;
  color:var(--muted);
  margin-bottom:6px;
}
.fact-value {
  font-size:11px;
  overflow-wrap:anywhere;
}
.timeline-panel {
  margin-top:22px;
}
.timeline-list {
  display:grid;
  gap:0;
}
.timeline-row {
  display:grid;
  grid-template-columns:76px 10px minmax(0,1fr) auto;
  gap:13px;
  padding:11px 0;
  align-items:start;
  font-size:11px;
}
.timeline-time {
  font-size:9px;
  color:var(--muted);
  padding-top:2px;
}
.timeline-dot {
  width:6px;
  height:6px;
  border-radius:50%;
  background:var(--line);
  margin-top:6px;
}
.timeline-ref {
  font-size:9px;
  color:var(--muted);
  margin-top:3px;
  overflow-wrap:anywhere;
}
.timeline-seq {
  font-size:9px;
  color:var(--muted);
}
.truncated {
  padding-top:13px;
  margin-top:12px;
  border-top:1px solid var(--line);
  font-size:10px;
  color:var(--attention);
}
.page-footer {
  display:flex;
  justify-content:space-between;
  gap:12px;
  padding-top:25px;
  font-size:9px;
  color:var(--muted);
}
@media(prefers-color-scheme:dark) {
  :root {
    --canvas:#12151b;
    --surface:#1a1e26;
    --rail:#151820;
    --text:#e6e8ee;
    --muted:#a0a8b8;
    --line:#303642;
    --accent:#b0a8ff;
    --accent-soft:#302b49;
    --attention:#e8bd69;
    --attention-bg:#322b1d;
    --danger:#f0a0a0;
    --danger-bg:#382426;
    --soft:#222731;
  }
  .brand-mark {
    background:#d9d6ff;
    color:#24203f;
  }
}
@media(min-width:1600px) {
  main {
    padding-top:45px;
  }
  .stats {
    margin-top:30px;
    margin-bottom:38px;
  }
  .panel {
    padding:24px;
  }
  .detail-grid {
    gap:20px;
  }
}
@media(max-width:1100px) {
  main {
    padding:30px 25px;
  }
  .app-shell {
    grid-template-columns:215px minmax(0,1fr);
  }
  .sidebar {
    padding:28px 15px;
  }
  .page-header {
    align-items:flex-start;
  }
  .refresh-controls {
    flex-direction:column-reverse;
    align-items:flex-end;
    gap:8px;
  }
  .stats {
    gap:10px;
  }
  .stat-card {
    padding:15px 13px;
  }
  .detail-grid {
    grid-template-columns:1fr;
  }
  .full-width {
    grid-column:auto;
  }
  .evidence-row {
    grid-template-columns:repeat(2,minmax(0,1fr));
  }
  .panel {
    padding:19px;
  }
  .workspace-label {
    font-size:9px;
  }
  .workspace-label .readonly-tag {
    font-size:7px;
  }
}
@media(max-width:720px) {
  .app-shell {
    display:block;
  }
  .sidebar {
    position:relative;
    height:auto;
    padding:20px;
    border-right:0;
    border-bottom:1px solid var(--line);
  }
  .brand {
    font-size:13px;
  }
  .workspace-label {
    margin:18px 0;
    font-size:10px;
    justify-content:flex-start;
  }
  .workspace-label .readonly-tag {
    margin-left:5px;
    font-size:8px;
  }
  .rail-heading {
    margin-bottom:9px;
  }
  .goal-list {
    max-height:190px;
    grid-template-columns:repeat(auto-fit,minmax(155px,1fr));
  }
  .rail-footer {
    display:none;
  }
  main {
    padding:26px 18px 20px;
  }
  .page-header {
    gap:12px;
  }
  h1 {
    font-size:24px;
  }
  .subtitle {
    max-width:220px;
    font-size:11px;
  }
  .eyebrow {
    font-size:8px;
  }
  .refresh-controls {
    gap:9px;
  }
  .poll-label {
    font-size:9px;
    white-space:normal;
    max-width:110px;
  }
  .refresh-button {
    padding:9px 12px;
  }
  .snapshot-meta {
    margin-top:20px;
  }
  .stats {
    grid-template-columns:repeat(2,minmax(0,1fr));
    margin-bottom:26px;
  }
  .stat-value {
    font-size:25px;
  }
  .goal-heading {
    align-items:flex-start;
    flex-direction:column;
  }
  .pills {
    justify-content:flex-start;
  }
  .panel {
    padding:18px;
  }
  .gap-value {
    font-size:24px;
  }
  .evidence-row {
    gap:15px;
  }
  .timeline-row {
    grid-template-columns:62px 7px minmax(0,1fr) auto;
    gap:8px;
  }
  .page-footer {
    flex-direction:column;
    gap:4px;
  }
}
`;

/** Data is only assigned to DOM text nodes. Keep this asset compatible with a strict script-src 'self' CSP. */
export const UI_JS = `
"use strict";
(() => {
  const byId = (id) => document.getElementById(id);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const label = (value) => {
    switch (value) {
      case "needs_reapproval": return "needs re-approval";
      case "finish": return "Success candidate · awaiting human sign-off";
      case "goal_integrity_attention": return "Goal integrity needs inspection";
      case "goal_invalid": return "Goal definition needs attention";
      default: return String(value).replaceAll("_", " ").replaceAll(".", " · ");
    }
  };
  const date = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "Time unavailable" : parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const tone = (value) => ["failed", "tampered", "invalid", "corrupt"].includes(value) ? "danger" : ["blocked_on_user", "awaiting_approval", "needs_reapproval", "human_needed"].includes(value) ? "attention" : value === "in_progress" || value === "running" ? "accent" : "";
  const pill = (value, prefix = "") => node("span", "pill " + tone(value), prefix + label(value));
  const empty = (target, text) => target.replaceChildren(node("p", "empty", text));
  const warningText = {
    project_uninitialized: "No OMF project is initialized for this repository.",
    project_unavailable: "Project state is unavailable.",
    ledger_corrupt: "The ledger could not be verified. Factory details are withheld.",
    ledger_torn_tail: "An incomplete ledger tail was found. Only the verified prefix is shown.",
    symlink_refused: "A state path could not be read safely.",
    concurrent_change: "Factory state changed while reading. Refresh to retry a consistent snapshot.",
    goal_unavailable: "Some goal state is unavailable.",
    goal_integrity_attention: "Goal integrity needs inspection in the CLI before deciding how to proceed.",
    goal_invalid: "The goal definition is invalid or unreadable. Inspect it in the CLI.",
    work_projection_invalid: "Some work state could not be verified and is omitted.",
    evidence_unavailable: "Some evidence is unavailable.",
    needs_human_unavailable: "Human-attention state is unavailable; an empty list does not prove no action is needed.",
    gap_unavailable: "No current, verified disclosure is available.",
    truncated: "This view is bounded. Some entries are omitted.",
    resource_limit: "State exceeded the safe reading limit. Some details are unavailable."
  };
  let snapshot = null;
  let selected = null;
  let loading = false;
  let lastRefresh = null;

  function notice(title, detail, error = false) {
    const target = byId("notice");
    target.className = "notice" + (error ? " error" : "");
    target.replaceChildren(node("strong", "", title), node("p", "", detail));
    target.hidden = false;
  }
  function renderOverview() {
    const goals = snapshot.goals;
    const states = ["ready", "awaiting_approval", "in_progress", "awaiting_review"];
    const open = goals.reduce((total, goal) => total + states.reduce((count, state) => count + (goal.work_counts[state] || 0), 0), 0);
    const human = goals.reduce((total, goal) => total + goal.needs_human.length, 0);
    const humanUnknown = goals.some((goal) => goal.warnings.includes("needs_human_unavailable"));
    const running = goals.filter((goal) => goal.audit_state === "approved" && goal.run_state === "running").length;
    const stats = [["Tracked goals", goals.length, "In this snapshot"], ["Running", running, "Approved and running"], ["Open work", open, "Across visible goals"], ["Needs human", humanUnknown ? "Unknown" : human, humanUnknown ? human + " recorded · state incomplete" : "Recorded attention items"]];
    byId("overview").replaceChildren(...stats.map(([title, value, foot], index) => {
      const card = node("div", "stat-card" + (index === 3 && (human > 0 || humanUnknown) ? " attention" : ""));
      card.append(node("p", "stat-label", title), node("strong", "stat-value", value), node("p", "stat-foot", foot));
      return card;
    }));
  }
  function renderGoals() {
    const list = byId("goal-list");
    if (snapshot.status === "corrupt" || snapshot.status === "unavailable") {
      byId("goal-count").textContent = "—";
      return empty(list, "Goal list withheld until verification succeeds.");
    }
    const query = byId("goal-filter").value.toLowerCase();
    const goals = snapshot.goals.filter((goal) => goal.goal_id.toLowerCase().includes(query));
    byId("goal-count").textContent = String(snapshot.goals.length);
    if (!goals.length) return empty(list, query ? "No matching goal IDs." : "No goals to display.");
    list.replaceChildren(...goals.map((goal) => {
      const button = node("button", "goal-button");
      button.type = "button";
      button.setAttribute("aria-pressed", String(goal.goal_id === selected));
      button.append(node("span", "goal-id mono", goal.goal_id), node("span", "goal-sub", "Audit · " + label(goal.audit_state)));
      button.addEventListener("click", () => { selected = goal.goal_id; renderGoals(); renderGoal(); });
      return button;
    }));
  }
  function renderGap(goal) {
    const target = byId("gap");
    if (!goal.gap) {
      empty(target, "Current disclosure unavailable. No gap is inferred from missing or stale evidence.");
    } else {
      const gap = goal.gap;
      target.replaceChildren(node("p", "gap-value", label(gap.size) + " · " + label(gap.direction)), node("p", "gap-detail", "Disclosed " + date(gap.at) + " · event #" + gap.seq));
    }
    target.append(node("p", "gap-note", "Coarse direction and size only. This is a past disclosure, not a live measurement."));
    const history = byId("history");
    if (!goal.gap_history.length) return empty(history, "History unavailable. No comparable disclosures are verified for the current goal contract.");
    const list = node("ol", "history-list");
    for (const point of goal.gap_history.slice().reverse()) {
      const row = node("li", "history-row");
      const text = node("span", "history-label");
      const dot = node("span", "history-dot");
      dot.setAttribute("aria-hidden", "true");
      text.append(dot, node("span", "", label(point.size) + " · " + label(point.direction)));
      const time = node("time", "", date(point.at) + " · #" + point.seq);
      time.dateTime = point.at;
      row.append(text, time);
      list.append(row);
    }
    history.replaceChildren(list, node("p", "gap-note", "Disclosure sequence only. Bucket changes do not establish a numeric trend."));
  }
  function renderWork(goal) {
    byId("work-count").textContent = String(goal.work_items.length);
    const target = byId("workboard");
    if (!goal.work_items.length) return empty(target, goal.warnings.includes("work_projection_invalid") ? "Work state unavailable." : "No work items recorded for this goal.");
    const list = node("ul", "data-list");
    for (const work of goal.work_items) {
      const row = node("li", "data-row");
      const title = node("div");
      title.append(node("p", "row-title mono", work.work_id), node("p", "row-subtitle", label(work.risk) + " risk"));
      row.append(title, pill(work.state));
      list.append(row);
    }
    target.replaceChildren(list);
    if (goal.truncated) target.append(node("p", "truncated", "Work list may be truncated; counts can include omitted items."));
  }
  function renderHuman(goal) {
    const target = byId("needs-human");
    const unknown = goal.warnings.includes("needs_human_unavailable");
    byId("human-count").textContent = unknown ? "Unknown" : String(goal.needs_human.length);
    if (!goal.needs_human.length) return empty(target, unknown ? "Attention state unknown. Continue in CLI to inspect unavailable state." : "No human-attention items recorded in this snapshot.");
    const list = node("ul", "data-list");
    for (const need of goal.needs_human) {
      const row = node("li", "data-row");
      const text = node("div");
      const title = node("p", "row-title");
      const marker = node("span", "human-marker");
      marker.setAttribute("aria-hidden", "true");
      title.append(marker, node("span", "", label(need.code)));
      text.append(title, node("p", "row-subtitle mono", need.work_id || goal.goal_id));
      row.append(text, node("span", "pill attention", "Continue in CLI"));
      list.append(row);
    }
    target.replaceChildren(list);
    if (unknown) target.prepend(node("p", "empty", "Additional attention state is unknown. Continue in CLI to inspect unavailable state."));
  }
  function fact(title, value) {
    const group = node("div");
    group.append(node("span", "fact-label", title), node("span", "fact-value", value));
    return group;
  }
  function renderEvidence(goal) {
    const target = byId("evidence");
    const works = goal.work_items.filter((work) => work.evidence);
    if (!works.length) return empty(target, "No evidence recommendations available. Missing evidence is not a passing result.");
    const list = node("ul", "evidence-list");
    for (const work of works) {
      const evidence = work.evidence;
      const row = node("li", "evidence-row");
      row.append(fact("Work item", work.work_id), fact("Agent recommendation", label(evidence.recommendation)), fact("Report verification", "Details withheld · inspect in CLI"), fact("Human approval", "Not established by this view"));
      list.append(row);
    }
    target.replaceChildren(list, node("p", "gap-note", "Ledger integrity verifies the record chain. It does not independently verify evidence quality or authorize a merge."));
  }
  function renderTimeline() {
    const target = byId("timeline");
    const events = snapshot.events.filter((event) => !selected || !event.goal_id || event.goal_id === selected);
    if (!events.length) return empty(target, "No recent ledger events to display.");
    const list = node("ol", "timeline-list");
    for (const event of events) {
      const row = node("li", "timeline-row");
      const time = node("time", "timeline-time", date(event.at));
      time.dateTime = event.at;
      const dot = node("span", "timeline-dot");
      dot.setAttribute("aria-hidden", "true");
      const content = node("div");
      content.append(node("p", "", label(event.type)));
      if (event.work_id || event.goal_id) content.append(node("p", "timeline-ref mono", event.work_id || event.goal_id));
      row.append(time, dot, content, node("span", "timeline-seq mono", "#" + event.seq));
      list.append(row);
    }
    target.replaceChildren(list);
    if (snapshot.truncated) target.append(node("p", "truncated", "Recent activity is bounded; older events may be omitted."));
  }
  function renderGoal() {
    const goal = snapshot.goals.find((item) => item.goal_id === selected);
    byId("goal-section").hidden = !goal;
    if (goal) {
      byId("selected-goal").textContent = goal.goal_id;
      byId("goal-status").replaceChildren(pill(goal.audit_state, "Audit · "), pill(goal.run_state, "Run · "), node("span", "pill", goal.ticks + " ticks"));
      byId("goal-warnings").replaceChildren(...goal.warnings.map((code) => node("p", "", warningText[code] || "State unavailable.")));
      renderGap(goal); renderWork(goal); renderHuman(goal); renderEvidence(goal);
    }
    byId("timeline-section").hidden = snapshot.status !== "ok";
    renderTimeline();
  }
  function render() {
    const valid = snapshot.status === "ok";
    byId("overview").hidden = !valid;
    byId("revision").textContent = valid && snapshot.ledger_head ? "Verified revision · " + snapshot.ledger_head : "Revision unavailable";
    byId("notice").hidden = true;
    if (!valid) {
      const titles = { uninitialized: "Factory not initialized", corrupt: "Ledger integrity unavailable", unavailable: "Snapshot unavailable" };
      notice(titles[snapshot.status] || "Snapshot unavailable", snapshot.warnings.map((code) => warningText[code] || "State unavailable.").join(" ") || "No verified factory state is available. Refresh to retry.", snapshot.status === "corrupt");
      selected = null;
    } else {
      if (!snapshot.goals.some((goal) => goal.goal_id === selected)) selected = snapshot.goals[0]?.goal_id || null;
      renderOverview();
      if (snapshot.warnings.length || snapshot.truncated) notice("Snapshot has limits", snapshot.warnings.map((code) => warningText[code] || "State unavailable.").join(" ") || "Some entries are omitted from this bounded snapshot.");
      if (!snapshot.goals.length && !snapshot.warnings.length) notice("No goals yet", "This workspace has no goals to display. Create and manage goals from your terminal.");
    }
    renderGoals(); renderGoal();
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    byId("refresh").disabled = true;
    byId("refresh").textContent = "Refreshing…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("./api/snapshot", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "session" : "request");
      const next = await response.json();
      if (next.schema_version !== 1 || !Array.isArray(next.goals) || !Array.isArray(next.events) || !Array.isArray(next.warnings)) throw new Error("schema");
      snapshot = next;
      lastRefresh = new Date().toISOString();
      byId("refresh-status").textContent = "Last refreshed " + date(lastRefresh) + " · snapshot " + date(snapshot.generated_at);
      render();
    } catch (error) {
      notice(snapshot ? "Refresh failed · previous snapshot retained" : "Unable to load factory state", error.message === "session" ? "This local session is unavailable. Reopen the URL printed by the running OMF UI command." : "The local service could not return a snapshot. Refresh to retry.", true);
      byId("refresh-status").textContent = lastRefresh ? "Stale · last successful refresh " + date(lastRefresh) : "No snapshot loaded";
    } finally {
      clearTimeout(timeout);
      loading = false;
      byId("refresh").disabled = false;
      byId("refresh").textContent = "Refresh";
    }
  }
  byId("refresh").addEventListener("click", refresh);
  byId("goal-filter").addEventListener("input", () => { if (snapshot) renderGoals(); });
  setInterval(() => { if (byId("auto-refresh").checked && document.visibilityState === "visible") refresh(); }, 15000);
  refresh();
})();
`;
