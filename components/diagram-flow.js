import { registerComponent } from "../component-registry.js";

const dgfPresets = { report: { figure: false, compact: true }, friendly: {}, paper: { palette: "mono", figure: true }, showcase: { height: "l" } };
const dgfProps = {
  title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, source: { type: "string" }, unit: { type: "string" },
  figure: { type: "boolean" }, palette: { type: "string", enum: ["acard", "colorblind", "mono"] }, height: { type: "string", enum: ["s", "m", "l"] }, preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] },
};
function dgfObjects(value, h, max) { return h.list(value, max).filter((item) => item && typeof item === "object" && !Array.isArray(item)); }
function dgfLines(C, x, y, value, width, size, max, opts) {
  return C.wrap(value, width, size, max).map((line, i) => C.text(x, y + i * size * 1.3, line, size, opts)).join("");
}
// One cycle stage stacked inside a circle of radius r: icon, the whole title in at most maxLines lines, and (with notes) the
// whole note in one line. Every line is measured against the circle's chord at its own height, so nothing is cut with "…".
// Returns null when the title or the note does not fit whole.
function dgfCycleStage(C, s, r, size, notes, maxLines = 2) {
  const pad = 4, lh = size * 1.2, icon = 24, noteH = 14, note = notes && s.text;
  const chord = (y, half) => { const e = Math.abs(y) + half; return e < r ? 2 * Math.sqrt(r * r - e * e) - pad * 2 : 0; };
  const whole = (lines, text) => lines.join("").replace(/\s/g, "") === text.normalize("NFC").replace(/\s/g, "");
  for (let k = 1; k <= maxLines; k++) {
    const top = -(icon + 3 + k * lh + (note ? 2 + noteH : 0)) / 2, ys = Array.from({ length: k }, (_, i) => top + icon + 3 + lh * (i + 0.5));
    if (chord(top + icon / 2, icon / 2) < C.textW(s.icon, 22)) continue;
    let width = Math.min(...ys.map((y) => chord(y, size * 0.6))), lines = C.wrap(s.title, width, size, k);
    if (!whole(lines, s.title)) continue;
    // Balance the lines ("看门狗 / 重启", not "看门狗重 / 启"): the narrowest width that keeps the line count and breaks
    // no more words (Latin, digits, Hangul) than the widest wrap did. Han and kana may break between any two characters.
    const breaks = (ls) => { const t = s.title.normalize("NFC").trim(); let pos = 0, n = 0; ls.forEach((l, i) => { pos = t.indexOf(l, pos) + l.length; if (i < ls.length - 1 && /[\p{L}\p{N}'’]/u.test(t[pos - 1] + t[pos]) && /^[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}$/u.test(t[pos - 1] + t[pos])) n += 1; }); return n; };
    for (let w = width - 1, base = breaks(lines); w > 0; w -= 1) { const next = C.wrap(s.title, w, size, k); if (next.length !== lines.length || !whole(next, s.title) || breaks(next) > base) break; lines = next; }
    const noteY = top + icon + 3 + k * lh + 2 + noteH / 2;
    if (note && !whole(C.wrap(s.text, chord(noteY, 6.6), 11, 1), s.text)) return null;
    return { iconY: top + icon / 2, lines, ys, noteY: note ? noteY : null };
  }
  return null;
}
// Smallest change that fits every title whole, at 13 px first: wrap to 2 lines, move the notes under the figure, grow the
// circles (and the ring with them) up to r 52, then 3 lines at r 52 ("Enter Earth's shadow" needs it); only then the same at
// 12 px (a smaller font alone does not help: at r 42 "지구 그림자 진입" still needs a third line). A title that fits nowhere
// keeps only its icon in the circle and is written in full in the list under the figure.
function dgfCycleLayout(C, stages) {
  const r0 = Math.min(42, 110 * Math.sin(Math.PI / stages.length) - 10), hasNotes = stages.some((s) => s.text);
  const tries = [];
  for (const size of [13, 12]) {
    for (let r = r0; r <= 52; r = r < 52 && r + 2 > 52 ? 52 : r + 2) for (const notes of [true, false]) tries.push({ r, size, notes, lines: 2 });
    tries.push({ r: Math.max(r0, 52), size, notes: false, lines: 3 });
  }
  for (const t of tries) {
    const fits = stages.map((s) => dgfCycleStage(C, s, t.r, t.size, t.notes, t.lines));
    if (fits.every(Boolean)) return { r: t.r, size: t.size, notes: t.notes || !hasNotes, fits };
  }
  const r = Math.max(r0, 52);
  return { r, size: 12, notes: false, fits: stages.map((s) => dgfCycleStage(C, s, r, 12, false, 3)) };
}

registerComponent({
  id: "diagram-cycle", family: "diagram", name: "개선 사이클",
  description: "A clockwise ring of 3–8 stages with curved arrows, using stages: [{icon, title, text}] to explain a repeating process.",
  schema: { type: "object", properties: { ...dgfProps, stages: { type: "array", minItems: 3, maxItems: 8, items: { type: "object", properties: { icon: { type: "string" }, title: { type: "string" }, text: { type: "string" } } } } }, required: ["stages"] },
  presets: dgfPresets, defaults: { stages: [] },
  sample: { title: "개선 사이클", subtitle: "지속적인 개선 과정을 순환 구조로 나타냅니다.", stages: [{ icon: "♧", title: "아이디어", text: "문제 발견" }, { icon: "▤", title: "계획", text: "방향 설정" }, { icon: "⚙", title: "실행", text: "실험 및 개발" }, { icon: "⌕", title: "검토", text: "결과 분석" }, { icon: "▥", title: "개선", text: "다음 단계" }], caption: "사이클" },
  slash: { label: "개선 사이클", hint: "반복되는 단계와 흐름", ico: "↻", aliases: "개선 순환 사이클 cycle loop stages" },
  css: ".ui-diagram-cycle .dgf-stage circle{fill:color-mix(in srgb,var(--dgf-color) 22%,var(--color-surface));stroke:color-mix(in srgb,var(--dgf-color) 65%,var(--color-border));stroke-width:1}.ui-diagram-cycle .dgf-stage .dgf-icon{fill:var(--dgf-color)}.ui-diagram-cycle .dgc-svg{max-width:440px;margin:auto}.ui-diagram-cycle .dgf-cycle-notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-1) var(--space-4);max-width:440px;margin:var(--space-3) auto 0;padding:0;list-style:none;font-size:var(--fs-13);line-height:var(--lh-snug,1.4);color:var(--color-text-dim);overflow-wrap:anywhere}.ui-diagram-cycle .dgf-cycle-notes li{position:relative;padding-left:14px}.ui-diagram-cycle .dgf-cycle-notes li::before{content:'';position:absolute;left:0;top:.45em;width:8px;height:8px;border-radius:50%;background:var(--dgf-color)}.ui-diagram-cycle .dgf-cycle-notes b{margin-right:4px;font-weight:650;color:var(--color-text)}",
  render(d, h) {
    const C = h.diagram, stages = dgfObjects(d.stages, h, 8).map((s, i) => ({ icon: h.str(s.icon, String(i + 1), 8), title: h.str(s.title, "단계 " + (i + 1), 80), text: h.str(s.text, "", 160) }));
    if (stages.length < 3) return C.figure("cycle", d, h, { empty: C.EMPTY });
    const n = stages.length, fit = dgfCycleLayout(C, stages), r = fit.r, R = Math.max(110, (r + 10) / Math.sin(Math.PI / n));
    const S = Math.max(320, Math.ceil(2 * (R + r) + 8)), mid = S / 2, gap = 2 * Math.asin((r + 5) / (2 * R));
    const point = (a) => [mid + R * Math.cos(a), mid + R * Math.sin(a)];
    const list = fit.notes && fit.fits.every(Boolean) ? "" : '<ul class="dgf-cycle-notes" aria-hidden="true">' + stages.map((s, i) => '<li style="--dgf-color:' + C.color(d.palette, i) + '"><b>' + C.esc(s.title) + '</b>' + (s.text ? " " + C.esc(s.text) : "") + '</li>').join("") + '</ul>';
    return C.figure("cycle", d, h, { w: S, h: S, after: list, label: "개선 사이클", desc: stages.map((s) => s.title).join(" → ") + " → " + stages[0].title,
      table: C.table(h.t("순환 단계", "Cycle stages"), [h.t("순서", "Order"), h.t("단계", "Stage"), h.t("설명", "Note")], stages.map((s, i) => [i + 1, s.title, s.text])),
      body(uid) {
        let body = C.marker(uid + "-arrow");
        stages.forEach((s, i) => {
          const angle = -Math.PI / 2 + i * 2 * Math.PI / n, a = point(angle + gap), b = point(angle + 2 * Math.PI / n - gap);
          body += '<path class="dgf-cycle-arrow" d="M' + a.map(C.round).join(" ") + " A" + C.round(R) + " " + C.round(R) + " 0 0 1 " + b.map(C.round).join(" ") + '" fill="none" stroke="var(--color-text-dim)" stroke-width="1.8" marker-end="url(#' + uid + '-arrow)"/>';
        });
        stages.forEach((s, i) => {
          const [x, y] = point(-Math.PI / 2 + i * 2 * Math.PI / n), f = fit.fits[i];
          const inner = f ? C.text(x, y + f.iconY, s.icon, 22, { cls: "dgf-icon" }) + f.lines.map((line, j) => C.text(x, y + f.ys[j], line, fit.size, { weight: 700, cls: "dgf-label" })).join("") + (f.noteY === null ? "" : C.text(x, y + f.noteY, s.text, 11, { cls: "dgc-muted" })) : C.text(x, y, s.icon, 22, { cls: "dgf-icon" });
          body += '<g class="dgf-stage" style="--dgf-color:' + C.color(d.palette, i) + '"><title>' + C.esc(s.title + (s.text ? " · " + s.text : "")) + '</title><circle cx="' + C.round(x) + '" cy="' + C.round(y) + '" r="' + C.round(r) + '"/>' + inner + '</g>';
        });
        return body;
      },
    });
  },
});

function dgfPyramid(d, h, levels, W) {
  const C = h.diagram, narrow = W === 320, width = narrow ? 170 : 200, center = width / 2 + 4, noteX = width + 25, row = 64;
  let body = "";
  levels.forEach((level, i) => {
    const y = 6 + i * row, top = width * i / levels.length / 2, bottom = width * (i + 1) / levels.length / 2;
    const points = [[center - top, y], [center + top, y], [center + bottom - 2, y + row - 4], [center - bottom + 2, y + row - 4]];
    const mid = y + (i ? 31 : 49), edge = center + (i ? (top + bottom) / 2 : bottom * .82);
    body += '<g class="dgf-level" style="--dgf-color:' + C.color(d.palette, i) + '"><title>' + C.esc(level.title + " · " + level.note) + '</title><polygon points="' + points.map((p) => p.map(C.round).join(",")).join(" ") + '"/>' + dgfLines(C, center, mid, level.title, i ? top + bottom - 12 : bottom * 1.7 - 2, i ? 14 : 11, 1, { weight: 700 }) + '<path d="M' + C.round(edge + 5) + " " + mid + " H" + (noteX - 8) + '" fill="none" stroke="var(--dgf-color)"/><circle cx="' + C.round(edge + 5) + '" cy="' + mid + '" r="3" fill="var(--dgf-color)"/>' + dgfLines(C, noteX, mid - 7, level.note, W - noteX - 3, 11, 3, { anchor: "start", cls: "dgc-muted" }) + '</g>';
  });
  return { w: W, h: levels.length * row + 8, body };
}
registerComponent({
  id: "diagram-pyramid", family: "diagram", name: "목표 피라미드",
  description: "A bottom-wide pyramid of 3–6 top-to-bottom levels, using levels: [{title, note}] with a side note for every level.",
  schema: { type: "object", properties: { ...dgfProps, levels: { type: "array", minItems: 3, maxItems: 6, items: { type: "object", properties: { title: { type: "string" }, note: { type: "string" } } } } }, required: ["levels"] },
  presets: dgfPresets, defaults: { levels: [] },
  sample: { title: "비즈니스 목표 피라미드", subtitle: "조직의 목표를 4단계로 나타냅니다.", levels: [{ title: "비전", note: "더 나은 생산성 도구로 사람들의 가능성을 확장합니다." }, { title: "전략", note: "사용자 중심의 혁신적인 기능을 지속적으로 개발합니다." }, { title: "실행", note: "제품 고도화와 시장 확대를 실행합니다." }, { title: "성과", note: "지속적인 성장과 사용자 만족을 달성합니다." }], caption: "피라미드" },
  slash: { label: "목표 피라미드", hint: "목표와 계층 구조", ico: "△", aliases: "목표 피라미드 계층 pyramid levels hierarchy" },
  css: ".ui-diagram-pyramid .dgf-level polygon{fill:color-mix(in srgb,var(--dgf-color) 34%,var(--color-surface));stroke:color-mix(in srgb,var(--dgf-color) 70%,var(--color-border));stroke-linejoin:round}.ui-diagram-pyramid .dgc-svg{max-width:480px;margin:auto}",
  render(d, h) {
    const C = h.diagram, levels = dgfObjects(d.levels, h, 6).map((l, i) => ({ title: h.str(l.title, "단계 " + (i + 1), 80), note: h.str(l.note, "설명을 추가해 주세요.", 240) }));
    if (levels.length < 3) return C.figure("pyramid", d, h, { empty: C.EMPTY });
    return C.figure("pyramid", d, h, { ...dgfPyramid(d, h, levels, 360), narrow: dgfPyramid(d, h, levels, 320), label: "목표 피라미드", desc: levels.map((l) => l.title).join(" → ") + " 순서의 계층입니다.", table: C.table("피라미드 단계", ["단계", "설명"], levels.map((l) => [l.title, l.note])) });
  },
});

const dgfStatus = { planned: "예정", active: "진행 중", done: "완료", blocked: "보류" };
function dgfRoadmap(d, h, lanes, periods, bars, W) {
  const C = h.diagram, left = W === 320 ? 66 : 100, step = (W - left - 4) / periods.length, tickEvery = Math.max(1, Math.ceil(36 / step));
  let y = 42, body = "";
  periods.forEach((period, i) => { if (i % tickEvery === 0) body += dgfLines(C, left + step * (i + .5), 20, period, step * tickEvery - 4, 11, 1); });
  lanes.forEach((lane, index) => {
    const ends = [], placed = bars.filter((b) => b.lane === index).sort((a, b) => a.start - b.start || a.end - b.end).map((b) => {
      let track = ends.findIndex((end) => end < b.start);
      if (track < 0) track = ends.length;
      ends[track] = b.end;
      return { ...b, track };
    });
    const height = Math.max(1, ends.length) * 34 + 14;
    body += '<g class="dgf-lane" style="--dgf-color:' + C.color(d.palette, index) + '"><rect class="dgf-lane-label" x="0" y="' + y + '" width="' + (left - 6) + '" height="' + height + '"/>' + dgfLines(C, (left - 6) / 2, y + height / 2 - (C.textW(lane, 12) > left - 16 ? 8 : 0), lane, left - 16, 12, 2, { weight: 650 });
    for (let i = 0; i <= periods.length; i++) body += '<path d="M' + C.round(left + i * step) + " " + y + " v" + height + '" stroke="var(--color-border)"/>';
    placed.forEach((b) => {
      const x = left + b.start * step + 3, w = (b.end - b.start + 1) * step - 6, top = y + 8 + b.track * 34;
      body += '<g class="dgf-bar" data-lane="' + index + '" data-start="' + b.start + '" data-end="' + b.end + '" data-track="' + b.track + '" data-status="' + b.status + '"><title>' + C.esc(b.label + " · " + periods[b.start] + "–" + periods[b.end] + " · " + dgfStatus[b.status]) + '</title><rect x="' + C.round(x) + '" y="' + top + '" width="' + C.round(w) + '" height="26"/>' + (w >= 18 ? dgfLines(C, x + w / 2, top + 13, (b.status === "done" ? "✓ " : b.status === "blocked" ? "! " : "") + b.label, w - 8, 11, 1) : "") + '</g>';
    });
    body += '</g>';
    y += height + 4;
  });
  const now = C.num(d.now);
  if (now !== null && now >= 0 && now <= periods.length - 1) {
    const x = left + (now + .5) * step;
    body += '<g class="dgf-now"><path d="M' + C.round(x) + ' 33 V' + (y - 4) + '" stroke="var(--color-danger-fg)" stroke-width="1.5" stroke-dasharray="4 3"/>' + C.text(x, 33, "현재", 11, { fill: "var(--color-danger-fg)", cls: "dgc-edge-label" }) + '</g>';
  }
  return { w: W, h: y + 2, body };
}
registerComponent({
  id: "diagram-roadmap", family: "diagram", name: "제품 개발 로드맵",
  description: "A roadmap with lanes: [{name}], periods: [labels], bars: [{lane, start, end, label, status}] using zero-based lane and inclusive period indexes, plus an optional now period index.",
  schema: { type: "object", properties: { ...dgfProps, lanes: { type: "array", maxItems: 12, items: { type: "object", properties: { name: { type: "string" } } } }, periods: { type: "array", maxItems: 12, items: { type: "string" } }, bars: { type: "array", maxItems: 48, items: { type: "object", properties: { lane: { type: "integer", minimum: 0 }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 }, label: { type: "string" }, status: { type: "string", enum: Object.keys(dgfStatus) } } } }, now: { type: "number", minimum: 0 } }, required: ["lanes", "periods", "bars"] },
  presets: dgfPresets, defaults: { lanes: [], periods: [], bars: [] },
  sample: { title: "제품 개발 로드맵", subtitle: "분기별 주요 기능 개발 계획을 나타냅니다.", lanes: [{ name: "핵심 기능" }, { name: "사용자 경험" }, { name: "인프라" }], periods: ["1분기", "2분기", "3분기", "4분기"], bars: [{ lane: 0, start: 0, end: 1, label: "기본 에디터 고도화", status: "done" }, { lane: 0, start: 2, end: 3, label: "AI 기능 추가", status: "planned" }, { lane: 1, start: 0, end: 1, label: "UI/UX 개선", status: "active" }, { lane: 1, start: 2, end: 3, label: "모바일 대응", status: "planned" }, { lane: 2, start: 0, end: 1, label: "성능 최적화", status: "done" }, { lane: 2, start: 2, end: 3, label: "글로벌 확장", status: "planned" }], now: 1.5, caption: "로드맵" },
  slash: { label: "제품 개발 로드맵", hint: "기간별 개발 계획", ico: "▦", aliases: "로드맵 일정 계획 roadmap lanes gantt schedule" },
  css: ".ui-diagram-roadmap .dgf-lane-label{fill:color-mix(in srgb,var(--dgf-color) 19%,var(--color-surface));rx:var(--radius-xs)}.ui-diagram-roadmap .dgf-bar rect{fill:color-mix(in srgb,var(--dgf-color) 26%,var(--color-surface));stroke:var(--dgf-color);rx:var(--radius-xs)}.ui-diagram-roadmap .dgf-bar[data-status=planned] rect{stroke-dasharray:4 3;fill:color-mix(in srgb,var(--dgf-color) 12%,var(--color-surface))}.ui-diagram-roadmap .dgf-bar[data-status=blocked] rect{stroke-dasharray:2 2}",
  render(d, h) {
    const C = h.diagram, lanes = dgfObjects(d.lanes, h, 12).map((l, i) => h.str(l.name, "영역 " + (i + 1), 80)), periods = h.list(d.periods, 12).map((p, i) => h.str(p, "기간 " + (i + 1), 40));
    const bars = dgfObjects(d.bars, h, 48).filter((b) => Number.isInteger(b.lane) && b.lane >= 0 && b.lane < lanes.length && Number.isInteger(b.start) && Number.isInteger(b.end) && b.start <= b.end && b.end >= 0 && b.start < periods.length).map((b) => ({ lane: b.lane, start: Math.max(0, b.start), end: Math.min(periods.length - 1, b.end), label: h.str(b.label, "작업", 160), status: h.oneOf(b.status, Object.keys(dgfStatus), "planned") }));
    if (!lanes.length || !periods.length) return C.figure("roadmap", d, h, { empty: C.EMPTY });
    return C.figure("roadmap", d, h, { ...dgfRoadmap(d, h, lanes, periods, bars, 640), narrow: dgfRoadmap(d, h, lanes, periods, bars, 320), label: "제품 개발 로드맵", desc: lanes.length + "개 영역, " + periods.length + "개 기간에 걸친 " + bars.length + "개 작업입니다.", table: C.table("로드맵 작업", ["영역", "작업", "시작", "종료", "상태"], bars.map((b) => [lanes[b.lane], b.label, periods[b.start], periods[b.end], dgfStatus[b.status]])) });
  },
});

registerComponent({
  id: "diagram-kanban", family: "diagram", name: "작업 관리 칸반 보드",
  description: "A script-free kanban board with counted columns: [{title, cards: [{title, tag, tone, assignee}]}] and keyboard-accessible horizontal column scrolling on small screens.",
  schema: { type: "object", properties: { ...dgfProps, columns: { type: "array", maxItems: 8, items: { type: "object", properties: { title: { type: "string" }, cards: { type: "array", maxItems: 24, items: { type: "object", properties: { title: { type: "string" }, tag: { type: "string" }, tone: { type: "string", enum: ["neutral", "info", "success", "warning", "danger", "accent"] }, assignee: { type: "string" } } } } } } } }, required: ["columns"] },
  presets: dgfPresets, defaults: { columns: [] },
  sample: { title: "작업 관리 칸반 보드", subtitle: "작업의 진행 상태를 칸반 보드로 관리합니다.", columns: [{ title: "할 일", cards: [{ title: "노트 템플릿 추가", tag: "기능", tone: "accent", assignee: "서연" }, { title: "다크 모드 개선", tag: "UI/UX", tone: "info", assignee: "민준" }, { title: "검색 성능 개선", tag: "개선", tone: "danger", assignee: "도현" }, { title: "가이드 문서 작성", tag: "문서", tone: "warning", assignee: "지윤" }] }, { title: "진행 중", cards: [{ title: "AI 요약 기능 개발", tag: "AI", tone: "accent", assignee: "지훈" }, { title: "공유 기능 고도화", tag: "기능", tone: "info", assignee: "서연" }, { title: "모바일 반응형 개선", tag: "개선", tone: "danger", assignee: "민준" }] }, { title: "완료", cards: [{ title: "회원가입 플로우 개선", tag: "기능", tone: "success", assignee: "도현" }, { title: "버그 수정", tag: "완료", tone: "success", assignee: "지훈" }, { title: "분석 대시보드", tag: "분석", tone: "info", assignee: "지윤" }] }], caption: "칸반 보드" },
  slash: { label: "작업 관리 칸반 보드", hint: "상태별 작업 카드", ico: "▥", aliases: "칸반 보드 작업 카드 kanban board columns tasks" },
  css: ".ui-diagram-kanban{min-width:0;max-width:100%}.ui-diagram-kanban .dgf-board{display:grid;grid-template-columns:repeat(var(--dgf-columns),minmax(0,1fr));gap:var(--space-2);max-width:100%;outline-offset:3px}.ui-diagram-kanban .dgf-column{min-width:0;border:1px solid color-mix(in srgb,var(--dgf-color) 28%,var(--color-border));border-radius:var(--radius-xs);background:color-mix(in srgb,var(--dgf-color) 5%,var(--color-surface));overflow-wrap:anywhere}.ui-diagram-kanban .dgf-column-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);padding:var(--space-2);background:color-mix(in srgb,var(--dgf-color) 19%,var(--color-surface));font-size:var(--fs-12);font-weight:700}.ui-diagram-kanban .dgf-count{flex:none;display:inline-grid;place-items:center;min-width:1.5em;min-height:1.5em;border-radius:var(--radius-pill);background:color-mix(in srgb,var(--dgf-color) 18%,var(--color-surface));font-variant-numeric:tabular-nums}.ui-diagram-kanban .dgf-cards{display:grid;gap:var(--space-2);list-style:none;padding:var(--space-2);margin:0}.ui-diagram-kanban .dgf-card{padding:var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-xs);background:var(--color-surface);font-size:var(--fs-12);line-height:1.5}.ui-diagram-kanban .dgf-card-title{display:flex;align-items:baseline;gap:var(--space-1)}.ui-diagram-kanban .dgf-card-title::before{content:'';width:6px;height:6px;border-radius:var(--radius-pill);flex:none;background:var(--dgf-tone-fg,var(--dgf-color))}.ui-diagram-kanban .dgf-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);margin-top:var(--space-1);font-size:var(--fs-11);color:var(--color-text-dim)}.ui-diagram-kanban .dgf-tag{padding:0 var(--space-1);border-radius:var(--radius-pill);background:var(--dgf-tone-bg,var(--color-surface-soft));color:var(--dgf-tone-fg,var(--color-text))}.ui-diagram-kanban .dgf-assignee{margin-left:auto}.ui-diagram-kanban .dgf-board[data-palette=mono] .dgf-card{--dgf-tone-bg:var(--color-surface-soft)!important;--dgf-tone-fg:var(--color-text)!important}.ui-diagram-kanban .dgf-empty-column{padding:var(--space-3);font-size:var(--fs-12);color:var(--color-text-dim)}.ui-diagram-kanban .dgf-board:focus-visible{outline:2px solid var(--color-accent)}@container (max-width:359px){.ui-diagram-kanban .dgf-board{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:min(260px,85%);overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;padding-bottom:var(--space-2)}.ui-diagram-kanban .dgf-column{scroll-snap-align:start}.ui-diagram-kanban .dgf-card{font-size:var(--fs-13)}}@media print{.ui-diagram-kanban .dgf-board{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:row;grid-auto-columns:auto;overflow:visible;scroll-snap-type:none}.ui-diagram-kanban .dgf-column{break-inside:avoid}}",
  render(d, h) {
    const C = h.diagram, columns = dgfObjects(d.columns, h, 8);
    if (!columns.length) return C.figure("kanban", d, h, { empty: C.EMPTY });
    const uid = C.uid("kanban", d);
    const plot = '<div class="dgf-board" role="region" tabindex="0" aria-label="' + C.esc(h.str(d.title, "작업 보드", 80) + " · 좌우 방향키로 열 이동") + '" data-palette="' + C.palette(d.palette) + '" style="--dgf-columns:' + columns.length + '">' + columns.map((column, index) => {
      const title = h.str(column.title, "열 " + (index + 1), 80), cards = dgfObjects(column.cards, h, 24);
      return '<section class="dgf-column" aria-labelledby="' + uid + '-' + index + '" style="--dgf-color:' + C.color(d.palette, index) + '"><div class="dgf-column-head"><span id="' + uid + '-' + index + '">' + C.esc(title) + '</span><span class="dgf-count" aria-label="' + cards.length + h.t('개 작업', cards.length === 1 ? ' task' : ' tasks') + '">' + cards.length + '</span></div>' + (cards.length ? '<ul class="dgf-cards">' + cards.map((card) => {
        const tone = h.oneOf(card.tone, h.TONES, "neutral"), tag = h.str(card.tag, "", 40), assignee = h.str(card.assignee, "", 60);
        return '<li class="dgf-card" style="--dgf-tone-bg:var(--color-' + (tone === "accent" ? "accent-soft" : tone + "-bg") + ');--dgf-tone-fg:var(--color-' + (tone === "accent" ? "accent-strong" : tone + "-fg") + ')"><div class="dgf-card-title">' + C.esc(h.str(card.title, "제목 없는 작업", 160)) + '</div>' + (tag || assignee ? '<div class="dgf-meta">' + (tag ? '<span class="dgf-tag">' + C.esc(tag) + '</span>' : '') + (assignee ? '<span class="dgf-assignee" aria-label="담당자 ' + C.esc(assignee) + '">' + C.esc(assignee) + '</span>' : '') + '</div>' : '') + '</li>';
      }).join("") + '</ul>' : '<p class="dgf-empty-column">등록된 작업이 없어요.</p>') + '</section>';
    }).join("") + '</div>';
    const summary = columns.map((column, i) => { const n = dgfObjects(column.cards, h, 24).length; return h.str(column.title, h.t("열 ", "Column ") + (i + 1), 80) + ": " + n + h.t("개 작업", n === 1 ? " task" : " tasks"); });
    const total = columns.reduce((sum, column) => sum + dgfObjects(column.cards, h, 24).length, 0);
    return C.figure("kanban", d, h, { plot, label: "작업 관리 칸반 보드", badge: '<span class="vk-sub" role="img" aria-label="' + C.esc(summary.join(" · ")) + '">' + total + h.t('개 작업', total === 1 ? ' task' : ' tasks') + '</span>', items: summary });
  },
});
