import { registerComponent } from "../component-registry.js";

const bltPresets = { report: { compact: true }, friendly: {}, paper: {}, showcase: {} };
const bltCommon = { preset: { type: "string", enum: ["report", "friendly", "paper", "showcase"] }, compact: { type: "boolean" } };

function bltCss(id) {
  const root = ".ui-" + id;
  return root + "{container-type:inline-size;min-width:0;color:var(--color-text);overflow-wrap:anywhere}" +
    root + " .blt-card{box-sizing:border-box;min-width:0;margin:0;padding:var(--space-5);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);font-size:var(--fs-14);line-height:1.65;break-inside:avoid}" +
    root + " .blt-compact{padding:var(--space-4)}" + root + " .blt-muted{color:var(--color-text-dim);font-size:var(--fs-13)}" +
    root + " p{margin:0}" + root + " p+p{margin-top:var(--space-3)}" + root + " .blt-title{margin:0 0 var(--space-3);font-size:var(--fs-17);font-weight:700;line-height:1.4}" +
    root + "[data-preset=showcase] .blt-card{padding:var(--space-6)}" + root + "[data-preset=paper] .blt-card{background:var(--color-surface);box-shadow:none;border-radius:var(--radius-2xs)}" +
    "@container (max-width:399px){" + root + " .blt-card{padding:var(--space-4)}}" +
    "@media print{" + root + " .blt-card{box-shadow:none;print-color-adjust:exact;-webkit-print-color-adjust:exact}}";
}
function bltCard(d) { return "blt-card" + (d.compact === true ? " blt-compact" : ""); }
function bltParagraphs(value, h, empty) {
  const parts = Array.isArray(value) ? h.list(value, 24) : h.str(value, "", 12000).split(/\n\s*\n/).slice(0, 24);
  const text = parts.map((p) => h.str(p, "", 4000)).filter(Boolean);
  return text.length ? text.map((p) => "<p>" + h.rich(p) + "</p>").join("") : '<p class="blt-muted">' + h.esc(empty) + "</p>";
}
// Normalize the path before accepting it: encoded traversal cannot escape the local asset roots.
function bltImage(value, h, avatar) {
  const raw = h.str(value, "", 2000);
  if (!/^\/(?:media|kit)\/[^\s\\]+$/.test(raw)) return "";
  try {
    const url = new URL(raw, "file:///");
    const path = decodeURIComponent(url.pathname);
    if (/[\\\s%]/.test(path) || path.split("/").some((p) => p === "." || p === "..")) return "";
    if (!(avatar ? /^\/kit\/.+/ : /^\/(?:media|kit)\/.+/).test(path)) return "";
    return raw;
  } catch { return ""; }
}
function bltEmoji(value, h) {
  const text = h.str(value, "", 80);
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text) && /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f\s]+$/u.test(text) ? text : "";
}
function bltHttps(value, h) {
  const text = h.str(value, "", 2000);
  if (!/^https:\/\//i.test(text) || /[\s\\]/.test(text)) return "";
  try { return new URL(text).protocol === "https:" ? text : ""; } catch { return ""; }
}

registerComponent({
  id: "block-quote", family: "block", name: "인용문",
  description: "A serif pull quote with text, author, role and source, with a plain paper preset.",
  schema: { type: "object", properties: { ...bltCommon, text: { type: "string" }, author: { type: "string" }, role: { type: "string" }, source: { type: "string" } }, required: ["text"] },
  presets: bltPresets, defaults: { text: "" },
  sample: { text: "좋은 도구는 생각을 더 멀리, 더 깊게 확장시켜 줍니다.", author: "김민서", role: "좋은 기록이 좋은 변화를 만듭니다." },
  slash: { label: "인용문", hint: "중요한 문장을 크게 강조", ico: "❝", aliases: "인용 인용문 저자 quote pullquote quotation" },
  css: bltCss("block-quote") +
    ".ui-block-quote .blt-card{background:color-mix(in srgb,var(--color-accent) 5%,var(--color-surface))}.ui-block-quote .blt-mark{display:block;height:var(--space-8);font-family:var(--font-serif);font-size:var(--fs-56);line-height:1;color:var(--color-accent)}" +
    ".ui-block-quote blockquote{margin:var(--space-3) 0 var(--space-5);font-family:var(--font-serif);font-size:var(--fs-28);line-height:1.55;letter-spacing:-.02em}.ui-block-quote figcaption{display:grid;gap:var(--space-1)}.ui-block-quote cite{font-style:normal;font-size:var(--fs-12);color:var(--color-text-dim)}" +
    ".ui-block-quote[data-preset=paper] .blt-card{border:0;border-left:2px solid var(--color-border)}.ui-block-quote[data-preset=paper] .blt-mark{display:none}.ui-block-quote[data-preset=paper] blockquote{margin-top:0}" +
    "@container (max-width:399px){.ui-block-quote blockquote{font-size:var(--fs-24)}}",
  render(d, h) {
    const author = h.str(d.author, "", 100), role = h.str(d.role, "", 200), source = h.str(d.source, "", 300);
    return '<figure class="' + bltCard(d) + '"><span class="blt-mark" aria-hidden="true">“</span><blockquote>' + h.rich(h.str(d.text, "인용할 문장을 넣어 주세요.", 4000)) + "</blockquote>" +
      (author || role || source ? "<figcaption>" + (author ? "<strong>— " + h.esc(author) + "</strong>" : "") + (role ? '<span class="blt-muted">' + h.esc(role) + "</span>" : "") + (source ? "<cite>출처: " + h.esc(source) + "</cite>" : "") + "</figcaption>" : "") + "</figure>";
  },
});

registerComponent({
  id: "block-figure", family: "block", name: "이미지와 캡션",
  description: "An image or emoji figure with image restricted to /media/ or /kit/, required alt text, caption, credit and optional shared report figure numbering.",
  schema: { type: "object", properties: { ...bltCommon, image: { type: "string" }, emoji: { type: "string" }, alt: { type: "string" }, caption: { type: "string" }, credit: { type: "string" }, figure: { type: "boolean" } }, required: ["alt"] },
  presets: { ...bltPresets, paper: { figure: true } }, defaults: { alt: "", image: "", figure: false },
  sample: { emoji: "🏞️", alt: "산과 호수로 표현한 사용자 여정", caption: "사용자 여정 지도", credit: "사용자의 주요 행동 흐름과 접점을 시각화한 여정 지도입니다.", figure: true },
  slash: { label: "이미지와 캡션", hint: "그림 설명과 출처", ico: "▧", aliases: "그림 이미지 캡션 사진 figure image caption" },
  css: bltCss("block-figure") +
    ".ui-block-figure .blt-frame{display:grid;place-items:center;aspect-ratio:16/7;overflow:hidden;border-radius:var(--radius-sm);background:repeating-linear-gradient(135deg,var(--color-surface-soft) 0 16px,var(--color-surface) 16px 32px);border:1px solid var(--color-border)}.ui-block-figure .blt-frame img{display:block;width:100%;height:100%;min-height:0;object-fit:contain}.ui-block-figure .blt-art{font-size:var(--fs-72);line-height:1.2;white-space:pre-wrap;text-align:center;max-width:100%}.ui-block-figure .blt-placeholder{padding:var(--space-4);text-align:center;color:var(--color-text-dim)}" +
    ".ui-block-figure figcaption{margin-top:var(--space-3)}.ui-block-figure .vk-fignum{font-weight:650}.ui-block-figure .blt-credit{display:block;margin-top:var(--space-1)}.ui-block-figure .vk-numbered .vk-fignum::before{content:'그림. '}.rp .ui-block-figure .vk-numbered .vk-fignum::before{content:none}" +
    "@container (max-width:399px){.ui-block-figure .blt-frame{aspect-ratio:16/9}.ui-block-figure .blt-art{font-size:var(--fs-56)}}",
  render(d, h) {
    const image = bltImage(d.image, h, false), emoji = bltEmoji(d.emoji, h), alt = h.str(d.alt, "그림 설명을 입력해 주세요.", 500);
    const caption = h.str(d.caption, "", 500), credit = h.str(d.credit, "", 500), numbered = d.figure === true;
    const art = image ? '<img src="' + h.esc(image) + '" alt="' + h.esc(alt) + '" loading="lazy">' : emoji ? '<span class="blt-art" role="img" aria-label="' + h.esc(alt) + '">' + h.esc(emoji) + "</span>" : '<span class="blt-placeholder" role="img" aria-label="' + h.esc(alt) + '">이미지를 넣으면 여기에 표시돼요.</span>';
    return '<figure class="' + bltCard(d) + (numbered ? " vk-numbered" : "") + '"><div class="blt-frame">' + art + "</div>" +
      (caption || credit || numbered ? '<figcaption><span class="vk-fignum">' + h.rich(caption) + "</span>" + (credit ? '<span class="blt-muted blt-credit">' + h.esc(credit) + "</span>" : "") + "</figcaption>" : "") + "</figure>";
  },
});

registerComponent({
  id: "block-abstract", family: "block", name: "초록",
  description: "An abstract box with title, text as paragraphs or a blank-line-separated string, and a keywords list.",
  schema: { type: "object", properties: { ...bltCommon, title: { type: "string" }, text: { type: ["string", "array"], items: { type: "string" } }, keywords: { type: "array", items: { type: "string" } } }, required: ["text"] },
  presets: bltPresets, defaults: { title: "초록", text: [], keywords: [] },
  sample: { title: "초록", text: ["본 연구는 지식 관리 도구가 개인의 생산성에 미치는 영향을 분석한다.", "Acard를 중심으로 한 사례 연구를 통해 디지털 메모 환경이 정보 조직화, 협업 효율, 학습 지속성에 긍정적인 효과를 보임을 확인하였다."], keywords: ["지식 관리", "생산성", "협업"] },
  slash: { label: "초록", hint: "연구 요약과 핵심어", ico: "≡", aliases: "초록 요약 논문 abstract summary keywords" },
  css: bltCss("block-abstract") +
    ".ui-block-abstract .blt-card{background:color-mix(in srgb,var(--color-accent) 4%,var(--color-surface))}.ui-block-abstract .blt-keywords{display:flex;flex-wrap:wrap;gap:var(--space-2);list-style:none;margin:var(--space-4) 0 0;padding:var(--space-3) 0 0;border-top:1px solid var(--color-border)}.ui-block-abstract .blt-keywords li{max-width:100%;padding:var(--space-1) var(--space-2);border-radius:var(--radius-xs);background:var(--color-surface-soft);font-size:var(--fs-12);color:var(--color-text-dim)}.ui-block-abstract[data-preset=paper] .blt-title{font-family:var(--font-serif)}",
  render(d, h) {
    const keywords = h.list(d.keywords, 12).map((k) => h.str(k, "", 80)).filter(Boolean);
    return '<section class="' + bltCard(d) + '" aria-label="' + h.esc(h.str(d.title, "초록", 120)) + '"><h3 class="blt-title">' + h.esc(h.str(d.title, "초록", 120)) + "</h3>" + bltParagraphs(d.text, h, "연구의 핵심 내용을 요약해 주세요.") +
      (keywords.length ? '<ul class="blt-keywords" aria-label="핵심어">' + keywords.map((k) => "<li>" + h.esc(k) + "</li>").join("") + "</ul>" : "") + "</section>";
  },
});

registerComponent({
  id: "block-footnotes", family: "block", name: "각주",
  description: "A numbered notes list of {id, text} entries. Body text cites a note as [^id] (e.g. [^1]): the page draws a linked superscript number in citation order, and the note links back with ↩.",
  schema: { type: "object", properties: { ...bltCommon, notes: { type: "array", items: { type: "object", properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]+$" }, text: { type: "string" } }, required: ["id", "text"] } } }, required: ["notes"] },
  presets: bltPresets, defaults: { notes: [] },
  sample: { notes: [{ id: "1", text: "Kim, M. (2024). 디지털 노트의 사용자 경험 연구. 서울: 지식출판사." }, { id: "2", text: "Lee, J. (2023). 협업 도구가 팀 생산성에 미치는 영향. 한국정보학회지, 34(2), 123–145." }, { id: "3", text: "Park, S. (2022). 지식 관리와 학습의 연결성에 관한 연구. 한국교육공학회 논문지, 28(1), 45–67." }] },
  slash: { label: "각주", hint: "본문에 [^1]처럼 쓰면 번호로 연결되는 주석 목록", ico: "⁎", aliases: "각주 주석 미주 footnotes notes reference" },
  css: bltCss("block-footnotes") +
    ".ui-block-footnotes ol{margin:0;padding-left:var(--space-5);display:grid;gap:var(--space-2);font-size:var(--fs-13);color:var(--color-text-dim)}.ui-block-footnotes li{padding-left:var(--space-1);scroll-margin-top:var(--space-6)}.ui-block-footnotes li::marker{font-variant-numeric:tabular-nums}.ui-block-footnotes li:target{background:var(--color-accent-soft);color:var(--color-text)}.ui-block-footnotes li:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}.ui-block-footnotes .blt-back{margin-left:var(--space-1);color:var(--color-accent-strong);text-decoration:none}.ui-block-footnotes .blt-back:hover{text-decoration:underline}",
  render(d, h) {
    const seen = new Set();
    const notes = h.list(d.notes, 100).filter((n) => n && typeof n === "object").map((n) => ({ id: h.str(n.id, "", 100), text: h.str(n.text, "", 4000) })).filter((n) => {
      if (!/^[A-Za-z0-9_-]+$/.test(n.id) || !n.text || seen.has(n.id)) return false;
      seen.add(n.id); return true;
    });
    // Notes the text cites ([^id]) come first in citation order with that number and a ↩ back to the citation; the rest
    // follow as before. With no citations (or outside a page) the list is exactly the old one.
    const cited = h.page && h.page.footnotes instanceof Map ? h.page.footnotes : new Map();
    const order = notes.filter((n) => cited.has(n.id)).sort((a, b) => cited.get(a.id) - cited.get(b.id)).concat(notes.filter((n) => !cited.has(n.id)));
    const title = h.t("각주", "Notes");
    return '<section class="' + bltCard(d) + '" aria-label="' + title + '">' + (h.titleShown(title) ? '<h3 class="blt-title">' + title + '</h3>' : "") + (order.length ? "<ol>" + order.map((n, i) => {
      const num = cited.get(n.id);
      const back = num ? ' <a class="blt-back" href="#fnref-' + h.esc(n.id) + '" aria-label="' + h.t("본문으로 돌아가기", "Back to text") + '">↩</a>' : "";
      return '<li id="fn-' + h.esc(n.id) + '" tabindex="-1"' + (num && num !== i + 1 ? ' value="' + num + '"' : "") + ">" + h.rich(n.text) + back + "</li>";
    }).join("") + "</ol>" : '<p class="blt-muted">각주를 넣으면 번호와 함께 표시돼요.</p>') + "</section>";
  },
});

registerComponent({
  id: "block-author", family: "block", name: "작성자 카드",
  description: "An author card with name, role, an emoji or /kit/ image avatar, bio, HTTPS links [{label, href}] and tag.",
  schema: { type: "object", properties: { ...bltCommon, name: { type: "string" }, role: { type: "string" }, avatar: { type: "string" }, bio: { type: ["string", "array"], items: { type: "string" } }, tag: { type: "string" }, links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, href: { type: "string", pattern: "^https://" } }, required: ["label", "href"] } } }, required: ["name"] },
  presets: bltPresets, defaults: { name: "", links: [] },
  sample: { name: "김민서", role: "프로덕트 디자이너", avatar: "👩🏻‍💻", tag: "Acard", bio: "사용자의 생각이 더 나은 세상을 만드는 도구가 될 수 있다고 믿습니다. 기록을 통해 성장하는 경험을 만들기 위해 노력하고 있습니다." },
  slash: { label: "작성자 카드", hint: "작성자 소개와 링크", ico: "♙", aliases: "작성자 저자 소개 프로필 author profile bio" },
  css: bltCss("block-author") +
    ".ui-block-author .blt-person{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:var(--space-3);margin-bottom:var(--space-3)}.ui-block-author .blt-avatar{width:64px;height:64px;display:grid;place-items:center;overflow:hidden;border-radius:var(--radius-pill);background:var(--color-accent-soft);font-size:var(--fs-32)}.ui-block-author .blt-avatar img{display:block;width:100%;height:100%;object-fit:cover}.ui-block-author .blt-name{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2);margin:0 0 var(--space-1);font-size:var(--fs-17);line-height:1.4}.ui-block-author .blt-tag{max-width:100%;padding:var(--space-1) var(--space-2);border-radius:var(--radius-pill);font-size:var(--fs-11);font-weight:500;background:var(--color-accent-soft);color:var(--color-accent-strong)}" +
    ".ui-block-author .blt-links{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-4);list-style:none;padding:0;margin:var(--space-3) 0 0}.ui-block-author .blt-links li{min-width:0;max-width:100%}.ui-block-author a{color:var(--color-accent-strong);text-underline-offset:.2em}.ui-block-author a:focus-visible{outline:2px solid var(--color-accent);outline-offset:3px}" +
    "@container (max-width:399px){.ui-block-author .blt-person{grid-template-columns:48px minmax(0,1fr)}.ui-block-author .blt-avatar{width:48px;height:48px;font-size:var(--fs-28)}}",
  render(d, h) {
    const name = h.str(d.name, "작성자", 120), role = h.str(d.role, "", 200), tag = h.str(d.tag, "", 80), image = bltImage(d.avatar, h, true), emoji = bltEmoji(d.avatar, h);
    const links = h.list(d.links, 8).filter((l) => l && typeof l === "object").map((l) => ({ label: h.str(l.label, "", 100), href: bltHttps(l.href, h) })).filter((l) => l.label && l.href);
    return '<article class="' + bltCard(d) + '"><header class="blt-person"><div class="blt-avatar" aria-hidden="true">' + (image ? '<img src="' + h.esc(image) + '" alt="" loading="lazy">' : h.esc(emoji || [...name][0])) + '</div><div><h3 class="blt-name">' + h.esc(name) + (tag ? '<span class="blt-tag">' + h.esc(tag) + "</span>" : "") + "</h3>" + (role ? '<p class="blt-muted">' + h.esc(role) + "</p>" : "") + "</div></header>" +
      bltParagraphs(d.bio, h, "작성자 소개를 넣어 주세요.") + (links.length ? '<ul class="blt-links" aria-label="작성자 링크">' + links.map((l) => '<li><a href="' + h.esc(l.href) + '">' + h.esc(l.label) + "</a></li>").join("") + "</ul>" : "") + "</article>";
  },
});
