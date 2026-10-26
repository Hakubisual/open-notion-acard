// Chart engine for the visual kit (charts family): shared figure frame, scales, axes, legend, palette and the
// screen-reader data table. Every chart-*.js component draws with h.chart.*. Server-rendered SVG, no script.
// Contract: design/visual-kit/SPEC.md.
import { registerComponent, registerHelpers, registerFamilyCss } from "../component-registry.js";

const CHC_PALETTES = { acard: 8, colorblind: 8, mono: 4 };
let chcSeq = 0;

function chcEsc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function chcNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.replace(/,/g, "")))) return Number(value.replace(/,/g, ""));
  return null;
}
function chcRound(v) { return Math.round(v * 10) / 10; }
function chcFmt(v, unit) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const text = abs >= 1e9 ? (v / 1e9).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "B"
    : Number(v.toPrecision(6)).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return text + (unit || "");
}
// Rough text width in SVG units: CJK and full-width glyphs ~1em, the rest ~0.58em.
function chcTextW(text, size) {
  let w = 0;
  for (const ch of String(text)) w += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]/.test(ch) ? size : size * 0.58;
  return w;
}
function chcClip(text, max) {
  const s = String(text ?? "").trim();
  return [...s].length > max ? [...s].slice(0, max - 1).join("") + "…" : s;
}
function chcHash(text) {
  let n = 2166136261;
  for (let i = 0; i < text.length; i += 1) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(36);
}
// A fresh id per render: two charts with the same data on one page never share an aria target.
function chcUid(kind, data) {
  chcSeq = (chcSeq + 1) % 1679616;
  return "vk" + kind + "-" + chcHash(JSON.stringify(data || {})).slice(0, 6) + chcSeq.toString(36);
}
function chcPalette(name) { return CHC_PALETTES[name] ? name : "acard"; }
// Series color i of the palette as a CSS variable (mono cycles 4 inks; colorblind uses Okabe-Ito).
function chcColor(palette, i) {
  const p = chcPalette(palette);
  if (p === "mono") return "var(--viz-ink-" + ((i % 4) + 1) + ")";
  if (p === "colorblind") return "var(--viz-cb-" + ((i % 8) + 1) + ")";
  return "var(--viz-" + ((i % 8) + 1) + ")";
}
// mono palette: dash pattern per series so lines stay apart in black and white.
function chcDash(palette, i) {
  return chcPalette(palette) === "mono" && i > 0 ? ' stroke-dasharray="' + ["6 4", "2 3", "8 3 2 3"][(i - 1) % 3] + '"' : "";
}
// Nice axis ticks between lo and hi (about `count` steps), always including 0 when the range crosses it.
function chcTicks(lo, hi, count) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  return out;
}
function chcScale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}
function chcText(x, y, text, size, opts) {
  const o = opts || {};
  return '<text x="' + chcRound(x) + '" y="' + chcRound(y) + '" font-size="' + size + '"' + (o.anchor ? ' text-anchor="' + o.anchor + '"' : "") +
    ' dominant-baseline="' + (o.base || "central") + '"' + (o.weight ? ' font-weight="' + o.weight + '"' : "") + ' fill="' + (o.fill || "currentColor") + '"' +
    (o.cls ? ' class="' + o.cls + '"' : "") + ">" + chcEsc(text) + "</text>";
}
// Category labels and series from data: labels [..], series [{name, data:[..]}] or values [..] for one series.
function chcSeries(d, h, maxSeries) {
  const labels = h.list(d.labels, 48).map((l, i) => chcClip(h.str(l, String(i + 1), 40), 40));
  let rows = h.list(d.series, maxSeries || 8).filter((s) => s && typeof s === "object");
  if (!rows.length && Array.isArray(d.values)) rows = [{ name: h.str(d.name, "값", 30), data: d.values }];
  const series = rows.map((s, i) => ({ name: chcClip(h.str(s.name, "계열 " + (i + 1), 30), 30), data: labels.map((_, k) => chcNum(Array.isArray(s.data) ? s.data[k] : null)), color: typeof s.color === "number" ? s.color : i }));
  const ok = labels.length > 0 && series.some((s) => s.data.some((v) => v !== null));
  return { labels, series, ok };
}
// Visually hidden data table: screen readers and print fallback read the numbers.
function chcTable(caption, head, rows) {
  return '<table class="vk-sr"><caption>' + chcEsc(caption) + "</caption><thead><tr>" + head.map((c) => '<th scope="col">' + chcEsc(c) + "</th>").join("") + "</tr></thead><tbody>" +
    rows.map((r) => "<tr>" + r.map((c, i) => (i ? "<td>" + chcEsc(c) + "</td>" : '<th scope="row">' + chcEsc(c) + "</th>")).join("") + "</tr>").join("") + "</tbody></table>";
}
function chcLegend(items, palette) {
  if (items.length < 2) return "";
  return '<ul class="vk-legend" aria-hidden="true">' + items.map((name, i) => '<li><i style="background:' + chcColor(palette, i) + '"></i>' + chcEsc(name) + "</li>").join("") + "</ul>";
}
// The figure frame every chart uses: header (title, subtitle, legend/badge) > svg > hidden table > caption.
// body: the inner svg markup (without <svg>), w/h: viewBox size, desc: one-sentence finding for the svg <desc>.
// plot: ready markup used instead of the svg (donut = svg + list); before: markup above the svg (KPI number).
function chcFigure(kind, d, h, part) {
  const uid = chcUid(kind, d);
  const title = h.str(d.title, "", 80), subtitle = h.str(d.subtitle, "", 160), caption = h.str(d.caption, "", 240), source = h.str(d.source, "", 160);
  const size = h.oneOf(d.height, ["s", "m", "l"], "m");
  const figure = d.figure === true;
  const label = title || part.label || "차트";
  const head = title || subtitle || part.legend || part.badge ? '<div class="vk-head"><div class="vk-titles">' +
    (title ? '<div class="vk-title" id="' + uid + '-t">' + h.rich(title) + "</div>" : "") +
    (subtitle ? '<div class="vk-sub">' + h.rich(subtitle) + "</div>" : "") + "</div>" + (part.badge || "") + (part.legend || "") + "</div>" : "";
  const svg = part.empty ? '<p class="vk-empty">' + chcEsc(part.empty) + "</p>" : part.plot !== undefined ? part.plot
    : !part.body ? "" : '<svg class="vk-svg' + (part.narrow ? " vk-wide" : "") + '" viewBox="0 0 ' + part.w + " " + part.h + '" role="img" aria-labelledby="' + uid + "-st " + uid + '-sd" preserveAspectRatio="' + (part.stretch ? "none" : "xMidYMid meet") + '">' +
      '<title id="' + uid + '-st">' + chcEsc(label) + '</title><desc id="' + uid + '-sd">' + chcEsc(part.desc || "") + "</desc>" + part.body + "</svg>" +
      (part.narrow ? '<svg class="vk-svg vk-narrow" viewBox="0 0 ' + part.narrow.w + " " + part.narrow.h + '" aria-hidden="true">' + part.narrow.body + "</svg>" : "");
  const foot = figure || caption || source ? '<figcaption class="vk-cap">' + (figure ? '<span class="vk-fignum">' + (title ? chcEsc(title) : "") + "</span>" : "") +
    (caption ? '<span class="vk-note">' + h.rich(caption) + "</span>" : "") + (source ? '<span class="vk-src">' + (h.en ? "Source: " : "출처: ") + h.rich(source) + "</span>" : "") + "</figcaption>" : "";
  return '<figure class="vk-fig vk-' + kind + " vk-h-" + size + (figure ? " vk-numbered" : "") + (d.compact === true ? " vk-compact" : "") + '" role="group"' +
    (title ? ' aria-labelledby="' + uid + '-t"' : ' aria-label="' + chcEsc(label) + '"') + ">" + head + '<div class="vk-plot">' + (part.before || "") + svg + "</div>" + (part.empty ? "" : part.table || "") + foot + "</figure>";
}
// Cartesian frame: gridlines + y ticks + x labels for category charts. Returns { x(i), bw, y(v), svg, plot box }.
function chcAxes(labels, lo, hi, opts) {
  const o = opts || {};
  const W = o.w || 640, H = o.h || 320;
  const ticks = chcTicks(lo, hi, o.ticks || 4);
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const tickW = Math.max(...ticks.map((t) => chcTextW(chcFmt(t, o.unit), 12)));
  const left = Math.max(36, Math.ceil(tickW) + 14), right = 12, top = 14, bottom = H - (o.xTitle ? 52 : 34);
  const y = chcScale(t0, t1, bottom, top);
  const n = Math.max(1, labels.length);
  const step = (W - left - right) / n;
  const x = (i) => left + step * (i + 0.5);
  const every = Math.max(1, Math.ceil(Math.max(...labels.map((l) => chcTextW(l, 12)), 1) / (step - 6)));
  let svg = "";
  for (const t of ticks) {
    svg += '<line class="vk-grid" x1="' + left + '" x2="' + (W - right) + '" y1="' + chcRound(y(t)) + '" y2="' + chcRound(y(t)) + '"/>' +
      chcText(left - 8, y(t), chcFmt(t, o.unit), 12, { anchor: "end", cls: "vk-tick" });
  }
  svg += '<line class="vk-base" x1="' + left + '" x2="' + (W - right) + '" y1="' + chcRound(y(Math.max(t0, Math.min(0, t1)))) + '" y2="' + chcRound(y(Math.max(t0, Math.min(0, t1)))) + '"/>';
  labels.forEach((l, i) => { if (i % every === 0) svg += chcText(x(i), bottom + 16, chcClip(l, Math.max(3, Math.floor((step * every) / 12))), 12, { anchor: "middle", cls: "vk-tick" }); });
  if (o.xTitle) svg += chcText(left + (W - left - right) / 2, H - 12, o.xTitle, 12, { anchor: "middle", cls: "vk-axis-title" });
  if (o.yTitle) svg += '<text class="vk-axis-title" font-size="12" text-anchor="middle" transform="translate(12 ' + chcRound((top + bottom) / 2) + ') rotate(-90)" fill="currentColor">' + chcEsc(o.yTitle) + "</text>";
  return { W, H, left, right, top, bottom, step, x, y, ticks, svg, zero: y(Math.max(t0, Math.min(0, t1))) };
}
function chcMinMax(series, stacked) {
  let lo = 0, hi = 0;
  if (stacked) {
    const n = series[0] ? series[0].data.length : 0;
    for (let k = 0; k < n; k += 1) {
      let pos = 0, neg = 0;
      for (const s of series) { const v = s.data[k]; if (v > 0) pos += v; else if (v < 0) neg += v; }
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    }
  } else for (const s of series) for (const v of s.data) if (v !== null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
  return { lo, hi: hi === lo ? lo + 1 : hi };
}
// Arc path for pie/donut/gauge/sunburst: center cx,cy, radii r0 (inner) r1 (outer), angles a0..a1 in radians.
function chcArc(cx, cy, r0, r1, a0, a1) {
  const big = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => chcRound(cx + r * Math.cos(a)) + " " + chcRound(cy + r * Math.sin(a));
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  return "M" + p(r1, a0) + " A" + r1 + " " + r1 + " 0 " + big + " 1 " + p(r1, a1) + (r0 > 0 ? " L" + p(r0, a1) + " A" + r0 + " " + r0 + " 0 " + big + " 0 " + p(r0, a0) : " L" + chcRound(cx) + " " + chcRound(cy)) + " Z";
}
// Finding sentence for <desc>: the largest and smallest point of the first series.
function chcFinding(labels, s, unit) {
  const pts = s.data.map((v, i) => [v, labels[i]]).filter((p) => p[0] !== null);
  if (!pts.length) return "";
  const max = pts.reduce((a, b) => (b[0] > a[0] ? b : a)), min = pts.reduce((a, b) => (b[0] < a[0] ? b : a));
  return s.name + ": " + max[1] + "이(가) " + chcFmt(max[0], unit) + "로 가장 높고, " + min[1] + "이(가) " + chcFmt(min[0], unit) + "로 가장 낮아요.";
}

const CHC_PRESETS = { paper: { palette: "mono", figure: true }, report: { compact: true }, friendly: {}, showcase: { height: "l" } };
const CHC_COMMON_PROPS = {
  title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, source: { type: "string" }, unit: { type: "string" },
  figure: { type: "boolean" }, palette: { enum: ["acard", "colorblind", "mono"] }, height: { enum: ["s", "m", "l"] }, preset: { enum: ["report", "friendly", "paper", "showcase"] },
};

registerHelpers("chart", {
  esc: chcEsc, num: chcNum, round: chcRound, fmt: chcFmt, textW: chcTextW, clip: chcClip, uid: chcUid, palette: chcPalette, color: chcColor, dash: chcDash,
  ticks: chcTicks, scale: chcScale, text: chcText, series: chcSeries, table: chcTable, legend: chcLegend, figure: chcFigure, axes: chcAxes, minMax: chcMinMax,
  arc: chcArc, finding: chcFinding, PRESETS: CHC_PRESETS, PROPS: CHC_COMMON_PROPS, EMPTY: "데이터를 넣으면 그래프가 그려져요.",
});

registerFamilyCss("chart",
  // Data palette from existing tokens (no new colors; dark mode follows the base tokens).
  ".ui[data-ui^=chart-]{--viz-1:color-mix(in srgb,var(--color-accent) 82%,var(--color-surface));--viz-2:color-mix(in srgb,var(--solid-green) 45%,var(--solid-blue));--viz-3:color-mix(in srgb,var(--color-accent) 45%,var(--color-surface));--viz-4:var(--solid-blue);--viz-5:var(--solid-green);--viz-6:var(--solid-orange);--viz-7:color-mix(in srgb,var(--tag-pink-fg) 55%,var(--color-surface));--viz-8:var(--color-text-dim);" +
  "--viz-up:var(--solid-green);--viz-down:var(--solid-red);--viz-grid:color-mix(in srgb,var(--color-border) 75%,var(--color-surface));--viz-axis:color-mix(in srgb,var(--color-border) 60%,var(--color-text-dim));" +
  "--viz-ink-1:var(--color-text);--viz-ink-2:color-mix(in srgb,var(--color-text) 62%,var(--color-surface));--viz-ink-3:var(--color-text-dim);--viz-ink-4:color-mix(in srgb,var(--color-text-dim) 45%,var(--color-surface))}" +
  ".vk-fig{container-type:inline-size;margin:0;padding:var(--space-5);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);box-shadow:var(--shadow-sm);color:var(--color-text);font-variant-numeric:tabular-nums;break-inside:avoid}" +
  ".vk-fig.vk-compact{padding:var(--space-4)}" +
  ".vk-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:var(--space-2) var(--space-4);margin-bottom:var(--space-3)}" +
  ".vk-titles{min-width:0;flex:1 1 auto}.vk-title{font-size:var(--fs-17);font-weight:700;line-height:var(--lh-tight);letter-spacing:var(--ls-heading)}" +
  ".vk-sub{margin-top:2px;color:var(--color-text-dim);font-size:var(--fs-13)}" +
  ".vk-legend{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2);margin:0;padding:2px var(--space-2);list-style:none;border-radius:var(--radius-pill);background:var(--color-surface-soft);font-size:var(--fs-12);color:var(--color-text-dim)}" +
  ".vk-legend li{display:inline-flex;align-items:center;gap:6px;padding:2px 4px}.vk-legend i{width:9px;height:9px;border-radius:50%;flex:none}" +
  ".vk-badge{flex:none;padding:3px var(--space-3);border-radius:var(--radius-pill);font-size:var(--fs-13);font-weight:650;background:var(--color-success-bg);color:var(--color-success-fg)}.vk-badge.down{background:var(--color-danger-bg);color:var(--color-danger-fg)}" +
  ".vk-plot{position:relative}.vk-svg{display:block;width:100%;height:auto;overflow:visible}.vk-h-s .vk-svg{max-height:200px}.vk-h-m .vk-svg{max-height:340px}.vk-h-l .vk-svg{max-height:480px}" +
  ".vk-svg text{font-family:inherit}.vk-tick{fill:var(--color-text-dim)}.vk-axis-title{fill:var(--color-text-dim)}.vk-val{fill:var(--color-text);font-weight:600}" +
  ".vk-grid{stroke:var(--viz-grid);stroke-width:1}.vk-base{stroke:var(--viz-axis);stroke-width:1}" +
  ".vk-cap{display:flex;flex-wrap:wrap;gap:2px var(--space-2);margin-top:var(--space-3);color:var(--color-text-dim);font-size:var(--fs-13)}" +
  ".vk-numbered .vk-fignum::before{content:'그림. ';font-weight:650;color:var(--color-text)}.vk-numbered:lang(en) .vk-fignum::before{content:'Figure. '}.rp .vk-numbered .vk-fignum::before{content:none}.rp .vk-numbered .vk-cap::before{font-weight:600}" +
  ".vk-src{color:var(--color-text-dim)}.vk-empty{margin:0;padding:var(--space-6) var(--space-4);border:1px dashed var(--color-border);border-radius:var(--radius-sm);text-align:center;color:var(--color-text-dim);font-size:var(--fs-14)}" +
  ".vk-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
  "[data-preset=paper] .vk-fig{box-shadow:none;border-color:var(--viz-ink-4)}[data-preset=paper] .vk-title{font-family:var(--font-serif)}[data-preset=showcase] .vk-fig{padding:var(--space-6);border-radius:var(--radius-lg)}" +
  ".vk-narrow{display:none}@container (max-width:519px){.vk-head{flex-direction:column}.vk-legend{order:3}.vk-wide{display:none}.vk-narrow{display:block}}" +
  "@media (prefers-reduced-motion:no-preference){.vk-fig .vk-draw{animation:vk-rise var(--dur-slow) var(--ease-out) both}}@keyframes vk-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}" +
  "@media print{.vk-fig{box-shadow:none;-webkit-print-color-adjust:exact;print-color-adjust:exact}}");
