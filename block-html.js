import { equationHtml } from "./equation-html.js";
import { visualBlockHtml, htmlHeadings } from "./visual-html.js";
import { partBlockHtml, partSuggestLine, PART_DEFAULT_IDS, PART_RUNTIME } from "./part-html.js";
import { renderComponentBlock, fallbackCardHtml, componentOwnCss, familyCss, getComponent, COMPONENT_BASE_CSS, uiDataIsEnglish, footnoteOrder, FOOTNOTE_REF } from "./component-registry.js";
import "./components/index.js";
import "./assets/editor-model.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}


function blockInline(block) {
  if (block.meta && Array.isArray(block.meta.richText) && globalThis.EditorModel) return footnoteRefs(evidenceTags(globalThis.EditorModel.richHtml(wikiRuns(block.meta.richText), block.text)));
  return footnoteRefs(inline(block.text));
}

// Footnote references (acard-footnote-fix): [^id] in text naming a note of the page's footnotes block draws as a linked
// superscript number (citation order, component-registry.js footnoteOrder); the note's ↩ comes back to the first one.
// Runs on finished inline HTML, outside tags, code and links; a mark naming no note stays as typed.
let pageFootnotes = null;
const footnoteCited = new Set();
function footnoteRefs(html) {
  if (!pageFootnotes || !pageFootnotes.size || !html.includes("[^")) return html;
  let inCode = 0, inLink = 0;
  return html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith("<")) {
      const tag = /^<(\/?)(code|a)\b/i.exec(part);
      if (tag) { const d = tag[1] ? -1 : 1; if (tag[2].toLowerCase() === "code") inCode += d; else inLink += d; }
      return part;
    }
    if (inCode > 0 || inLink > 0) return part;
    return part.replace(FOOTNOTE_REF, (mark, id) => {
      const n = pageFootnotes.get(id);
      if (!n) return mark;
      const first = !footnoteCited.has(id);
      footnoteCited.add(id);
      return '<sup class="fnref"><a href="#fn-' + id + '"' + (first ? ' id="fnref-' + id + '"' : "") + ">" + n + "</a></sup>";
    });
  }).join("");
}
// Superscript in the link color and the small type step; a jumped-to citation shows like a jumped-to note (li:target).
export const FOOTNOTE_CSS = ".fnref{font-size:var(--fs-12);line-height:0;vertical-align:super;font-variant-numeric:tabular-nums}.fnref a{padding:0 1px;color:var(--accent);text-decoration:none;scroll-margin-top:var(--space-6)}.fnref a:hover{text-decoration:underline}.fnref a:target{border-radius:var(--radius-2xs);background:var(--color-accent-soft)}";

// [[대상]], [[대상|별칭]], [[대상#제목]]: 대상은 슬러그가 먼저, 아니면 휴지통 밖 페이지 제목(대소문자·공백 무시, 최근 수정 우선).
// 제목 목록(index)이 없으면 공백 없는 대상만 슬러그로 본다. renderBlocks 가 ctx.pages 로 한 번 만들어 wikiPages 에 둔다.
export const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g;
let wikiPages = null;
const wikiKey = (text) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function wikiIndex(pages) {
  const slugs = new Set(), titles = new Map(), stamps = new Map();
  for (const page of pages || []) {
    const slug = String(page.slug), key = wikiKey(page.title), stamp = Number(page.updated) || 0;
    slugs.add(slug);
    if (key && (!titles.has(key) || stamp > stamps.get(key))) { titles.set(key, slug); stamps.set(key, stamp); }
  }
  return { slugs, titles };
}

export function wikiTarget(raw, index) {
  const bar = raw.indexOf("|");
  const head = bar < 0 ? raw : raw.slice(0, bar);
  const hash = head.indexOf("#");
  const name = (hash < 0 ? head : head.slice(0, hash)).trim();
  const heading = hash < 0 ? "" : head.slice(hash + 1).trim();
  const alias = bar < 0 ? "" : raw.slice(bar + 1).trim();
  if (!name) return null;
  const slug = index && index.slugs.has(name) ? name : (index && index.titles.get(wikiKey(name))) || (/\s/.test(name) ? null : name);
  if (!slug) return null;
  return { slug, href: "/" + slug + "/" + (heading ? "#" + headingSlug(heading) : ""), text: alias || name };
}

function wikiRuns(runs) {
  return runs.flatMap((run) => {
    if (!run || typeof run.text !== "string" || run.href || run.mention || run.code || !run.text.includes("[[")) return [run];
    const out = [];
    let offset = 0;
    for (const match of run.text.matchAll(WIKI_LINK)) {
      const link = wikiTarget(match[1], wikiPages);
      if (!link) continue;
      if (match.index > offset) out.push({ ...run, text: run.text.slice(offset, match.index) });
      out.push({ ...run, text: link.text, href: link.href });
      offset = match.index + match[0].length;
    }
    if (offset < run.text.length) out.push({ ...run, text: run.text.slice(offset) });
    return out;
  });
}

// Evidence labels (research report style): the text [MEASURED], [CLAIMED] or [ESTIMATED] draws as a colored tag. The stored
// text and markdown keep the bracket word, so exports, agents and an older build show it as plain text. Runs on escaped HTML.
const EVIDENCE = /\[(MEASURED|CLAIMED|ESTIMATED)\]/g;
export function evidenceTags(html) {
  return String(html).replace(EVIDENCE, (_, kind) => '<span class="ev ev-' + kind.toLowerCase() + '">' + kind + "</span>");
}
// Tag look on every page (the tag can appear anywhere), in the page's own font and the success/warning/info tones.
// Inline with the first tag of a page.
export const EVIDENCE_CSS = ".ev{display:inline-block;font-size:var(--fs-11);font-weight:600;letter-spacing:.03em;border-radius:var(--radius-pill);padding:0 var(--space-2);vertical-align:1px;white-space:nowrap;line-height:1.7}" +
  ".ev-measured{background:var(--color-success-bg);color:var(--color-success-fg)}.ev-claimed{background:var(--color-warning-bg);color:var(--color-warning-fg)}.ev-estimated{background:var(--color-info-bg);color:var(--color-info-fg)}";

export function inline(text) {
  const source = String(text);
  // Tokenize before escaping: destinations and code are opaque, never input to emphasis replacements.
  const tokens = /`(?<code>[^`]+)`|\[\[(?<wiki>[^[\]\n]+)\]\]|\[(?<label>[^\]]+)\]\((?<href>(?:\/|#|https?:)[^)\s]+)\)|(?<url>https?:\/\/[^\s<>]+)|\*\*(?<bold>[^*]+)\*\*|(?<![\p{L}\p{N}_*])\*(?!\s)(?<star>[^*\n]*?[^\s*])\*(?![\p{L}\p{N}_*])|(?<![\p{L}\p{N}_])_(?!\s)(?<under>[^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu;
  let html = "", offset = 0;
  for (const match of source.matchAll(tokens)) {
    html += escapeHtml(source.slice(offset, match.index));
    const { code, wiki, label, href, url, bold, star, under } = match.groups;
    if (code !== undefined) html += "<code>" + escapeHtml(code) + "</code>";
    else if (wiki !== undefined) {
      const link = wikiTarget(wiki, wikiPages);
      html += link ? '<a href="' + escapeHtml(link.href) + '">' + escapeHtml(link.text) + "</a>" : escapeHtml(match[0]);
    }
    else if (href !== undefined) html += globalThis.EditorModel.safeHref(href) ? '<a href="' + escapeHtml(href) + '"' + (/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : "") + ">" + inline(label) + "</a>" : inline(label);
    else if (url !== undefined) html += escapeHtml(url);
    else if (bold !== undefined) html += "<strong>" + inline(bold) + "</strong>";
    else html += "<em>" + inline(star ?? under) + "</em>";
    offset = match.index + match[0].length;
  }
  return evidenceTags(html + escapeHtml(source.slice(offset)));
}

function legacyDatabaseHtml(block, ctx) {
  const meta = block.meta;
  const columns = Array.isArray(meta && meta.columns) ? meta.columns : [];
  const rows = Array.isArray(meta && meta.rows) ? meta.rows : [];
  // The block id goes along so "[ ]" cells stay checkable; lazy/checks.js writes rows[r][column name] for this block type.
  return renderBlocks([{ id: block.id, type: "table", meta: { columns, rows: rows.map((row) => columns.map((name) => row && row[name])) } }], ctx).replace(/^<span id="block-[^"]*"><\/span>/, "");
}

function headingSlug(text) {
  const s = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().replace(/\s+/g, "-");
  return s.slice(0, 60) || "section";
}

const EMBED_HOSTS = [
  "youtube.com", "youtube-nocookie.com", "youtu.be", "vimeo.com", "player.vimeo.com",
  "codepen.io", "codesandbox.io", "gist.github.com", "docs.google.com", "figma.com",
  "soundcloud.com", "spotify.com", "open.spotify.com", "maps.google.com",
];

// Acard's own origins never load inside a page (a framed copy of the app could act with the reader's cookies).
const SELF_HOSTS = ["notes.example.com", "notes-example.pages.dev", "localhost"];

// notion-parity C11: "trusted" = the known players (EMBED_HOSTS, unchanged frame), "sandboxed" = any other https site in a
// sandboxed frame (widgets: charts, clocks, github.io / lovable.app pages), null = refused (not https, Acard itself, an IP).
export function embedMode(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || SELF_HOSTS.some((h) => host === h || host.endsWith("." + h))) return null;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[") || !host.includes(".")) return null;
  return EMBED_HOSTS.some((h) => host === h || host.endsWith("." + h)) ? "trusted" : "sandboxed";
}

// meta.height of an embed: 120..2000 px, or 0 = the default 16:9 box.
export function embedHeight(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(2000, Math.max(120, n)) : 0;
}

// Notion-style block colors (notion-parity C6): the same ten names as db-model.js OPTION_COLORS, as text or as background.
export const BLOCK_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

// A stored meta.color -> its class (bc-red, bc-yellow_background), or "" for default / anything not in the list.
export function blockColor(name) {
  const m = /^([a-z]+)(_background)?$/.exec(String(name || ""));
  if (!m || BLOCK_COLORS.indexOf(m[1]) < 1) return "";
  return "bc-" + m[0];
}

// A stored callout meta.icon -> a short emoji / text, or "" (then the default line icon stays).
export function calloutIcon(icon) {
  const s = typeof icon === "string" ? icon.trim() : "";
  return s && [...s].length <= 8 ? s : "";
}

// Block color rules ride inline once per page that uses a color (like AGENT_MEDIA_STYLE), so pages without colors and the
// first-screen budget stay the same and public links (style-src 'unsafe-inline') get them too. Same rules as the editor chunk.
// tokens.css has no brown tag color, so its light/dark pair rides here (4.5:1+ like the others; tests/block-html.test.ts).
const BROWN_LIGHT = "--tag-brown-bg:#f3ece5;--tag-brown-fg:#7a5230", BROWN_DARK = "--tag-brown-bg:#3a2e24;--tag-brown-fg:#e3bf98";
export const BLOCK_COLOR_CSS = ":root{" + BROWN_LIGHT + '}html[data-theme="dark"]{' + BROWN_DARK + '}@media (prefers-color-scheme:dark){html:not([data-theme="light"]):not([data-theme="dark"]){' + BROWN_DARK + "}}" + BLOCK_COLORS.slice(1).map((c) => ".bc-" + c + "{color:var(--tag-" + c + "-fg)}.bc-" + c + "_background,.blocks .bc-" + c + "_background,.blocks .callout.bc-" + c + "_background{background:var(--tag-" + c + "-bg)}").join("") +
  '.blocks [class*="_background"]:not(.callout){border-radius:var(--radius-xs);padding-inline:6px}.blocks .callout[class*="_background"]{border-color:transparent}span.callout-ico{font-size:var(--fs-19);line-height:1.2}';
const BLOCK_COLOR_STYLE = "<style>" + BLOCK_COLOR_CSS + "</style>";
// Heading 4 (notion-parity C16) rides inline the same way: the reader first-screen CSS had no bytes left.
export const HEADING4_CSS = "article h5,.blocks h5{font-size:var(--fs-15);font-weight:650;line-height:1.45;margin:20px 0 4px}.blocks .tocblock .lvl5{padding-left:54px}";
const HEADING4_STYLE = "<style>" + HEADING4_CSS + "</style>";
// Research report page style (font "report"). Owner 2026-10-23: a report page looks like any other Acard page (same fonts,
// background, width, byline place, tiles, tables). It only adds numbering, inline in the reader and the shared link and
// scoped to .rp: every equation block is numbered (1)(2)..., a captioned figure is numbered 그림 1, 2 ...
// The evidence tags (EVIDENCE_CSS) draw on every page.
const RP = ".rp";
export const REPORT_CSS = [
  RP + "{counter-reset:rp-eq rp-fig}",
  RP + " .mathblock{position:relative;counter-increment:rp-eq;padding-inline:3.2em}" + RP + " .mathblock::after{content:'(' counter(rp-eq) ')';position:absolute;right:var(--space-4);top:50%;transform:translateY(-50%);font-size:var(--fs-13);color:var(--fg-dim);font-style:normal;font-variant-numeric:tabular-nums}",
  RP + " figure:has(figcaption){counter-increment:rp-fig}" + RP + " figure figcaption::before{content:'\\ADF8\\B9BC  ' counter(rp-fig) '. ';font-weight:600}" + RP + " figure:lang(en) figcaption::before{content:'Figure ' counter(rp-fig) '. '}",
  "@media (max-width:500px){" + RP + " .mathblock{padding-inline:2.4em}}",
].join("");
export const isReportPage = (settings) => Boolean(settings && settings.font === "report");
// Toggle headings (notion-parity C7): the heading sits beside the toggle arrow inside its summary.
export const TOGGLE_HEADING_CSS = ".blocks details.toggle.heading>summary{display:flex;align-items:center;gap:2px;font-weight:inherit}.blocks details.toggle.heading>summary>:is(h2,h3,h4,h5){margin:0;display:inline}";
// A TOC link (or any #hash) to a heading inside a closed toggle heading opens the toggles around it, then scrolls there.
// Inline and only on pages with a toggle heading (the reader first-screen script had no bytes left); public links drop
// scripts by their CSP, where the toggle still opens by click.
export const TOGGLE_HEADING_JS = "(function(){function o(){var h=decodeURIComponent(location.hash.slice(1)),t=h&&document.getElementById(h),p=t;if(!t)return;while(p=p.parentElement)if(p.tagName=='DETAILS')p.open=true;t.scrollIntoView()}addEventListener('hashchange',o);document.readyState=='loading'?addEventListener('DOMContentLoaded',o):o()})()";
const TOGGLE_HEADING_STYLE = "<style>" + TOGGLE_HEADING_CSS + "</style><script>" + TOGGLE_HEADING_JS + "</script>";

function withClass(html, cls) {
  // Skip a leading inline <style> so the class lands on the block element itself.
  const lead = /^(?:<style>[^<]*<\/style>|<script>[^<]*<\/script>)*/.exec(html);
  const start = lead ? lead[0].length : 0;
  const m = /^<([a-z][a-z0-9]*)([^>]*)>/.exec(html.slice(start));
  if (!m) return html;
  const attrs = /\sclass="/.test(m[2]) ? m[2].replace(/\sclass="/, ' class="' + cls + " ") : ' class="' + cls + '"' + m[2];
  return html.slice(0, start) + "<" + m[1] + attrs + ">" + html.slice(start + m[0].length);
}

export function tableHeaderIcon(name, type) {
  return ico(({ 상태: "circle-dot", 담당: "users", 담당자: "users", 우선순위: "star", 진행률: "list-checks", 마감일: "calendar", "다음 할 일": "list-checks" })[name] || ({ status: "circle-dot", date: "calendar", number: "list-checks", checkbox: "square", select: "tag", multi_select: "tag" })[type] || "type");
}

export function tablePersonHtml(name) {
  return '<span class="table-person">' + avatarHtml(name) + '<span>' + escapeHtml(name) + '</span></span>';
}

export function tableHeadingHtml() {
  return '<h3 class="table-heading">' + ico("table") + '<span>주요 작업 목록</span></h3>';
}

export function tableDateHtml(value) {
  if (!String(value || "").trim() || /^[-—–]$/.test(String(value).trim())) return '<span class="dbnodate">마감일 없음</span>';
  return escapeHtml(String(value || "").replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_m, y, m, d) => y + "년 " + Number(m) + "월 " + Number(d) + "일"));
}

export function tableProgressHtml(value, complete) {
  const amount = Math.max(0, Math.min(100, Number(String(value).replace(/%$/, "")) || 0));
  return '<span class="numwrap' + (complete ? ' complete' : '') + '"><span class="numtext">' + amount + '%</span><span class="numbartrack"><span class="numbar" style="width:' + amount + '%"></span></span></span>';
}

export function tableNewHtml(slug) {
  return '<a class="table-new" href="/edit/' + encodeURIComponent(slug) + '/">' + ico("plus") + '<span>새 작업</span><span class="table-new-tail">' + ico("chevron-down") + '</span></a>';
}

// 제목이 이보다 많은 목차는 하위 제목을 접어서 보여 준다.
const TOC_FOLD_AT = 12;

// Inline once per page that has agent images, so the reader's first screen stays the same and the published page's
// CSP (style-src 'unsafe-inline' only) still applies it.
const AGENT_MEDIA_STYLE = "<style>.blocks .imgby{display:inline-flex;align-items:center;gap:6px;margin:14px 0 -8px;padding:3px 10px;border-radius:8px;background:rgba(123,104,238,.1);color:#5b47d6;font-size:var(--fs-13);font-weight:600}.blocks .imgby .ico{width:15px;height:15px}.blocks .imgrow{display:flex;flex-wrap:wrap;gap:14px;margin:18px 0}.blocks .imgrow figure.img{margin:0;min-width:min(120px,100%)}.blocks .imgmiss{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:96px;padding:14px;border:1px dashed var(--line);border-radius:var(--radius-md);background:var(--bg-soft);color:var(--fg-dim);font-size:var(--fs-13);text-align:center}.blocks .imgmiss small{font-size:var(--fs-12);opacity:.8;overflow-wrap:anywhere}.blocks figure.img .imgview{position:relative}.blocks .imgtime{position:absolute;left:8px;bottom:8px;padding:2px 8px;border-radius:6px;background:rgba(20,20,30,.72);color:#fff;font-size:var(--fs-13);font-variant-numeric:tabular-nums}@media (max-width:640px){.blocks .imgrow{flex-direction:column}}</style>";

function figureHtml(block, inRow) {
  const meta = block.meta || {};
  const src = String(meta.src || "");
  const width = Number.isFinite(meta.width) ? Math.min(100, Math.max(10, meta.width)) : 100;
  const box = ' style="' + (inRow ? (width < 100 ? "flex:0 1 " + width + "%" : "flex:1 1 0") : "width:" + width + "%") + '"';
  const caption = block.text ? "<figcaption>" + inline(block.text) + "</figcaption>" : "";
  // Issue 176: an address the browser cannot load (a local path the agent's machine never uploaded, e.g. a Codex clipboard
  // temp file) draws a placeholder with the file name instead of the raw path, and keeps its place in the row.
  if (!globalThis.EditorModel.safeHref(src)) {
    const name = /^data:/i.test(src) ? "" : src.split(/[\\/]/).pop().slice(0, 80);
    return '<figure class="img"' + box + '><div class="imgmiss" role="img" aria-label="이미지를 불러올 수 없어요"><span>이미지를 불러올 수 없어요</span>' + (name ? "<small>" + escapeHtml(name) + "</small>" : "") + "</div>" + caption + "</figure>";
  }
  const alt = block.text || "이미지";
  const time = typeof meta.time === "string" && /^\d{1,2}(?::\d{2}){1,2}$/.test(meta.time) ? meta.time : "";
  const dimensions = Number.isFinite(meta.iw) && meta.iw > 0 && Number.isFinite(meta.ih) && meta.ih > 0 ? ' width="' + meta.iw + '" height="' + meta.ih + '" style="height:auto"' : "";
  const media = /^\/media\/[^/?#]+$/.test(src) && !/\.(svg|gif)$/i.test(src) && !/^image\/(svg|gif)/i.test(meta.mime || meta.type || "");
  const responsive = media ? ' srcset="' + [400, 800, 1600].map((w) => escapeHtml(src) + '?w=' + w + ' ' + w + 'w').join(', ') + '" sizes="(max-width: 760px) 100vw, 760px"' : "";
  // An English caption marks the figure lang="en", so a report page numbers it "Figure N." (REPORT_CSS) instead of 그림 N.
  return '<figure class="img"' + (block.text && uiDataIsEnglish(block.text) ? ' lang="en"' : "") + box + ">" +
    '<a class="imgview" href="' + escapeHtml(src) + '"><img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '"' + dimensions + responsive + ' decoding="async" loading="lazy">' +
    (time ? '<span class="imgtime">' + time + "</span>" : "") + "</a>" +
    caption +
    "</figure>";
}

// A columns block and the blocks under it (notion-parity C13): each direct column child is one .col holding its own
// blocks. Widths come from meta.widths as fr units; on a phone the grid is one column (style.css).
function columnsHtml(block, branch, ctx, headingContext) {
  const base = (block.indent || 0) + 1;
  const cols = [];
  for (let i = 0; i < branch.length; i += 1) {
    let end = i + 1;
    while (end < branch.length && (branch[end].indent || 0) > (branch[i].indent || 0)) end += 1;
    if (branch[i].type === "column" && (branch[i].indent || 0) === base) cols.push(renderBlocks(branch.slice(i + 1, end), ctx, headingContext));
    i = end - 1;
  }
  if (!cols.length) return "";
  return '<div class="cols cols' + cols.length + '" style="--cols:' + columnTemplate(block.meta && block.meta.widths, cols.length) + '">' + cols.map((html) => '<div class="col">' + html + "</div>").join("") + "</div>";
}

// grid-template-columns for n columns: meta.widths as fr units when they match, else equal columns.
function columnTemplate(widths, n) {
  const list = Array.isArray(widths) && widths.length === n ? widths : Array(n).fill(1 / n);
  return list.map((w) => Math.max(0.05, Number(w) || 0).toFixed(4).replace(/\.?0+$/, "") + "fr").join(" ");
}

// Types the switch above handles without output when empty (no fallback card for them).
const KNOWN_EMPTY = new Set(["paragraph", "subpage", "photo-text"]);

// Expanded blocks are response-only. Never put these IDs or flags back into page storage.
export function materializeSyncedBlocks(blocks, resolved = [], canonicalEditable = false) {
  const instances = new Map(resolved.map(item => [item.id, item]));
  const out = [];
  const hex = value => Array.from(String(value)).map(char => char.codePointAt(0).toString(16).padStart(6, "0")).join("");
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type !== "synced") { out.push(block); continue; }
    while (index + 1 < blocks.length && (blocks[index + 1].indent || 0) > (block.indent || 0)) index++;
    const item = instances.get(block.id);
    if (item?.status !== "available") {
      out.push({ id: block.id, type: "paragraph", text: "Synced content unavailable", indent: block.indent || 0, syncedUnavailable: true });
      continue;
    }
    if (canonicalEditable && block.meta?.synced?.source === null) {
      out.push(...item.blocks.map(child => ({ ...child, indent: (block.indent || 0) + (child.indent || 0) })));
      continue;
    }
    const scope = "synced-" + hex(block.id) + "-";
    out.push(...item.blocks.map(child => ({ ...child, id: scope + hex(child.id), indent: (block.indent || 0) + (child.indent || 0), syncedScope: scope, syncedReadOnly: true })));
  }
  return out;
}

export function renderBlocks(blocks, ctx, headingContext) {
  if (!headingContext && ctx && Array.isArray(ctx.pages) && wikiPages === null) {
    wikiPages = ctx.wikiPages || (ctx.wikiPages = wikiIndex(ctx.pages));
    try { return renderBlocks(blocks, ctx); } finally { wikiPages = null; }
  }
  // Old text-only columns draw as column blocks (notion-parity C13); a nested call already has converted input.
  if (!headingContext && globalThis.ColumnsModel) blocks = globalThis.ColumnsModel.columnsFromLegacy(blocks);
  // Footnote numbers are set once per page in text order; nested calls (children, columns) share them.
  if (!headingContext) {
    const saved = pageFootnotes, savedCited = new Set(footnoteCited);
    pageFootnotes = footnoteOrder(blocks);
    footnoteCited.clear();
    try { return renderBlocksIn(blocks, ctx, headingContext); }
    finally { pageFootnotes = saved; footnoteCited.clear(); savedCited.forEach((id) => footnoteCited.add(id)); }
  }
  return renderBlocksIn(blocks, ctx, headingContext);
}

function renderBlocksIn(blocks, ctx, headingContext) {
  const out = [];
  // The heading right before a block at this level: a footnotes or references block under the same words hides its title.
  let prevHeading = "";
  let listType = null;
  let listItems = [];

  // 제목 id 는 문서 순서로 한 번만 정한다. 목차 블록이 제목보다 앞에 있어도 같은 id 를 쓴다.
  const seen = new Map();
  const headingIds = headingContext ? headingContext.headingIds : new Map();
  const headings = headingContext ? headingContext.headings : [];
  // One color <style> per page: ctx carries it across calls (intro + body), colorOnce across child calls without a ctx.
  const colorOnce = headingContext && headingContext.colorOnce ? headingContext.colorOnce : { done: false };
  const h4Style = () => { if (colorOnce.h4 || (ctx && ctx.heading4Css)) return ""; colorOnce.h4 = true; if (ctx) ctx.heading4Css = true; return HEADING4_STYLE; };
  // ds10: component rules ride inline (published pages drop <link>s): the shared base once per page, then each
  // component's own rules once, just before its first block. ctx carries both across calls (intro + body).
  const uiSeen = colorOnce.uiIds || (colorOnce.uiIds = (ctx && ctx.componentIds) || new Set());
  if (ctx) ctx.componentIds = uiSeen;
  const uiStyle = (id) => {
    let css = "";
    if (!colorOnce.ui && !(ctx && ctx.componentCss)) { colorOnce.ui = true; if (ctx) ctx.componentCss = true; css += COMPONENT_BASE_CSS; }
    const fam = id && getComponent(id) ? getComponent(id).family : "";
    if (fam && !uiSeen.has("family:" + fam)) { uiSeen.add("family:" + fam); css += familyCss(fam); }
    if (id && !uiSeen.has(id)) { uiSeen.add(id); css += componentOwnCss(id); }
    return css ? "<style>" + css + "</style>" : "";
  };
  const colorStyle = () => { if (colorOnce.done || (ctx && ctx.blockColorCss)) return ""; colorOnce.done = true; if (ctx) ctx.blockColorCss = true; return BLOCK_COLOR_STYLE; };
  for (const block of headingContext ? [] : blocks) {
    if (block.type === "heading1" || block.type === "heading2" || block.type === "heading3" || block.type === "heading4") {
      const base = (block.syncedScope || "") + headingSlug(block.text);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      const id = n > 0 ? base + "-" + (n + 1) : base;
      headingIds.set(block.id, id);
      headings.push({ id, text: block.text, level: Number(block.type.slice(-1)) + 1 });
    } else if (block.type === "html" && block.id) {
      // Headings inside an HTML block join the TOCs in block order (h1 like a heading1 block); visual-html.js draws
      // their anchors with these ids. Keyed by the block id: a heading block never shares an id with an HTML block.
      const ids = htmlHeadings(block.text).map((h) => {
        const base = (block.syncedScope || "") + headingSlug(h.text);
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        const id = n > 0 ? base + "-" + (n + 1) : base;
        headings.push({ id, text: h.text, level: Math.min(5, h.level + 1) });
        return id;
      });
      if (ids.length) headingIds.set(block.id, ids);
    }
  }

  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === "numbered" ? "ol" : "ul";
    out.push("<" + tag + ">" + listItems.join("") + "</" + tag + ">");
    listItems = [];
    listType = null;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const parentCtx = ctx;
    if (block.syncedReadOnly) ctx = { ...ctx, page: { ...ctx?.page, readOnly: true }, syncedReadOnly: true };
    let end = index + 1;
    while (end < blocks.length && (blocks[end].indent || 0) > (block.indent || 0)) end += 1;
    const branch = blocks.slice(index + 1, end);
    const childHtml = branch.length && block.type !== "columns" && block.type !== "synced" ? renderBlocks(branch, ctx, { headingIds, headings, colorOnce }) : "";
    index = end - 1;
    const type = block.type;
    const toggleHeading = /^heading[1-4]$/.test(type) && !!(block.meta && block.meta.toggle === true);
    if (type !== "bulleted" && type !== "numbered") flushList();
    const anchor = block.id ? '<span id="block-' + escapeHtml(block.id) + '"></span>' : "";
    const outputStart = out.length;
    switch (type) {
      case "synced": out.push('<p class="synced-unavailable" role="status">Synced content unavailable</p>'); break;
      case "heading1": case "heading2": case "heading3": case "heading4": {
        const tag = "h" + (Number(type.slice(-1)) + 1);
        const tgStyle = toggleHeading && !colorOnce.tg && !(ctx && ctx.toggleHeadingCss) ? (colorOnce.tg = true, ctx && (ctx.toggleHeadingCss = true), TOGGLE_HEADING_STYLE) : "";
        const head = (type === "heading4" ? h4Style() : "") + "<" + tag + ' id="' + headingIds.get(block.id) + '">' + blockInline(block) + "</" + tag + ">";
        // Toggle heading (notion-parity C7): the heading is the summary and its indented blocks fold under it, script-free.
        out.push(toggleHeading ? tgStyle + '<details class="toggle heading"' + (block.meta.open ? " open" : "") + "><summary>" + head + "</summary>" + childHtml + "</details>" : head);
        break;
      }
      case "paragraph": out.push((block.syncedUnavailable ? '<p class="synced-unavailable" role="status">' : "<p>") + blockInline(block) + "</p>"); break;
      case "bulleted":
      case "numbered": {
        if (listType && listType !== type) flushList();
        listType = type;
        const color = blockColor(block.meta && block.meta.color);
        const content = childHtml && typeof block.meta?.open === "boolean"
          ? '<details class="toggle"' + (block.meta.open ? " open" : "") + "><summary>" + blockInline(block) + "</summary>" + childHtml + "</details>"
          : blockInline(block) + childHtml;
        listItems.push("<li" + (color ? ' class="' + color + '"' : "") + ">" + (color ? colorStyle() : "") + anchor + content + "</li>");
        break;
      }
      case "to_do":
        // #34: the box is a real checkbox; lazy/checks.js toggles and saves it on pages the reader may edit.
        out.push('<div class="todo' + (block.checked ? " on" : "") + '"><span class="box" role="checkbox" aria-checked="' + !!block.checked + '"' + (block.id && !(ctx && ctx.page && ctx.page.readOnly) ? ' tabindex="0" data-check="' + escapeHtml(block.id) + '"' : "") + '>' + (block.checked ? "✓" : "") + "</span><span>" + blockInline(block) + "</span></div>");
        break;
      case "toggle":
        out.push('<details class="toggle"' + (block.meta && block.meta.open ? " open" : "") + "><summary>" + blockInline(block) + "</summary>" + childHtml + "</details>");
        break;
      case "callout":
        // Blocks indented under a callout draw inside its box (notion-parity C13), not in a wrapper after it.
        out.push('<div class="callout ' + escapeHtml(String((block.meta && block.meta.tone) || "note")) + '">' + (calloutIcon(block.meta && block.meta.icon) ? '<span class="callout-ico" aria-hidden="true">' + escapeHtml(calloutIcon(block.meta.icon)) + "</span>" : ico("sparkles", "callout-ico")) + '<div class="callout-body">' + blockInline(block).replace(/\n/g, "<br>") + (childHtml ? '<div class="callout-children">' + childHtml + "</div>" : "") + "</div></div>");
        break;
      case "quote": out.push("<blockquote>" + blockInline(block).replace(/\n/g, "<br>") + "</blockquote>"); break;
      case "code": out.push("<pre><code>" + escapeHtml(block.text) + "</code></pre>"); break;
      case "diagram": case "chart": case "visual": case "html": out.push(visualBlockHtml(block, block.id || String(index), type === "html" ? headingIds.get(block.id) : null)); break;
      case "part":
        out.push(partBlockHtml(block, block.id || String(index), ctx?.syncedReadOnly && PART_DEFAULT_IDS.has(String(block.meta?.part || "")) ? { code: PART_RUNTIME } : undefined));
        // #38: the page script that hands each part frame its code, once per page (immutable ?v= file).
        if (ctx && !ctx.partsLoaded) { ctx.partsLoaded = true; out.push('<script src="/lazy/parts.js?v=__PARTS_JS__" async></script>'); }
        break;
      case "journal": {
        if (ctx?.syncedReadOnly) { out.push("<p>Journal</p>"); break; }
        const meta = block.meta || {};
        const attrs = ["session", "agent", "day", "memory"].filter((k) => typeof meta[k] === "string").map((k) => " data-" + k + '="' + escapeHtml(meta[k]) + '"').join("");
        out.push('<div class="journal-embed"' + attrs + (meta.digest ? ' data-digest="1"' : "") + '><p class="journal-loading">작업 기록을 불러오는 중이에요…</p></div>');
        if (!ctx.journalLoaded) {
          ctx.journalLoaded = true;
          out.push('<link rel="stylesheet" href="/lazy/journal.css?v=__JOURNAL_CSS__"><script src="/lazy/journal.js?v=__JOURNAL_JS__" defer></script>');
        }
        break;
      }
      case "divider": out.push("<hr>"); break;
      case "database": out.push(legacyDatabaseHtml(block, ctx)); break;
      case "image": {
        const meta = block.meta || {};
        if (!meta.src) break;
        // Images an agent attached (#33): one marker above the group, and images sharing meta.group (video
        // keyframes, a set of screenshots) sit in one row right under the paragraph they support.
        const row = [block];
        if (meta.group && !childHtml) {
          while (index + 1 < blocks.length) {
            const next = blocks[index + 1];
            const after = blocks[index + 2];
            if (next.type !== "image" || !next.meta || next.meta.group !== meta.group || (next.indent || 0) !== (block.indent || 0) || (after && (after.indent || 0) > (next.indent || 0))) break;
            row.push(next);
            index += 1;
          }
        }
        const css = row.some((b) => b.meta.agent || b.meta.group || b.meta.time || !globalThis.EditorModel.safeHref(String(b.meta.src))) && !(ctx && ctx.agentMediaCss);
        if (css && ctx) ctx.agentMediaCss = true;
        out.push((css ? AGENT_MEDIA_STYLE : "") +
          (row.some((b) => b.meta.agent) ? '<p class="imgby">' + ico("sparkles") + "에이전트가 붙임</p>" : "") +
          (row.length > 1 ? '<div class="imgrow">' + row.map((b) => figureHtml(b, true)).join("") + "</div>" : figureHtml(block, false)));
        break;
      }
      case "video": {
        const url = String((block.meta && block.meta.url) || "");
        if (!url) break;
        if (!globalThis.EditorModel.safeHref(url)) { out.push("<p>" + escapeHtml(url) + "</p>"); break; }
        const yt = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{6,})/.exec(url);
        const vm = /^(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/.exec(url);
        if (yt) out.push('<div class="media16"><iframe src="https://www.youtube-nocookie.com/embed/' + yt[1] + '" title="영상" loading="lazy" allowfullscreen></iframe></div>');
        else if (vm) out.push('<div class="media16"><iframe src="https://player.vimeo.com/video/' + vm[1] + '" title="영상" loading="lazy" allowfullscreen></iframe></div>');
        else {
          // A first-frame picture the editor took before uploading (meta.poster, an /media/ address) shows before playback.
          const poster = String((block.meta && block.meta.poster) || "");
          out.push('<video controls preload="metadata"' + (/^\/media\/[0-9a-f]{16}$/.test(poster) ? ' poster="' + poster + '"' : "") + ' src="' + escapeHtml(url) + '"></video>');
        }
        break;
      }
      case "audio": {
        const url = String((block.meta && block.meta.url) || "");
        if (!url) break;
        if (!globalThis.EditorModel.safeHref(url)) { out.push("<p>" + escapeHtml(url) + "</p>"); break; }
        out.push('<audio controls preload="metadata" src="' + escapeHtml(url) + '"></audio>');
        break;
      }
      case "embed": {
        const url = String((block.meta && block.meta.url) || "");
        if (!url) break;
        const mode = globalThis.EditorModel.safeHref(url) ? embedMode(url) : null;
        const height = embedHeight(block.meta.height);
        // A fixed height replaces the 16:9 padding box; the frame already fills the box (position:absolute; inset:0).
        const box = '<div class="media16 embed"' + (height ? ' style="padding-top:0;height:' + height + 'px"' : "") + ">";
        if (mode === "trusted") out.push(box + '<iframe src="' + escapeHtml(url) + '" loading="lazy" allowfullscreen referrerpolicy="no-referrer"></iframe></div>');
        else if (mode === "sandboxed") out.push(box + '<iframe src="' + escapeHtml(url) + '" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" loading="lazy" referrerpolicy="no-referrer"></iframe></div>');
        else {
          const fallback = '<div class="callout note">여기에 넣을 수 없는 주소예요. <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + "</a></div>";
          out.push(globalThis.EditorModel.safeHref(url) ? fallback : fallback.replace(/<a [^>]*>|<\/a>/g, ""));
        }
        break;
      }
      case "bookmark": {
        const meta = block.meta || {};
        const url = String(meta.url || "");
        if (!url) break;
        if (!globalThis.EditorModel.safeHref(url)) { out.push("<p>" + escapeHtml(url) + "</p>"); break; }
        let site = "";
        try { site = new URL(url).hostname.replace(/^www\./, ""); } catch {}
        const title = String(meta.title || site || url);
        out.push('<a class="bookmark" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
          '<span class="bico" aria-hidden="true">🔖</span><span class="bbody"><span class="btitle">' + escapeHtml(title) + "</span>" +
          (meta.description ? '<span class="bdesc">' + escapeHtml(String(meta.description)) + "</span>" : "") +
          '<span class="bsite">' + escapeHtml(site) + "</span></span></a>");
        break;
      }
      case "file": {
        const meta = block.meta || {};
        const url = String(meta.url || "");
        if (!url) break;
        if (!globalThis.EditorModel.safeHref(url)) { out.push("<p>" + escapeHtml(url) + "</p>"); break; }
        const name = block.text || String(meta.name || "파일");
        out.push('<a class="filecard" href="' + escapeHtml(url) + '" download><span class="fico" aria-hidden="true">📄</span><span class="fname">' + escapeHtml(name) + '</span><span class="fdl">받기 ↓</span></a>');
        break;
      }
      case "columns": {
        const legacyCols = Array.isArray(block.meta && block.meta.columns) ? block.meta.columns : null;
        if (legacyCols) {
          // A page too full to convert keeps its old text-only columns; they still draw (read only).
          if (!legacyCols.length) break;
          out.push('<div class="cols cols' + legacyCols.length + '" style="--cols:' + columnTemplate(null, legacyCols.length) + '">' + legacyCols.map((c) =>
            '<div class="col">' + String((c && c.text) || "").split("\n").map((l) => l.trim() ? "<p>" + inline(l) + "</p>" : "").join("") + "</div>"
          ).join("") + "</div>");
          break;
        }
        out.push(columnsHtml(block, branch, ctx, { headingIds, headings, colorOnce }));
        break;
      }
      case "column": if (childHtml) out.push('<div class="col">' + childHtml + "</div>"); break;
      case "table": {
        const meta = block.meta || {};
        const columns = Array.isArray(meta.columns) ? meta.columns : [];
        const rows = Array.isArray(meta.rows) ? meta.rows : [];
        if (!columns.length) break;
        const isDatabase = ctx && !ctx.syncedReadOnly && ctx.page && ctx.page.kind === "db";
        // #34: the leftmost box only shows a 상태 완료 row on database-style tables; a plain table has no box column
        // (it looked like a to-do box but did nothing). A cell written "[ ]" / "[x]" is a real checkbox instead.
        const doneCol = isDatabase && columns.indexOf("상태") >= 0;
        // #73: a plain table with no "[ ]" column keeps a leftmost box per row (the column #34 took away). The first tick
        // adds a 완료 column of "[ ]" cells to the block (lazy/checks.js, data-c="new"), so the state is in the markdown too.
        const addCol = !isDatabase && block.id && !(ctx && ctx.page && ctx.page.readOnly) && !rows.some((r) => Array.isArray(r) && r.some((v) => /^\[( |x|X)?\]$/.test(String(v ?? "").trim())));
        const head = (doneCol ? '<th class="table-select" scope="col" aria-label="완료"></th>' : addCol ? '<th class="table-select" scope="col" aria-label="완료"></th>' : "") + columns.map((c) => '<th scope="col"><span class="thname">' + tableHeaderIcon(String(c)) + inline(String(c)) + '</span></th>').join("");
        const body = rows.map((r, ri) => '<tr>' + (doneCol ? '<td class="table-select"><span class="table-check' + (r[columns.indexOf("상태")] === "완료" ? ' on' : '') + '" aria-hidden="true"></span></td>'
          : addCol ? '<td class="table-select cellcheck-td"><span class="cellcheck" role="checkbox" aria-checked="false" aria-label="' + escapeHtml(String((r && r[0]) ?? "")) + " " + "완료" + '" tabindex="0" data-check="' + escapeHtml(block.id) + '" data-r="' + ri + '" data-c="new"></span></td>' : "") + columns.map((c, i) => {
          const value = String((r && r[i]) ?? "");
          const box = /^\[( |x|X)?\]$/.exec(value.trim());
          if (box) return '<td class="cellcheck-td"><span class="cellcheck' + (box[1] && box[1] !== " " ? " on" : "") + '" role="checkbox" aria-checked="' + !!(box[1] && box[1] !== " ") + '" aria-label="' + escapeHtml(String((r && r[i === 0 ? 1 : 0]) ?? "")) + ' ' + escapeHtml(String(c)) + '"' + (block.id && !(ctx && ctx.page && ctx.page.readOnly) ? ' tabindex="0" data-check="' + escapeHtml(block.id) + '" data-r="' + ri + '" data-c="' + i + '"' : "") + '></span></td>';
          const tone = ({ 진행: "blue", "진행 중": "blue", 마무리: "green", 완료: "green", 대기: "purple", "결정 필요": "purple" })[value];
          const cell = c === "상태" && tone ? '<span class="tag table-status ' + tone + '">' + inline(value) + '</span>'
            : c === "우선순위" && value ? '<span class="tag ' + (({ 높음: "pink", 보통: "yellow", 낮음: "gray" })[value] || "gray") + '">' + inline(value) + '</span>'
            : c === "진행률" && value !== "" ? tableProgressHtml(value, r[columns.indexOf("상태")] === "완료")
            : c === "마감일" ? tableDateHtml(value)
            : (c === "담당" || c === "담당자") && value ? tablePersonHtml(value) : inline(value);
          return '<td>' + cell + '</td>';
        }).join("") + '</tr>').join("");
        const tabs = [["table", "테이블", ""], ["layout-panel-left", "보드", "board"], ["calendar", "캘린더", "calendar"], ["layout-grid", "갤러리", "gallery"]];
        const bar = isDatabase ? tableHeadingHtml() + '<div class="table-toolbar"><div class="table-tabs"' + (ctx.tabHref ? ' role="tablist"' : '') + ' aria-label="보기">' + tabs.map(([icon, label, view], i) => ctx.tabHref ? '<button type="button" role="tab" class="table-tab' + (i === 0 ? ' on' : '') + '" aria-selected="' + (i === 0) + '" data-href="' + ctx.tabHref + (view ? '?view=' + view : '') + '" data-view="' + (view || 'table') + '">' + ico(icon) + label + '</button>' : '<span class="table-tab' + (i === 0 ? ' on' : '') + '">' + ico(icon) + label + '</span>').join("") + (ctx.tabHref ? '' : '<span class="table-tab" aria-hidden="true">' + ico("plus") + '</span>') + '</div>' + tableNewHtml(ctx.page.slug) + '</div>' : '';
        out.push('<div class="table-section">' + bar + '<div class="stable" tabindex="0" role="region" aria-label="작업 표"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></div>');
        break;
      }
      case "equation": if (block.text) out.push('<div class="mathblock">' + equationHtml(block.text) + "</div>"); break;
      case "toc": {
        const item = (h) => '<li class="lvl' + h.level + '"><a href="#' + h.id + '">' + inline(h.text) + "</a></li>";
        let items = "";
        if (headings.length > TOC_FOLD_AT) {
          // 긴 목차는 맨 윗단계 제목마다 하위 제목을 접어 둔다. 제목 링크를 누르면 이동하고, 화살표를 누르면 펼친다.
          const top = Math.min(...headings.map((h) => h.level));
          for (let i = 0; i < headings.length; ) {
            const h = headings[i];
            let j = i + 1;
            while (j < headings.length && headings[j].level > top) j += 1;
            const kids = h.level === top ? headings.slice(i + 1, j) : [];
            items += kids.length
              ? '<li class="lvl' + h.level + ' tocgrp"><details><summary><a href="#' + h.id + '">' + inline(h.text) + '</a> <span class="tcount">' + kids.length + "</span></summary><ul>" + kids.map(item).join("") + "</ul></details></li>"
              : item(h);
            i = kids.length ? j : i + 1;
          }
        } else {
          items = headings.map(item).join("");
        }
        // The whole TOC folds to a one-line summary (목차 · N); it starts open.
        // The heading reads "Contents" when every heading it lists is English, like the components' own words.
        out.push('<nav class="tocblock"><details open><summary><h3>' + (headings.length && headings.every((h) => uiDataIsEnglish(h.text)) ? "Contents" : "목차") + "</h3>" + (headings.length ? ' <span class="tcount">' + headings.length + "</span>" : "") + "</summary><ul>" + (items || '<li class="tempty">아래에 제목이 없어요</li>') + "</ul></details></nav>");
        break;
      }
      case "breadcrumb": {
        const chain = [];
        if (ctx && ctx.page) {
          const bySlug = new Map((ctx.pages || []).map((p) => [p.slug, p]));
          let cur = ctx.page;
          const guard = new Set();
          while (cur && !guard.has(cur.slug)) {
            guard.add(cur.slug);
            chain.unshift(cur);
            cur = cur.parent ? bySlug.get(cur.parent) : null;
          }
        }
        if (chain.length) {
          out.push('<nav class="crumbs">' + chain.map((p) =>
            '<a href="/' + (p.slug === "index" ? "home" : encodeURIComponent(p.slug)) + '/">' + escapeHtml(p.title) + "</a>"
          ).join('<span class="sep" aria-hidden="true">›</span>') + "</nav>");
        }
        break;
      }
      case "button": {
        const meta = block.meta || {};
        const actions = Array.isArray(meta.actions) ? meta.actions : [];
        if (actions.length && block.id) {
          const confirm = actions.find((action) => action && action.type === "confirm");
          const color = /^(gray|brown|orange|yellow|green|blue|purple|pink|red)$/.test(String(meta.color || "")) ? " btn-" + meta.color : "";
          const icon = meta.icon ? '<span class="btn-ico" aria-hidden="true">' + escapeHtml(String(meta.icon).slice(0, 8)) + "</span>" : "";
          const readOnly = ctx && ctx.page && ctx.page.readOnly;
          out.push('<p class="btnrow"><button type="button" class="btn act' + color + '"' + (ctx?.syncedReadOnly ? "" : ' data-button="' + escapeHtml(block.id) + '"' + (confirm ? ' data-confirm="' + escapeHtml(String(confirm.message || "실행할까요?")) + '"' : "")) + (readOnly ? " disabled" : "") + ">" + icon + (block.text ? inline(block.text) : "버튼") + "</button></p>");
          // Inline loader, not <script src>: reader navigation swaps <main> and replays only inline scripts.
          if (ctx && !ctx.buttonsLoaded) { ctx.buttonsLoaded = true; out.push('<link rel="stylesheet" href="/lazy/buttons.css?v=__BUTTONS_CSS__">' + (readOnly ? "" : '<script>window.AcardButtons||document.head.appendChild(Object.assign(document.createElement("script"),{src:"/lazy/buttons.js?v=__BUTTONS_JS__"}))</script>')); }
          break;
        }
        const url = String(meta.url || "");
        if (!url) break;
        if (!globalThis.EditorModel.safeHref(url)) { out.push("<p>" + escapeHtml(block.text || url) + "</p>"); break; }
        out.push('<p class="btnrow"><a class="btn" href="' + escapeHtml(url) + '">' + (block.text ? inline(block.text) : "이동") + "</a></p>");
        break;
      }
      case "progress": {
        const meta = block.meta || {};
        const value = Math.min(100, Math.max(0, Math.round(Number(meta.value) || 0)));
        const color = String(meta.color || "blue");
        out.push('<div class="progress ' + escapeHtml(color) + '"><div class="phead"><span>' + inline(block.text || "") + '</span><span class="pval">' + value + '%</span></div>' +
          '<div class="pbar" role="progressbar" aria-valuenow="' + value + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + value + '%"></span></div></div>');
        break;
      }
      case "db_ref": out.push(block.meta && block.meta.html ? block.meta.html.replace(/loading="eager" fetchpriority="high"/g, 'loading="lazy"') : '<div class="db"><p class="dbempty">연결된 데이터베이스를 불러오지 못했어요.</p></div>'); break;
      case "component": {
        const uiCss = uiStyle(String((block.meta && block.meta.ui) || ""));
        if (uiCss) out.push(uiCss);
        out.push(renderComponentBlock(block, { footnotes: pageFootnotes, heading: prevHeading }));
        break;
      }
      // Unknown types keep their text as a paragraph (unchanged); a text-less unknown block (a type a newer build
      // saved, then rolled back) shows a quiet fallback card instead of vanishing.
      default: if (block.text) out.push("<p>" + inline(block.text) + "</p>"); else if (type && !KNOWN_EMPTY.has(type)) out.push(uiStyle() + fallbackCardHtml(type, ""));
    }
    // progress keeps its own meta.color (bar color), so block color skips it.
    const color = type === "progress" ? "" : blockColor(block.meta && block.meta.color);
    if (color && out.length > outputStart && type !== "bulleted" && type !== "numbered") out[outputStart] = withClass(out[outputStart], color);
    if (out.length > outputStart && (color || (type === "callout" && calloutIcon(block.meta && block.meta.icon)))) { const css = colorStyle(); if (css) out.splice(outputStart, 0, css); }
    if (block.meta && block.meta.human && out.length > outputStart && type !== "bulleted" && type !== "numbered") {
      out.splice(outputStart, 0, '<div class="human-block' + (block.meta.suggest ? " has-suggest" : "") + '"><span class="human-tag">' + ico("lock") + "사람이 고친 문단 · 보호됨</span>");
      out.push("</div>");
    }
    if (block.meta && block.meta.suggest && block.id && !ctx?.syncedReadOnly) out.push(suggestHtml(block));
    if (out.length > outputStart && type !== "bulleted" && type !== "numbered") out.splice(outputStart, 0, anchor);
    // #34: the toggle code and styles load only on pages that have a checkable box.
    if (ctx && !ctx.syncedReadOnly && !ctx.checksLoaded && out.slice(outputStart).some((html) => html.includes(" data-check=") || html.includes(" data-suggest=") || html.startsWith('<div class="callout summary"') || html.startsWith('<div class="callout sources"'))) {
      ctx.checksLoaded = true;
      out.push('<link rel="stylesheet" href="/lazy/checks.css?v=__CHECKS_CSS__"><script src="/lazy/checks.js?v=__CHECKS_JS__" defer></script>');
    }
    if (childHtml && !toggleHeading && !["toggle", "bulleted", "numbered", "callout", "column"].includes(type)) out.push('<div class="block-children">' + childHtml + '</div>');
    prevHeading = /^heading[1-4]$/.test(type) ? String(block.text || "") : "";
    ctx = parentCtx;
  }
  flushList();
  let html = out.join("\n");
  // Promote in final DOM order, not recursion order (children are rendered before their parents).
  if (!headingContext && !(ctx && ctx.bodyImageLoaded)) html = html.replace(/(<img\b[^>]*\b)loading="lazy"/, (_match, before) => {
    if (ctx) ctx.bodyImageLoaded = true;
    return before + 'loading="eager" fetchpriority="high"';
  });
  if (!headingContext && !(ctx && ctx.evidenceCss) && html.includes('<span class="ev ev-')) { if (ctx) ctx.evidenceCss = true; html = "<style>" + EVIDENCE_CSS + "</style>" + html; }
  if (!headingContext && !(ctx && ctx.footnoteCss) && html.includes('<sup class="fnref">')) { if (ctx) ctx.footnoteCss = true; html = "<style>" + FOOTNOTE_CSS + "</style>" + html; }
  return html;
}

// 라인 아이콘은 Lucide(ISC, assets/img/LICENSE-lucide.txt)에서 path 만 옮겨 왔다.
const ICONS = {"lock":"<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>","house":"<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\"/><path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>","files":"<path d=\"M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8\"/><path d=\"M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z\"/><path d=\"M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1\"/>","clock":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 6v6l4 2\"/>","star":"<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"/>","trash-2":"<path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>","search":"<path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/>","plus":"<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>","chevron-down":"<path d=\"m6 9 6 6 6-6\"/>","chevron-right":"<path d=\"m9 18 6-6-6-6\"/>","file-text":"<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/><path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/><path d=\"M10 9H8\"/><path d=\"M16 13H8\"/><path d=\"M16 17H8\"/>","table":"<path d=\"M12 3v18\"/><rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M3 9h18\"/><path d=\"M3 15h18\"/>","share-2":"<circle cx=\"18\" cy=\"5\" r=\"3\"/><circle cx=\"6\" cy=\"12\" r=\"3\"/><circle cx=\"18\" cy=\"19\" r=\"3\"/><line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\"/><line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\"/>","message-square":"<path d=\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\"/>","ellipsis":"<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/><circle cx=\"5\" cy=\"12\" r=\"1\"/>","notebook-pen":"<path d=\"M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4\"/><path d=\"M2 6h4\"/><path d=\"M2 10h4\"/><path d=\"M2 14h4\"/><path d=\"M2 18h4\"/><path d=\"M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z\"/>","sun":"<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>","moon":"<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\"/>","log-out":"<path d=\"m16 17 5-5-5-5\"/><path d=\"M21 12H9\"/><path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"/>","globe":"<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>","tag":"<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>","sparkles":"<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\"/><path d=\"M20 2v4\"/><path d=\"M22 4h-4\"/><circle cx=\"4\" cy=\"20\" r=\"2\"/>","users":"<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><path d=\"M16 3.128a4 4 0 0 1 0 7.744\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/>","circle-dot":"<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"10\"/>","flag":"<path d=\"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528\"/>","list-checks":"<path d=\"M13 5h8\"/><path d=\"M13 12h8\"/><path d=\"M13 19h8\"/><path d=\"m3 17 2 2 4-4\"/><path d=\"m3 7 2 2 4-4\"/>","calendar":"<path d=\"M8 2v3\"/><path d=\"M16 2v3\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M3 9h18\"/>","type":"<path d=\"M12 4v16\"/><path d=\"M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2\"/><path d=\"M9 20h6\"/>","columns-3":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M9 3v18\"/><path d=\"M15 3v18\"/>","layout-grid":"<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\"/>","square":"<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>","command":"<path d=\"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3\"/>","layout-panel-left":"<rect width=\"7\" height=\"18\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\"/>"};

// #36: word diff of the person's paragraph against the agent's suggestion (added words marked, removed struck out).
function suggestDiff(before, after) {
  const a = String(before).split(/\s+/).filter(Boolean), b = String(after).split(/\s+/).filter(Boolean);
  const n = a.length, m = b.length;
  if (n * m > 40000) return "<ins>" + escapeHtml(after) + "</ins>";
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const parts = [];
  const push = (kind, word) => { const last = parts[parts.length - 1]; if (last && last.kind === kind) last.words.push(word); else parts.push({ kind, words: [word] }); };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push("same", a[i]); i += 1; j += 1; }
    else if (i < n && (j >= m || t[i + 1][j] >= t[i][j + 1])) { push("del", a[i]); i += 1; }
    else { push("ins", b[j]); j += 1; }
  }
  return parts.map((p) => { const text = escapeHtml(p.words.join(" ")); return p.kind === "same" ? text : "<" + p.kind + ">" + text + "</" + p.kind + ">"; }).join(" ");
}

function suggestHtml(block) {
  const s = block.meta.suggest;
  const when = s.at ? new Date(Number(s.at) + 9 * 3600000).toISOString().slice(5, 16).replace("-", "/").replace("T", " ") : "";
  const body = s.remove ? '<p class="suggest-remove">에이전트가 이 문단을 지우자고 해요.</p>' : block.type === "part" ? '<p class="suggest-text">' + escapeHtml(partSuggestLine(block.text, s.text)) + "</p>" : '<p class="suggest-text">' + suggestDiff(block.text, s.text).replace(/\n/g, "<br>") + "</p>";
  return '<div class="suggest" data-suggest="' + escapeHtml(block.id) + '" role="group"><div class="suggest-head">' + ico("sparkles") + '<b>에이전트 업데이트 제안</b><span>' + escapeHtml([s.by, when].filter(Boolean).join(" · ")) + "</span></div>" + body
    + '<div class="suggest-actions"><button type="button" class="suggest-accept" data-act="accept">반영</button><button type="button" class="suggest-dismiss" data-act="dismiss">무시</button></div></div>';
}

export function ico(name, cls) {
  return '<svg class="ico' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

// 빌드가 정적 파일 해시를 채운다. 동적으로 고르는 이미지 주소도 캐시를 깨도록 같은 표를 쓴다.
export function assetUrl(path) {
  const versions = globalThis.ACARD_ASSET_VERSIONS || {};
  return versions[path] ? path + "?v=" + versions[path] : path;
}

const PAGE_ICONS = { index: "home", board: "project-status", facetion: "facetion", gravity: "gravity", "motion-native": "motion-native", akanesasu: "akanesasu", vtuber: "vtuber-bg", "real-miku": "real-miku", "text-survival": "text-survival", infra: "infra", decisions: "decision-pending", samples: "block-sample" };
const KNOWN_ICONS = new Set(Object.values(PAGE_ICONS));
const GRADIENTS = 6;

function gradientIndex(slug) {
  let h = 0;
  for (const ch of String(slug || "index")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return slug === "index" ? 1 : (h % GRADIENTS) + 1;
}

function imagePath(value, dir, suffix) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (/^(\/|https?:)/.test(v)) return v;
  if (/^[\w-]+$/.test(v)) return assetUrl("/img/" + dir + "/" + v + suffix);
  return "";
}

export function pageIconHtml(page, settings, size) {
  const s = settings || {};
  const raw = String(s.icon || (page && page.icon) || "").trim();
  // 시안의 큰 페이지 아이콘 타일 자리에는 Acard A 로고를 둔다(오너 지시 2026-10-16).
  if (!raw && size > 40) return '<img class="mark" src="/logo.svg" alt="" width="' + size + '" height="' + size + '">';
  const name = raw || (page && page.ws === "member" ? "" : PAGE_ICONS[page && page.slug]) || "";
  const path = KNOWN_ICONS.has(name) ? assetUrl("/img/icons/" + name + "-" + (size > 40 ? 256 : 128) + ".webp") : imagePath(name, "icons", "-" + (size > 40 ? 256 : 128) + ".webp");
  if (path) return '<img src="' + escapeHtml(path) + '" alt="" width="' + size + '" height="' + size + '"' + (/^\/media\/[0-9a-f]{16}$/.test(path) ? ' class="upicon" style="object-fit:cover;border-radius:' + (size > 40 ? 12 : 4) + 'px"' : "") + ">";
  if (raw) return '<span class="emoji">' + escapeHtml(raw) + "</span>";
  return page && page.kind === "db" ? ico("table") : ico("file-text");
}

export function coverHtml(page, settings) {
  const s = settings || {};
  const chosen = String(s.cover || "").trim();
  if (/^\/media\/[0-9a-f]{16}$/.test(chosen)) return '<div class="pagecover img"><img src="' + escapeHtml(chosen) + '?w=1600" srcset="' + [800, 1600].map((w) => escapeHtml(chosen) + "?w=" + w + " " + w + "w").join(", ") + '" sizes="100vw" alt="" fetchpriority="high"></div>';
  if (/^(\/media\/|https?:)/.test(chosen)) return '<div class="pagecover img"><img src="' + escapeHtml(chosen) + '" alt="" fetchpriority="high"></div>';
  // 시안의 사진 커버 자리: 파스텔 그라데이션 위에 A 로고를 은은한 무늬와 큰 워터마크로 깐다.
  const fm = /^g([1-6])$/.exec(chosen) || /^g([1-6])$/.exec(String((page && page.cover) || "").trim());
  return '<div class="pagecover grad brandcover g' + (fm ? fm[1] : gradientIndex(page && page.slug)) + '" aria-hidden="true"><img src="/logo.svg" alt="" width="150" height="150"></div>';
}

export function pageActionsHtml(slug, menuHtml) {
  const q = encodeURIComponent(slug || "index");
  return '<div class="page-actions">' +
    '<button type="button" class="pa-share" id="share">공유</button>' +
    '<a class="icon" href="/edit/' + q + '/#comments" aria-label="댓글" title="댓글">' + ico("message-square") + "</a>" +
    '<button type="button" class="icon" id="fav" aria-pressed="false" aria-label="즐겨찾기" title="즐겨찾기" data-slug="' + escapeHtml(slug || "index") + '">' + ico("star") + "</button>" +
    '<a class="icon" id="editlink" href="/edit/' + q + '/" aria-label="이 페이지 고치기" title="고치기">' + ico("notebook-pen") + "</a>" +
    (menuHtml || "") + "</div>";
}

function ownerPageMeta(page) {
  if (page && page.ws === "member") return {};
  return (globalThis.ACARD_PAGE_META || {})[page && page.slug] || {};
}

export function pageHeadHtml(page, settings, actionsHtml) {
  const meta = ownerPageMeta(page);
  page = Object.assign({}, meta, page);
  settings = Object.assign({}, { icon: meta.icon, cover: meta.cover }, settings || {});
  return '<div class="page-head">' + coverHtml(page, settings) +
    '<div class="page-head-row"><div class="pageicon" aria-hidden="true">' + pageIconHtml(page, settings, 88) + "</div>" + (actionsHtml || "") + "</div></div>";
}

const AGENT_NAMES = { markdown: "AI", editor: "오너" };
const AVATARS = { "AI": "dori", "도리": "dori", "오너": "owner" };

function avatarHtml(name) {
  const file = AVATARS[name];
  return file ? '<img src="' + assetUrl("/img/avatars/" + file + "-96.webp") + '" alt="" width="24" height="24">' : '<i>' + escapeHtml(String(name).slice(0, 1)) + "</i>";
}

function whenText(updated) {
  const value = typeof updated === "number" ? new Date(updated) : new Date(String(updated || ""));
  if (Number.isNaN(value.getTime())) return String(updated || "");
  const kst = new Date(value.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCFullYear() + "년 " + (kst.getUTCMonth() + 1) + "월 " + kst.getUTCDate() + "일";
  const hasTime = typeof updated === "number" || /T\d/.test(String(updated));
  return hasTime ? day + " " + String(kst.getUTCHours()).padStart(2, "0") + ":" + String(kst.getUTCMinutes()).padStart(2, "0") : day;
}

export function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).map((t) => t.trim()).filter(Boolean);
  return String(value || "").replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

const TAG_ICONS = { "공개": "globe", "비공개": "globe", "표": "table" };
// ref-1: the first topic tag is the page's category (accent pill); status tags (공개, 표) and later tags stay neutral.
function tagTone(tags, i) {
  return i === tags.findIndex((t) => !TAG_ICONS[t]) ? "accent" : "neutral";
}

// issue 110: "나" takes 내가, and a Korean name ending in a final consonant takes 이 (민준이 씀); everything else keeps 가.
function wroteBy(name) {
  if (name === "나") return "내가 씀";
  const last = name.charCodeAt(name.length - 1) - 0xac00;
  return name + (last >= 0 && last < 11172 && last % 28 ? "이 씀" : "가 씀");
}

export function bylineHtml(page) {
  page = Object.assign({}, ownerPageMeta(page), page);
  const member = page.ws === "member";
  const agent = page.agent || (member ? "나" : AGENT_NAMES[page.source] || "AI");
  const people = member ? [agent] : [agent].concat(agent === "오너" ? [] : ["오너"]);
  const tags = parseTags(page.tags);
  if (page.kind === "db" && !tags.includes("표")) tags.push("표");
  return '<p class="byline"><span class="who"><span class="avatars">' + people.map(avatarHtml).join("") + "</span>" +
    escapeHtml(wroteBy(agent)) + "</span>" +
    '<span class="when">' + ico("clock") + "<span><time>" + escapeHtml(whenText(page.updated)) + "</time>에 수정됨</span></span>" +
    (tags.length ? '<span class="pills">' + tags.map((t, i, all) => '<span class="chip t-' + tagTone(all, i) + '">' + ico(TAG_ICONS[t] || "tag") + escapeHtml(t) + "</span>").join("") + "</span>" : "") + "</p>";
}

const OVERVIEW = [
  { key: "needs", match: /답|결정|기다리/, title: "내 답이 필요한 것", pill: "decide", label: "결정 필요" },
  { key: "doing", match: /진행/, title: "진행 중", pill: "doing", label: "진행 중" },
  { key: "done", match: /끝난|완료|최근/, title: "AI가 최근 한 일", pill: "done", label: "완료" },
];

export function overviewHtml(blocks) {
  const groups = { needs: [], doing: [], done: [] };
  let current = null;
  for (const block of blocks || []) {
    if (/^heading[123]$/.test(block.type)) {
      const hit = OVERVIEW.find((o) => o.match.test(block.text));
      current = hit ? hit.key : null;
    } else if (current && block.type === "bulleted" && !(block.indent > 0)) {
      groups[current].push(block.text);
    }
  }
  if (!groups.needs.length && !groups.doing.length && !groups.done.length) return "";
  const card = (o, more) => {
    const items = groups[o.key];
    const rows = items.slice(0, 5).map((text) => {
      const m = /^(.*?)\s*\(([^()]*(?:\d+일째|\d{4}-\d{2}-\d{2})[^()]*)\)\s*$/.exec(text);
      return "<li><span class=\"t\">" + inline(m ? m[1] : text) + "</span>" + (m ? '<span class="d">' + escapeHtml(m[2]) + "</span>" : "") + "</li>";
    }).join("");
    return '<section class="card ' + o.key + '" aria-label="' + o.title + '"><h2>' + o.title +
      '<span class="count pill ' + o.pill + '">' + items.length + "</span></h2><ul>" + rows + "</ul>" +
      (more ? '<a class="more" href="' + more + '">모두 보기 →</a>' : "") + "</section>";
  };
  return '<div class="overview">' + card(OVERVIEW[0], "/decisions/") + card(OVERVIEW[1], "") + card(OVERVIEW[2], "") + "</div>";
}

export function thumbBarHtml(slug) {
  return '<nav class="thumbbar" aria-label="빠른 이동">' +
    '<a href="/home/"' + (slug === "index" ? ' class="on" aria-current="page"' : "") + '><span class="ti" aria-hidden="true">⌂</span>홈</a>' +
    '<button type="button" data-open="palette"><span class="ti" aria-hidden="true">⌕</span>검색</button>' +
    '<button type="button" data-new-page><span class="ti" aria-hidden="true">+</span>새 페이지</button>' +
    '<button type="button" data-open="pages"><span class="ti" aria-hidden="true">☰</span>페이지</button></nav>';
}

export function navTree(pages, current) {
  const known = new Set(pages.map((page) => page.slug));
  const parentOf = (page) => (page.parent && known.has(page.parent) ? page.parent : null);
  const open = new Set();
  for (let cur = pages.find((p) => p.slug === current); cur && !open.has(cur.slug); cur = pages.find((p) => p.slug === parentOf(cur))) open.add(cur.slug);
  const render = (parent) => {
    const items = pages.filter((page) => page.slug !== "index" && parentOf(page) === parent);
    if (!items.length) return "";
    return '<ul class="tree">' + items.map((page) => {
      const kids = render(page.slug);
      const href = "/" + encodeURIComponent(page.slug) + "/";
      return '<li class="' + (kids ? "has-kids" + (open.has(page.slug) ? " open" : "") : "") + '"><div class="row">' +
        (kids ? '<button type="button" class="tw" aria-label="펼치기">' + ico("chevron-right") + "</button>" : '<span class="tw"></span>') +
        '<a href="' + href + '"' + (page.slug === current ? ' class="on" aria-current="page"' : "") + '><span class="pi">' + (page.kind === "db" ? ico("table") : ico("file-text")) + '</span><span class="pt">' + escapeHtml(page.title) + "</span>" + (page.kind === "db" ? ' <span class="dbmark">표</span>' : "") + "</a></div>" + kids + "</li>";
    }).join("") + "</ul>";
  };
  return '<div class="navgroup" id="side-tree">' + render(null) + "</div>";
}


const WORDMARK_SVG = "<svg class=\"wordmark\" viewBox=\"0 0 375.59 100\" role=\"img\" aria-label=\"Acard\" focusable=\"false\"><use href=\"/wordmark-symbol.svg#w\"/></svg>";
// The logo mark doubles as the "A" of "Acard"; other site names keep the mark + text.
export function brandMarkHtml(siteName, size) {
  const name = siteName || "Acard";
  if (name === "Acard") return WORDMARK_SVG;
  return '<img src="/logo-small.svg" alt="" width="' + size + '" height="' + size + '">' + escapeHtml(name);
}
export function sideNavHtml(pages, current, siteName) {
  const name = escapeHtml(siteName || "Acard");
  // ds10 issue 101: an icon nav list under search (ref-1); the ⋯ menu keeps its items so existing shortcuts and QA still find them.
  // One-path icons with stroke set in CSS (.side-nav svg) keep the reader first screen inside its byte budget.
  const navIco = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  const navItem = (act, d, label) => '<button type="button" data-act="' + act + '">' + navIco(d) + label + "</button>";
  const nav = '<div class="side-nav">' +
    '<a href="/home/"' + (current === "index" ? ' class="on" aria-current="page"' : "") + ">" + navIco("M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z") + "홈</a>" +
    navItem("all", "M14 3H6v18h12V7zm0 0v4h4M9 12h6m-6 4h6", "모든 페이지") +
    navItem("recent", "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "최근 편집됨") +
    navItem("favorites", "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z", "즐겨찾기") +
    navItem("trash", "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13m-8 4v5m4-5v5", "휴지통") + "</div>";
  return '<div class="side-brand"><a class="brand" href="/home/" aria-label="홈">' + brandMarkHtml(siteName, 26) + "</a>" +
    '<div class="side-tools"><button type="button" class="icon" id="side-more" aria-label="더 보기" title="더 보기" aria-haspopup="menu" aria-expanded="false" aria-controls="side-menu">' + ico("ellipsis") + "</button>" +
    '<ul class="side-menu" id="side-menu" role="menu" hidden>' +
    '<li><button type="button" role="menuitem" data-act="all">모든 페이지</button></li>' +
    '<li><button type="button" role="menuitem" data-act="recent">최근 편집됨</button></li>' +
    '<li><a role="menuitem" href="/import">노션·옵시디언에서 가져오기</a></li>' +
    '<li><button type="button" role="menuitem" data-act="trash">휴지통</button></li>' +
    '<li><button type="button" role="menuitem" data-act="suggest">✦ 정리 제안</button></li></ul>' +
    '<button class="icon" id="collapse" aria-label="사이드바 접기" aria-expanded="true" title="사이드바 접기">' + ico("layout-panel-left") + "</button></div></div>" +
    '<button type="button" class="side-search" id="palette-open" aria-label="빠른 검색">' + ico("search") + '<span>검색하기</span><kbd class="kbd">Ctrl K</kbd></button>' + nav +
    '<div class="side-ws"><div class="side-ws-head"><span>작업 공간</span><button type="button" class="icon side-add" data-act="new" aria-label="새 페이지" title="새 페이지">' + ico("plus") + "</button></div>" +
    '<div class="side-root open"><div class="row"><button type="button" class="tw" aria-label="접기">' + ico("chevron-down") + '</button><a href="/home/"><img src="/logo-16.svg" alt="" width="18" height="18">' + name + "</a></div>" +
    navTree(pages, current) + "</div>" +
    '<button type="button" class="side-new" data-act="new">' + ico("plus") + "새 페이지</button></div>";
}

export function sideImageHtml(page) {
  page = Object.assign({}, ownerPageMeta(page), page);
  const v = String((page && page.side_image) || "").trim();
  if (!v) return "";
  // 시안의 사진 카드 자리: 그라데이션 카드 가운데에 A 로고.
  const fm = /^g([1-6])$/.exec(v);
  return '<figure class="page-side grad brandside g' + (fm ? fm[1] : (gradientIndex(page.slug) % GRADIENTS) + 1) + '" aria-hidden="true"><img src="/logo.svg" alt="" width="132" height="132"></figure>';
}

export function introSplit(blocks) {
  const i = (blocks || []).findIndex((b) => /^heading[123]$/.test(b.type) || b.type === "table" || b.type === "database" || b.type === "db_ref");
  return i < 0 ? [blocks || [], []] : [blocks.slice(0, i), blocks.slice(i)];
}

export function sideFootHtml() {
  return '<div class="side-foot">' +
    '<button class="icon" id="theme" aria-label="테마 바꾸기" title="테마 바꾸기">' + ico("sun", "t-light") + ico("moon", "t-dark") + "</button>" +
    '<a class="icon" href="/settings/agents/" aria-label="에이전트 연결" title="에이전트 연결">' + ico("users") + "</a>" +
    '<form method="POST" action="/__logout" class="side-logout"><button class="icon" type="submit" aria-label="로그아웃" title="로그아웃">' + ico("log-out") + "</button></form></div>";
}

export function mobileBarHtml(siteName) {
  return '<header class="mbar"><button class="icon" id="menu" aria-label="메뉴" aria-expanded="false" aria-controls="sidebar">' + ico("layout-panel-left") + "</button>" +
    '<a class="brand" href="/home/">' + brandMarkHtml(siteName, 24) + "</a></header>";
}

export function sidePanelHtml() {
  return '<div class="overlay" id="sidepanel" hidden role="dialog" aria-modal="true" aria-label="페이지 목록"><div class="sheet"><h2 id="sidepanel-title"></h2><div id="sidepanel-list" class="palette-list"></div>' +
    '<button type="button" class="close" id="sidepanel-close">닫기</button></div></div>';
}
