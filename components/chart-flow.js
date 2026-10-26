import { registerComponent } from "../component-registry.js";

// Flow and hierarchy charts. All geometry is local; frames, text and palettes use the chart engine.
const chflProps = {
  title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, source: { type: "string" }, unit: { type: "string" },
  figure: { type: "boolean" }, palette: { type: "string", enum: ["acard", "colorblind", "mono"] },
  height: { type: "string", enum: ["s", "m", "l"] }, preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] },
};
const chflPresets = { paper: { palette: "mono", figure: true }, report: { figure: false, compact: true }, friendly: {}, showcase: { height: "l" } };
const chflLabels = { type: "array", items: { type: "string" } };

function chflRect(C, x, y, w, h, fill, title, cls) {
  return '<rect class="' + cls + '" x="' + C.round(x) + '" y="' + C.round(y) + '" width="' + C.round(Math.max(0, w)) + '" height="' + C.round(Math.max(0, h)) + '" rx="' + C.round(Math.min(5, w / 8, h / 8)) + '" fill="' + fill + '"><title>' + C.esc(title) + '</title></rect>';
}
function chflFit(C, text, width, size) {
  let n = [...text].length;
  while (n > 1 && C.textW(C.clip(text, n), size) > width) n -= 1;
  const label = C.clip(text, n);
  return C.textW(label, size) <= width ? label : "";
}
function chflFigure(kind, label, d, h, draw) {
  const wide = draw(d, h, 640, 320);
  return h.chart.figure(kind, d, h, wide ? { ...wide, narrow: draw(d, h, 360, 300), label } : { empty: h.chart.EMPTY });
}
function chflHeatFill(C, pal, step) {
  return 'color-mix(in srgb,' + C.color(pal, 0) + ' ' + (12 + step * 12) + '%,var(--color-surface))';
}
function chflHeatmap(d, h, W, H) {
  const C = h.chart, unit = h.str(d.unit, "", 8), pal = C.palette(d.palette);
  const rows = h.list(d.rows, 16).map((v, i) => h.str(v, String(i + 1), 40));
  const cols = h.list(d.cols, 24).map((v, i) => h.str(v, String(i + 1), 40));
  const matrix = h.list(d.values, 16);
  const values = rows.map((_, i) => cols.map((__, j) => C.num(h.list(matrix[i], 24)[j])));
  const valid = values.flat().filter((v) => v !== null);
  if (!rows.length || !cols.length || !valid.length) return null;
  const lo = Math.min(...valid), hi = Math.max(...valid);
  const left = Math.min(W * 0.28, Math.max(36, ...rows.map((s) => C.textW(s, 12) + 20)));
  const top = 36, bottom = H - 32, cw = (W - left - 8) / cols.length, rh = (bottom - top) / rows.length;
  let body = C.text(W - 174, 13, h.t("적음", "Low"), 11, { cls: "vk-tick" }) + C.text(W - 4, 13, h.t("많음", "High"), 11, { anchor: "end", cls: "vk-tick" });
  for (let s = 0; s < 6; s += 1) body += chflRect(C, W - 144 + s * 18, 5, 15, 16, chflHeatFill(C, pal, s), C.fmt(lo + (hi - lo) * s / 5, unit), "chfl-key");
  const every = Math.max(1, Math.ceil(38 / cw));
  cols.forEach((col, j) => { if (j % every === 0) body += '<g><title>' + C.esc(col) + '</title>' + C.text(left + cw * (j + 0.5), H - 14, chflFit(C, col, cw * every - 6, 12), 12, { anchor: "middle", cls: "vk-tick" }) + '</g>'; });
  rows.forEach((row, i) => {
    body += '<g><title>' + C.esc(row) + '</title>' + C.text(left - 10, top + rh * (i + 0.5), chflFit(C, row, left - 14, 12), 12, { anchor: "end", cls: "vk-tick" }) + '</g>';
    values[i].forEach((v, j) => {
      const step = v === null ? 0 : hi === lo ? (hi === 0 ? 0 : 3) : Math.min(5, Math.floor((v - lo) / (hi - lo) * 6));
      const value = C.fmt(v, unit), label = row + ' · ' + cols[j] + ': ' + value;
      body += chflRect(C, left + j * cw + 2, top + i * rh + 2, cw - 4, rh - 4, v === null ? 'var(--color-surface-soft)' : chflHeatFill(C, pal, step), label, "chfl-cell");
      if (rh >= 23 && C.textW(value, 11) + 10 <= cw) body += C.text(left + cw * (j + 0.5), top + rh * (i + 0.5), value, 11, { anchor: "middle" });
    });
  });
  const table = C.table(h.str(d.title, "히트맵", 80), ["행", "열", "값"], rows.flatMap((r, i) => cols.map((c, j) => [r, c, C.fmt(values[i][j], unit)])));
  return { w: W, h: H, body, table, desc: rows.length + '개 행과 ' + cols.length + '개 열의 값은 ' + C.fmt(lo, unit) + '에서 ' + C.fmt(hi, unit) + ' 사이예요.' };
}

registerComponent({
  id: "chart-heatmap", family: "chart", name: "히트맵",
  description: "Heatmap comparing a numeric matrix with sequential intensity; rows: [labels], cols: [labels], values: [[numbers]], with a scale legend and fitted cell values.",
  schema: { type: "object", properties: { ...chflProps, rows: chflLabels, cols: chflLabels, values: { type: "array", items: { type: "array", items: { type: ["number", "null"] } } } }, required: ["rows", "cols", "values"] },
  presets: chflPresets, defaults: { rows: [], cols: [], values: [] },
  sample: { title: "요일별 활동", subtitle: "요일과 시간대별 활동량을 비교합니다.", rows: ["오전 6시", "오전 10시", "오후 2시", "오후 6시", "오후 10시"], cols: ["월", "화", "수", "목", "금", "토", "일"], values: [[8, 12, 18, 22, 14, 10, 8], [20, 32, 45, 58, 36, 28, 24], [30, 48, 64, 72, 51, 38, 30], [24, 36, 52, 60, 44, 29, 21], [8, 15, 24, 29, 20, 12, 6]], caption: "활동 횟수 (단위: 회)" },
  slash: { label: "히트맵", hint: "행과 열의 값 비교", ico: "▦", aliases: "히트맵 열지도 활동 heatmap matrix intensity" }, css: "",
  render(d, h) { return chflFigure("heatmap", "히트맵", d, h, chflHeatmap); },
});

// Squarify: take descending areas and keep a row while its worst aspect ratio improves.
// Areas tile the whole rectangle; separation is drawn as a stroke, never subtracted from the data area.
function chflSquarify(items, x, y, w, h) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const pending = items.map((item) => ({ ...item, area: item.value / total * w * h })).sort((a, b) => b.area - a.area);
  const out = [];
  const worst = (row, side) => {
    if (!row.length) return Infinity;
    const sum = row.reduce((s, item) => s + item.area, 0), max = row[0].area, min = row[row.length - 1].area;
    return Math.max(side * side * max / (sum * sum), sum * sum / (side * side * min));
  };
  while (pending.length) {
    const side = Math.min(w, h), row = [pending.shift()];
    while (pending.length && worst([...row, pending[0]], side) <= worst(row, side)) row.push(pending.shift());
    const sum = row.reduce((s, item) => s + item.area, 0), thickness = sum / side;
    let offset = 0;
    for (const item of row) {
      const length = item.area / thickness;
      out.push({ ...item, x: x + (w >= h ? 0 : offset), y: y + (w >= h ? offset : 0), w: w >= h ? thickness : length, h: w >= h ? length : thickness });
      offset += length;
    }
    if (w >= h) { x += thickness; w = Math.max(0, w - thickness); } else { y += thickness; h = Math.max(0, h - thickness); }
  }
  return out;
}
function chflTreemap(d, h, W, H) {
  const C = h.chart, pal = C.palette(d.palette), unit = h.str(d.unit, "", 8);
  const items = h.list(d.items, 48).filter((it) => it && typeof it === "object").map((it, i) => ({ label: h.str(it.label, "항목 " + (i + 1), 60), group: h.str(it.group, "", 40), value: C.num(it.value), color: i })).filter((it) => it.value > 0);
  const total = items.reduce((s, it) => s + it.value, 0);
  if (!items.length || !Number.isFinite(total)) return null;
  const groups = [...new Set(items.map((it) => it.group))];
  const grouped = items.some((it) => it.group);
  // Group regions are themselves squarified, then filled with their own items.
  const regions = grouped ? chflSquarify(groups.map((group) => ({ group, value: items.filter((it) => it.group === group).reduce((s, it) => s + it.value, 0) })), 2, 2, W - 4, H - 4) : [{ x: 2, y: 2, w: W - 4, h: H - 4 }];
  let body = "";
  for (const region of regions) {
    const cells = chflSquarify(grouped ? items.filter((it) => it.group === region.group) : items, region.x, region.y, region.w, region.h);
    for (const cell of cells) {
      const color = C.color(pal, grouped ? groups.indexOf(cell.group) : cell.color);
      const title = (cell.group ? cell.group + ' · ' : '') + cell.label + ': ' + C.fmt(cell.value, unit) + ' (' + C.fmt(cell.value / total * 100, '%') + ')';
      body += '<g><title>' + C.esc(title) + '</title>' + chflRect(C, cell.x, cell.y, cell.w, cell.h, 'color-mix(in srgb,' + color + ' 24%,var(--color-surface))', title, "chfl-tile");
      const label = chflFit(C, cell.label, cell.w - 20, 13), value = C.fmt(cell.value, unit);
      if (cell.h >= 32 && label) body += C.text(cell.x + 10, cell.y + 18, label, 13, { weight: 650 });
      if (cell.h >= 56 && C.textW(value, 12) <= cell.w - 20) body += C.text(cell.x + 10, cell.y + 40, value, 12, { cls: "vk-tick" });
      body += '</g>';
    }
  }
  const top = items.reduce((a, b) => a.value >= b.value ? a : b);
  return { w: W, h: H, body, legend: grouped ? C.legend(groups.map((g) => g || "기타"), pal) : "", desc: top.label + '이(가) 전체 ' + C.fmt(total, unit) + ' 중 ' + C.fmt(top.value / total * 100, '%') + '로 가장 커요.', table: C.table(h.str(d.title, "트리맵", 80), ["항목", "그룹", "값"], items.map((it) => [it.label, it.group, C.fmt(it.value, unit)])) };
}
registerComponent({
  id: "chart-treemap", family: "chart", name: "트리맵",
  description: "Squarified treemap of shares with optional nested group regions; items: [{label, value, group?}], positive values determine areas and labels appear only where they fit.",
  schema: { type: "object", properties: { ...chflProps, items: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, group: { type: "string" } }, required: ["label", "value"] } } }, required: ["items"] },
  presets: chflPresets, defaults: { items: [] },
  sample: { title: "제품별 매출 비중", subtitle: "제품군 안에서 각 제품이 차지하는 비중입니다.", items: [{ label: "팀 요금제", value: 420, group: "구독" }, { label: "개인 요금제", value: 280, group: "구독" }, { label: "기업 요금제", value: 180, group: "구독" }, { label: "템플릿", value: 150, group: "콘텐츠" }, { label: "교육 자료", value: 90, group: "콘텐츠" }, { label: "컨설팅", value: 80, group: "서비스" }], caption: "면적은 매출에 비례합니다. (단위: 만원)" },
  slash: { label: "트리맵", hint: "면적으로 비중 비교", ico: "▤", aliases: "트리맵 사각형 계층 비중 treemap squarify hierarchy" },
  css: ".ui-chart-treemap .chfl-tile{stroke:var(--color-surface);stroke-width:3}",
  render(d, h) { return chflFigure("treemap", "트리맵", d, h, chflTreemap); },
});

function chflTree(raw, h, depth) {
  if (!raw || typeof raw !== "object" || depth > 3) return null;
  const children = h.list(raw.children, 24).map((node) => chflTree(node, h, depth + 1)).filter(Boolean);
  const value = children.length ? children.reduce((s, node) => s + node.value, 0) : h.chart.num(raw.value);
  return value > 0 && Number.isFinite(value) ? { label: h.str(raw.label, depth ? "항목" : "전체", 60), value, children } : null;
}
function chflSunburst(d, h, W, H) {
  const C = h.chart, root = chflTree(d.tree, h, 0), pal = C.palette(d.palette), unit = h.str(d.unit, "", 8);
  if (!root || !root.children.length) return null;
  const depthOf = (node) => node.children.length ? 1 + Math.max(...node.children.map(depthOf)) : 0;
  const depth = Math.max(2, depthOf(root)), cx = W / 2, cy = H / 2, outer = H / 2 - 8, inner = 40, band = (outer - inner) / depth;
  const merge = (children) => children.length <= 6 ? children : children.slice(0, 5).concat([{ label: "기타", value: children.slice(5).reduce((s, node) => s + node.value, 0), children: [] }]);
  const first = merge(root.children);
  let body = "";
  const draw = (children, total, a0, a1, level, colorIndex) => {
    let angle = a0;
    merge(children).forEach((node, i, siblings) => {
      const end = i === siblings.length - 1 ? a1 : angle + node.value / total * (a1 - a0);
      const ci = level === 1 ? i : colorIndex, color = C.color(pal, ci), r0 = inner + (level - 1) * band, r1 = node.children.length ? inner + level * band : outer;
      const fill = 'color-mix(in srgb,' + color + ' ' + (58 - level * 10) + '%,var(--color-surface))';
      body += '<g><title>' + C.esc(node.label + ': ' + C.fmt(node.value, unit)) + '</title><path class="chfl-ring-' + level + '" d="' + C.arc(cx, cy, r0, r1, angle, end) + '" fill="' + fill + '" stroke="var(--color-surface)" stroke-width="2"/>';
      const mid = (angle + end) / 2, radius = (r0 + r1) / 2, span = end - angle;
      // Text is horizontal. Its whole bounding box must fit in the annular sector.
      const tw = C.textW(node.label, 11), half = Math.hypot(tw / 2 + 3, 9);
      if (half < (r1 - r0) / 2 && half < radius * Math.sin(Math.min(Math.PI / 2, span / 2))) body += C.text(cx + radius * Math.cos(mid), cy + radius * Math.sin(mid), node.label, 11, { anchor: "middle", weight: 600 });
      body += '</g>';
      if (node.children.length) draw(node.children, node.value, angle, end, level + 1, ci);
      angle = end;
    });
  };
  draw(first, root.value, -Math.PI / 2, Math.PI * 1.5, 1, 0);
  const totalText = chflFit(C, C.fmt(root.value, unit), 72, 17);
  body += C.text(cx, cy - 6, totalText, 17, { anchor: "middle", weight: 750 }) + C.text(cx, cy + 15, chflFit(C, root.label, 68, 11), 11, { anchor: "middle", cls: "vk-tick" });
  const rows = [];
  const collect = (node, path) => { const label = path ? path + ' / ' + node.label : node.label; if (node.children.length) node.children.forEach((child) => collect(child, label)); else rows.push([label, C.fmt(node.value, unit)]); };
  root.children.forEach((node) => collect(node, ""));
  const top = first.reduce((a, b) => a.value >= b.value ? a : b);
  return { w: W, h: H, body, legend: C.legend(first.map((node) => node.label), pal), desc: root.label + ' 합계는 ' + C.fmt(root.value, unit) + '이고, ' + top.label + '이(가) 가장 커요.', table: C.table(h.str(d.title, "선버스트", 80), ["경로", "값"], rows) };
}
registerComponent({
  id: "chart-sunburst", family: "chart", name: "선버스트",
  description: "Sunburst with two or three hierarchical rings; tree: {label, children:[{label, value | children}]}, internal totals sum children and more than six siblings merge into 기타.",
  schema: { type: "object", $defs: { node: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } }, properties: { ...chflProps, tree: { type: "object", properties: { label: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } }, required: ["tree"] },
  presets: chflPresets, defaults: { tree: {} },
  sample: { title: "콘텐츠 이용 비중", subtitle: "안쪽은 분야, 바깥쪽은 세부 콘텐츠입니다.", tree: { label: "전체 이용", children: [{ label: "학습", children: [{ label: "강의", value: 320 }, { label: "문제집", value: 180 }] }, { label: "업무", children: [{ label: "문서", value: 240 }, { label: "회의", value: 160 }] }, { label: "생활", children: [{ label: "일기", value: 120 }, { label: "계획", value: 80 }] }] }, caption: "각 부채꼴의 각도는 이용 횟수에 비례합니다." },
  slash: { label: "선버스트", hint: "동심원으로 계층 비중", ico: "◉", aliases: "선버스트 계층 원형 sunburst hierarchy rings" }, css: "",
  render(d, h) { return chflFigure("sunburst", "선버스트", d, h, chflSunburst); },
});

function chflWaterfall(d, h, W, H) {
  const C = h.chart, unit = h.str(d.unit, "", 8), pal = C.palette(d.palette);
  const steps = h.list(d.steps, 32).filter((it) => it && typeof it === "object" && C.num(it.value) !== null).map((it, i) => ({ label: h.str(it.label, "단계 " + (i + 1), 60), value: C.num(it.value), kind: h.oneOf(it.kind, ["total", "change"], "change") }));
  if (!steps.length) return null;
  let current = 0;
  const bars = steps.map((it) => { const from = it.kind === "total" ? 0 : current; current = it.kind === "total" ? it.value : current + it.value; return { ...it, from, to: current }; });
  if (bars.some((it) => !Number.isFinite(it.to))) return null;
  const lo = Math.min(0, ...bars.flatMap((it) => [it.from, it.to])), hi = Math.max(0, ...bars.flatMap((it) => [it.from, it.to]));
  const ax = C.axes(steps.map((it) => it.label), lo, hi === lo ? lo + 1 : hi, { unit, w: W, h: H });
  const bw = ax.step * 0.62;
  let body = ax.svg;
  bars.forEach((it, i) => {
    if (i < bars.length - 1) body += '<line class="vk-base chfl-connector" x1="' + C.round(ax.x(i) + bw / 2) + '" x2="' + C.round(ax.x(i + 1) - bw / 2) + '" y1="' + C.round(ax.y(it.to)) + '" y2="' + C.round(ax.y(it.to)) + '" stroke-dasharray="3 3"/>';
    const color = it.kind === "total" ? C.color(pal, 0) : pal === "mono" ? C.color(pal, it.value < 0 ? 2 : 1) : it.value < 0 ? 'var(--viz-down)' : 'var(--viz-up)';
    const value = (it.kind !== "total" && it.value > 0 ? '+' : '') + C.fmt(it.value, unit);
    const top = Math.min(ax.y(it.from), ax.y(it.to)), height = Math.abs(ax.y(it.from) - ax.y(it.to));
    body += chflRect(C, ax.x(i) - bw / 2, top, bw, height, color, it.label + ': ' + value + ' · 누계 ' + C.fmt(it.to, unit), "chfl-bar");
    if (C.textW(value, 11) <= ax.step - 4) body += C.text(ax.x(i), it.value < 0 && it.kind !== "total" ? Math.min(ax.bottom - 8, top + height + 12) : Math.max(7, top - 10), value, 11, { anchor: "middle", cls: "vk-val" });
  });
  const legend = '<ul class="vk-legend" aria-hidden="true"><li><i style="background:' + (pal === "mono" ? C.color(pal, 1) : 'var(--viz-up)') + '"></i>증가 (+)</li><li><i style="background:' + (pal === "mono" ? C.color(pal, 2) : 'var(--viz-down)') + '"></i>감소 (−)</li><li><i style="background:' + C.color(pal, 0) + '"></i>합계</li></ul>';
  return { w: W, h: H, body, legend, desc: steps.length + '단계를 거친 최종 합계는 ' + C.fmt(current, unit) + '예요.', table: C.table(h.str(d.title, "워터폴", 80), ["단계", "종류", "값", "누계"], bars.map((it) => [it.label, it.kind === "total" ? "합계" : "변화", C.fmt(it.value, unit), C.fmt(it.to, unit)])) };
}
registerComponent({
  id: "chart-waterfall", family: "chart", name: "워터폴",
  description: "Waterfall of cumulative changes; steps: [{label, value, kind?: total|change}], total bars reset the running value and start at zero, while signed changes float with connectors.",
  schema: { type: "object", properties: { ...chflProps, steps: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, kind: { type: "string", enum: ["total", "change"] } }, required: ["label", "value"] } } }, required: ["steps"] },
  presets: chflPresets, defaults: { steps: [] },
  sample: { title: "비용 변화", subtitle: "전월 대비 비용 증감 내역입니다.", steps: [{ label: "기초 비용", value: 750, kind: "total" }, { label: "마케팅", value: 120 }, { label: "서버비", value: -80 }, { label: "인건비", value: 150 }, { label: "기타", value: -60 }, { label: "최종 비용", value: 880, kind: "total" }], caption: "비용 (단위: 만원)" },
  slash: { label: "워터폴", hint: "합계까지 증감 추적", ico: "▥", aliases: "워터폴 폭포 증감 비용 waterfall bridge change" }, css: "",
  render(d, h) { return chflFigure("waterfall", "워터폴", d, h, chflWaterfall); },
});

function chflDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp / 86400000 : null;
}
function chflGantt(d, h, W, H) {
  const C = h.chart, pal = C.palette(d.palette);
  const tasks = h.list(d.tasks, 12).filter((it) => it && typeof it === "object").map((it, i) => ({ label: h.str(it.label, "작업 " + (i + 1), 60), start: chflDay(it.start), end: chflDay(it.end), group: h.str(it.group, "작업", 40), done: it.done === true })).filter((it) => it.start !== null && it.end !== null && it.end >= it.start);
  if (!tasks.length) return null;
  const lo = Math.min(...tasks.map((it) => it.start)), hi = Math.max(...tasks.map((it) => it.end)) + 1;
  const left = Math.min(W * 0.32, Math.max(72, ...tasks.map((it) => C.textW(it.label, 12) + 24))), right = W - 12, top = 40, bottom = H - 30;
  const x = C.scale(lo, hi, left, right), rowH = (bottom - top) / tasks.length, barH = Math.min(25, rowH - 6), groups = [...new Set(tasks.map((it) => it.group))];
  const first = new Date(lo * 86400000), last = new Date((hi - 1) * 86400000);
  const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
  const every = Math.max(1, Math.ceil(months / Math.max(1, Math.floor((right - left) / 72))));
  let body = '';
  for (let i = 0; i < months; i += every) {
    const month = new Date(lo * 86400000);
    month.setUTCDate(1); month.setUTCMonth(month.getUTCMonth() + i);
    const day = Math.max(lo, month.getTime() / 86400000), tx = x(day);
    body += '<line class="vk-grid" x1="' + C.round(tx) + '" x2="' + C.round(tx) + '" y1="32" y2="' + bottom + '"/>';
    const label = month.getUTCFullYear() + '.' + String(month.getUTCMonth() + 1).padStart(2, '0');
    if (tx + C.textW(label, 11) < right + 2) body += C.text(tx + 2, 19, label, 11, { cls: "vk-tick" });
  }
  const date = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
  tasks.forEach((it, i) => {
    const y = top + rowH * (i + 0.5), title = it.label + ' · ' + date(it.start) + ' ~ ' + date(it.end) + (it.done ? ' · 완료' : ' · 진행 중');
    body += '<line class="vk-grid" x1="' + left + '" x2="' + right + '" y1="' + C.round(y + rowH / 2) + '" y2="' + C.round(y + rowH / 2) + '"/>';
    body += '<g><title>' + C.esc(title) + '</title>' + C.text(left - 10, y, chflFit(C, (it.done ? '✓ ' : '') + it.label, left - 14, 12), 12, { anchor: "end", cls: "vk-tick" }) + '</g>';
    body += chflRect(C, x(it.start), y - barH / 2, x(it.end + 1) - x(it.start), barH, C.color(pal, groups.indexOf(it.group)), title, "chfl-task");
    if (it.done && x(it.end + 1) - x(it.start) >= 26) body += C.text(x(it.start) + 12, y, '✓', 12, { anchor: "middle", fill: "var(--color-surface)", weight: 700 });
  });
  // Explicit date keeps server rendering deterministic; callers supply their local today's date.
  const today = chflDay(d.today);
  if (today !== null && today >= lo && today < hi) body += '<line class="chfl-today" x1="' + C.round(x(today)) + '" x2="' + C.round(x(today)) + '" y1="32" y2="' + bottom + '" stroke="var(--viz-down)" stroke-width="1.5" stroke-dasharray="4 3"><title>' + C.esc('오늘: ' + date(today)) + '</title></line>' + C.text(Math.min(right, Math.max(left + 14, x(today))), H - 12, "오늘", 11, { anchor: "middle", fill: "var(--viz-down)" });
  return { w: W, h: H, body, legend: C.legend(groups, pal), desc: date(lo) + '부터 ' + date(hi - 1) + '까지 ' + tasks.length + '개 작업 중 ' + tasks.filter((it) => it.done).length + '개를 완료했어요.', table: C.table(h.str(d.title, "간트 차트", 80), ["작업", "시작", "종료", "그룹", "상태"], tasks.map((it) => [it.label, date(it.start), date(it.end), it.group, it.done ? "완료" : "진행 중"])) };
}
registerComponent({
  id: "chart-gantt", family: "chart", name: "간트 차트",
  description: "Gantt schedule with month ticks and inclusive end dates; tasks: [{label, start, end (YYYY-MM-DD), group?, done?}], today?: YYYY-MM-DD adds a deterministic today marker.",
  schema: { type: "object", properties: { ...chflProps, today: { type: "string", format: "date" }, tasks: { type: "array", items: { type: "object", properties: { label: { type: "string" }, start: { type: "string", format: "date" }, end: { type: "string", format: "date" }, group: { type: "string" }, done: { type: "boolean" } }, required: ["label", "start", "end"] } } }, required: ["tasks"] },
  presets: chflPresets, defaults: { tasks: [] },
  sample: { title: "신제품 출시 일정", subtitle: "기획부터 출시까지 팀별 작업 일정입니다.", tasks: [{ label: "사용자 조사", start: "2026-09-01", end: "2026-09-20", group: "기획", done: true }, { label: "제품 설계", start: "2026-09-15", end: "2026-10-10", group: "디자인", done: true }, { label: "핵심 기능 개발", start: "2026-10-01", end: "2026-11-10", group: "개발" }, { label: "사용성 검증", start: "2026-10-25", end: "2026-11-20", group: "디자인" }, { label: "정식 출시", start: "2026-11-21", end: "2026-11-30", group: "개발" }], today: "2026-10-23", caption: "종료일을 포함한 일정 · 체크 표시는 완료한 작업" },
  slash: { label: "간트 차트", hint: "날짜별 작업 일정", ico: "▤", aliases: "간트 일정 프로젝트 작업 gantt timeline schedule" }, css: "",
  render(d, h) { return chflFigure("gantt", "간트 차트", d, h, chflGantt); },
});
