import { registerComponent } from "../component-registry.js";

const chstPresets = { paper: { palette: "mono", figure: true }, report: { figure: false, compact: true }, friendly: {}, showcase: { height: "l" } };
const chstProps = {
  title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, source: { type: "string" }, unit: { type: "string" },
  figure: { type: "boolean" }, palette: { type: "string", enum: ["acard", "colorblind", "mono"] }, height: { type: "string", enum: ["s", "m", "l"] },
  preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] },
  xTitle: { type: "string" }, yTitle: { type: "string" }, xUnit: { type: "string" }, yUnit: { type: "string" },
};
const chstPointsSchema = { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, r: { type: "number", minimum: 0 }, label: { type: "string" }, group: { type: "string" } }, required: ["x", "y"] } };

function chstTitle(d, h, axis, fallback, unit) {
  return h.str(d[axis + "Title"], fallback, 60) + (unit ? " (" + unit + ")" : "");
}

function chstText(C, x, y, text, width, opts) {
  let clipped = text;
  while (clipped.length > 1 && C.textW(clipped, 12) > width) clipped = C.clip(clipped, [...clipped].length - 1);
  return "<g><title>" + C.esc(text) + "</title>" + C.text(x, y, clipped, 12, opts) + "</g>";
}

// Continuous axes need edge ticks rather than the category centers returned by chart.axes.
function chstAxes(C, W, H, xs, ys, xTitle, yTitle, categories) {
  const left = Math.max(46, Math.ceil(Math.max(...ys.map((v) => C.textW(C.fmt(v), 12)))) + 38);
  const right = 26, top = 30, bottom = H - 58;
  const x = C.scale(xs[0], xs[xs.length - 1], left, W - right), y = C.scale(ys[0], ys[ys.length - 1], bottom, top);
  let svg = "";
  for (const v of ys) svg += '<line class="vk-grid" x1="' + left + '" x2="' + (W - right) + '" y1="' + C.round(y(v)) + '" y2="' + C.round(y(v)) + '"/>' + C.text(left - 8, y(v), C.fmt(v), 12, { anchor: "end", cls: "vk-tick" });
  if (categories) {
    const step = (W - right - left) / categories.length;
    const every = Math.max(1, Math.ceil(40 / step));
    categories.forEach((label, i) => {
      if (i % every === 0) svg += chstText(C, x(i + 0.5), bottom + 18, label, step * every - 8, { anchor: "middle", cls: "vk-tick" });
    });
  } else {
    const width = Math.max(...xs.map((v) => C.textW(C.fmt(v), 12))) + 14;
    const every = Math.max(1, Math.ceil(width / ((W - right - left) / Math.max(1, xs.length - 1))));
    xs.forEach((v, i) => {
      svg += '<line class="vk-grid" x1="' + C.round(x(v)) + '" x2="' + C.round(x(v)) + '" y1="' + top + '" y2="' + bottom + '"/>';
      if (i % every === 0 && (i === xs.length - 1 || i < xs.length - every)) svg += C.text(x(v), bottom + 18, C.fmt(v), 12, { anchor: i === 0 ? "start" : "middle", cls: "vk-tick" });
    });
    if ((xs.length - 1) % every !== 0) svg += C.text(x(xs[xs.length - 1]), bottom + 18, C.fmt(xs[xs.length - 1]), 12, { anchor: "end", cls: "vk-tick" });
  }
  svg += '<line class="vk-base" x1="' + left + '" x2="' + (W - right) + '" y1="' + bottom + '" y2="' + bottom + '"/>';
  svg += chstText(C, (left + W - right) / 2, H - 12, xTitle, W - left - right, { anchor: "middle", cls: "vk-axis-title" });
  svg += '<g transform="translate(12 ' + C.round((top + bottom) / 2) + ') rotate(-90)">' + chstText(C, 0, 0, yTitle, bottom - top, { anchor: "middle", cls: "vk-axis-title" }) + "</g>";
  return { x, y, left, right, top, bottom, svg };
}

function chstRange(C, values, count, pad) {
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || Math.max(1, Math.abs(lo) * 0.2);
  return C.ticks(lo - span * pad, hi + span * pad, count);
}

function chstPoints(d, h, bubble) {
  const C = h.chart;
  return h.list(d.points, 500).filter((p) => p && typeof p === "object").map((p, i) => ({
    x: C.num(p.x), y: C.num(p.y), r: C.num(p.r), label: h.str(p.label, "관측 " + (i + 1), 60), group: h.str(p.group, "관측값", 40),
  })).filter((p) => p.x !== null && p.y !== null && (!bubble || (p.r !== null && p.r >= 0)));
}

function chstPointBody(d, h, W, H, bubble) {
  const C = h.chart, points = chstPoints(d, h, bubble);
  if (!points.length) return null;
  const xUnit = h.str(d.xUnit, "", 12), yUnit = h.str(d.yUnit, h.str(d.unit, "", 12), 12);
  const xTitle = chstTitle(d, h, "x", "X", xUnit), yTitle = chstTitle(d, h, "y", "Y", yUnit);
  const xs = chstRange(C, points.map((p) => p.x), W < 400 ? 3 : 5, bubble ? 0.2 : 0.06);
  const ys = chstRange(C, points.map((p) => p.y), 4, bubble ? 0.2 : 0.06);
  const ax = chstAxes(C, W, H, xs, ys, xTitle, yTitle), pal = C.palette(d.palette);
  const groups = [...new Set(points.map((p) => p.group))];
  let body = ax.svg;
  if (!bubble && d.trend === true && points.length > 1) {
    const mx = points.reduce((s, p) => s + p.x / points.length, 0), my = points.reduce((s, p) => s + p.y / points.length, 0);
    const xx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    if (xx > 0) {
      const slope = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / xx;
      let a = Math.min(...points.map((p) => p.x)), b = Math.max(...points.map((p) => p.x));
      if (slope !== 0) {
        const u = mx + (ys[0] - my) / slope, v = mx + (ys[ys.length - 1] - my) / slope;
        a = Math.max(a, Math.min(u, v)); b = Math.min(b, Math.max(u, v));
      }
      body += '<line class="vk-chst-trend" x1="' + C.round(ax.x(a)) + '" y1="' + C.round(ax.y(my + slope * (a - mx))) + '" x2="' + C.round(ax.x(b)) + '" y2="' + C.round(ax.y(my + slope * (b - mx))) + '" stroke="var(--viz-ink-2)" stroke-width="1.5" stroke-dasharray="6 4"><title>최소제곱 추세선</title></line>';
    }
  }
  const maxSize = Math.max(...points.map((p) => p.r || 0)), maxRadius = W < 400 ? 24 : 30;
  const occupied = [];
  const ordered = bubble ? [...points].sort((a, b) => b.r - a.r) : points;
  ordered.forEach((p) => {
    const r = bubble ? (maxSize > 0 ? maxRadius * Math.sqrt(p.r / maxSize) : 0) : 4;
    const x = ax.x(p.x), y = ax.y(p.y), color = C.color(pal, groups.indexOf(p.group));
    const tooltip = p.label + " · " + p.group + ": " + C.fmt(p.x, xUnit) + ", " + C.fmt(p.y, yUnit) + (bubble ? " · 크기 " + C.fmt(p.r) : "");
    body += '<circle class="vk-chst-point" cx="' + C.round(x) + '" cy="' + C.round(y) + '" r="' + r + '" fill="' + color + '" fill-opacity=".55" stroke="' + color + '" stroke-width="1.5"><title>' + C.esc(tooltip) + "</title></circle>";
    if (bubble && r >= 17 && !occupied.some((q) => Math.abs(x - q.x) < r + q.r && Math.abs(y - q.y) < 18)) {
      body += chstText(C, x, y, p.label, r * 1.7, { anchor: "middle", weight: 650 });
      occupied.push({ x, y, r });
    }
  });
  const table = C.table(h.str(d.title, bubble ? "버블 그래프" : "산점도", 80), ["항목", "그룹", xTitle, yTitle, ...(bubble ? ["크기 (면적)"] : [])], points.map((p) => [p.label, p.group, C.fmt(p.x, xUnit), C.fmt(p.y, yUnit), ...(bubble ? [C.fmt(p.r)] : [])]));
  const desc = C.finding(points.map((p) => p.label), { name: yTitle, data: points.map((p) => p.y) }, yUnit);
  return { w: W, h: H, body, table, desc, legend: C.legend(groups, pal) };
}

registerComponent({
  id: "chart-scatter", family: "chart", name: "산점도",
  description: "Scatter plot of points [{x,y,label?,group?}] with colored groups, xTitle/yTitle, xUnit/yUnit, and an optional least-squares dashed trend line (trend: true).",
  schema: { type: "object", properties: { ...chstProps, points: chstPointsSchema, trend: { type: "boolean" } }, required: ["points"] },
  presets: chstPresets, defaults: { points: [] },
  sample: { title: "학습 시간과 점수", subtitle: "학습 시간과 평가 점수의 상관관계입니다.", xTitle: "학습 시간", xUnit: "시간", yTitle: "평가 점수", yUnit: "점", trend: true, points: [{ x: 2, y: 28, group: "오전반" }, { x: 4, y: 36, group: "오전반" }, { x: 6, y: 60, group: "오전반" }, { x: 8, y: 46, group: "오전반" }, { x: 10, y: 76, group: "오전반" }, { x: 12, y: 64, group: "오전반" }, { x: 3, y: 22, group: "오후반" }, { x: 7, y: 48, group: "오후반" }, { x: 11, y: 58, group: "오후반" }, { x: 14, y: 82, group: "오후반" }, { x: 17, y: 90, group: "오후반" }, { x: 19, y: 98, group: "오후반" }], caption: "점선은 최소제곱 추세선입니다. 상관관계는 인과관계를 뜻하지 않습니다." },
  slash: { label: "산점도", hint: "두 수치의 상관관계", ico: "∷", aliases: "산점도 분산 상관관계 scatter plot correlation regression" }, css: "",
  render(d, h) {
    const wide = chstPointBody(d, h, 640, 320, false), narrow = chstPointBody(d, h, 360, 300, false);
    return h.chart.figure("scatter", d, h, wide ? { ...wide, narrow, label: "산점도" } : { empty: h.chart.EMPTY });
  },
});

registerComponent({
  id: "chart-bubble", family: "chart", name: "버블 그래프",
  description: "Bubble plot of points [{x,y,r,label?,group?}], where nonnegative r scales circle area and large bubbles carry labels; xTitle/yTitle and xUnit/yUnit label the axes.",
  schema: { type: "object", properties: { ...chstProps, points: { ...chstPointsSchema, items: { ...chstPointsSchema.items, required: ["x", "y", "r"] } } }, required: ["points"] },
  presets: chstPresets, defaults: { points: [] },
  sample: { title: "제품별 성장과 매출", subtitle: "원의 면적은 활성 고객 수를 나타냅니다.", xTitle: "월 매출", xUnit: "만원", yTitle: "성장률", yUnit: "%", points: [{ x: 120, y: 12, r: 180, label: "노트", group: "개인" }, { x: 240, y: 28, r: 720, label: "플래너", group: "개인" }, { x: 410, y: 18, r: 540, label: "협업", group: "팀" }, { x: 560, y: 42, r: 1000, label: "위키", group: "팀" }], caption: "원의 반지름이 아닌 면적을 고객 수에 비례시켰습니다." },
  slash: { label: "버블 그래프", hint: "위치와 크기로 세 수치 비교", ico: "◯", aliases: "버블 거품 크기 bubble chart area scatter" }, css: "",
  render(d, h) {
    const wide = chstPointBody(d, h, 640, 320, true), narrow = chstPointBody(d, h, 360, 300, true);
    return h.chart.figure("bubble", d, h, wide ? { ...wide, narrow, label: "버블 그래프" } : { empty: h.chart.EMPTY });
  },
});

function chstHistogramBody(d, h, W, H) {
  const C = h.chart, values = h.list(d.values, 2000).map(C.num).filter((v) => v !== null);
  if (!values.length) return null;
  let lo = Math.min(...values), hi = Math.max(...values);
  const constant = lo === hi;
  if (constant) { const pad = Math.max(0.5, Math.abs(lo) * 0.05); lo -= pad; hi += pad; }
  const requested = C.num(d.bins);
  const count = requested !== null && requested >= 1 ? Math.min(40, Math.floor(requested)) : constant ? 1 : Math.ceil(Math.log2(values.length) + 1);
  const step = (hi - lo) / count, edges = Array.from({ length: count + 1 }, (_, i) => i === count ? hi : lo + i * step);
  const counts = Array(count).fill(0);
  values.forEach((v) => { counts[Math.min(count - 1, Math.floor((v - lo) / step))] += 1; });
  const unit = h.str(d.xUnit, h.str(d.unit, "", 12), 12), xTitle = chstTitle(d, h, "x", "값", unit);
  const ys = C.ticks(0, Math.max(...counts, 4), 4), ax = chstAxes(C, W, H, edges, ys, xTitle, h.str(d.yTitle, "빈도 (개)", 60));
  let body = ax.svg;
  counts.forEach((n, i) => {
    const x = C.round(ax.x(edges[i])), end = C.round(ax.x(edges[i + 1]));
    const range = C.fmt(edges[i], unit) + " ≤ 값 " + (i === count - 1 ? "≤ " : "< ") + C.fmt(edges[i + 1], unit);
    body += '<rect class="vk-chst-bin" x="' + x + '" y="' + C.round(ax.y(n)) + '" width="' + C.round(end - x) + '" height="' + C.round(ax.y(0) - ax.y(n)) + '" fill="' + C.color(d.palette, 0) + '" fill-opacity=".72" stroke="var(--color-surface)" stroke-width=".5"><title>' + C.esc(range + ": " + n + "개") + "</title></rect>";
  });
  const peak = counts.indexOf(Math.max(...counts));
  const desc = values.length + "개 관측값 중 " + C.fmt(edges[peak], unit) + "~" + C.fmt(edges[peak + 1], unit) + " 구간에 " + counts[peak] + "개로 가장 많이 모여 있어요.";
  const table = C.table(h.str(d.title, "히스토그램", 80), ["관측", xTitle, "구간 시작", "구간 끝"], values.map((v, i) => {
    const bin = Math.min(count - 1, Math.floor((v - lo) / step));
    return [i + 1, C.fmt(v, unit), C.fmt(edges[bin], unit), C.fmt(edges[bin + 1], unit)];
  }));
  return { w: W, h: H, body, table, desc };
}

registerComponent({
  id: "chart-histogram", family: "chart", name: "히스토그램",
  description: "Histogram of values [numbers] in equal-width contiguous bins (bins: count, default Sturges); boundary values enter the right bin except the inclusive final edge, with constant data in one bin.",
  schema: { type: "object", properties: { ...chstProps, values: { type: "array", items: { type: "number" } }, bins: { type: "integer", minimum: 1, maximum: 40 } }, required: ["values"] },
  presets: chstPresets, defaults: { values: [] },
  sample: { title: "과제 완료 시간 분포", subtitle: "학생 24명의 과제 완료 시간을 구간별로 비교합니다.", xTitle: "완료 시간", unit: "분", values: [12, 18, 21, 22, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 38, 40, 41, 43, 46, 49, 54, 60], bins: 6, caption: "막대는 같은 폭의 구간에 속한 관측값의 개수입니다." },
  slash: { label: "히스토그램", hint: "수치의 빈도 분포", ico: "▥", aliases: "히스토그램 도수분포 빈도 histogram distribution bins frequency" }, css: "",
  render(d, h) {
    const wide = chstHistogramBody(d, h, 640, 320), narrow = chstHistogramBody(d, h, 360, 300);
    return h.chart.figure("histogram", d, h, wide ? { ...wide, narrow, label: "히스토그램" } : { empty: h.chart.EMPTY });
  },
});

// Linear interpolation at (n - 1) * p (R type 7); whiskers end at actual observations within 1.5 IQR.
function chstQuantile(sorted, p) {
  const at = (sorted.length - 1) * p, i = Math.floor(at);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (at - i);
}

function chstGroups(d, h) {
  const C = h.chart;
  return h.list(d.groups, 24).filter((g) => g && typeof g === "object").map((g, i) => {
    const label = h.str(g.label, "그룹 " + (i + 1), 60);
    const values = h.list(g.values, 2000).map(C.num).filter((v) => v !== null).sort((a, b) => a - b);
    if (values.length) {
      const q1 = chstQuantile(values, 0.25), median = chstQuantile(values, 0.5), q3 = chstQuantile(values, 0.75), iqr = q3 - q1;
      const inner = values.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
      return { label, values, q1, median, q3, min: inner[0], max: inner[inner.length - 1], outliers: values.filter((v) => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr) };
    }
    const stats = [g.min, g.q1, g.median, g.q3, g.max].map(C.num);
    if (stats.some((v) => v === null) || stats.some((v, j) => j > 0 && v < stats[j - 1])) return null;
    return { label, values: [], min: stats[0], q1: stats[1], median: stats[2], q3: stats[3], max: stats[4], outliers: [] };
  }).filter(Boolean);
}

function chstBoxBody(d, h, W, H) {
  const C = h.chart, groups = chstGroups(d, h);
  if (!groups.length) return null;
  const unit = h.str(d.yUnit, h.str(d.unit, "", 12), 12);
  const ys = chstRange(C, groups.flatMap((g) => [g.min, g.max, ...g.outliers]), 4, 0.08);
  const ax = chstAxes(C, W, H, [0, groups.length], ys, h.str(d.xTitle, h.t("그룹", "Group"), 60), chstTitle(d, h, "y", h.t("값", "Value"), unit), groups.map((g) => g.label));
  const bw = Math.min(68, (W - ax.left - ax.right) / groups.length * 0.55);
  let body = ax.svg;
  groups.forEach((g, i) => {
    const x = ax.x(i + 0.5), color = C.color(d.palette, i);
    const stats = "중앙값 " + C.fmt(g.median, unit) + " · Q1 " + C.fmt(g.q1, unit) + " · Q3 " + C.fmt(g.q3, unit) + " · 수염 " + C.fmt(g.min, unit) + "~" + C.fmt(g.max, unit);
    body += '<g class="vk-chst-box"><title>' + C.esc(g.label + ": " + stats) + '</title><path d="M' + C.round(x) + " " + C.round(ax.y(g.min)) + " V" + C.round(ax.y(g.max)) + " M" + C.round(x - bw / 4) + " " + C.round(ax.y(g.min)) + " h" + C.round(bw / 2) + " M" + C.round(x - bw / 4) + " " + C.round(ax.y(g.max)) + " h" + C.round(bw / 2) + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
    body += '<rect x="' + C.round(x - bw / 2) + '" y="' + C.round(ax.y(g.q3)) + '" width="' + C.round(bw) + '" height="' + C.round(ax.y(g.q1) - ax.y(g.q3)) + '" fill="' + color + '" fill-opacity=".3" stroke="' + color + '" stroke-width="1.5"/>';
    body += '<line class="vk-chst-median" x1="' + C.round(x - bw / 2) + '" x2="' + C.round(x + bw / 2) + '" y1="' + C.round(ax.y(g.median)) + '" y2="' + C.round(ax.y(g.median)) + '" stroke="var(--color-text)" stroke-width="2"/></g>';
    g.outliers.forEach((v) => { body += '<circle class="vk-chst-outlier" cx="' + C.round(x) + '" cy="' + C.round(ax.y(v)) + '" r="3" fill="var(--color-surface)" stroke="' + color + '" stroke-width="1.5"><title>' + C.esc(g.label + " 이상값: " + C.fmt(v, unit)) + "</title></circle>"; });
  });
  const table = C.table(h.str(d.title, "상자 그림", 80), ["그룹", "관측값", "아래 수염", "Q1", "중앙값", "Q3", "위 수염", "이상값"], groups.flatMap((g) => (g.values.length ? g.values : [null]).map((v) => [g.label, C.fmt(v, unit), C.fmt(g.min, unit), C.fmt(g.q1, unit), C.fmt(g.median, unit), C.fmt(g.q3, unit), C.fmt(g.max, unit), v !== null && g.outliers.includes(v) ? "예" : "—"])));
  const desc = C.finding(groups.map((g) => g.label), { name: "중앙값", data: groups.map((g) => g.median) }, unit);
  return { w: W, h: H, body, table, desc };
}

registerComponent({
  id: "chart-boxplot", family: "chart", name: "상자 그림",
  description: "Boxplot of groups [{label,values:[numbers]}] using interpolated quartiles (R type 7), median, 1.5-IQR whiskers and outlier dots; groups also accept ordered precomputed {min,q1,median,q3,max} as whisker endpoints and quartiles.",
  schema: { type: "object", properties: { ...chstProps, groups: { type: "array", items: { type: "object", properties: { label: { type: "string" }, values: { type: "array", items: { type: "number" } }, min: { type: "number" }, q1: { type: "number" }, median: { type: "number" }, q3: { type: "number" }, max: { type: "number" } } } } }, required: ["groups"] },
  presets: chstPresets, defaults: { groups: [] },
  sample: { title: "팀별 응답 시간", subtitle: "중앙값, 사분위 범위와 이상값을 비교합니다.", xTitle: "지원 팀", yTitle: "응답 시간", unit: "분", groups: [{ label: "기획팀", values: [12, 14, 15, 18, 20, 21, 23, 25, 48] }, { label: "디자인팀", values: [10, 14, 18, 19, 22, 24, 28, 30, 34] }, { label: "개발팀", values: [8, 12, 14, 16, 17, 19, 21, 24, 42] }] },
  slash: { label: "상자 그림", hint: "중앙값과 분포 비교", ico: "⊞", aliases: "박스플롯 상자그림 상자 수염 사분위 boxplot box whisker quartile outlier" }, css: "",
  render(d, h) {
    const wide = chstBoxBody(d, h, 640, 320), narrow = chstBoxBody(d, h, 360, 300);
    const caption = h.str(d.caption, "", 160);
    const note = h.t("상자: Q1–Q3, 선: 중앙값. 수염: 1.5 IQR 이내 관측값, 점: 이상값. 사전 계산값은 입력 수염을 사용합니다.", "Box: Q1–Q3, line: median. Whiskers: values within 1.5 IQR, dots: outliers. Precomputed groups use the given whiskers.");
    return h.chart.figure("boxplot", { ...d, caption: caption ? caption + " · " + note : note }, h, wide ? { ...wide, narrow, label: "상자 그림" } : { empty: h.chart.EMPTY });
  },
});
