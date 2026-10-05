/**
 * Folha de estilo do relatório. Tokens de cor por papel (superfície, tintas, séries, status),
 * definidos para o tema claro e para o escuro (este com passos próprios, validados contra a
 * superfície escura). O tema segue o sistema e pode ser trocado pelo botão (data-theme).
 */
export const REPORT_CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10); --wash: rgba(11,11,11,0.04);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s8: #e34948;
  --good: #0ca30c; --good-ink: #006300; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s8: #e66767; --good-ink: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s8: #e66767; --good-ink: #0ca30c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 16px; margin: 0 0 12px; font-weight: 600; }
h3 { font-size: 14px; margin: 16px 0 4px; font-weight: 600; }
.sub { color: var(--ink-2); margin: 0; }
.muted { color: var(--muted); }
header.top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 16px; }
.badges { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
button#theme { font: inherit; color: var(--ink-2); background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 4px 10px; cursor: pointer; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-top: 16px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap: 16px; }
.grid2 > .card { margin-top: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--muted); font-size: 12px; }
.alert { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface); margin-top: 8px; }
.alert .icon { font-weight: 700; width: 18px; text-align: center; }
.alert.critical .icon { color: var(--critical); } .alert.warning .icon { color: var(--serious); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.scroll { overflow-x: auto; }
.status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; white-space: nowrap; }
.status.ok { color: var(--good-ink); } .status.fail { color: var(--critical); } .status.warn { color: var(--ink-2); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--ink-2); font-size: 13px; margin: 0 0 4px; }
.key { display: inline-flex; align-items: center; gap: 6px; }
.chart { position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart svg:focus-visible { outline: 2px solid var(--s1); outline-offset: 4px; border-radius: 4px; }
.chart .grid { stroke: var(--grid); stroke-width: 1; }
.chart .axis { stroke: var(--axis); stroke-width: 1; }
.chart .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.chart .dlabel { fill: var(--ink-2); font-size: 12px; }
.chart .line { stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart .wash { opacity: 0.10; }
.chart .end { stroke: var(--surface); stroke-width: 2; }
.chart .warmup { fill: var(--wash); }
.chart .xhair { stroke: var(--axis); stroke-width: 1; }
.chart .bar { transition: opacity .1s; }
.chart .bhit.on { fill: var(--wash); }
.tip { position: absolute; pointer-events: none; background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 120px; z-index: 2; }
.thead { color: var(--muted); margin-bottom: 2px; }
.trow { display: flex; align-items: center; gap: 6px; }
.tkey { width: 12px; height: 2px; border-radius: 1px; display: inline-block; }
.tname { color: var(--ink-2); }
details summary { cursor: pointer; color: var(--ink-2); font-weight: 600; }
code, pre { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
pre { background: var(--wash); padding: 10px; border-radius: 8px; overflow-x: auto; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
a { color: var(--s1); }
@media print { button#theme { display: none; } .card { break-inside: avoid; } }
`;
