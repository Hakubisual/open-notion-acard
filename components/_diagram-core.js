// Shared diagram frame and SVG primitives. Components own their layouts and pass trusted SVG markup.
import { registerComponent, registerHelpers, registerFamilyCss } from "../component-registry.js";

let dgcSeq = 0;
function dgcEsc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function dgcNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) { const n = Number(value.replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
  return null;
}
function dgcRound(value) { return Math.round(value * 10) / 10; }
function dgcUid(kind, data) {
  let hash = 2166136261;
  const text = JSON.stringify(data || {});
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return "vkdiagram-" + (hash >>> 0).toString(36) + "x" + (++dgcSeq).toString(36);
}
function dgcPalette(name) { return ["acard", "colorblind", "mono"].includes(name) ? name : "acard"; }
function dgcColor(palette, index) {
  const p = dgcPalette(palette), n = p === "mono" ? 4 : 8;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return "var(--viz-" + (p === "mono" ? "ink-" : p === "colorblind" ? "cb-" : "") + (((i % n + n) % n) + 1) + ")";
}
// NFC keeps decomposed Hangul at the same measured width as composed Korean labels.
function dgcTextW(text, size = 14) {
  let width = 0;
  for (const ch of String(text ?? "").normalize("NFC")) {
    if (/\p{Mark}|[\u200d\ufe0e\ufe0f]/u.test(ch)) continue;
    width += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]|\p{Extended_Pictographic}/u.test(ch) ? size : size * 0.58;
  }
  return width;
}
function dgcClip(text, max = 24) {
  const chars = [...String(text ?? "").trim()];
  const count = Math.max(0, Math.floor(max));
  return chars.length <= count ? chars.join("") : count ? chars.slice(0, count - 1).join("") + "…" : "";
}
// Width-bounded lines, preferring word breaks but allowing unspaced Korean and long identifiers.
function dgcWrap(text, width, size = 14, maxLines = 2) {
  const source = String(text ?? "").normalize("NFC").trim();
  if (!source || !(width > 0) || !(size > 0) || !(maxLines >= 1)) return [];
  const chars = [...source], lines = [];
  let start = 0;
  while (start < chars.length && lines.length < Math.floor(maxLines)) {
    let end = start, space = -1, measured = 0;
    while (end < chars.length && chars[end] !== "\n") {
      const next = dgcTextW(chars[end], size);
      if (measured + next > width) break;
      measured += next;
      if (/\s/.test(chars[end])) space = end;
      end += 1;
    }
    if (lines.length === Math.floor(maxLines) - 1 && end < chars.length) {
      let tail = chars.slice(start, end).join("").trimEnd();
      while (tail && dgcTextW(tail + "…", size) > width) tail = [...tail].slice(0, -1).join("").trimEnd();
      lines.push(dgcTextW("…", size) <= width ? tail + "…" : "");
      break;
    }
    if (end === start && chars[end] !== "\n") { lines.push(dgcTextW("…", size) <= width ? "…" : ""); break; }
    if (end < chars.length && chars[end] !== "\n" && space > start) end = space;
    lines.push(chars.slice(start, end).join("").trim());
    start = end;
    while (start < chars.length && /\s/.test(chars[start])) start += 1;
  }
  return lines;
}
function dgcText(x, y, text, size = 14, opts = {}) {
  const font = Math.max(11, size);
  return '<text x="' + dgcRound(x) + '" y="' + dgcRound(y) + '" font-size="' + font + '" text-anchor="' + dgcEsc(opts.anchor || "middle") + '" dominant-baseline="' + dgcEsc(opts.base || "central") + '" fill="' + dgcEsc(opts.fill || "currentColor") + '"' +
    (opts.weight ? ' font-weight="' + dgcEsc(opts.weight) + '"' : "") + (opts.cls ? ' class="' + dgcEsc(opts.cls) + '"' : "") + '>' + dgcEsc(text) + '</text>';
}
// A node's visible lines fit its padded box; its title always preserves the complete label.
function dgcNode(x, y, w, h, label, opts = {}) {
  const size = Math.max(11, opts.size || 14), step = size * 1.35, pad = 10;
  const subtitle = opts.subtitle ? String(opts.subtitle) : "";
  const room = Math.max(0, Math.floor((h - pad * 2) / step));
  const lines = dgcWrap(label, Math.max(0, w - pad * 2), size, Math.max(0, room - (subtitle && room > 1 ? 1 : 0)));
  const sub = subtitle && room > 1 ? dgcWrap(subtitle, Math.max(0, w - pad * 2), 11, 1) : [];
  const total = lines.length * step + (sub.length ? 15 : 0);
  let body = '<g class="dgc-node" style="--dgc-node-color:' + dgcEsc(dgcColor(opts.palette, opts.index)) + '"><title>' + dgcEsc(label) + (subtitle ? ' · ' + dgcEsc(subtitle) : '') + '</title><rect x="' + dgcRound(x) + '" y="' + dgcRound(y) + '" width="' + Math.max(0, dgcRound(w)) + '" height="' + Math.max(0, dgcRound(h)) + '"/>';
  lines.forEach((line, i) => { body += dgcText(x + w / 2, y + (h - total) / 2 + step * (i + 0.5), line, size, { weight: 650 }); });
  if (sub.length) body += dgcText(x + w / 2, y + (h + total) / 2 - 7.5, sub[0], 11, { cls: "dgc-muted" });
  return body + '</g>';
}
function dgcMarker(id, color = "var(--color-text-dim)") {
  return '<defs><marker id="' + dgcEsc(id) + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M1 1 L9 5 L1 9 Z" fill="' + dgcEsc(color) + '"/></marker></defs>';
}
function dgcArrow(x1, y1, x2, y2, opts = {}) {
  if (x1 === x2 && y1 === y2) return "";
  const id = opts.marker || dgcUid("arrow"), color = opts.color || "var(--color-text-dim)";
  return (opts.marker ? "" : dgcMarker(id, color)) + '<path class="dgc-edge" d="M' + dgcRound(x1) + ' ' + dgcRound(y1) + ' L' + dgcRound(x2) + ' ' + dgcRound(y2) + '" fill="none" stroke="' + dgcEsc(color) + '" stroke-width="1.5" marker-end="url(#' + dgcEsc(id) + ')"' + (opts.dashed ? ' stroke-dasharray="5 4"' : '') + '/>' +
    (opts.label ? dgcText((x1 + x2) / 2, (y1 + y2) / 2 - 10, opts.label, 11, { cls: "dgc-edge-label" }) : "");
}
function dgcTable(caption, head, rows) {
  return '<table class="vk-sr dgc-sr"><caption>' + dgcEsc(caption) + '</caption><thead><tr>' + head.map((cell) => '<th scope="col">' + dgcEsc(cell) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell, i) => i ? '<td>' + dgcEsc(cell) + '</td>' : '<th scope="row">' + dgcEsc(cell) + '</th>').join('') + '</tr>').join('') + '</tbody></table>';
}
function dgcList(caption, items) {
  return '<ul class="vk-sr dgc-sr" aria-label="' + dgcEsc(caption) + '">' + items.map((item) => '<li>' + dgcEsc(item) + '</li>').join('') + '</ul>';
}
// body(uid) lets layouts scope marker IDs separately in the wide and narrow SVGs.
function dgcFigure(kind, d, h, part) {
  const uid = dgcUid(kind, d), title = h.str(d.title, "", 80), subtitle = h.str(d.subtitle, "", 160);
  const caption = h.str(d.caption, "", 240), source = h.str(d.source, "", 160), label = title || part.label || "다이어그램";
  const numbered = d.figure === true, size = h.oneOf(d.height, ["s", "m", "l"], "m");
  const svg = (p, narrow) => {
    const id = uid + (narrow ? "-n" : "-w"), body = typeof p.body === "function" ? p.body(id) : p.body;
    return '<svg class="vk-svg dgc-svg' + (part.narrow ? narrow ? ' dgc-narrow' : ' dgc-wide' : '') + '" viewBox="0 0 ' + (dgcNum(p.w) > 0 ? dgcNum(p.w) : 640) + ' ' + (dgcNum(p.h) > 0 ? dgcNum(p.h) : 320) + '" role="img" aria-labelledby="' + id + '-t ' + id + '-d"><title id="' + id + '-t">' + dgcEsc(label) + '</title><desc id="' + id + '-d">' + dgcEsc(part.desc || label) + '</desc>' + (body || '') + '</svg>';
  };
  const head = title || subtitle || part.legend || part.badge ? '<div class="vk-head"><div class="vk-titles">' + (title ? '<div class="vk-title" id="' + uid + '-t">' + h.rich(title) + '</div>' : '') + (subtitle ? '<div class="vk-sub">' + h.rich(subtitle) + '</div>' : '') + '</div>' + (part.badge || '') + (part.legend || '') + '</div>' : '';
  const empty = part.empty || (!part.body && part.plot === undefined ? dgcEmpty : "");
  const plot = empty ? '<p class="vk-empty">' + dgcEsc(empty) + '</p>' : part.plot !== undefined ? part.plot : svg(part, false) + (part.narrow ? svg(part.narrow, true) : '');
  const foot = numbered || caption || source ? '<figcaption class="vk-cap">' + (numbered ? '<span class="vk-fignum">' + dgcEsc(title) + '</span>' : '') + (caption ? '<span class="vk-note">' + h.rich(caption) + '</span>' : '') + (source ? '<span class="vk-src">' + (h.en ? 'Source: ' : '출처: ') + h.rich(source) + '</span>' : '') + '</figcaption>' : '';
  return '<figure class="vk-fig dgc-fig dgc-' + dgcEsc(kind) + ' vk-h-' + size + (numbered ? ' vk-numbered' : '') + (d.compact === true ? ' vk-compact' : '') + '" role="group"' + (title ? ' aria-labelledby="' + uid + '-t"' : ' aria-label="' + dgcEsc(label) + '"') + '>' + head + '<div class="vk-plot">' + (part.before || '') + plot + (empty ? '' : part.after || '') + '</div>' + (empty ? '' : part.table || dgcList(label, part.items || [part.desc || label])) + foot + '</figure>';
}
const dgcEmpty = "데이터를 넣으면 다이어그램이 그려져요.";
const dgcPresets = { report: { figure: false, compact: true }, friendly: {}, paper: { palette: "mono", figure: true }, showcase: { height: "l" } };
const dgcProps = {
  title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, source: { type: "string" }, unit: { type: "string" },
  figure: { type: "boolean" }, palette: { type: "string", enum: ["acard", "colorblind", "mono"] }, height: { type: "string", enum: ["s", "m", "l"] }, preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] },
};
registerHelpers("diagram", { esc: dgcEsc, num: dgcNum, round: dgcRound, uid: dgcUid, palette: dgcPalette, color: dgcColor, textW: dgcTextW, clip: dgcClip, wrap: dgcWrap, text: dgcText, node: dgcNode, marker: dgcMarker, arrow: dgcArrow, table: dgcTable, list: dgcList, figure: dgcFigure, PRESETS: dgcPresets, PROPS: dgcProps, EMPTY: dgcEmpty });

registerFamilyCss("diagram",
  ".vk-fig.dgc-fig{--viz-1:color-mix(in srgb,var(--color-accent) 82%,var(--color-surface));--viz-2:var(--solid-blue);--viz-3:color-mix(in srgb,var(--solid-green) 65%,var(--solid-blue));--viz-4:color-mix(in srgb,var(--color-accent) 65%,var(--solid-red));--viz-5:var(--solid-orange);--viz-6:var(--solid-green);--viz-7:var(--solid-yellow);--viz-8:var(--color-text-dim);--viz-ink-1:var(--color-text);--viz-ink-2:color-mix(in srgb,var(--color-text) 70%,var(--color-surface));--viz-ink-3:var(--color-text-dim);--viz-ink-4:color-mix(in srgb,var(--color-text-dim) 60%,var(--color-surface));container-type:inline-size;position:relative;min-width:0;margin:0;padding:var(--space-5);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);box-shadow:var(--shadow-sm);color:var(--color-text);font-variant-numeric:tabular-nums;break-inside:avoid}" +
  ".vk-fig.dgc-fig.vk-compact{padding:var(--space-4)}.vk-fig.dgc-fig .vk-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:var(--space-2) var(--space-4);margin-bottom:var(--space-3)}.vk-fig.dgc-fig .vk-titles{min-width:0;flex:1 1 auto}.vk-fig.dgc-fig .vk-title{font-size:var(--fs-17);font-weight:700;line-height:var(--lh-tight);letter-spacing:var(--ls-heading);overflow-wrap:anywhere}.vk-fig.dgc-fig .vk-sub{margin-top:var(--space-1);font-size:var(--fs-13);color:var(--color-text-dim);overflow-wrap:anywhere}" +
  ".vk-fig.dgc-fig .vk-plot{position:relative;min-width:0}.vk-fig.dgc-fig .dgc-svg{display:block;width:100%;height:auto;max-height:none;overflow:hidden}.vk-fig.dgc-fig .dgc-svg text{font-family:inherit}.vk-fig.dgc-fig .dgc-node rect{rx:var(--radius-sm);fill:color-mix(in srgb,var(--dgc-node-color) 17%,var(--color-surface));stroke:color-mix(in srgb,var(--dgc-node-color) 65%,var(--color-border));stroke-width:1}.vk-fig.dgc-fig .dgc-node text{fill:var(--color-text)}.vk-fig.dgc-fig .dgc-node .dgc-muted,.vk-fig.dgc-fig .dgc-muted{fill:var(--color-text-dim)}.vk-fig.dgc-fig .dgc-edge{stroke-linejoin:round;stroke-linecap:round}.vk-fig.dgc-fig .dgc-edge-label{fill:var(--color-text-dim);paint-order:stroke;stroke:var(--color-surface);stroke-width:4;stroke-linejoin:round}" +
  ".vk-fig.dgc-fig .vk-cap{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2);margin-top:var(--space-3);color:var(--color-text-dim);font-size:var(--fs-13);overflow-wrap:anywhere}.vk-fig.dgc-fig.vk-numbered .vk-fignum::before{content:'그림. ';font-weight:650;color:var(--color-text)}.vk-fig.dgc-fig.vk-numbered:lang(en) .vk-fignum::before{content:'Figure. '}.rp .vk-fig.dgc-fig.vk-numbered .vk-fignum::before{content:none}.vk-fig.dgc-fig .vk-empty{margin:0;padding:var(--space-6) var(--space-4);border:1px dashed var(--color-border);border-radius:var(--radius-sm);text-align:center;color:var(--color-text-dim);font-size:var(--fs-14)}" +
  ".vk-fig.dgc-fig .vk-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.vk-fig.dgc-fig .dgc-narrow{display:none}[data-preset=paper] .vk-fig.dgc-fig{box-shadow:none}[data-preset=paper] .vk-fig.dgc-fig .vk-title{font-family:var(--font-serif)}[data-preset=showcase] .vk-fig.dgc-fig{padding:var(--space-6);border-radius:var(--radius-lg)}" +
  "@container (max-width:519px){.vk-fig.dgc-fig .vk-head{flex-direction:column}.vk-fig.dgc-fig .vk-legend{flex-wrap:wrap;order:3}.vk-fig.dgc-fig .dgc-wide{display:none}.vk-fig.dgc-fig .dgc-narrow{display:block}}" +
  "@media print{.vk-fig.dgc-fig{box-shadow:none;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}.vk-fig.dgc-fig .vk-sr{position:static;width:auto;height:auto;margin:var(--space-3) 0 0;overflow:visible;clip:auto;white-space:normal;font-size:var(--fs-11)}.vk-fig.dgc-fig table.vk-sr{width:100%;border-collapse:collapse}.vk-fig.dgc-fig .vk-sr th,.vk-fig.dgc-fig .vk-sr td{padding:var(--space-1);border:1px solid var(--color-border);text-align:left;overflow-wrap:anywhere}}");
