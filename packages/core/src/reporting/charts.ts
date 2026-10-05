/**
 * Gráficos SVG sem dependências para o relatório HTML autocontido.
 * Especificação visual: linhas de 2px, marcadores de 8px com anel na cor da superfície, colunas
 * de no máximo 24px com topo arredondado (4px) e 2px de respiro, grade em linha fina, um único
 * eixo Y, legenda para ≥ 2 séries e rótulos diretos só no fim das linhas. Cores vêm de variáveis
 * CSS (--s1, --s2…) definidas para tema claro e escuro. Interatividade (crosshair + tooltip) é
 * feita pelo script do relatório a partir dos dados embutidos em JSON.
 */

export const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export interface Series {
  name: string;
  /** Variável CSS da cor, ex.: "var(--s1)". */
  color: string;
  values: (number | null)[];
}

/** Largura do viewBox ≈ largura do cartão em px, para o texto do SVG não encolher. */
const FULL_W = 820;
const HALF_W = 500;
const M = { l: 52, t: 26, b: 30 };

/** Ticks do eixo: números limpos ("20", não "20.0"). */
const tickFmt = (v: number) => (Math.abs(v) >= 1e4 ? fmtNum(v) : String(+v.toFixed(2)));

/** Ticks "bonitos" (1, 2, 2.5, 5 × 10ⁿ). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1]! < max) ticks.push(+(ticks[ticks.length - 1]! + step).toFixed(10));
  return ticks;
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return +v.toFixed(2) + "";
}

export function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

function xTickStep(span: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((s) => span / s <= 8) ?? 7200;
}

/** Reduz para no máximo `max` pontos; latências usam o máximo do intervalo (picos não somem). */
export function downsample(x: number[], series: Series[], max: number, agg: ("max" | "mean")[]) {
  if (x.length <= max) return { x, series };
  const bin = Math.ceil(x.length / max);
  const nx: number[] = [];
  const ns = series.map((s) => ({ ...s, values: [] as (number | null)[] }));
  for (let i = 0; i < x.length; i += bin) {
    nx.push(x[i]!);
    series.forEach((s, k) => {
      const slice = s.values.slice(i, i + bin).filter((v): v is number => v !== null);
      ns[k]!.values.push(
        slice.length
          ? agg[k] === "max"
            ? Math.max(...slice)
            : slice.reduce((a, b) => a + b, 0) / slice.length
          : null,
      );
    });
  }
  return { x: nx, series: ns };
}

interface ChartBase {
  id: string;
  /** "full" (largura total do cartão) ou "half" (cartão em grade de duas colunas). */
  size?: "full" | "half";
  /** Unidade mostrada no eixo e no tooltip (ex.: "ms", "req/s"). */
  unit: string;
  height?: number;
  /** Rótulo acessível (descrição curta do gráfico). */
  label: string;
}

export interface LineChartOpts extends ChartBase {
  x: number[];
  series: Series[];
  /** Faixa de aquecimento (segundos) sombreada. */
  warmupUntil?: number;
  /** Lavagem de área sob a série (só para série única). */
  area?: boolean;
  yMax?: number;
  /** Formato do X no tooltip: segundos (padrão) ou percentil "nines". */
  xKind?: "seconds" | "nines";
}

function legend(series: Series[], kind: "line" | "rect"): string {
  if (series.length < 2) return "";
  return `<div class="legend">${series
    .map(
      (s) =>
        `<span class="key"><svg width="16" height="10" aria-hidden="true">${
          kind === "line"
            ? `<line x1="1" y1="5" x2="15" y2="5" stroke="${s.color}" stroke-width="2" stroke-linecap="round"/>`
            : `<rect x="3" y="0" width="10" height="10" rx="2" fill="${s.color}"/>`
        }</svg>${esc(s.name)}</span>`,
    )
    .join("")}</div>`;
}

function dataScript(id: string, payload: unknown): string {
  // "<" escapado para que o JSON nunca feche a tag <script>
  return `<script type="application/json" id="data-${esc(id)}">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;
}

export function lineChart(o: LineChartOpts): string {
  const W = o.size === "half" ? HALF_W : FULL_W;
  const R = o.series.length > 1 || o.size !== "half" ? 96 : 76;
  const H = o.height ?? (o.size === "half" ? 220 : 260);
  const iw = W - M.l - R;
  const ih = H - M.t - M.b;
  const xs = o.x;
  const x0 = xs[0] ?? 0;
  const x1 = Math.max(xs[xs.length - 1] ?? 1, x0 + 1);
  const all = o.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(o.yMax ?? Math.max(1e-9, ...all));
  const yTop = ticks[ticks.length - 1]!;
  const sx = (v: number) => M.l + ((v - x0) / (x1 - x0)) * iw;
  const sy = (v: number) => M.t + ih - (v / yTop) * ih;
  const parts: string[] = [];

  if (o.warmupUntil && o.warmupUntil > x0) {
    const w = sx(Math.min(o.warmupUntil, x1)) - M.l;
    parts.push(
      `<rect x="${M.l}" y="${M.t}" width="${w.toFixed(1)}" height="${ih}" class="warmup"/>` +
        `<text x="${M.l + 6}" y="${M.t + 12}" class="tick">aquecimento</text>`,
    );
  }
  for (const t of ticks) {
    const y = sy(t).toFixed(1);
    parts.push(
      `<line x1="${M.l}" x2="${W - R}" y1="${y}" y2="${y}" class="${t === 0 ? "axis" : "grid"}"/>` +
        `<text x="${M.l - 8}" y="${y}" dy="4" text-anchor="end" class="tick">${tickFmt(t)}</text>`,
    );
  }
  if (o.xKind === "nines") {
    for (let n = 0; n <= Math.floor(x1); n++) {
      const label = n === 0 ? "p0" : `p${(100 - 100 / 10 ** n).toFixed(Math.max(0, n - 2))}`;
      parts.push(
        `<text x="${sx(n).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tick">${label}</text>`,
      );
    }
  } else {
    const step = xTickStep(x1 - x0);
    for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) {
      parts.push(
        `<text x="${sx(v).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tick">${fmtSeconds(v)}</text>`,
      );
    }
  }
  parts.push(
    `<text x="${M.l - 8}" y="12" text-anchor="end" class="tick unit">${esc(o.unit)}</text>`,
  );

  const labels: { y: number; text: string; color: string }[] = [];
  for (const s of o.series) {
    let d = "";
    let pen = false;
    let last: [number, number] | null = null;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      const px = sx(xs[i]!);
      const py = sy(v);
      d += `${pen ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
      pen = true;
      last = [px, py];
    });
    if (o.area && o.series.length === 1 && d) {
      const firstX = sx(xs[s.values.findIndex((v) => v !== null)]!);
      parts.push(
        `<path d="${d}L${last![0].toFixed(1)} ${sy(0).toFixed(1)}L${firstX.toFixed(1)} ${sy(0).toFixed(1)}Z" fill="${s.color}" class="wash"/>`,
      );
    }
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" class="line"/>`);
    if (last) {
      const [lx, ly] = last as [number, number];
      parts.push(
        `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" fill="${s.color}" class="end"/>`,
      );
      const lastVal = [...s.values].reverse().find((v) => v !== null)!;
      labels.push({ y: ly, text: `${s.name} ${fmtNum(lastVal)}`, color: s.color });
    }
  }
  // rótulos diretos no fim das linhas; os que colidiriam ficam só na legenda/tooltip
  labels.sort((a, b) => a.y - b.y);
  let lastY = -Infinity;
  for (const l of labels) {
    if (l.y - lastY < 13) continue;
    parts.push(
      `<text x="${W - R + 10}" y="${l.y.toFixed(1)}" dy="4" class="dlabel">${esc(l.text)}</text>`,
    );
    lastY = l.y;
  }
  parts.push(
    `<line class="xhair" x1="0" x2="0" y1="${M.t}" y2="${M.t + ih}" visibility="hidden"/>` +
      `<rect class="hit" x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent"/>`,
  );

  const payload = {
    kind: "line",
    xKind: o.xKind ?? "seconds",
    unit: o.unit,
    x: xs,
    series: o.series.map((s) => ({ name: s.name, color: s.color, values: s.values })),
    geom: { l: M.l, iw, x0, x1, W },
  };
  return (
    legend(o.series, "line") +
    `<div class="chart" data-chart="${esc(o.id)}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}" tabindex="0">${parts.join("")}</svg><div class="tip" hidden></div></div>` +
    dataScript(o.id, payload)
  );
}

export interface ColumnChartOpts extends ChartBase {
  /** Rótulo de cada coluna (eixo X) e texto do tooltip. */
  labels: string[];
  values: number[];
  color: string;
  /** Mostrar só alguns rótulos no eixo X (a cada N). */
  labelEvery?: number;
  tipExtra?: string[];
}

export function columnChart(o: ColumnChartOpts): string {
  const W = o.size === "half" ? HALF_W : FULL_W;
  const H = o.height ?? (o.size === "half" ? 220 : 260);
  const iw = W - M.l - 24;
  const ih = H - M.t - M.b;
  const n = o.values.length;
  const ticks = niceTicks(Math.max(1e-9, ...o.values));
  const yTop = ticks[ticks.length - 1]!;
  const band = iw / Math.max(1, n);
  const bw = Math.max(1, Math.min(24, band - 2));
  const sy = (v: number) => M.t + ih - (v / yTop) * ih;
  const parts: string[] = [];
  for (const t of ticks) {
    const y = sy(t).toFixed(1);
    parts.push(
      `<line x1="${M.l}" x2="${M.l + iw}" y1="${y}" y2="${y}" class="${t === 0 ? "axis" : "grid"}"/>` +
        `<text x="${M.l - 8}" y="${y}" dy="4" text-anchor="end" class="tick">${tickFmt(t)}</text>`,
    );
  }
  parts.push(
    `<text x="${M.l - 8}" y="12" text-anchor="end" class="tick unit">${esc(o.unit)}</text>`,
  );
  const every = o.labelEvery ?? Math.max(1, Math.ceil(n / 10));
  o.values.forEach((v, i) => {
    const cx = M.l + band * i + band / 2;
    const x = cx - bw / 2;
    const y = sy(v);
    const h = sy(0) - y;
    if (v > 0) {
      const r = Math.min(4, bw / 2, h);
      // topo arredondado (4px), base reta sobre a linha de base
      parts.push(
        `<path d="M${x.toFixed(1)} ${sy(0).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)} ${y.toFixed(1)} ${(x + bw).toFixed(1)} ${(y + r).toFixed(1)}V${sy(0).toFixed(1)}Z" fill="${o.color}" class="bar"/>`,
      );
    }
    // área de toque maior que a coluna (a faixa inteira)
    parts.push(
      `<rect class="bhit" data-i="${i}" x="${(M.l + band * i).toFixed(1)}" y="${M.t}" width="${band.toFixed(1)}" height="${ih}" fill="transparent" tabindex="-1"/>`,
    );
    if (i % every === 0) {
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tick">${esc(o.labels[i])}</text>`,
      );
    }
  });
  const payload = {
    kind: "column",
    unit: o.unit,
    labels: o.labels,
    values: o.values,
    extra: o.tipExtra ?? [],
    color: o.color,
  };
  return (
    `<div class="chart" data-chart="${esc(o.id)}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}" tabindex="0">${parts.join("")}</svg><div class="tip" hidden></div></div>` +
    dataScript(o.id, payload)
  );
}

/** Script de interação: crosshair + tooltip (linhas) e tooltip por coluna; teclado com setas. */
export const CHART_SCRIPT = `
(() => {
  const fmt = (v) => v === null || v === undefined || !isFinite(v) ? "—" :
    Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : String(+v.toFixed(2));
  const secs = (s) => s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60 ? (s % 60) + "s" : "");
  const nines = (n) => "p" + (100 - 100 / Math.pow(10, n)).toFixed(Math.max(0, Math.ceil(n) - 1));
  function row(tip, color, value, name) {
    const r = document.createElement("div"); r.className = "trow";
    if (color) { const k = document.createElement("span"); k.className = "tkey"; k.style.background = color; r.append(k); }
    const b = document.createElement("strong"); b.textContent = value; r.append(b);
    const s = document.createElement("span"); s.className = "tname"; s.textContent = name; r.append(s);
    tip.append(r);
  }
  document.querySelectorAll(".chart").forEach((el) => {
    const data = JSON.parse(document.getElementById("data-" + el.dataset.chart).textContent);
    const svg = el.querySelector("svg"), tip = el.querySelector(".tip");
    const toPx = (clientX) => { const r = svg.getBoundingClientRect(); return (clientX - r.left) * (svg.viewBox.baseVal.width / r.width); };
    const place = (px, py) => {
      const r = svg.getBoundingClientRect(), k = r.width / svg.viewBox.baseVal.width;
      tip.hidden = false;
      const left = Math.min(px * k + 12, r.width - tip.offsetWidth - 4);
      tip.style.left = Math.max(0, left) + "px"; tip.style.top = Math.max(0, py * k - 10) + "px";
    };
    if (data.kind === "line") {
      const g = data.geom, xh = svg.querySelector(".xhair");
      let idx = -1;
      const show = (i) => {
        if (i < 0 || i >= data.x.length) return;
        idx = i;
        const px = g.l + ((data.x[i] - g.x0) / (g.x1 - g.x0)) * g.iw;
        xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.setAttribute("visibility", "visible");
        tip.textContent = "";
        const h = document.createElement("div"); h.className = "thead";
        h.textContent = data.xKind === "nines" ? nines(data.x[i]) : "t = " + secs(data.x[i]); tip.append(h);
        for (const s of data.series) row(tip, data.series.length > 1 ? s.color : null, fmt(s.values[i]) + " " + data.unit, s.name);
        place(px, 20);
      };
      const nearest = (px) => {
        const xv = g.x0 + ((px - g.l) / g.iw) * (g.x1 - g.x0);
        let best = 0; for (let i = 1; i < data.x.length; i++) if (Math.abs(data.x[i] - xv) < Math.abs(data.x[best] - xv)) best = i;
        return best;
      };
      svg.addEventListener("pointermove", (e) => show(nearest(toPx(e.clientX))));
      svg.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
      svg.addEventListener("focus", () => show(idx < 0 ? data.x.length - 1 : idx));
      svg.addEventListener("blur", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
      svg.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") { show(Math.max(0, idx - 1)); e.preventDefault(); }
        if (e.key === "ArrowRight") { show(Math.min(data.x.length - 1, idx + 1)); e.preventDefault(); }
      });
    } else {
      const hits = [...svg.querySelectorAll(".bhit")];
      let idx = -1;
      const show = (i) => {
        if (i < 0 || i >= data.values.length) return;
        hits.forEach((h) => h.classList.toggle("on", +h.dataset.i === i)); idx = i;
        tip.textContent = "";
        const h = document.createElement("div"); h.className = "thead"; h.textContent = data.labels[i]; tip.append(h);
        row(tip, null, fmt(data.values[i]) + " " + data.unit, data.extra[i] || "");
        const b = hits[i].getBBox(); place(b.x + b.width, 20);
      };
      hits.forEach((h) => h.addEventListener("pointerenter", () => show(+h.dataset.i)));
      svg.addEventListener("pointerleave", () => { tip.hidden = true; hits.forEach((h) => h.classList.remove("on")); });
      svg.addEventListener("focus", () => show(idx < 0 ? 0 : idx));
      svg.addEventListener("blur", () => { tip.hidden = true; });
      svg.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") { show(Math.max(0, idx - 1)); e.preventDefault(); }
        if (e.key === "ArrowRight") { show(Math.min(data.values.length - 1, idx + 1)); e.preventDefault(); }
      });
    }
  });
  const btn = document.getElementById("theme");
  if (btn) btn.addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
  });
})();
`;
