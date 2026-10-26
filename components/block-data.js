import { registerComponent } from "../component-registry.js";

// Read-only document data blocks. Each frame is local to this group; no client runtime is needed.
const bldPresets = { report: { compact: true }, friendly: {}, paper: { palette: "mono" }, showcase: { height: "l" } };
const bldProps = { title: { type: "string" }, subtitle: { type: "string" }, caption: { type: "string" }, preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] } };
function bldRows(value, h, max = 120) { return h.list(value, max).filter((row) => row && typeof row === "object" && !Array.isArray(row)); }
function bldFrame(d, h, label, body) {
  const title = h.str(d.title, label, 120), subtitle = h.str(d.subtitle, "", 240), caption = h.str(d.caption, "", 400);
  // A heading right above with the same words (## 참고문헌 + this block) already titles the block: its own title stays off.
  const shown = h.titleShown(title);
  return '<figure class="bld-frame" role="group" aria-label="' + h.esc(title) + '">' + (shown || subtitle ? '<header class="bld-head">' + (shown ? '<div class="bld-title">' + h.esc(title) + '</div>' : '') + (subtitle ? '<div class="bld-sub">' + h.esc(subtitle) + '</div>' : '') + '</header>' : '') + body + (caption ? '<figcaption class="bld-caption">' + h.esc(caption) + '</figcaption>' : '') + '</figure>';
}
function bldEmpty(h) { return '<p class="bld-empty">' + h.esc("내용을 넣으면 여기에 표시돼요.") + '</p>'; }
function bldUrl(value, h) {
  const url = h.str(value, "", 2000);
  if (!/^https?:\/\//i.test(url) || /[\s<>"']/.test(url)) return "";
  try { return new URL(url).hostname ? url : ""; } catch { return ""; }
}
function bldCss(id) {
  const root = '.ui-' + id;
  return root + '{container-type:inline-size;min-width:0}' + root + ' .bld-frame{margin:0;min-width:0;padding:var(--space-5);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);color:var(--color-text);box-shadow:var(--shadow-sm);font-size:var(--fs-14);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;break-inside:avoid}' +
    root + ' .bld-head{margin-bottom:var(--space-3)}' + root + ' .bld-title{font-size:var(--fs-17);font-weight:700;line-height:1.4}' + root + ' .bld-sub,' + root + ' .bld-caption{color:var(--color-text-dim);font-size:var(--fs-13);line-height:1.6}' + root + ' .bld-sub{margin-top:var(--space-1)}' + root + ' .bld-caption{margin-top:var(--space-3)}' + root + ' .bld-empty{margin:0;padding:var(--space-5) var(--space-3);border:1px dashed var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-dim);text-align:center}' +
    root + '[data-preset=paper] .bld-frame{box-shadow:none}' + root + '[data-preset=paper] .bld-title{font-family:var(--font-serif)}' + root + '[data-preset=friendly] .bld-frame{border-radius:var(--radius-lg)}' + root + '[data-preset=showcase] .bld-frame{padding:var(--space-6)}' +
    '@container (max-width:389px){' + root + ' .bld-frame{padding:var(--space-4)}}@media print{' + root + ' .bld-frame{box-shadow:none;print-color-adjust:exact;-webkit-print-color-adjust:exact}}';
}

registerComponent({
  id: "block-swatches", family: "block", name: "색상 팔레트",
  description: "Swatch cards from colors [{name, hex}] with validated hexadecimal data colors and a neutral fallback for invalid values.",
  schema: { type: "object", properties: { ...bldProps, colors: { type: "array", items: { type: "object", properties: { name: { type: "string" }, hex: { type: "string", pattern: "^#[0-9a-fA-F]{3,8}$" } }, required: ["hex"] } } }, required: ["colors"] },
  defaults: { colors: [] }, presets: bldPresets,
  // Palette values are sample data, encoded as integers so source styles contain no color literals.
  sample: { title: "색상 팔레트", subtitle: "Acard에서 사용하는 주요 색상입니다.", colors: [["바이올렛", 8087790], ["소프트 바이올렛", 10852351], ["아쿠아", 8839139], ["라일락", 12890868], ["스카이", 9748468], ["민트", 10804411], ["피치", 15845010], ["핑크", 15380941], ["성공", 7388069], ["오류", 14711430]].map(([name, value]) => ({ name, hex: "#" + value.toString(16).padStart(6, "0") })) },
  slash: { label: "색상 팔레트", hint: "이름과 색상 코드 카드", ico: "▦", aliases: "색상 팔레트 견본 swatches colors palette hex" },
  css: bldCss("block-swatches") + '.ui-block-swatches .bld-swatches{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--space-3) var(--space-2);padding:0;margin:0;list-style:none}.ui-block-swatches .bld-swatch{min-width:0}.ui-block-swatches .bld-chip{display:block;height:42px;border:1px solid var(--color-border);border-radius:var(--radius-xs);background:var(--sw,var(--color-neutral-bg))}.ui-block-swatches .bld-colorname{display:block;margin-top:var(--space-1);font-size:var(--fs-11);line-height:1.5}.ui-block-swatches .bld-hex{display:block;font-family:var(--font-mono);font-size:var(--fs-11);color:var(--color-text-dim);line-height:1.5}@container (max-width:389px){.ui-block-swatches .bld-swatches{grid-template-columns:repeat(3,minmax(0,1fr))}}',
  render(d, h) {
    const colors = bldRows(d.colors, h, 48);
    if (!colors.length) return bldFrame(d, h, "색상 팔레트", bldEmpty(h));
    return bldFrame(d, h, "색상 팔레트", '<ul class="bld-swatches">' + colors.map((row, i) => {
      const hex = h.str(row.hex, "", 200), valid = /^#[0-9a-fA-F]{3,8}$/.test(hex) && hex === hex.trim() && [4, 5, 7, 9].includes(hex.length), name = h.str(row.name, "색상 " + (i + 1), 80);
      return '<li class="bld-swatch"><span class="bld-chip" aria-hidden="true"' + (valid ? ' style="--sw:' + hex + '"' : '') + '></span><span class="bld-colorname">' + h.esc(name) + '</span><span class="bld-hex">' + h.esc(valid ? hex : '유효하지 않은 색상') + '</span></li>';
    }).join('') + '</ul>');
  },
});

registerComponent({
  id: "block-toc", family: "block", name: "문서 목차",
  description: "Static numbered print outline with items [{title, page, level}] at levels 1–3, separate from the live reader table of contents.",
  schema: { type: "object", properties: { ...bldProps, items: { type: "array", items: { type: "object", properties: { title: { type: "string" }, page: { type: ["string", "number"] }, level: { type: "integer", minimum: 1, maximum: 3 } }, required: ["title"] } } }, required: ["items"] },
  defaults: { items: [] }, presets: bldPresets,
  sample: { title: "문서 목차", items: [{ title: "서론", page: 1 }, { title: "관련 연구", page: 3 }, { title: "시스템 설계", page: 5 }, { title: "구현 결과", page: 8 }, { title: "사용자 평가", page: 12 }, { title: "결론 및 향후 연구", page: 15 }] },
  slash: { label: "문서 목차", hint: "인쇄용 정적 목차와 페이지", ico: "≡", aliases: "문서 목차 인쇄 outline contents toc print" },
  css: bldCss("block-toc") + '.ui-block-toc .bld-toc{display:grid;gap:var(--space-2);list-style:none;padding:0;margin:0;font-size:var(--fs-13)}.ui-block-toc .bld-tocitem{display:flex;align-items:baseline;gap:var(--space-2);min-width:0;line-height:1.6}.ui-block-toc .bld-tocnum{flex:none;color:var(--color-text-dim)}.ui-block-toc .bld-toctitle{min-width:0}.ui-block-toc .bld-leader{flex:1;min-width:var(--space-2);border-bottom:1px dotted var(--color-border)}.ui-block-toc .bld-page{max-width:25%;text-align:right;color:var(--color-text-dim)}.ui-block-toc .bld-level-2{padding-left:var(--space-4)}.ui-block-toc .bld-level-3{padding-left:var(--space-7)}@container (max-width:389px){.ui-block-toc .bld-level-2{padding-left:var(--space-2)}.ui-block-toc .bld-level-3{padding-left:var(--space-4)}}',
  render(d, h) {
    const items = bldRows(d.items, h).map((row) => ({ title: h.str(row.title, "", 400), page: h.str(row.page, "", 40), level: h.oneOf(row.level, [1, 2, 3], 1) })).filter((row) => row.title);
    if (!items.length) return bldFrame(d, h, "문서 목차", bldEmpty(h));
    const counters = [0, 0, 0];
    let previous = 0;
    return bldFrame(d, h, "문서 목차", '<ol class="bld-toc">' + items.map((row) => {
      // A skipped parent level is promoted to the next available level, never numbered 0.0.1.
      const level = Math.min(row.level, previous + 1);
      counters[level - 1] += 1;
      for (let i = level; i < counters.length; i += 1) counters[i] = 0;
      previous = level;
      const number = counters.slice(0, level).join('.');
      return '<li class="bld-tocitem bld-level-' + level + '"><span class="bld-tocnum">' + number + '.</span><span class="bld-toctitle">' + h.esc(row.title) + '</span>' + (row.page ? '<span class="bld-leader" aria-hidden="true"></span><span class="bld-page">' + h.esc(row.page) + '</span>' : '') + '</li>';
    }).join('') + '</ol>');
  },
});

registerComponent({
  id: "block-math", family: "block", name: "수식 블록",
  description: "Numbered equation source box with a tex string or lines of a derivation, a right-aligned number, and note without a TeX engine.",
  schema: { type: "object", properties: { ...bldProps, tex: { type: "string" }, lines: { type: "array", items: { type: "string" } }, number: { type: ["string", "number"] }, note: { type: "string" } }, required: ["tex"] },
  defaults: { tex: "", number: 1 }, presets: bldPresets,
  sample: { title: "수식 블록", subtitle: "수식의 TeX 원문을 깔끔하게 표시합니다.", tex: "f(x) = \\frac{1}{n} \\sum_{i=1}^{n} x_i", number: 1, note: "여기서 x_i는 i번째 관측값을 나타냅니다." },
  slash: { label: "수식 블록", hint: "번호가 있는 수식 원문", ico: "∑", aliases: "수식 방정식 유도 math equation tex derivation" },
  css: bldCss("block-math") + '.ui-block-math .bld-equation{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--space-4);padding:var(--space-6) var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-soft)}.ui-block-math .bld-tex{min-width:0;text-align:center;font-family:var(--font-mono);font-size:var(--fs-15);line-height:1.9}.ui-block-math .bld-texline{display:block;white-space:pre-wrap;overflow-wrap:anywhere}.ui-block-math .bld-eqnum{max-width:8em;font-family:var(--font-serif);font-size:var(--fs-16)}.ui-block-math .bld-note{margin:var(--space-3) 0 0;color:var(--color-text-dim);font-size:var(--fs-13);line-height:1.6}.ui-block-math[data-preset=paper] .bld-equation{background:var(--color-surface)}@container (max-width:389px){.ui-block-math .bld-equation{gap:var(--space-2);padding:var(--space-5) var(--space-3)}.ui-block-math .bld-tex{font-size:var(--fs-13)}}',
  render(d, h) {
    let lines = h.list(d.lines, 120).map((line) => h.str(line, "", 4000)).filter(Boolean);
    if (!lines.length) { const tex = h.str(d.tex, "", 16000); if (tex) lines = tex.replace(/\r\n?/g, '\n').split('\n'); }
    if (!lines.length) return bldFrame(d, h, "수식 블록", bldEmpty(h));
    const number = h.str(d.number, "1", 32), note = h.str(d.note, "", 2000);
    return bldFrame(d, h, "수식 블록", '<div class="bld-equation"><div class="bld-tex" aria-label="TeX 원문">' + lines.map((line) => '<span class="bld-texline">' + h.esc(line) + '</span>').join('') + '</div><span class="bld-eqnum">(' + h.esc(number) + ')</span></div>' + (note ? '<p class="bld-note">' + h.esc(note) + '</p>' : ''));
  },
});

registerComponent({
  id: "block-references", family: "block", name: "참고문헌",
  description: "Bibliography of references [{authors, year, title, venue, url}] with author-year APA-like or numbered IEEE-style entries.",
  schema: { type: "object", properties: { ...bldProps, style: { type: "string", enum: ["apa", "ieee"] }, references: { type: "array", items: { type: "object", properties: { authors: { type: "string" }, year: { type: ["string", "number"] }, title: { type: "string" }, venue: { type: "string" }, url: { type: "string" } }, required: ["title"] } } }, required: ["references"] },
  defaults: { references: [], style: "apa" }, presets: bldPresets,
  sample: { title: "참고문헌", subtitle: "참고문헌을 깔끔하게 정리할 수 있습니다.", style: "ieee", references: [{ authors: "Kim, M.", year: 2024, title: "디지털 노트의 사용자 경험 연구", venue: "서울: 지식출판사" }, { authors: "Lee, J.", year: 2023, title: "협업 도구가 팀 생산성에 미치는 영향", venue: "한국정보학회지, 34(2), 123–145" }, { authors: "Park, S.", year: 2022, title: "지식 관리와 학습의 연결성에 관한 연구", venue: "한국교육공학회 논문지, 28(1), 45–67" }] },
  slash: { label: "참고문헌", hint: "APA 또는 번호형 인용 목록", ico: "≡", aliases: "참고문헌 인용 출처 references bibliography citation apa ieee" },
  css: bldCss("block-references") + '.ui-block-references .bld-refs{display:grid;gap:var(--space-3);margin:0;padding:0;list-style:none;font-size:var(--fs-13);line-height:1.65}.ui-block-references .bld-ref{padding-left:var(--space-5);text-indent:calc(-1 * var(--space-5))}.ui-block-references .bld-refs.is-ieee{counter-reset:bld-ref}.ui-block-references .is-ieee .bld-ref{counter-increment:bld-ref;padding-left:2.5em;text-indent:-2.5em}.ui-block-references .is-ieee .bld-ref::before{content:"[" counter(bld-ref) "] ";display:inline-block;width:2.5em;text-indent:0;color:var(--color-text-dim)}.ui-block-references .bld-ref a{color:var(--color-accent-strong);text-decoration:underline;text-underline-offset:.2em}.ui-block-references .bld-ref a:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}',
  render(d, h) {
    const refs = bldRows(d.references, h).filter((row) => h.str(row.title, "", 600) || h.str(row.authors, "", 400));
    if (!refs.length) return bldFrame(d, h, h.t("참고문헌", "References"), bldEmpty(h));
    const style = h.oneOf(d.style, ['apa', 'ieee'], 'apa'), tag = style === 'ieee' ? 'ol' : 'ul';
    return bldFrame(d, h, h.t("참고문헌", "References"), '<' + tag + ' class="bld-refs is-' + style + '">' + refs.map((row) => {
      const authors = h.str(row.authors, "저자 미상", 400), year = h.str(row.year, "연도 미상", 40), title = h.str(row.title, "제목 없음", 600), venue = h.str(row.venue, "", 600), url = bldUrl(row.url, h);
      const text = style === 'apa' ? h.esc(authors) + ' (' + h.esc(year) + '). <cite>' + h.esc(title) + '</cite>.' + (venue ? ' ' + h.esc(venue) + '.' : '') : h.esc(authors) + ', “' + h.esc(title) + ',”' + (venue ? ' <cite>' + h.esc(venue) + '</cite>,' : '') + ' ' + h.esc(year) + '.';
      return '<li class="bld-ref">' + text + (url ? ' <a href="' + h.esc(url) + '">' + h.esc(url) + '</a>' : '') + '</li>';
    }).join('') + '</' + tag + '>');
  },
});

registerComponent({
  id: "block-checklist", family: "block", name: "체크리스트",
  description: "Read-only checklist with items [{text, done}], a completed/total progress bar, and paper checkbox marks.",
  schema: { type: "object", properties: { ...bldProps, items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, done: { type: "boolean" } }, required: ["text"] } } }, required: ["items"] },
  defaults: { items: [] }, presets: bldPresets,
  sample: { title: "체크리스트", subtitle: "할 일을 체크하며 진행 상황을 관리합니다.", items: [{ text: "프로젝트 기획서 초안 작성", done: true }, { text: "디자인 시안 검토", done: true }, { text: "개발 일정 조율", done: true }, { text: "사용자 피드백 수집", done: false }, { text: "최종 배포 준비", done: false }] },
  slash: { label: "체크리스트", hint: "읽기 전용 할 일과 진행률", ico: "☑", aliases: "체크리스트 할일 진행률 checklist tasks progress" },
  css: bldCss("block-checklist") + '.ui-block-checklist .bld-progress{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-4)}.ui-block-checklist .bld-progress strong{font-size:var(--fs-13);font-weight:600;white-space:nowrap}.ui-block-checklist .bld-track{height:12px;flex:1;overflow:hidden;border-radius:var(--radius-pill);background:var(--color-surface-soft)}.ui-block-checklist .bld-fill{display:block;height:100%;background:var(--color-accent);border-radius:inherit}.ui-block-checklist .bld-items{display:grid;gap:var(--space-3);margin:0;padding:0;list-style:none}.ui-block-checklist .bld-item{display:flex;align-items:flex-start;gap:var(--space-3);line-height:1.5}.ui-block-checklist .bld-check{display:grid;place-items:center;flex:none;width:20px;height:20px;border:1px solid var(--color-border);border-radius:var(--radius-xs);font-size:var(--fs-14)}.ui-block-checklist .bld-item.is-done .bld-check{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-on-accent)}.ui-block-checklist[data-preset=paper] .bld-check{border:0;background:none;color:var(--color-text);font-size:var(--fs-20)}.ui-block-checklist[data-preset=paper] .bld-fill{background:var(--color-text)}',
  render(d, h) {
    const items = bldRows(d.items, h).map((row) => ({ text: h.str(row.text, "", 600), done: row.done === true })).filter((row) => row.text);
    if (!items.length) return bldFrame(d, h, "체크리스트", bldEmpty(h));
    const done = items.filter((row) => row.done).length, percent = Math.round(done / items.length * 10000) / 100;
    const progress = '<div class="bld-progress"><strong>' + done + '/' + items.length + '</strong><div class="bld-track" role="progressbar" aria-label="완료 항목" aria-valuemin="0" aria-valuemax="' + items.length + '" aria-valuenow="' + done + '"><span class="bld-fill" style="width:' + percent + '%"></span></div></div>';
    return bldFrame(d, h, "체크리스트", progress + '<ul class="bld-items">' + items.map((row) => '<li class="bld-item' + (row.done ? ' is-done' : '') + '"><span class="bld-check" role="img" aria-label="' + (row.done ? '완료' : '미완료') + '">' + (d.preset === 'paper' ? (row.done ? '☑' : '☐') : (row.done ? '✓' : '')) + '</span><span>' + h.esc(row.text) + '</span></li>').join('') + '</ul>');
  },
});

registerComponent({
  id: "block-code", family: "block", name: "코드 블록",
  description: "Plain escaped code with filename, language, CSS line numbers, highlight line numbers, caption, and a decorative copy label.",
  schema: { type: "object", properties: { ...bldProps, filename: { type: "string" }, language: { type: "string" }, code: { type: "string" }, highlight: { type: "array", items: { type: "integer", minimum: 1 } } }, required: ["code"] },
  defaults: { code: "" }, presets: bldPresets,
  sample: { title: "코드 블록", subtitle: "코드 예시를 깔끔하게 표시합니다.", filename: "hello.py", language: "Python", code: 'def main():\n    # Acard에 오신 것을 환영합니다!\n    message = "안녕하세요, Acard!"\n    print(message)\n\nif __name__ == "__main__":\n    main()', highlight: [3] },
  slash: { label: "코드 블록", hint: "파일명과 줄 번호가 있는 코드", ico: "⌘", aliases: "코드 소스 파일 code source snippet" },
  css: bldCss("block-code") + '.ui-block-code .bld-codebox{min-width:0;overflow:hidden;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-soft)}.ui-block-code .bld-codehead{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--color-border);background:var(--color-raised);font-size:var(--fs-12)}.ui-block-code .bld-file{flex:1;min-width:0;font-weight:600}.ui-block-code .bld-lang{color:var(--color-text-dim)}.ui-block-code .bld-copy{padding:var(--space-1) var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-xs);color:var(--color-text-dim)}.ui-block-code .bld-code-scroll{margin:0;padding:var(--space-3) 0;max-width:100%;overflow-x:auto;white-space:pre;font-family:var(--font-mono);font-size:var(--fs-12);line-height:1.75;tab-size:4;background:none;color:var(--color-text)}.ui-block-code .bld-code-scroll:focus-visible{outline:2px solid var(--color-accent);outline-offset:-2px}.ui-block-code .bld-source{display:block;min-width:100%;width:max-content;counter-reset:bld-line;background:none;padding:0;font:inherit;color:inherit}.ui-block-code .bld-line{display:block;min-height:1.75em;padding-right:var(--space-4);counter-increment:bld-line}.ui-block-code .bld-line::before{content:counter(bld-line);display:inline-block;width:3.5em;padding-right:1em;text-align:right;color:var(--color-text-dim);user-select:none}.ui-block-code .bld-line.is-highlight{background:var(--color-accent-soft)}@media print{.ui-block-code .bld-code-scroll{overflow:visible;white-space:pre-wrap}.ui-block-code .bld-source{width:auto}.ui-block-code .bld-line{overflow-wrap:anywhere}.ui-block-code .bld-copy{display:none}}',
  render(d, h) {
    const code = h.str(d.code, "", 100000), filename = h.str(d.filename, h.t("코드", "Code"), 160), language = h.str(d.language, "", 40);
    if (!code) return bldFrame(d, h, h.t("코드 블록", "Code"), bldEmpty(h));
    const highlighted = new Set(h.list(d.highlight, 10000).filter((n) => Number.isInteger(n) && n > 0));
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    return bldFrame(d, h, h.t("코드 블록", "Code"), '<div class="bld-codebox"><div class="bld-codehead"><span class="bld-file">' + h.esc(filename) + '</span><span class="bld-lang">' + h.esc(language) + '</span><span class="bld-copy" aria-hidden="true">⧉ ' + h.t('복사', 'Copy') + '</span></div><pre class="bld-code-scroll" tabindex="0" role="region" aria-label="' + h.esc(filename + ' 코드') + '"><code class="bld-source">' + lines.map((line, i) => '<span class="bld-line' + (highlighted.has(i + 1) ? ' is-highlight' : '') + '">' + h.esc(line) + '</span>').join('') + '</code></pre></div>');
  },
});
