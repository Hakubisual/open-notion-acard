import { registerComponent } from "../component-registry.js";

// Script-free reveals. All ids and CSS properties are local to this file's prefix.
let ixrSequence = 0;
const ixrPresets = { report: { compact: true }, friendly: {}, paper: { mono: true }, showcase: { spacious: true } };
const ixrProps = { title: { type: "string" }, subtitle: { type: "string" }, preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] } };
const ixrFrameCss = ".ui-ixr-frame{container-type:inline-size;margin:0;padding:var(--space-5);border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);color:var(--color-text);box-shadow:var(--shadow-sm);font-size:var(--fs-14);line-height:1.6;overflow-wrap:anywhere;min-width:0;break-inside:avoid}.ui-ixr-frame.ui-ixr-compact{padding:var(--space-4)}.ui-ixr-frame.ui-ixr-spacious{padding:var(--space-6)}.ui-ixr-title{margin:0;font-size:var(--fs-17);font-weight:750;line-height:1.4}.ui-ixr-sub{margin:var(--space-1) 0 var(--space-4);color:var(--color-text-dim);font-size:var(--fs-13)}.ui-ixr-empty{margin:var(--space-4) 0;color:var(--color-text-dim)}.ui-ixr-frame.ui-ixr-mono{--color-accent:var(--color-text);--color-accent-strong:var(--color-text);--color-accent-soft:var(--color-surface-soft);--color-on-accent:var(--color-surface);box-shadow:none}.ui-ixr-frame :focus-visible{outline:2px solid var(--color-accent);outline-offset:4px}@media print{.ui-ixr-frame{box-shadow:none;print-color-adjust:exact}}";

function ixrUid(data) {
  let hash = 2166136261;
  const text = JSON.stringify(data);
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return "vkixr-" + (hash >>> 0).toString(36) + (++ixrSequence).toString(36);
}
function ixrFrame(d, h, title, body) {
  return '<section class="ui-ixr-frame' + (d.compact === true ? " ui-ixr-compact" : "") + (d.spacious === true ? " ui-ixr-spacious" : "") + (d.mono === true ? " ui-ixr-mono" : "") + '"><h3 class="ui-ixr-title">' + h.esc(h.str(d.title, title, 100)) + '</h3><p class="ui-ixr-sub">' + h.esc(h.str(d.subtitle, "", 200)) + "</p>" + body + "</section>";
}
function ixrEmpty() { return '<p class="ui-ixr-empty">내용을 넣으면 여기에 표시돼요.</p>'; }

registerComponent({
  id: "ix-tooltip", family: "interactive", name: "용어 툴팁",
  description: "Inline definitions revealed on hover or keyboard focus, with text containing [[term]] markers and a terms object mapping each term to its definition.",
  schema: { type: "object", properties: { ...ixrProps, text: { type: "string" }, terms: { type: "object", additionalProperties: { type: "string" } } }, required: ["text"] },
  defaults: { text: "", terms: {} }, presets: ixrPresets,
  sample: { title: "툴팁", subtitle: "밑줄 친 용어에 마우스를 올리거나 탭으로 이동해 보세요.", text: "Acard는 [[마크다운]]으로 생각을 정리하고, [[백링크]]로 노트 사이의 연결을 발견합니다.", terms: { "마크다운": "간단한 기호로 제목, 목록, 강조를 표현하는 텍스트 작성 방식입니다.", "백링크": "현재 노트를 참조하는 다른 노트로 이어지는 연결입니다." } },
  slash: { label: "용어 툴팁", hint: "본문에 용어 설명 달기", ico: "?", aliases: "툴팁 용어 설명 tooltip definition glossary" },
  css: ixrFrameCss + ".ui-ix-tooltip .ui-ixr-prose{position:relative;margin:0;padding-bottom:var(--space-2);line-height:1.9}.ui-ix-tooltip .ui-ixr-term{color:var(--color-accent-strong);text-decoration:underline dotted;text-underline-offset:4px;cursor:help}.ui-ix-tooltip .ui-ixr-bubble{position:absolute;inset-inline:0;top:100%;z-index:3;padding:var(--space-3) var(--space-4);border-radius:var(--radius-sm);background:var(--color-text);color:var(--color-bg);box-shadow:var(--shadow-md);font-size:var(--fs-13);line-height:1.6;visibility:hidden;opacity:0;text-decoration:none}.ui-ix-tooltip .ui-ixr-term:hover .ui-ixr-bubble,.ui-ix-tooltip .ui-ixr-term:focus-visible .ui-ixr-bubble{visibility:visible;opacity:1}.ui-ix-tooltip .ui-ixr-footnotes{display:none}.ui-ix-tooltip .ui-ixr-ref{display:none}@container (max-width:519px){.ui-ix-tooltip .ui-ixr-prose{font-size:var(--fs-14)}}@media print{.ui-ix-tooltip .ui-ixr-bubble{display:none}.ui-ix-tooltip .ui-ixr-footnotes{display:block;padding-inline-start:var(--space-5);font-size:var(--fs-12)}.ui-ix-tooltip .ui-ixr-ref{display:inline}.ui-ix-tooltip .ui-ixr-term{color:var(--color-text)}}",
  render(d, h) {
    const text = h.str(d.text, "", 8000), terms = d.terms && typeof d.terms === "object" && !Array.isArray(d.terms) ? d.terms : {};
    const uid = ixrUid(d), notes = [], indexes = new Map();
    let cursor = 0, body = "", occurrence = 0;
    for (const match of text.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
      body += h.esc(text.slice(cursor, match.index));
      const term = match[1], definition = Object.prototype.hasOwnProperty.call(terms, term) ? h.str(terms[term], "", 1200) : "";
      if (definition) {
        if (!indexes.has(term)) { indexes.set(term, notes.length + 1); notes.push({ term, definition }); }
        const id = uid + "-tip-" + (++occurrence);
        body += '<span class="ui-ixr-term" tabindex="0" aria-describedby="' + id + '">' + h.esc(term) + '<sup class="ui-ixr-ref">[' + indexes.get(term) + ']</sup><span class="ui-ixr-bubble" role="tooltip" id="' + id + '">' + h.esc(definition) + "</span></span>";
      } else body += h.esc(term);
      cursor = match.index + match[0].length;
    }
    body += h.esc(text.slice(cursor));
    return ixrFrame(d, h, "용어 툴팁", text ? '<p class="ui-ixr-prose">' + body + '</p>' + (notes.length ? '<ol class="ui-ixr-footnotes">' + notes.map(n => "<li><strong>" + h.esc(n.term) + "</strong>: " + h.esc(n.definition) + "</li>").join("") + "</ol>" : "") : ixrEmpty());
  },
});

registerComponent({
  id: "ix-hovercard", family: "interactive", name: "호버 카드",
  description: "A person or item card expands on hover or keyboard focus using name, role, avatar emoji, bio, and an optional safe link URL.",
  schema: { type: "object", properties: { ...ixrProps, name: { type: "string" }, role: { type: "string" }, avatar: { type: "string" }, bio: { type: "string" }, link: { type: "string" } }, required: ["name"] },
  defaults: { name: "", role: "", avatar: "", bio: "", link: "" }, presets: ixrPresets,
  sample: { title: "호버 카드", subtitle: "프로필에 마우스를 올리거나 탭으로 이동해 보세요.", name: "김서연", role: "제품 디자이너", avatar: "👩🏻‍🎨", bio: "좋은 도구로 더 나은 생각을 만들어가는 것을 좋아합니다. ✨", link: "/profile/seoyeon" },
  slash: { label: "호버 카드", hint: "인물과 항목의 자세한 소개", ico: "◎", aliases: "호버 카드 프로필 인물 hovercard profile person" },
  css: ixrFrameCss + ".ui-ix-hovercard .ui-ixr-person{border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);background:var(--color-surface)}.ui-ix-hovercard .ui-ixr-person-head{display:flex;gap:var(--space-3);align-items:center;min-width:0}.ui-ix-hovercard .ui-ixr-avatar{display:grid;place-items:center;flex:none;width:52px;height:52px;border-radius:var(--radius-pill);background:var(--color-accent-soft);font-size:var(--fs-28)}.ui-ix-hovercard .ui-ixr-name{font-weight:750;font-size:var(--fs-16)}.ui-ix-hovercard .ui-ixr-role{color:var(--color-text-dim);font-size:var(--fs-13)}.ui-ix-hovercard .ui-ixr-bio{display:none}.ui-ix-hovercard .ui-ixr-person:hover .ui-ixr-bio,.ui-ix-hovercard .ui-ixr-person:focus-within .ui-ixr-bio{display:block}.ui-ix-hovercard .ui-ixr-bio p{margin:var(--space-3) 0;color:var(--color-text-dim)}.ui-ix-hovercard .ui-ixr-link{display:inline-block;max-width:100%;box-sizing:border-box;padding:var(--space-2) var(--space-5);border-radius:var(--radius-sm);background:var(--color-accent);color:var(--color-on-accent);font-weight:650;text-decoration:none}@container (max-width:519px){.ui-ix-hovercard .ui-ixr-person{padding:var(--space-3)}}@media print{.ui-ix-hovercard .ui-ixr-bio{display:block}.ui-ix-hovercard .ui-ixr-link{color:var(--color-text);background:var(--color-surface-soft)}}",
  render(d, h) {
    const name = h.str(d.name, "", 100), role = h.str(d.role, "", 120), avatar = h.str(d.avatar, "◎", 32), bio = h.str(d.bio, "", 2000);
    const link = h.str(d.link, "", 2000).trim();
    const safe = !/[\s\\\u0000-\u001f\u007f]/.test(link) && /^(https?:\/\/[^/]+|\/(?!\/)|#[^\s])/i.test(link);
    const uid = ixrUid(d);
    return ixrFrame(d, h, "호버 카드", name ? '<article class="ui-ixr-person" tabindex="0" aria-labelledby="' + uid + '-name"><div class="ui-ixr-person-head"><span class="ui-ixr-avatar" aria-hidden="true">' + h.esc(avatar) + '</span><div><div class="ui-ixr-name" id="' + uid + '-name">' + h.esc(name) + '</div><div class="ui-ixr-role">' + h.esc(role) + '</div></div></div><div class="ui-ixr-bio"><p>' + h.esc(bio) + '</p>' + (safe ? '<a class="ui-ixr-link" href="' + h.esc(link) + '" aria-label="' + h.esc(name + " 프로필 보기") + '">프로필 보기</a>' : "") + "</div></article>" : ixrEmpty());
  },
});

registerComponent({
  id: "ix-stepper", family: "interactive", name: "스텝퍼",
  description: "A script-free radio stepper with steps [{title, text, done}] and a zero-based current index, displaying the selected step count and text while printing every step.",
  schema: { type: "object", properties: { ...ixrProps, steps: { type: "array", maxItems: 12, items: { type: "object", properties: { title: { type: "string" }, text: { type: "string" }, done: { type: "boolean" } }, required: ["title"] } }, current: { type: "integer", minimum: 0 } }, required: ["steps"] },
  defaults: { steps: [], current: 0 }, presets: ixrPresets,
  sample: { title: "스텝퍼", subtitle: "작업의 단계를 시각적으로 보여줍니다.", steps: [{ title: "기획", text: "문제와 목표를 정리했어요.", done: true }, { title: "디자인", text: "아이디어를 화면으로 구체화하고 있어요.", done: false }, { title: "개발", text: "설계한 경험을 제품으로 만들어요.", done: false }, { title: "출시", text: "완성한 제품을 사용자에게 선보여요.", done: false }], current: 1 },
  slash: { label: "스텝퍼", hint: "단계별 진행과 설명", ico: "①", aliases: "스텝퍼 단계 진행 stepper steps process" },
  css: ixrFrameCss + ".ui-ix-stepper .ui-ixr-steps{display:grid;grid-template-columns:repeat(var(--ixr-columns),minmax(0,1fr));row-gap:var(--space-4);position:relative;margin:0;padding:0;border:0;min-width:0}.ui-ix-stepper .ui-ixr-choice,.ui-ix-stepper .ui-ixr-legend{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.ui-ix-stepper .ui-ixr-step{position:relative;text-align:center;cursor:pointer;min-width:0;order:1;padding-inline:var(--space-1);color:var(--color-text-dim);font-size:var(--fs-13)}.ui-ix-stepper .ui-ixr-step::after{content:'';position:absolute;top:16px;left:calc(50% + 22px);width:calc(100% - 44px);height:1px;background:var(--color-border)}.ui-ix-stepper .ui-ixr-step:last-of-type::after{display:none}.ui-ix-stepper .ui-ixr-marker{display:grid;place-items:center;box-sizing:border-box;width:32px;height:32px;margin:0 auto var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-pill);background:var(--color-surface-soft);color:var(--color-text-dim);font-variant-numeric:tabular-nums}.ui-ix-stepper .ui-ixr-done .ui-ixr-marker,.ui-ix-stepper .ui-ixr-choice:checked + .ui-ixr-step .ui-ixr-marker{background:var(--color-accent);color:var(--color-on-accent);border-color:var(--color-accent)}.ui-ix-stepper .ui-ixr-choice:checked + .ui-ixr-step{color:var(--color-accent-strong);font-weight:700}.ui-ix-stepper .ui-ixr-choice:focus-visible + .ui-ixr-step .ui-ixr-marker{outline:2px solid var(--color-accent);outline-offset:3px}.ui-ix-stepper .ui-ixr-panel{display:none;grid-column:1/-1;order:2;min-width:0;padding:var(--space-3);background:var(--color-surface-soft);border-radius:var(--radius-sm)}.ui-ix-stepper .ui-ixr-choice:checked + .ui-ixr-step + .ui-ixr-panel{display:block}.ui-ix-stepper .ui-ixr-step-count{display:inline-block;padding:var(--space-1) var(--space-3);border-radius:var(--radius-pill);background:var(--color-accent-soft);font-size:var(--fs-12);font-variant-numeric:tabular-nums}.ui-ix-stepper .ui-ixr-panel p{margin:var(--space-2) 0 0}.ui-ix-stepper .ui-ixr-panel-title{display:block;margin-top:var(--space-2)}@container (max-width:519px){.ui-ix-stepper .ui-ixr-steps{grid-template-columns:repeat(min(var(--ixr-columns),4),minmax(0,1fr))}.ui-ix-stepper .ui-ixr-step::after{display:none}}@media print{.ui-ix-stepper .ui-ixr-panel{display:block}.ui-ix-stepper .ui-ixr-step,.ui-ix-stepper .ui-ixr-choice{display:none}}",
  render(d, h) {
    const steps = h.list(d.steps, 12).filter(s => s && typeof s === "object" && !Array.isArray(s));
    if (!steps.length) return ixrFrame(d, h, "스텝퍼", ixrEmpty());
    const current = typeof d.current === "number" && Number.isFinite(d.current) ? Math.max(0, Math.min(steps.length - 1, Math.floor(d.current))) : 0;
    const uid = ixrUid(d);
    const body = steps.map((s, i) => {
      const id = uid + "-" + i, title = h.str(s.title, "단계 " + (i + 1), 120);
      return '<input class="ui-ixr-choice" type="radio" name="' + uid + '" id="' + id + '" aria-controls="' + id + '-panel"' + (i === current ? " checked" : "") + '><label class="ui-ixr-step' + (s.done === true ? " ui-ixr-done" : "") + '" for="' + id + '"><span class="ui-ixr-marker" aria-hidden="true">' + (s.done === true ? "✓" : i + 1) + '</span>' + h.esc(title) + (s.done === true ? '<span class="ui-ixr-legend"> (' + h.t('완료', 'done') + ')</span>' : "") + '</label><section class="ui-ixr-panel" id="' + id + '-panel" aria-label="' + h.esc(title) + '"><span class="ui-ixr-step-count">Step ' + (i + 1) + " of " + steps.length + '</span><strong class="ui-ixr-panel-title">' + h.esc(title) + '</strong><p>' + h.esc(h.str(s.text, "", 2000)) + '</p></section>';
    }).join("");
    return ixrFrame(d, h, "스텝퍼", '<fieldset class="ui-ixr-steps" style="--ixr-columns:' + Math.min(steps.length, 6) + '"><legend class="ui-ixr-legend">' + h.esc(h.str(d.title, "진행 단계 선택", 100)) + '</legend>' + body + '</fieldset>');
  },
});

registerComponent({
  id: "ix-countup", family: "interactive", name: "숫자 카운트업",
  description: "Large metrics from numbers [{value, label, delta, prefix, suffix}] with CSS-only integer count-up decoration when motion is allowed, while final numeric text remains accessible and printable.",
  schema: { type: "object", properties: { ...ixrProps, numbers: { type: "array", maxItems: 8, items: { type: "object", properties: { value: { type: "number" }, label: { type: "string" }, delta: { type: "string" }, prefix: { type: "string" }, suffix: { type: "string" } }, required: ["value"] } } }, required: ["numbers"] },
  defaults: { numbers: [] }, presets: ixrPresets,
  sample: { title: "숫자 카운트업", subtitle: "변화하는 수치를 강조하여 보여줍니다.", numbers: [{ value: 12480, label: "전체 방문자 수", delta: "+18%", prefix: "", suffix: "" }] },
  slash: { label: "숫자 카운트업", hint: "큰 숫자와 변화량 강조", ico: "#", aliases: "숫자 카운트업 지표 countup counter number metric" },
  css: ixrFrameCss + ".ui-ix-countup .ui-ixr-numbers{display:grid;grid-template-columns:repeat(var(--ixr-columns),minmax(0,1fr));gap:var(--space-5)}.ui-ix-countup .ui-ixr-metric{min-width:0}.ui-ix-countup .ui-ixr-value-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3)}.ui-ix-countup .ui-ixr-value{position:relative;max-width:100%;font-size:var(--fs-44);line-height:1.15;font-weight:780;font-variant-numeric:tabular-nums;letter-spacing:-.025em}.ui-ix-countup .ui-ixr-number-label{margin-top:var(--space-2);color:var(--color-text-dim);font-size:var(--fs-13)}.ui-ix-countup .ui-ixr-delta{padding:var(--space-1) var(--space-3);border-radius:var(--radius-pill);background:var(--color-success-bg);color:var(--color-success-fg);font-size:var(--fs-13);font-weight:650}.ui-ix-countup .ui-ixr-delta.is-down{background:var(--color-danger-bg);color:var(--color-danger-fg)}.ui-ix-countup .ui-ixr-counter{display:none}@property --ixr-counter{syntax:'<integer>';initial-value:0;inherits:false}@media (prefers-reduced-motion:no-preference){.ui-ix-countup .ui-ixr-counter{display:block;position:absolute;inset:0;background:var(--color-surface);pointer-events:none;--ixr-counter:var(--ixr-target);counter-reset:ixr-number var(--ixr-counter);animation:ixr-count var(--dur-slow) var(--ease-out),ixr-counter-hide var(--dur-slow) steps(1,end) forwards}.ui-ix-countup .ui-ixr-counter::after{content:attr(data-prefix) counter(ixr-number) attr(data-suffix)}@keyframes ixr-count{from{--ixr-counter:0}to{--ixr-counter:var(--ixr-target)}}@keyframes ixr-counter-hide{from{opacity:1}to{opacity:0}}}@container (max-width:519px){.ui-ix-countup .ui-ixr-numbers{grid-template-columns:minmax(0,1fr)}.ui-ix-countup .ui-ixr-value{font-size:var(--fs-38)}}@media print{.ui-ix-countup .ui-ixr-counter{display:none}.ui-ix-countup .ui-ixr-value{font-size:var(--fs-38)}}",
  render(d, h) {
    const numbers = h.list(d.numbers, 8).filter(n => n && typeof n === "object" && typeof n.value === "number" && Number.isFinite(n.value));
    if (!numbers.length) return ixrFrame(d, h, h.t("숫자 카운트업", "Key numbers"), ixrEmpty());
    const body = numbers.map(n => {
      const prefix = h.str(n.prefix, "", 20), suffix = h.str(n.suffix, "", 20), label = h.str(n.label, "지표", 160), delta = h.str(n.delta, "", 60);
      const value = prefix + n.value.toLocaleString("ko-KR", { maximumFractionDigits: 20 }) + suffix;
      const target = Math.round(n.value), animate = Number.isSafeInteger(target) && Math.abs(target) <= 2147483647;
      return '<div class="ui-ixr-metric"><div class="ui-ixr-value-row"><strong class="ui-ixr-value"><span class="ui-ixr-final">' + h.esc(value) + '</span>' + (animate ? '<span class="ui-ixr-counter" aria-hidden="true" style="--ixr-target:' + target + '" data-prefix="' + h.esc(prefix) + '" data-suffix="' + h.esc(suffix) + '"></span>' : "") + '</strong>' + (delta ? '<span class="ui-ixr-delta' + (/^[-−↓]/.test(delta.trim()) ? ' is-down' : '') + '">' + h.esc(delta) + '</span>' : "") + '</div><div class="ui-ixr-number-label">' + h.esc(label) + '</div></div>';
    }).join("");
    return ixrFrame(d, h, h.t("숫자 카운트업", "Key numbers"), '<div class="ui-ixr-numbers" style="--ixr-columns:' + Math.min(3, numbers.length) + '">' + body + '</div>');
  },
});
