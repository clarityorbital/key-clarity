// HTML for the usage panel: spend per day stacked by model, with tables by model and by key.
// Pure: no vscode imports, so it can be unit-tested. Everything from the proxy is escaped.

import { money } from "./format";
import { USAGE_PERIODS, type UsageMetrics, type UsagePeriod, type UsageReport } from "./proxy/usage";

/** Categorical series colors; light and dark steps of the same hues, in a fixed order checked for color-blind separation. */
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];
export const SERIES_COUNT = SERIES_LIGHT.length;

export interface UsageViewState {
  period: UsagePeriod;
  /** sha256 of the key to show; null for all of the user's keys. */
  keyHash: string | null;
  keyOptions: Array<{ hash: string; label: string }>;
  /** Key names by hash, for keys the proxy reports without an alias. */
  keyNames: ReadonlyMap<string, string>;
  loading: boolean;
  report?: UsageReport;
  error?: string;
  loadedAt?: Date;
  /** Model -> series slot. Kept across loads, so a model keeps its color when the period or key changes. */
  slots: Map<string, number>;
}

/**
 * Gives models a series slot, highest spend first, keeping slots already given. Models left
 * without one once the slots run out are drawn together as "Other".
 */
export function assignSlots(models: ReadonlyArray<[string, UsageMetrics]>, slots: Map<string, number>): void {
  const used = new Set(slots.values());
  for (const [name, m] of models) {
    if (slots.has(name) || m.spend <= 0) continue;
    let free = 0;
    while (used.has(free)) free++;
    if (free >= SERIES_COUNT) return;
    slots.set(name, free);
    used.add(free);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const OTHER = "Other";

/** A chart series: a model with its own slot, or every other model together. */
interface Series {
  name: string;
  slot: number | null;
  spendByDay: number[];
  total: number;
}

function buildSeries(report: UsageReport, slots: ReadonlyMap<string, number>): Series[] {
  const own = new Map<string, Series>();
  const other: Series = { name: OTHER, slot: null, spendByDay: report.days.map(() => 0), total: 0 };
  report.days.forEach((day, i) => {
    for (const [name, m] of day.models) {
      const slot = slots.get(name);
      let s = slot === undefined ? other : own.get(name);
      if (!s) own.set(name, (s = { name, slot: slot!, spendByDay: report.days.map(() => 0), total: 0 }));
      s.spendByDay[i] += m.spend;
      s.total += m.spend;
    }
    // Spend the proxy didn't split by model still counts toward the day.
    const split = [...day.models.values()].reduce((sum, m) => sum + m.spend, 0);
    if (day.total.spend - split > 1e-9) {
      other.spendByDay[i] += day.total.spend - split;
      other.total += day.total.spend - split;
    }
  });
  const series = [...own.values()].sort((a, b) => a.slot! - b.slot!);
  if (other.total > 0) series.push(other);
  return series;
}

const color = (s: Series) => (s.slot === null ? "var(--other)" : `var(--s${s.slot})`);

/** The top of the y axis: four gridline steps of 1, 2, 2.5 or 5 times a power of ten, reaching `max`. */
export function axisMax(max: number): number {
  if (max <= 0) return 1;
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return 4 * m * pow;
  return 40 * pow;
}

const shortMoney = (n: number) => (n >= 1000 ? `$${compact(n)}` : n >= 10 || n === 0 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

function dateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function chart(report: UsageReport, series: Series[]): string {
  const W = 760;
  const H = 260;
  const left = 52;
  const bottom = 24;
  const top = 8;
  const plotW = W - left - 8;
  const plotH = H - top - bottom;
  const days = report.days;
  const max = axisMax(Math.max(...days.map((_, i) => series.reduce((sum, s) => sum + s.spendByDay[i], 0))));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const slot = plotW / days.length;
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const out: string[] = [];

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const gy = y(v);
    out.push(`<line class="grid" x1="${left}" x2="${W - 8}" y1="${gy}" y2="${gy}"/>`);
    out.push(`<text class="axis" x="${left - 6}" y="${gy + 4}" text-anchor="end">${shortMoney(v)}</text>`);
  }
  const every = Math.ceil(days.length / 8);
  days.forEach((day, i) => {
    const cx = left + slot * i + slot / 2;
    if (i % every === 0 || i === days.length - 1) {
      if (i === days.length - 1 && i % every !== 0 && i % every < every / 2) return;
      out.push(`<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${dateLabel(day.date)}</text>`);
    }
  });
  days.forEach((day, i) => {
    const x = left + slot * i + (slot - barW) / 2;
    const parts = series.filter((s) => s.spendByDay[i] > 0);
    let base = 0;
    const rects: string[] = [];
    parts.forEach((s, j) => {
      const v = s.spendByDay[i];
      const y0 = y(base);
      const y1 = y(base + v);
      base += v;
      // 2px gap between stacked segments; the top segment gets rounded data-end corners.
      const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
      const yTop = y0 - (j > 0 ? 2 : 0) - h;
      if (j === parts.length - 1 && h > 4) {
        const r = Math.min(4, barW / 2);
        rects.push(
          `<path fill="${color(s)}" d="M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z"/>`,
        );
      } else {
        rects.push(`<rect fill="${color(s)}" x="${x}" y="${yTop}" width="${barW}" height="${h}"/>`);
      }
    });
    const tip = [`${dateLabel(day.date)}: ${money(day.total.spend)}`, ...parts.slice().reverse().map((s) => `${s.name}: ${money(s.spendByDay[i])}`)].join("\n");
    // The hit target covers the whole column, so a day with tiny spend is still easy to hover.
    out.push(`<g class="day"><title>${escapeHtml(tip)}</title><rect class="hit" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"/>${rects.join("")}</g>`);
  });
  out.push(`<line class="baseline" x1="${left}" x2="${W - 8}" y1="${y(0)}" y2="${y(0)}"/>`);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend per day by model">${out.join("")}</svg>`;
}

const swatch = (s: Series | undefined) => `<span class="sw" style="background:${s ? color(s) : "var(--other)"}"></span>`;

function modelTable(report: UsageReport, series: Series[]): string {
  const byName = new Map(series.map((s) => [s.name, s]));
  const other = byName.get(OTHER);
  const rows = report.models.map(([name, m]) => {
    const share = report.total.spend > 0 ? `${Math.round((m.spend / report.total.spend) * 100)}%` : "";
    return `<tr><td>${swatch(byName.get(name) ?? other)}${escapeHtml(name)}</td><td class="num">${money(m.spend)}</td><td class="num">${share}</td><td class="num">${m.requests.toLocaleString("en-US")}</td><td class="num">${compact(m.inputTokens)}</td><td class="num">${compact(m.outputTokens)}</td></tr>`;
  });
  return `<table><thead><tr><th>Model</th><th class="num">Spend</th><th class="num">Share</th><th class="num">Requests</th><th class="num">Input tokens</th><th class="num">Output tokens</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function keyTable(report: UsageReport, names: ReadonlyMap<string, string>): string {
  const rows = report.keys.map((k) => {
    const name = k.alias ?? names.get(k.hash) ?? `${k.hash.slice(0, 8)}…`;
    return `<tr><td>${escapeHtml(name)}</td><td class="num">${money(k.spend)}</td><td class="num">${k.requests.toLocaleString("en-US")}</td><td class="num">${compact(k.inputTokens)}</td><td class="num">${compact(k.outputTokens)}</td></tr>`;
  });
  return `<table><thead><tr><th>Key</th><th class="num">Spend</th><th class="num">Requests</th><th class="num">Input tokens</th><th class="num">Output tokens</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function body(state: UsageViewState): string {
  if (state.error) return `<p class="error">${escapeHtml(state.error)}</p>`;
  const report = state.report;
  if (!report) return `<p class="muted">${state.loading ? "Loading…" : "Not loaded yet."}</p>`;
  if (report.total.spend === 0 && report.total.requests === 0) return `<p class="muted">No usage in this period.</p>`;
  assignSlots(report.models, state.slots);
  const series = buildSeries(report, state.slots);
  const legend = series.map((s) => `<span class="item">${swatch(s)}${escapeHtml(s.name)}</span>`).join("");
  const tiles = [
    ["Spend", money(report.total.spend)],
    ["Requests", report.total.requests.toLocaleString("en-US")],
    ["Input tokens", compact(report.total.inputTokens)],
    ["Output tokens", compact(report.total.outputTokens)],
  ]
    .map(([label, value]) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div></div>`)
    .join("");
  return [
    `<div class="tiles">${tiles}</div>`,
    `<h2>Spend per day</h2><div class="legend">${legend}</div>${chart(report, series)}`,
    `<h2>By model</h2>${modelTable(report, series)}`,
    state.keyHash === null && report.keys.length > 0 ? `<h2>By key</h2>${keyTable(report, state.keyNames)}` : "",
  ].join("");
}

export function renderUsageHtml(state: UsageViewState, csp: { nonce: string; cspSource: string }): string {
  const periods = USAGE_PERIODS.map((p) => `<option value="${p.id}"${p.id === state.period ? " selected" : ""}>${p.label}</option>`).join("");
  const keys = [{ hash: "", label: "All my keys" }, ...state.keyOptions]
    .map((k) => `<option value="${escapeHtml(k.hash)}"${k.hash === (state.keyHash ?? "") ? " selected" : ""}>${escapeHtml(k.label)}</option>`)
    .join("");
  const range = state.report ? `${dateLabel(state.report.start)} – ${dateLabel(state.report.end)}, UTC days.` : "";
  const loaded = state.loadedAt ? ` Loaded ${state.loadedAt.toLocaleTimeString()}.` : "";
  const vars = (list: string[]) => list.map((c, i) => `--s${i}:${c};`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp.cspSource} 'unsafe-inline'; script-src 'nonce-${csp.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Usage</title>
<style>
  body { ${vars(SERIES_LIGHT)} --other: #8c8b86; --surface: var(--vscode-editor-background); color: var(--vscode-foreground); background: var(--surface); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px 16px 24px; max-width: 960px; }
  body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) { ${vars(SERIES_DARK)} --other: #8a8983; }
  h1 { font-size: 1.3em; font-weight: 600; margin: 0 0 8px; }
  h2 { font-size: 1.05em; font-weight: 600; margin: 20px 0 6px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  select, button { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 3px 6px; border-radius: 2px; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  .muted, .note { color: var(--vscode-descriptionForeground); }
  .note { margin: 6px 0 0; font-size: 0.92em; }
  .error { color: var(--vscode-errorForeground); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 14px; }
  .tile { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 8px 10px; }
  .tile .label { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .tile .value { font-size: 1.4em; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 4px; }
  .legend .item { display: inline-flex; align-items: center; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; flex: none; }
  .chart { width: 100%; height: auto; display: block; }
  .chart .grid { stroke: var(--vscode-editorWidget-border, #8884); stroke-opacity: 0.35; stroke-width: 1; }
  .chart .baseline { stroke: var(--vscode-descriptionForeground); stroke-width: 1; }
  .chart .axis { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .chart .hit { fill: transparent; }
  .chart .day:hover .hit { fill: var(--vscode-list-hoverBackground); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td:first-child { word-break: break-all; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
</style></head>
<body>
<h1>Usage</h1>
<div class="controls">
  <select id="period" aria-label="Period">${periods}</select>
  <select id="key" aria-label="Key">${keys}</select>
  <button id="refresh"${state.loading ? " disabled" : ""}>${state.loading ? "Loading…" : "Refresh"}</button>
</div>
<p class="note">${range} Read from your proxy only when you open this view, change a filter or press Refresh.${loaded}</p>
${body(state)}
<script nonce="${csp.nonce}">
  const vscode = acquireVsCodeApi();
  const load = () => vscode.postMessage({ type: "load", period: document.getElementById("period").value, key: document.getElementById("key").value });
  document.getElementById("period").addEventListener("change", load);
  document.getElementById("key").addEventListener("change", load);
  document.getElementById("refresh").addEventListener("click", load);
</script>
</body></html>`;
}
