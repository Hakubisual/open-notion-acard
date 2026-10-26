import { registerComponent } from "../component-registry.js";

const chshItemsSchema = { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number", minimum: 0 } }, required: ["label", "value"] } };

function chshGaugeBody(value, min, max, target, d, h) {
  const C = h.chart, pal = C.palette(d.palette), unit = h.str(d.unit, "", 8);
  const fraction = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const thresholds = h.list(d.thresholds, 2).map(C.num);
  const limits = thresholds.length === 2 && thresholds.every((v) => v !== null) && thresholds[0] <= thresholds[1] ? thresholds : [min + (max - min) * 0.4, min + (max - min) * 0.8];
  const color = pal === "mono" ? C.color(pal, 0) : value < limits[0] ? "var(--viz-down)" : value < limits[1] ? C.color(pal, 0) : "var(--viz-up)";
  const cx = 180, cy = 188, R = 152;
  let body = '<path d="' + C.arc(cx, cy, 122, R, Math.PI, Math.PI * 2) + '" fill="var(--viz-grid)"/>';
  if (fraction > 0) body += '<path class="chsh-gauge-value" d="' + C.arc(cx, cy, 122, R, Math.PI, Math.PI + fraction * Math.PI) + '" fill="' + color + '"><title>' + C.esc(C.fmt(value, unit)) + "</title></path>";
  if (target !== null && target >= min && target <= max) {
    const angle = Math.PI + (target - min) / (max - min) * Math.PI;
    body += '<line class="chsh-gauge-target" x1="' + C.round(cx + 116 * Math.cos(angle)) + '" y1="' + C.round(cy + 116 * Math.sin(angle)) + '" x2="' + C.round(cx + 158 * Math.cos(angle)) + '" y2="' + C.round(cy + 158 * Math.sin(angle)) + '" stroke="var(--color-text)" stroke-width="2"><title>' + C.esc("목표 " + C.fmt(target, unit)) + "</title></line>";
  }
  const text = C.fmt(value, unit), font = Math.max(18, Math.min(46, 200 / Math.max(1, C.textW(text, 1))));
  body += C.text(cx, 143, text, font, { anchor: "middle", weight: 750 });
  body += chshLabel(C, cx, 176, h.str(d.label, "목표 달성률", 80), 216, { anchor: "middle", cls: "vk-tick" });
  body += C.text(cx - R, 211, C.fmt(min, unit), 12, { anchor: "start", cls: "vk-tick" }) + C.text(cx + R, 211, C.fmt(max, unit), 12, { anchor: "end", cls: "vk-tick" });
  if (target !== null) body += C.text(cx, 237, h.t("목표 ", "Target ") + C.fmt(target, unit), 12, { anchor: "middle", cls: "vk-tick" });
  return { w: 360, h: 256, body };
}

registerComponent({
  id: "chart-gauge", family: "chart", name: "게이지 그래프",
  description: "Semicircle gauge with value, min (default 0), max (default 100), optional target tick and label; thresholds: [low, high] sets red, accent, green bands, defaulting to 40% and 80% of the range.",
  schema: { type: "object", properties: { value: { type: "number" }, min: { type: "number" }, max: { type: "number" }, target: { type: "number" }, label: { type: "string" }, thresholds: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } } }, required: ["value"] },
  presets: { paper: { palette: "mono", figure: true }, report: { compact: true }, friendly: {}, showcase: { height: "l" } },
  defaults: { value: null, min: 0, max: 100 },
  sample: { title: "목표 달성률", subtitle: "연간 목표 대비 현재 달성 현황입니다.", value: 72, target: 85, unit: "%", label: "목표 달성률", caption: "연간 목표와 현재 실적" },
  slash: { label: "게이지 그래프", hint: "목표 대비 달성률", ico: "◠", aliases: "게이지 목표 달성률 반원 gauge meter goal chart" },
  css: ".ui-chart-gauge .vk-svg{max-width:520px;margin:0 auto}",
  render(d, h) {
    const C = h.chart, value = C.num(d.value), min = C.num(d.min) ?? 0, max = C.num(d.max) ?? 100, target = C.num(d.target), unit = h.str(d.unit, "", 8);
    if (value === null || max <= min) return C.figure("gauge", d, h, { empty: C.EMPTY });
    return C.figure("gauge", d, h, { ...chshGaugeBody(value, min, max, target, d, h), label: "게이지 그래프", desc: "현재 " + C.fmt(value, unit) + ", 범위 " + C.fmt(min, unit) + "부터 " + C.fmt(max, unit) + (target !== null ? ", 목표 " + C.fmt(target, unit) : "") + "입니다.", table: C.table(h.str(d.title, "게이지 그래프", 80), ["항목", "현재", "최솟값", "최댓값", "목표"], [[h.str(d.label, "달성률", 80), C.fmt(value, unit), C.fmt(min, unit), C.fmt(max, unit), C.fmt(target, unit)]]) });
  },
});

function chshFunnelBody(stages, d, h, W) {
  const C = h.chart, unit = h.str(d.unit, "", 8), pal = C.palette(d.palette), narrow = W < 520;
  const width = narrow ? 174 : 330, cx = narrow ? 97 : 190, countX = narrow ? 255 : 475, H = stages.length * 66 + 32;
  const widths = stages.map((s) => width * Math.sqrt(s.value / stages[0].value));
  let body = C.text(countX, 12, h.t("인원", "Count") + (unit ? " (" + unit + ")" : ""), 12, { anchor: "end", cls: "vk-tick" }) + C.text(W - 10, 12, h.t("이전 대비", "vs. previous"), 12, { anchor: "end", cls: "vk-tick" });
  stages.forEach((s, i) => {
    const y = 30 + i * 66, top = widths[i], bottom = i + 1 < stages.length ? widths[i + 1] : top * 0.7;
    const conversion = i === 0 ? null : stages[i - 1].value > 0 ? s.value / stages[i - 1].value * 100 : null;
    body += chshLabel(C, cx, y + 3, s.label, width, { anchor: "middle", cls: "vk-tick" });
    body += '<polygon class="chsh-funnel-stage" points="' + [cx - top / 2, y + 16, cx + top / 2, y + 16, cx + bottom / 2, y + 50, cx - bottom / 2, y + 50].map(C.round).reduce((text, v, k) => text + (k ? k % 2 ? "," : " " : "") + v, "") + '" fill="' + C.color(pal, i) + '"><title>' + C.esc(s.label + ": " + C.fmt(s.value, unit)) + "</title></polygon>";
    body += C.text(countX, y + 33, C.fmt(s.value), 14, { anchor: "end", weight: 650 }) + C.text(W - 10, y + 33, C.fmt(conversion, "%"), 12, { anchor: "end", cls: "vk-tick" });
  });
  return { w: W, h: H, body };
}

registerComponent({
  id: "chart-funnel", family: "chart", name: "퍼널 그래프",
  description: "Funnel of stages: [{label, value}] in non-increasing order (up to eight), with narrowing trapezoids, counts and conversion percentages relative to the previous stage; zero-denominator conversion is undefined.",
  schema: { type: "object", properties: { stages: { ...chshItemsSchema, maxItems: 8 } }, required: ["stages"] },
  presets: { paper: { palette: "mono", figure: true }, report: { compact: true }, friendly: {}, showcase: { height: "l" } },
  defaults: { stages: [] },
  sample: { title: "가입 퍼널", subtitle: "각 단계별 전환율을 확인합니다.", stages: [{ label: "웹사이트 방문", value: 12480 }, { label: "회원가입 클릭", value: 5420 }, { label: "정보 입력", value: 2980 }, { label: "가입 완료", value: 1820 }], unit: "명", caption: "전환율은 바로 이전 단계 대비 비율입니다." },
  slash: { label: "퍼널 그래프", hint: "단계별 인원과 전환율", ico: "▽", aliases: "퍼널 깔때기 전환율 단계 funnel conversion chart" },
  css: ".ui-chart-funnel .vk-svg{max-height:none}",
  render(d, h) {
    const C = h.chart, stages = chshItems(h.list(d.stages, 8), h), unit = h.str(d.unit, "", 8);
    if (!stages.length || !stages[0].value || stages.some((s, i) => i > 0 && s.value > stages[i - 1].value)) return C.figure("funnel", d, h, { empty: C.EMPTY });
    const wide = chshFunnelBody(stages, d, h, 640), narrow = chshFunnelBody(stages, d, h, 360), last = stages[stages.length - 1];
    return C.figure("funnel", d, h, { ...wide, narrow, label: "퍼널 그래프", desc: stages[0].label + " " + C.fmt(stages[0].value, unit) + " 중 " + last.label + " " + C.fmt(last.value, unit) + "으로 전체 전환율은 " + C.fmt(last.value / stages[0].value * 100, "%") + "입니다.", table: C.table(h.str(d.title, "퍼널 그래프", 80), ["단계", "값", "이전 단계 대비 전환율"], stages.map((s, i) => [s.label, C.fmt(s.value, unit), C.fmt(i > 0 && stages[i - 1].value > 0 ? s.value / stages[i - 1].value * 100 : null, "%")])) });
  },
});

function chshItems(value, h) {
  const C = h.chart;
  return h.list(value, 48).filter((it) => it && typeof it === "object").map((it, i) => ({ label: h.str(it.label, "항목 " + (i + 1), 80), value: C.num(it.value) })).filter((it) => it.value !== null && it.value >= 0);
}

function chshLabel(C, x, y, label, width, opts) {
  let clipped = label;
  while (C.textW(clipped, 12) > width && [...clipped].length > 2) clipped = C.clip(clipped, [...clipped].length - 1);
  return "<g><title>" + C.esc(label) + "</title>" + C.text(x, y, clipped, 12, opts) + "</g>";
}

function chshPieBody(items, total, d, h, W, H) {
  const C = h.chart, pal = C.palette(d.palette), unit = h.str(d.unit, "", 8);
  const cx = W / 2, cy = H / 2, R = W < 520 ? 96 : 124;
  const labels = [];
  let angle = -Math.PI / 2, body = "";
  items.forEach((it, i) => {
    const share = it.value / total, end = angle + share * Math.PI * 2, mid = (angle + end) / 2;
    body += '<path class="chsh-slice" d="' + C.arc(cx, cy, 0, R, angle, end) + '" fill="' + C.color(pal, i) + '" stroke="var(--color-surface)" stroke-width="2"><title>' + C.esc(it.label + ": " + C.fmt(it.value, unit) + " (" + C.fmt(share * 100, "%") + ")") + "</title></path>";
    if (share >= 0.08) body += C.text(cx + R * 0.62 * Math.cos(mid), cy + R * 0.62 * Math.sin(mid), C.fmt(share * 100, "%"), 12, { anchor: "middle", fill: "var(--color-surface)", weight: 650 });
    else labels.push({ label: it.label + " " + C.fmt(share * 100, "%"), mid, side: Math.cos(mid) >= 0 ? 1 : -1, y: cy + (R + 16) * Math.sin(mid) });
    angle = end;
  });
  // Small neighboring slices keep their angular order, but their labels get a full line each.
  for (const side of [-1, 1]) {
    const group = labels.filter((l) => l.side === side).sort((a, b) => a.y - b.y);
    group.forEach((l, i) => { l.y = Math.max(18, l.y, i ? group[i - 1].y + 24 : 18); });
    if (group.length) {
      group[group.length - 1].y = Math.min(H - 18, group[group.length - 1].y);
      for (let i = group.length - 2; i >= 0; i -= 1) group[i].y = Math.min(group[i].y, group[i + 1].y - 24);
    }
    for (const l of group) {
      const x = cx + side * (R + 14);
      body += '<polyline points="' + C.round(cx + R * Math.cos(l.mid)) + "," + C.round(cy + R * Math.sin(l.mid)) + " " + C.round(x - side * 5) + "," + C.round(l.y) + " " + C.round(x) + "," + C.round(l.y) + '" fill="none" class="vk-base"/>';
      body += chshLabel(C, x + side * 4, l.y, l.label, W / 2 - R - 22, { anchor: side > 0 ? "start" : "end", cls: "vk-tick" });
    }
  }
  return { w: W, h: H, body };
}

registerComponent({
  id: "chart-pie", family: "chart", name: "파이 그래프",
  description: "Pie chart without a hole for items: [{label, value}]; at most six visible slices including 기타, with small shares labeled outside and original values in the data table.",
  schema: { type: "object", properties: { items: chshItemsSchema }, required: ["items"] },
  presets: { paper: { palette: "mono", figure: true }, report: { compact: true }, friendly: {}, showcase: { height: "l" } },
  defaults: { items: [] },
  sample: { title: "유입 채널 비중", subtitle: "전체 방문자 중 각 채널의 비중입니다.", items: [{ label: "검색", value: 5242 }, { label: "SNS", value: 3494 }, { label: "광고", value: 2496 }, { label: "추천", value: 998 }, { label: "이메일", value: 250 }], unit: "명", caption: "채널별 방문자 비중" },
  slash: { label: "파이 그래프", hint: "전체를 나눈 비중", ico: "◕", aliases: "파이 원그래프 비중 점유율 pie chart share" },
  css: "",
  render(d, h) {
    const C = h.chart, rows = chshItems(d.items, h), positive = rows.filter((it) => it.value > 0);
    const items = positive.length > 6 ? positive.slice(0, 5).concat([{ label: "기타", value: positive.slice(5).reduce((sum, it) => sum + it.value, 0) }]) : positive;
    const total = items.reduce((sum, it) => sum + it.value, 0);
    if (!total || !Number.isFinite(total)) return C.figure("pie", d, h, { empty: C.EMPTY });
    const unit = h.str(d.unit, "", 8), top = items.reduce((a, b) => a.value > b.value ? a : b);
    const wide = chshPieBody(items, total, d, h, 640, 320), narrow = chshPieBody(items, total, d, h, 360, 300);
    return C.figure("pie", d, h, { ...wide, narrow, label: "파이 그래프", legend: C.legend(items.map((it) => it.label), C.palette(d.palette)), desc: "전체 " + C.fmt(total, unit) + " 중 " + top.label + "이(가) " + C.fmt(top.value / total * 100, "%") + "로 가장 커요.", table: C.table(h.str(d.title, "파이 그래프", 80), ["항목", "값", "비중"], rows.map((it) => [it.label, C.fmt(it.value, unit), C.fmt(it.value / total * 100, "%")])) });
  },
});

function chshRadarBody(labels, series, max, d, h, W, H) {
  const C = h.chart, pal = C.palette(d.palette), cx = W / 2, cy = H / 2, R = W < 520 ? 78 : 118;
  const point = (i, value) => { const angle = i * Math.PI * 2 / labels.length - Math.PI / 2; return [cx + R * value / max * Math.cos(angle), cy + R * value / max * Math.sin(angle)]; };
  const points = (values) => values.map((v, i) => point(i, v).map(C.round).join(",")).join(" ");
  let body = "";
  for (let ring = 1; ring <= 4; ring += 1) body += '<polygon class="vk-grid" points="' + points(labels.map(() => max * ring / 4)) + '" fill="none"/>';
  labels.forEach((label, i) => {
    const p = point(i, max), angle = i * Math.PI * 2 / labels.length - Math.PI / 2;
    const x = cx + (R + 22) * Math.cos(angle), y = cy + (R + 22) * Math.sin(angle), side = Math.cos(angle);
    const anchor = Math.abs(side) < 0.15 ? "middle" : side > 0 ? "start" : "end";
    body += '<line class="vk-grid" x1="' + cx + '" y1="' + cy + '" x2="' + C.round(p[0]) + '" y2="' + C.round(p[1]) + '"/>';
    body += chshLabel(C, x, y, label, anchor === "middle" ? 100 : Math.min(x, W - x) - 8, { anchor, cls: "vk-tick" });
  });
  series.forEach((s, si) => {
    const color = C.color(pal, si);
    body += '<polygon class="chsh-radar-series" points="' + points(s.data) + '" fill="' + color + '" fill-opacity=".16" stroke="' + color + '" stroke-width="2"' + C.dash(pal, si) + "><title>" + C.esc(s.name) + "</title></polygon>";
    s.data.forEach((v, i) => {
      const p = point(i, v);
      body += '<circle cx="' + C.round(p[0]) + '" cy="' + C.round(p[1]) + '" r="3" fill="' + color + '"><title>' + C.esc(labels[i] + " · " + s.name + ": " + C.fmt(v, h.str(d.unit, "", 8))) + "</title></circle>";
    });
  });
  for (let ring = 1; ring <= 4; ring += 1) body += C.text(cx + 8, cy - R * ring / 4, C.fmt(max * ring / 4), 11, { cls: "vk-tick" });
  return { w: W, h: H, body };
}

registerComponent({
  id: "chart-radar", family: "chart", name: "레이더 그래프",
  description: "Radar comparison with labels: [axes], series: [{name, data}] (up to three complete nonnegative series, three to twelve axes), optional max shared scale, and translucent polygons on a ring grid.",
  schema: { type: "object", properties: { labels: { type: "array", minItems: 3, maxItems: 12, items: { type: "string" } }, series: { type: "array", maxItems: 3, items: { type: "object", properties: { name: { type: "string" }, data: { type: "array", items: { type: "number", minimum: 0 } } }, required: ["data"] } }, max: { type: "number", exclusiveMinimum: 0 } }, required: ["labels", "series"] },
  presets: { paper: { palette: "mono", figure: true }, report: { compact: true }, friendly: {}, showcase: { height: "l" } },
  defaults: { labels: [], series: [] },
  sample: { title: "역량 비교", subtitle: "팀원들의 역량을 항목별로 비교합니다.", labels: ["기획력", "커뮤니케이션", "문제해결력", "전문지식", "실행력", "창의력"], series: [{ name: "김서연", data: [82, 74, 68, 80, 70, 64] }, { name: "이준호", data: [76, 54, 88, 72, 84, 76] }], max: 100, unit: "점", caption: "역량 평가 (단위: 점)" },
  slash: { label: "레이더 그래프", hint: "여러 항목의 역량 비교", ico: "⬡", aliases: "레이더 방사형 역량 비교 radar spider chart" },
  css: "",
  render(d, h) {
    const C = h.chart, parsed = C.series({ ...d, labels: h.list(d.labels, 12) }, h, 3);
    const labels = parsed.labels, series = parsed.series.filter((s) => s.data.every((v) => v !== null && v >= 0));
    if (labels.length < 3 || !series.length) return C.figure("radar", d, h, { empty: C.EMPTY });
    const observed = Math.max(...series.flatMap((s) => s.data)), requested = C.num(d.max);
    const max = Math.max(observed, requested > 0 ? requested : C.ticks(0, observed || 1, 4).at(-1));
    const unit = h.str(d.unit, "", 8), wide = chshRadarBody(labels, series, max, d, h, 640, 320), narrow = chshRadarBody(labels, series, max, d, h, 360, 300);
    return C.figure("radar", d, h, { ...wide, narrow, label: "레이더 그래프", legend: C.legend(series.map((s) => s.name), C.palette(d.palette)), desc: C.finding(labels, series[0], unit) + " 공통 최댓값은 " + C.fmt(max, unit) + "입니다.", table: C.table(h.str(d.title, "레이더 그래프", 80), ["항목", ...series.map((s) => s.name)], labels.map((label, i) => [label, ...series.map((s) => C.fmt(s.data[i], unit))])) });
  },
});
