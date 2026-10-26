import { join } from "node:path";
import "./assets/editor-model.js";
import "./assets/columns-model.js";
import { mkdir, rm, readdir, readFile, writeFile, cp, stat } from "node:fs/promises";
import { markdownToBlocks, blocksHash, type Block } from "./markdown-blocks.ts";
import { renderBlocks, pageHeadHtml, bylineHtml, overviewHtml, thumbBarHtml, sideNavHtml, sideFootHtml, mobileBarHtml, sidePanelHtml, pageActionsHtml, sideImageHtml, introSplit } from "./block-html.js";
import siteConfig from "./site-config.json";
import { IMPORT_CORE_FILES } from "./import-core-files.ts";
import { existsSync } from "node:fs";

const ROOT = import.meta.dir;
const NOTES = join(ROOT, "notes");
const DIST = join(ROOT, "dist");
const ASSETS = join(ROOT, "assets");
const NL = "\n";
const SITE = siteConfig.name;
const OWNER = "오너 전용";

type Toc = { level: number; id: string; text: string };
type Page = { icon: string; cover: string; side_image: string; tags: string; slug: string; group: string; order: number; parent: string | null; kind: string; title: string; summary: string; updated: string; html: string; toc: Toc[]; text: string; blocks: Block[]; hash: string; };

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta: Record<string, string> = {};
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["\x27]|["\x27]$/g, "");
    }
  }
  return { meta, body };
}

function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().replace(/\s+/g, "-");
  return s.slice(0, 60) || "section";
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, String.fromCharCode(34)).replace(/&#39;/g, String.fromCharCode(39));
}

function renderBody(md: string): { html: string; toc: Toc[] } {
  let html = Bun.markdown.html(md);
  const toc: Toc[] = [];
  const seen = new Map<string, number>();
  html = html.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (_all: string, lvl: string, _attrs: string, inner: string) => {
    const level = Number(lvl);
    const text = stripTags(inner);
    let id = slugify(text);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = id + "-" + (n + 1);
    if (level >= 2 && level <= 3) toc.push({ level, id, text });
    return "<h" + level + " id=\"" + id + "\">" + inner + "</h" + level + ">";
  });
  html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, "<a href=\"$1\" target=\"_blank\" rel=\"noopener\"");
  return { html, toc };
}

function toText(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\r?\n?/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>-]+\s?/gm, " ")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function collect(): Promise<Page[]> {
  const pages: Page[] = [];
  const top = (await readdir(NOTES)).filter((f) => f.endsWith(".md"));
  const proj = await readdir(join(NOTES, "projects")).catch(() => [] as string[]);
  const inputs: { path: string; slug: string; group: string }[] = [];
  for (const f of top) {
    const slug = f === "home.md" ? "index" : f.replace(/\.md$/, "");
    inputs.push({ path: join(NOTES, f), slug, group: f === "home.md" ? "home" : "etc" });
  }
  for (const f of proj.filter((f) => f.endsWith(".md"))) {
    inputs.push({ path: join(NOTES, "projects", f), slug: f.replace(/\.md$/, ""), group: "project" });
  }
  for (const input of inputs) {
    const raw = await readFile(input.path, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const st = await stat(input.path);
    const { html, toc } = renderBody(body);
    // Build-time block ids must be stable: markdownToBlocks adds a random suffix, so every build looked like a seed change and
    // every deploy made syncIfStale rewrite all seed pages, and concurrent rewrites collided on blocks_pkey / page_fts_pkey.
    const blocks = markdownToBlocks(body).map((block, index) => ({ ...block, id: "s" + index.toString(36) }));
    pages.push({
      icon: meta.icon ?? "", cover: meta.cover ?? "", side_image: meta.side_image ?? "", tags: meta.tags ?? "",
      slug: input.slug,
      group: meta.group ?? input.group,
      order: Number(meta.order ?? 50),
      parent: meta.parent ? meta.parent.trim() : null,
      kind: meta.kind === "db" ? "db" : "note",
      title: meta.title ?? input.slug,
      summary: meta.summary ?? "",
      updated: meta.updated ?? st.mtime.toISOString().slice(0, 10),
      html, toc, text: toText(body), blocks, hash: blocksHash(blocks)
    });
  }
  pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "ko"));
  return pages;
}

// 빠른 검색 팔레트. app.js 가 최근 본 페이지와 검색 결과를 채운다.
function paletteHtml(): string {
  return [
    "<div class=\"overlay\" id=\"palette\" hidden role=\"dialog\" aria-modal=\"true\" aria-label=\"빠른 검색\">",
    "<div class=\"sheet\">",
    "<input id=\"palette-q\" type=\"search\" placeholder=\"노트 제목·본문 검색…\" aria-label=\"빠른 검색\" autocomplete=\"off\">",
    "<div id=\"palette-list\" class=\"palette-list\" role=\"listbox\"></div>",
    "<div class=\"palette-hint\">↑↓ 고르기 · Enter 열기 · Esc 닫기</div>",
    "</div>",
    "</div>",
  ].join("");
}

// 키보드 단축키 도움말.
function shortcutsHtml(): string {
  return [
    "<div class=\"overlay\" id=\"shortcuts\" hidden role=\"dialog\" aria-modal=\"true\" aria-label=\"키보드 단축키\">",
    "<div class=\"sheet\">",
    "<h2>키보드 단축키</h2>",
    "<dl class=\"keys\">",
    "<dt>/ · K</dt><dd>빠른 검색 (입력 중 제외)</dd><dt>N · Q · ?</dt><dd>새 페이지 · 빠른 메모 · 도움말 (입력 중 제외)</dd><dt>G → H / T</dt><dd>홈 / 휴지통 (입력 중 제외)</dd><dt>Ctrl/Cmd + Enter</dt><dd>빠른 메모 저장</dd>",
    "<dt>Ctrl/Cmd + K</dt><dd>빠른 검색</dd>",
    "<dt>Ctrl/Cmd + /</dt><dd>이 단축키 목록</dd>",
    "<dt>Ctrl/Cmd + B · \\</dt><dd>사이드바 접기·펴기</dd>",
    "<dt>Esc</dt><dd>열려 있는 창 닫기</dd>",
    "<dt>/</dt><dd>편집기에서 블록 종류 메뉴</dd>",
    "<dt>Tab / Shift+Tab</dt><dd>편집기에서 들여쓰기·내어쓰기</dd>",
    "<dt>Ctrl/Cmd + B/I/U/E</dt><dd>편집기에서 굵게·기울임·밑줄·코드</dd>",
    "</dl>",
    "<button type=\"button\" class=\"close\" id=\"shortcuts-close\" aria-label=\"닫기\">닫기</button>",
    "</div>",
    "</div>",
  ].join("");
}

function href(slug: string): string { return slug === "index" ? "/home/" : "/" + slug + "/"; }

// 읽기 화면 상단의 더보기 메뉴 (gate/_worker.js 의 moreMenu 와 같은 마크업을 쓴다)
function moreMenuHtml(slug: string): string {
  const file = slug.replace(/[^\w.-]+/g, "_").slice(0, 60);
  return [
    "<div class=\"menuwrap\">",
    "<button class=\"icon\" id=\"more\" aria-label=\"더보기\" aria-expanded=\"false\" title=\"더보기\">⋯</button>",
    "<div class=\"menu\" id=\"more-menu\" hidden>",
    "<div class=\"menu-width\"></div>",
    "<a href=\"/print/" + encodeURIComponent(slug) + "/\" target=\"_blank\" rel=\"noopener\">인쇄 · PDF로 저장</a>",
    "<a href=\"/api/export?slug=" + encodeURIComponent(slug) + "&format=acard-md\" download=\"" + file + ".md\">마크다운으로 내보내기</a>",
    "<a href=\"/api/export?slug=" + encodeURIComponent(slug) + "&format=html\" download=\"" + file + ".html\">HTML로 내보내기</a>",
    "<a href=\"/api/export?scope=all&format=zip\" download=\"acard.zip\">전체 노트 내보내기 (zip)</a>",
    "<button type=\"button\" class=\"menuitem\" id=\"shortcuts-open\">키보드 단축키</button>",
    "<button type=\"button\" class=\"menuitem\" id=\"quick-note-open\">빠른 메모</button>",
    "</div>",
    "</div>",
  ].join("");
}

// 시안의 홈은 인트로 아래에 "주요 작업 목록" 표가 온다. 프로젝트 현황(board)의 표를 앞 6행만 그대로 보여 주고, 대시보드 카드는 그 아래에 둔다.
function homeTasksHtml(pages: Page[]): string {
  const board = pages.find((x) => x.slug === "board");
  const table = board && board.blocks.find((b) => b.type === "database" || b.type === "table");
  if (!board || !table) return "";
  const meta = table.meta as { columns: string[]; rows: unknown[] };
  const short = { ...table, meta: { ...meta, rows: meta.rows.slice(0, 6) } };
  return "<div class=\"blocks home-tasks\">" + renderBlocks([short], { page: { slug: "board", kind: "db" }, pages, tabHref: "/board/" }) + "</div>";
}

function layout(p: Page, pages: Page[]): string {
  const toc = p.toc.length
    ? "<nav class=\"toc\" aria-label=\"목차\"><h2>이 글의 목차</h2><ul>" + p.toc.map((t) =>
        "<li class=\"lvl" + t.level + "\"><a href=\"#" + t.id + "\">" + t.text + "</a></li>").join("") + "</ul></nav>"
    : "";
  const page = { ...p, source: "markdown" };
  const settings = { icon: p.icon, cover: p.cover };
  const [intro, rest] = introSplit(p.blocks);
  const side = sideImageHtml(p);
  const heading = "<h1>" + p.title + "</h1>" + bylineHtml(page) + (p.summary ? "<p class=\"lede\">" + p.summary + "</p>" : "");
  const top = side
    ? "<div class=\"page-top\"><div class=\"page-top-main\">" + heading + (intro.length ? "<div class=\"blocks\">" + renderBlocks(intro, { page: p, pages }) + "</div>" : "") + "</div>" + side + "</div>"
    : heading;
  const body = p.slug === "index" ? homeTasksHtml(pages) : "<div class=\"blocks\">" + renderBlocks(side ? rest : p.blocks, { page: p, pages }) + "</div>";
  return [
    "<!doctype html>",
    "<html lang=\"ko\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">",
    "<meta name=\"robots\" content=\"noindex, nofollow\">",
    "<meta name=\"color-scheme\" content=\"light dark\">",
    "<meta name=\"application-name\" content=\"" + SITE + "\">",
    "<meta property=\"og:site_name\" content=\"" + SITE + "\">",
    "<link rel=\"manifest\" href=\"/manifest.webmanifest\">",
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta property="og:image" content="/og.png">',
    "<title>" + p.title + " · " + SITE + "</title>",
    p.summary ? "<meta name=\"description\" content=\"" + p.summary + "\">" : "",
    "<link rel=\"preload\" href=\"/fonts/pretendard-core.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>",
    "<link rel=\"stylesheet\" href=\"/style.css\">",
    uiLinksFor(p.blocks, p.slug),
    readerFeatures.css ? '<link rel="stylesheet" href="/features-reader.css">' : "",
    "</head>",
    "<body class=\"reader\">",
    "<a class=\"skip\" href=\"#main\">본문으로</a>",
    mobileBarHtml(SITE),
    "<div class=\"shell\">",
    "<nav class=\"sidebar\" id=\"sidebar\" aria-label=\"문서 목록\">" + sideNavHtml(pages.map((x) => ({ slug: x.slug, title: x.title, parent: x.parent, kind: x.kind, icon: x.icon })), p.slug, SITE) + sideFootHtml() + "</nav>",
    "<main id=\"main\"" + (p.kind === "db" ? " class=\"wide\"" : "") + ">",
    "<div id=\"results\" class=\"results\" hidden></div>",
    "<article id=\"article\">",
    pageHeadHtml(page, settings, pageActionsHtml(p.slug, moreMenuHtml(p.slug))),
    top,
    p.slug === "index" ? body + overviewHtml(p.blocks) : body,
    "</article>",
    "<div class=\"backlinks\" id=\"backlinks\" hidden></div>",
    toc,
    "<footer class=\"foot\">비공개 노트 · " + OWNER + "</footer>",
    "</main>",
    "</div>",
    thumbBarHtml(p.slug),
    paletteHtml(),
    shortcutsHtml(),
    sidePanelHtml(),
    "<script src=\"/app.js\"></script>",
    readerFeatures.js ? '<script src="/features-reader.js"></script>' : "",
    "</body>",
    "</html>",
    ""
  ].filter((x) => x !== "").join("\n");
}

// 표지·아이콘·아바타는 화면에서 고르기 때문에 이름별 내용 해시를 먼저 만들어 렌더러가 ?v= 를 붙이게 한다.
const imageVersions: Record<string, string> = {};
for await (const file of new Bun.Glob("**/*.{webp,png,svg}").scan({ cwd: join(ASSETS, "img") })) {
  imageVersions["/img/" + file.replaceAll("\\", "/")] = Bun.hash(await Bun.file(join(ASSETS, "img", file)).bytes()).toString(36).slice(0, 8);
}
(globalThis as any).ACARD_ASSET_VERSIONS = imageVersions;
const UI_CSS = ["acard-shell.css", "acard-page.css", "acard-body.css", "acard-mobile.css"];
// 표 스타일은 표가 있는 페이지에서만 받는다(읽기 첫 화면 성능 예산).
// 정적 페이지는 라이브 DB 뷰(.dbbrowser 등)를 그리지 않으니, 그 규칙을 걷어 낸 표 스타일(acard-table-static.css)을 받는다.
const uiLinksFor = (blocks: Block[], slug = "") => UI_CSS.concat(slug === "index" || blocks.some((x) => x.type === "table" || x.type === "database" || x.type === "db_ref") ? ["acard-table-static.css"] : [])
  .map((name) => "<link rel=\"stylesheet\" href=\"/" + name + "\">").join("");

function minifyCss(css: string): string {
  // 이 CSS 들의 문자열 값에는 ", " ": " "> " 가 없다(빌드 전에 확인). 그래서 그 주변 공백도 걷어도 뜻이 같다.
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};,>])\s*/g, "$1").replace(/: /g, ":").replace(/;}/g, "}").trim();
}

// 최소화된 CSS 에서 라이브 DB 전용 선택자(.db…)만 빼고, 빈 규칙과 빈 @media 는 지운다.
function staticTableCss(css: string): string {
  const splitTop = (sel: string) => { const out: string[] = []; let depth = 0, cur = ""; for (const ch of sel) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && !depth) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
  const walk = (src: string): string => {
    let out = "", i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < src.length && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@")) { const inner = walk(body); if (inner) out += head + "{" + inner + "}"; }
      else { const keep = splitTop(head).map((part) => part.replace(/:is\((?:\.stable|\.db\w+|, ?)+\)/g, (all) => all.includes(".stable") ? ".stable" : all)).filter((part) => !/\.db/.test(part)); if (keep.length) out += keep.join(",") + "{" + body + "}"; }
      i = j;
    }
    return out;
  };
  return walk(css);
}

const pages = await collect();
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(ASSETS, DIST, { recursive: true });
// The public pages share the landing's top bar (gate/site-nav-html.ts): one header, written in assets/_site/index.html.
{
  const { withSiteNav } = await import("./gate/site-nav-html.ts");
  const landing = await readFile(join(ASSETS, "_site", "index.html"), "utf8");
  for (const name of ["download"]) {
    const file = join(DIST, "_site", name + ".html");
    await writeFile(file, withSiteNav(await readFile(file, "utf8"), landing, "/" + name), "utf8");
  }
}
// Editor first-screen scripts ship whitespace-minified (classic scripts, behaviour unchanged) to stay under the editor cap.
// The block models load on the editor first screen, so they get full minify like editor.js.
for (const name of ["editor-model.js", "columns-model.js", "ai-marks.js"]) {
  const built = await Bun.build({ entrypoints: [join(ASSETS, name)], minify: true, format: "iife" });
  if (!built.success) throw new Error(name + " build failed:\n" + built.logs.map(String).join("\n"));
  await writeFile(join(DIST, name), await built.outputs[0].text());
}
// db.js and db-views.js are single IIFEs that talk to the page only through window.*, so they get full minify like editor.js.
// i18n-app.js (the en/zh dictionary loader, issue 147) is one IIFE that talks to the page only through window.* as well.
for (const name of ["db.js", "db-views.js", "editor-pages-ui.js", "editor-format.js", "i18n-app.js"]) {
  const built = await Bun.build({ entrypoints: [join(ASSETS, name)], minify: true, format: "iife" });
  if (!built.success) throw new AggregateError(built.logs, name + " minify failed");
  await writeFile(join(DIST, name), await built.outputs[0].text());
}
// welcome-guide.js (the 시작 가이드 coach) is the same kind of IIFE (window.AcardGuide only); its phone placement (#150) fits the total cap this way.
// Desktop onboarding shares the site/auth styles. Minify these isolated page scripts too so the new screens fit
// the existing total-client cap without adding anything to the reader/editor first-screen bundles.
for (const name of ["_site/welcome-guide.js", "_site/auth.js", "_site/onboarding.js", "_site/settings.js"]) {
  const built = await Bun.build({ entrypoints: [join(ASSETS, name)], minify: true, format: "iife" });
  if (!built.success) throw new AggregateError(built.logs, name + " minify failed");
  await writeFile(join(DIST, name), await built.outputs[0].text());
}
// The landing's own files (acard-landing-examples-live: the example cards' frame cycle and markdown demo) ship minified the
// same way, so the section fits the total cap; tests read the sources in assets/_site.
for (const name of ["_site/landing-examples.js"]) {
  const built = await Bun.build({ entrypoints: [join(ASSETS, name)], minify: true, format: "iife" });
  if (!built.success) throw new AggregateError(built.logs, name + " minify failed");
  await writeFile(join(DIST, name), await built.outputs[0].text());
}
for (const name of ["_site/styles.css", "_site/type.css"]) await writeFile(join(DIST, name), minifyCss(await readFile(join(ASSETS, name), "utf8")) + "\n", "utf8");
for (const name of ["_site/auth.css", "_site/onboarding.css"]) await writeFile(join(DIST, name), minifyCss(await readFile(join(ASSETS, name), "utf8")) + "\n", "utf8");
// editor.js is one IIFE that talks to the page only through window.*, so it gets full minify (local names too) like app.js:
// -2 KB gzip on the editor first screen, which leaves room for the block color/icon entries (notion-parity C6) under the same cap.
const editorBuild = await Bun.build({ entrypoints: [join(ASSETS, "editor.js")], minify: true, format: "iife" });
if (!editorBuild.success) throw new AggregateError(editorBuild.logs, "editor.js minify failed");
await writeFile(join(DIST, "editor.js"), await editorBuild.outputs[0].text());
// Keep reader delivery under the fixed first-screen cap as features accumulate.
// 읽기 화면 CSS 는 주석과 공백만 걷어 낸다(규칙 순서와 값은 그대로).
// style.css starts with @import url("/tokens.css"), a second serial CSS round trip before first paint on every page, so
// dist/style.css carries the minified tokens in its place (same rule order). dist/tokens.css stays for local/cloud-page.ts.
const TOKENS_IMPORT = '@import url("/tokens.css");';
const tokensCss = minifyCss(await readFile(join(ASSETS, "tokens.css"), "utf8"));
for (const name of ["style.css", "tokens.css", ...UI_CSS, "acard-table.css", "editor.css", "db.css"]) {
  let css = minifyCss(await readFile(join(ASSETS, name), "utf8"));
  if (name === "style.css") {
    if (!css.startsWith(TOKENS_IMPORT)) throw new Error("assets/style.css must start with " + TOKENS_IMPORT);
    css = tokensCss + css.slice(TOKENS_IMPORT.length);
  }
  await writeFile(join(DIST, name), css + "\n", "utf8");
}
const uiVersions: Record<string, string> = {};
await rm(join(DIST, "ui"), { recursive: true, force: true });
for (const name of ["kit.css", "home.css", "home.js"]) {
  const source = await readFile(join(ASSETS, "ui", name), "utf8");
  const built = name.endsWith(".js") ? await Bun.build({ entrypoints: [join(ASSETS, "ui", name)], minify: true, format: "iife" }) : null;
  if (built && !built.success) throw new AggregateError(built.logs, "home minify failed");
  const bytes = built ? await built.outputs[0].text() : minifyCss(source) + "\n";
  await mkdir(join(DIST, "lazy"), { recursive: true });
  await writeFile(join(DIST, "lazy", "ui-" + name.replace(".", "-") + "." + name.split(".").pop()), bytes, "utf8");
  uiVersions[name] = Bun.hash(bytes).toString(36).slice(0, 8);
}
await writeFile(join(DIST, "acard-table-static.css"), staticTableCss(minifyCss(await readFile(join(ASSETS, "acard-table.css"), "utf8"))) + "\n", "utf8");
// ds10 component registry + every components/*.js (sorted): inlined into the worker and into the editor's lazy
// "components" chunk (assets/features/lazy/components.js carries the //__COMPONENT_SOURCE__ marker).
const componentFiles = ["component-registry.js", ...(await readdir(join(ROOT, "components"))).filter((name) => name.endsWith(".js") && name !== "index.js").sort().map((name) => "components/" + name)];
const componentSource = (await Promise.all(componentFiles.map(async (name) => (await readFile(join(ROOT, name), "utf8")).replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "").trim()))).join("\n");
// Visual kit: the worker gets every component (componentSource above); the editor's "components" chunk gets the
// registry and the basic family plus a slash manifest of every component, and each other family ships as its own lazy
// chunk components-<family> that the editor loads when such a block is shown or inserted. A file's family comes from
// its name (chart-*, _chart-core.js -> chart) and must match the family its registerComponent calls declare.
const COMPONENT_FAMILY_PREFIX: Record<string, string> = { chart: "chart", diagram: "diagram", ix: "interactive", block: "block", asset: "asset" };
const componentFamilyOf = (file: string) => COMPONENT_FAMILY_PREFIX[/^components\/_?([a-z]+)-/.exec(file)?.[1] ?? ""] ?? "basic";
const componentRegistry = await import(join(ROOT, "component-registry.js"));
await import(join(ROOT, "components", "index.js"));
const componentFamilyFiles: Record<string, string[]> = {};
for (const file of componentFiles.slice(1)) (componentFamilyFiles[componentFamilyOf(file)] ||= []).push(file);
for (const c of componentRegistry.listComponents()) {
  const files = componentFamilyFiles[c.family] || [];
  if (c.family !== "basic" && !files.length) throw new Error("component " + c.id + " declares family " + c.family + " but no components/" + c.family + "-*.js file holds it");
}
// One lazy chunk per component file (components-<file>) and one per family core (components-<family>-core, from
// components/_<family>-core.js) that the file chunks need first. The manifest names each component's chunk.
const componentIdsByFile: Record<string, string[]> = {};
for (const file of componentFiles.slice(1)) componentIdsByFile[file] = [...(await readFile(join(ROOT, file), "utf8")).matchAll(/registerComponent\(\{\s*id:\s*"([a-z][a-z0-9-]{1,39})"/g)].map((m) => m[1]);
const componentChunkOf = (file: string) => "components-" + file.replace(/^components\/_?/, "").replace(/\.js$/, "");
const componentManifest = componentRegistry.listComponents().filter((c: any) => c.family !== "basic").map((c: any) => {
  const file = Object.keys(componentIdsByFile).find((f) => componentIdsByFile[f].includes(c.id));
  if (!file) throw new Error("component " + c.id + " is registered but no components/*.js file declares it as registerComponent({ id: \"" + c.id + "\"");
  const core = (componentFamilyFiles[c.family] || []).find((f) => f.startsWith("components/_"));
  return { id: c.id, name: c.name, family: c.family, slash: c.slash, chunk: componentChunkOf(file), ...(core ? { core: componentChunkOf(core) } : {}) };
});
const moduleText = async (name: string) => (await readFile(join(ROOT, name), "utf8")).replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "").trim();
const basicComponentSource = [await moduleText("component-registry.js"), ...(await Promise.all((componentFamilyFiles.basic || []).map(moduleText)))].join("\n");
await mkdir(join(ROOT, ".build"), { recursive: true });
const componentFamilyChunks: Record<string, string> = {};
for (const [family, files] of Object.entries(componentFamilyFiles)) {
  if (family === "basic") continue;
  for (const file of files) {
    const chunk = componentChunkOf(file);
    const entry = join(ROOT, ".build", chunk + ".js");
    await writeFile(entry, "(function () {\n  var C = window.AcardComponents;\n  if (!C) return;\n  var registerComponent = C.registerComponent, registerHelpers = C.registerHelpers, registerFamilyCss = C.registerFamilyCss, UI_TONES = C.UI_TONES;\n" +
      (await moduleText(file)) + "\n  C.familyLoaded(" + JSON.stringify(family) + ");\n  window.AcardEditor && window.AcardEditor.provide(" + JSON.stringify(chunk) + ", { family: " + JSON.stringify(family) + " });\n})();\n", "utf8");
    const built = await Bun.build({ entrypoints: [entry], minify: true, format: "iife" });
    if (!built.success) throw new AggregateError(built.logs, chunk + " minify failed");
    componentFamilyChunks[chunk] = await built.outputs[0].text();
  }
}
const lazyVersions: Record<string, Record<string, string>> = Object.create(null);
const lazyDir = join(ASSETS, "features", "lazy");
for (const file of (await readdir(lazyDir).catch(() => [] as string[])).sort()) {
  const match = /^([a-z0-9-]+)\.(js|css)$/.exec(file);
  if (!match) continue;
  const source = (await readFile(join(lazyDir, file), "utf8")).replace("//__COMPONENT_SOURCE__", () => basicComponentSource)
    .replace("//__COMPONENT_MANIFEST__", () => "var COMPONENT_MANIFEST = " + JSON.stringify(componentManifest) + ";");
  // Lazy chunks ship whitespace-minified (behaviour unchanged); the chat panel chunk also gets syntax minify (its loader rides on every page).
  let bytes: Buffer;
  // folders (#16): one IIFE that talks to the page only through window.AcardFolders and DOM events, so full minify is safe.
  // graph and db-tools (#124 #123) are IIFEs too: the graph talks only to /api/graph and the DOM, db-tools only through window.AcardDbTools.
  if (["reader-navigation", "reader-enhancements", "import", "toc", "folders", "part-form", "part-register", "part-gallery", "graph", "db-tools", "import-engine", "import-obsidian", "import-notion", "paste-md", "components", "ai-marks-ui", "context-menu", "command-search", "tab-palette", "page-settings"].includes(match[1]) && match[2] === "js") {
    // components holds the inlined registry source, so it is bundled from a temp copy with the markers filled in.
    const entryFile = match[1] === "components" ? join(ROOT, ".build", "lazy-components.js") : join(lazyDir, file);
    if (match[1] === "components") await writeFile(entryFile, source, "utf8");
    const built = await Bun.build({ entrypoints: [entryFile], minify: true, format: "iife" });
    if (!built.success) throw new AggregateError(built.logs, file + " minify failed");
    bytes = Buffer.from(await built.outputs[0].text());
  } else bytes = Buffer.from(match[2] === "js" ? new Bun.Transpiler({ minifyWhitespace: true, minifySyntax: match[1] === "agent-chat" }).transformSync(source) : minifyCss(source) + "\n");
  await mkdir(join(DIST, "lazy"), { recursive: true });
  await writeFile(join(DIST, "lazy", file), bytes);
  (lazyVersions[match[1]] ||= {})[match[2]] = Bun.hash(bytes).toString(36).slice(0, 8);
}
// Family chunks only ship next to the editor's components chunk that loads them (a build without it has no editor).
componentFamilyChunks["components-index"] = "window.AcardEditor&&window.AcardEditor.provide(\"components-index\",{list:" + JSON.stringify(componentManifest).replace(/</g, "\\u003c") + "});\n";
for (const [chunk, code] of Object.entries(lazyVersions.components ? componentFamilyChunks : {})) {
  const bytes = Buffer.from(code);
  await writeFile(join(DIST, "lazy", chunk + ".js"), bytes);
  lazyVersions[chunk] = { js: Bun.hash(bytes).toString(36).slice(0, 8) };
}
// The browser video re-encode (acard-upload-100mb, editor-next/video-encode.js) bundles mediabunny (MPL-2.0, unmodified)
// from node_modules at build time instead of shipping a committed copy; big-upload loads it only for a dropped video.
if (lazyVersions["big-upload"]) {
  const built = await Bun.build({ entrypoints: [join(ROOT, "editor-next", "video-encode.js")], minify: true, target: "browser", format: "iife" });
  if (!built.success) throw new AggregateError(built.logs, "video-encode build failed");
  const bytes = Buffer.from("/*! mediabunny (MPL-2.0) https://github.com/Vanilagy/mediabunny - unmodified, bundled */\n" + await built.outputs[0].text());
  await writeFile(join(DIST, "lazy", "video-encode.js"), bytes);
  lazyVersions["video-encode"] = { js: Bun.hash(bytes).toString(36).slice(0, 8) };
}
for (const [name, versions] of Object.entries(lazyVersions)) {
  if (!versions.js) throw new Error("Lazy feature needs JavaScript: " + name);
}
// Reader-only TOC assets are conditional, not on the first-screen path or editor manifest.
const enhancementsPath = join(DIST, "lazy", "reader-enhancements.js");
if (lazyVersions.toc && lazyVersions["reader-enhancements"]) {
  const bytes = (await readFile(enhancementsPath, "utf8")).replace("__TOC_JS__", lazyVersions.toc.js).replace("__TOC_CSS__", lazyVersions.toc.css);
  await writeFile(enhancementsPath, bytes);
  lazyVersions["reader-enhancements"].js = Bun.hash(bytes).toString(36).slice(0, 8);
}
// db.js is built before the lazy chunks; its button cells load /lazy/buttons and /lazy/button-editor by these hashes.
await writeFile(join(DIST, "db.js"), (await readFile(join(DIST, "db.js"), "utf8")).replaceAll("__BUTTONS_JS__", lazyVersions.buttons?.js ?? "0").replaceAll("__BUTTONS_CSS__", lazyVersions.buttons?.css ?? "0").replaceAll("__BUTTON_EDITOR_JS__", lazyVersions["button-editor"]?.js ?? "0").replaceAll("__BUTTON_EDITOR_CSS__", lazyVersions["button-editor"]?.css ?? "0").replaceAll("__DB_TOOLS_JS__", lazyVersions["db-tools"]?.js ?? "0").replaceAll("__DB_TOOLS_CSS__", lazyVersions["db-tools"]?.css ?? "0"));
// The reader share button loads /lazy/share-dialog.js; app.js carries its content hash.
// Full minify (names + syntax) keeps the reader first screen under its gzip cap; app.js is one classic IIFE script.
const appBuild = await Bun.build({ entrypoints: [join(ASSETS, "app.js")], minify: true, format: "iife" });
if (!appBuild.success) throw new AggregateError(appBuild.logs, "app.js minify failed");
await writeFile(join(DIST, "app.js"), (await appBuild.outputs[0].text()).replace("__SHARE_DIALOG__", lazyVersions["share-dialog"]?.js ?? "0").replace("__READER_TOOLS__", lazyVersions["reader-tools"]?.js ?? "0").replace("__READER_TOOLS_CSS__", lazyVersions["reader-tools"]?.css ?? "0").replace("__SCROLLBARS__", lazyVersions.scrollbars?.js ?? "0").replace("__READER_NAVIGATION__", lazyVersions["reader-navigation"]?.js ?? "0").replace("__READER_ENHANCEMENTS__", lazyVersions["reader-enhancements"]?.js ?? "0"));
const readerFeatures = { js: false, css: false };
for (const ext of ["js", "css"] as const) {
  const names = (await readdir(join(ASSETS, "features"))).filter((name) => name.endsWith("." + ext)).sort();
  for (const reader of [false, true]) {
    const selected = names.filter((name) => reader
      ? name.endsWith(".reader." + ext) || name.endsWith(".shared.js")
      : !name.endsWith(".reader." + ext));
    const parts = await Promise.all(selected.map((name) => readFile(join(ASSETS, "features", name), "utf8")));
    const manifest = !reader && ext === "js" && Object.keys(lazyVersions).length
      ? "window.AcardLazy = " + JSON.stringify(Object.fromEntries(Object.entries(lazyVersions).filter(([name]) => !["import", "import-engine", "import-obsidian", "import-notion", "toc"].includes(name)))) + ";\n" : "";
    const content = (manifest + parts.filter((part) => part.trim()).join(ext === "js" ? "\n;\n" : "\n")).replace("__AGENT_CHAT_JS__", lazyVersions["agent-chat"]?.js ?? "0").replace("__AGENT_CHAT_CSS__", lazyVersions["agent-chat"]?.css ?? "0").replace('"/lazy/quick-note.js"', '"/lazy/quick-note.js?v=' + (lazyVersions["quick-note"]?.js ?? "0") + '"');
    if (reader) readerFeatures[ext] = content.length > 0;
    let output = content;
    // Both bundles are joined IIFEs that talk to the page only through window.*, so names + whitespace minify is safe.
    if (ext === "js" && content) {
      const built = await Bun.build({ entrypoints: ["features.js"], files: { "features.js": content }, minify: { whitespace: true, identifiers: true, syntax: false }, format: "esm" });
      if (!built.success) throw new AggregateError(built.logs, (reader ? "reader" : "editor") + " features minify failed");
      output = (await built.outputs[0].text()).trimEnd();
    }
    await writeFile(join(DIST, "features" + (reader ? "-reader" : "") + "." + ext), output, "utf8");
  }
}
await rm(join(DIST, "features"), { recursive: true, force: true });
const siteNameHtml = SITE.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The editor's first content render waits for /lazy/recent-cache.js after DOMContentLoaded (editor.js), so the head
// preloads it by the URL the lazy loader builds (/lazy/<name>.js?v=<AcardLazy hash>); without the chunk the line goes.
const recentCacheLine = /<link rel="preload" as="script" href="\/lazy\/recent-cache\.js\?v=__RECENT_CACHE_JS__">\r?\n/;
const editorHtml = await readFile(join(ASSETS, "editor.html"), "utf8");
if (!recentCacheLine.test(editorHtml)) throw new Error("assets/editor.html is missing the recent-cache preload line");
await writeFile(join(DIST, "editor.html"), editorHtml.replace(recentCacheLine, (line) => lazyVersions["recent-cache"]?.js ? line.replace("__RECENT_CACHE_JS__", lazyVersions["recent-cache"].js) : "").replaceAll("__SITE_NAME__", siteNameHtml), "utf8");
await writeFile(join(DIST, "agents.html"), (await readFile(join(ASSETS, "agents.html"), "utf8")).replaceAll("__SITE_NAME__", siteNameHtml).replaceAll("__PROJECTS_JS__", lazyVersions.projects?.js ?? "0").replaceAll("__PROJECTS_CSS__", lazyVersions.projects?.css ?? "0"), "utf8");
await writeFile(join(DIST, "gallery.html"), (await readFile(join(ASSETS, "gallery.html"), "utf8")).replaceAll("__SITE_NAME__", siteNameHtml), "utf8");
await writeFile(join(DIST, "site-config.js"), "window.DoriSite = " + JSON.stringify(siteConfig).replace(/</g, "\\u003c") + ";\n", "utf8");
const manifest = { ...JSON.parse(await readFile(join(ASSETS, "site.webmanifest"), "utf8")), name: SITE, short_name: SITE };
await writeFile(join(DIST, "manifest.webmanifest"), JSON.stringify(manifest), "utf8");
await writeFile(join(DIST, "site.webmanifest"), JSON.stringify(manifest), "utf8");
await cp(join(ROOT, "seed", "db-mcp-master.json"), join(DIST, "db-seed.json"));
await (await import("./features/templates.build.ts")).buildTemplates(ROOT, DIST);

const stripModule = (source: string) => source.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
for (const shared of ["db-model.js", "db-formula.js"]) {
  const source = await readFile(join(ROOT, shared), "utf8");
  const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((match) => match[1]);
  const globalName = shared === "db-model.js" ? "DoriDBModel" : "DoriFormula";
  // The shared model is wrapped in an IIFE so its top-level names stay local, then fully minified; window.<global> is its only output.
  const tmp = join(DIST, "__" + shared);
  await writeFile(tmp, "(function(){\n" + stripModule(source) + "\nwindow." + globalName + " = {" + names.join(",") + "};\n})();\n", "utf8");
  const built = await Bun.build({ entrypoints: [tmp], minify: true, format: "iife" });
  await rm(tmp);
  if (!built.success) throw new AggregateError(built.logs, shared + " minify failed");
  await writeFile(join(DIST, shared), await built.outputs[0].text(), "utf8");
}
for (const p of pages) {
  const dir = p.slug === "index" ? DIST : join(DIST, p.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), layout(p, pages), "utf8");
  // notes/home.md 의 슬러그는 index 라서 /home/ 으로 들어오는 사람을 위해 한 부 더 둔다.
  if (p.slug === "index") {
    await mkdir(join(DIST, "home"), { recursive: true });
    await writeFile(join(DIST, "home", "index.html"), layout(p, pages), "utf8");
  }
}
const pageMeta: Record<string, Record<string, string>> = {};
for (const p of pages) {
  const m: Record<string, string> = {};
  for (const k of ["icon", "cover", "side_image", "tags"] as const) if (p[k]) m[k] = p[k];
  if (Object.keys(m).length) pageMeta[p.slug] = m;
}
const index = pages.map((p) => ({ t: p.title, u: href(p.slug), s: p.summary, g: p.group, h: p.toc.map((t) => t.text), b: p.text.slice(0, 6000) }));
await writeFile(join(DIST, "search-index.json"), JSON.stringify(index), "utf8");
const seed = {
  generatedAt: new Date().toISOString(),
  pages: pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    parent: p.parent,
    ord: p.order,
    kind: p.kind,
    updated: Date.parse(p.updated) || Date.now(),
    hash: p.hash,
    blocks: p.blocks
  }))
};
await writeFile(join(DIST, "notes-seed.json"), JSON.stringify(seed), "utf8");
await writeFile(join(DIST, "robots.txt"), "User-agent: *" + NL + "Disallow: /" + NL, "utf8");
await writeFile(join(DIST, "_headers"), [
  "/*",
  "  X-Robots-Tag: noindex, nofollow",
  "  X-Frame-Options: DENY",
  "  Referrer-Policy: no-referrer",
  "  X-Content-Type-Options: nosniff",
  ""
].join("\n"), "utf8");
const notFound = ["<!doctype html>", "<html lang=\"ko\"><head><meta charset=\"utf-8\">",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
  "<meta name=\"robots\" content=\"noindex\">", "<title>없는 문서 · " + SITE + "</title>",
  "<link rel=\"stylesheet\" href=\"/style.css\"></head><body>",
  "<main id=\"main\" class=\"missing\"><h1>없는 문서예요</h1>",
  "<p>주소를 다시 확인하거나 <a href=\"/\">홈</a>으로 돌아가 주세요.</p></main></body></html>", ""].join("\n");
await writeFile(join(DIST, "404.html"), notFound, "utf8");
const gateLogo = "data:image/svg+xml;base64," + Buffer.from(await readFile(join(ASSETS, "logo.svg"), "utf8")).toString("base64");
const workerSource = (await readFile(join(ROOT, "gate", "_worker.js"), "utf8")).replaceAll("__GATE_LOGO__", gateLogo).replaceAll("__SITE_NAME__", siteNameHtml.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
const equationSource = await readFile(join(ROOT, "equation-html.js"), "utf8");
const writeCore = "";
const inline = async (name: string) => stripModule(await readFile(join(ROOT, name), "utf8")).replace("//__WRITE_CORE__", () => writeCore).trim();
// TS 모듈은 타입을 떼고 넣는다 (notion-import/notion-export 는 워커 안에서도 그대로 돈다).
const inlineTs = async (name: string) => stripModule(new Bun.Transpiler({ loader: "ts" }).transformSync(await readFile(join(ROOT, name), "utf8"))).trim();
const featureFiles = (await readdir(join(ROOT, "features"))).filter((name) => name.endsWith(".js")).sort();
const inlines: Record<string, string> = {
  "//__READER_FEATURE_CSS__": readerFeatures.css ? "'<link rel=\"stylesheet\" href=\"/features-reader.css\">'," : "",
  "//__READER_FEATURE_JS__": readerFeatures.js ? "'<script src=\"/features-reader.js\"></script>'," : "",
  "//__FEATURES__": (await Promise.all(featureFiles.map((name) => inline("features/" + name)))).join("\n;\n"),
  "//__EQUATION_HTML__": stripModule(equationSource).trim() + "\n" + await inline("sandbox-policy.js") + "\n" + await inline("visual-html.js") + "\n" + await inline("part-html.js") + "\n" + componentSource,
  "//__BLOCK_HTML__": (await readFile(join(ROOT, "assets/editor-model.js"), "utf8")) + "\n" + (await readFile(join(ROOT, "assets/columns-model.js"), "utf8")) + "\n" + (await readFile(join(ROOT, "assets/ai-marks.js"), "utf8")) + "\n" + await inline("block-html.js"),
  "//__EDITOR_PAGES__": await inline("editor-pages.js"),
  "//__AGENT_API__": await inline("agent-api.js"),
  "//__DB_MODEL__": await inline("db-model.js"),
  "//__DB_FORMULA__": await inline("db-formula.js"),
  "//__DB_HTML__": await inline("db-html.js"),
  "//__MARKDOWN_BLOCKS__": await inlineTs("markdown-blocks.ts"),
  "//__NOTION_IMPORT__": await inlineTs("notion-import.ts"),
  "//__NOTION_EXPORT__": await inlineTs("notion-export.ts"),
  "//__IMPORT_CORE__": (await Promise.all(IMPORT_CORE_FILES.filter((name) => existsSync(join(ROOT, name))).map((name) => inlineTs(name)))).join("\n"),
};
let workerOut = workerSource.replace("//__BLOCK_HTML__", "globalThis.ACARD_ASSET_VERSIONS = " + JSON.stringify(imageVersions) + ";\nglobalThis.ACARD_PAGE_META = " + JSON.stringify(pageMeta).replace(/</g, "\\u003c") + ";\n//__BLOCK_HTML__");
workerOut = workerOut.replaceAll("__LIVE_JS__", lazyVersions.live?.js ?? "0");
workerOut = workerOut.replaceAll("__FOLDERS_JS__", lazyVersions.folders?.js ?? "0").replaceAll("__FOLDERS_CSS__", lazyVersions.folders?.css ?? "0");
workerOut = workerOut.replaceAll("__HOME_JS__", uiVersions["home.js"]).replaceAll("__HOME_CSS__", uiVersions["home.css"]).replaceAll("__UI_KIT_CSS__", uiVersions["kit.css"]);
workerOut = workerOut.replaceAll("__PROJECTS_JS__", lazyVersions.projects?.js ?? "0").replaceAll("__PROJECTS_CSS__", lazyVersions.projects?.css ?? "0");
workerOut = workerOut.replaceAll("__JOURNAL_JS__", lazyVersions.journal?.js ?? "0").replaceAll("__JOURNAL_CSS__", lazyVersions.journal?.css ?? "0");
const stampChecks = (text: string) => text.replaceAll("__CHECKS_JS__", lazyVersions.checks?.js ?? "0").replaceAll("__CHECKS_CSS__", lazyVersions.checks?.css ?? "0").replaceAll("__PARTS_JS__", lazyVersions.parts?.js ?? "0").replaceAll("__BUTTONS_JS__", lazyVersions.buttons?.js ?? "0").replaceAll("__BUTTONS_CSS__", lazyVersions.buttons?.css ?? "0");
workerOut = stampChecks(workerOut);
for (const [marker, code] of Object.entries(inlines)) {
  if (!workerOut.includes(marker)) throw new Error("gate/_worker.js is missing the " + marker + " marker");
  workerOut = workerOut.replace(marker, () => code);
}
// 편집기 미리보기는 같은 소스를 브라우저 전역으로 노출한 사본을 쓴다 (단일 소스 규칙, README 참고).
// Wrapped in an IIFE and fully minified like db-model.js; window.EquationHtml is its only output.
{
  const tmp = join(DIST, "__equation-html.js");
  await writeFile(tmp, "(function(){\n" + stripModule(equationSource) + "\nwindow.EquationHtml = { renderLatex, equationHtml };\n})();\n", "utf8");
  const built = await Bun.build({ entrypoints: [tmp], minify: true, format: "iife" });
  await rm(tmp);
  if (!built.success) throw new AggregateError(built.logs, "equation-html.js minify failed");
  await writeFile(join(DIST, "equation-html.js"), await built.outputs[0].text(), "utf8");
}
// Files in fonts/ and _site/ (and the font and image URLs inside CSS, and the font CSS paths in app.js) get a content-hash ?v=
// too, so every static file a page loads is served immutable (gate/static-cache.ts). Leaves are hashed first, then CSS/JS are
// stamped and re-hashed until stable, so a font change changes fonts.css?v= and a tokens.css change changes style.css?v=.
const nestedVersion = new Map<string, string>();
const hashOf = async (rel: string) => Bun.hash(await readFile(join(DIST, rel))).toString(36).slice(0, 8);
const nestedFiles: string[] = [];
for (const dir of ["fonts", "_site"]) {
  for await (const file of new Bun.Glob("**/*.{css,js,svg,png,woff2}").scan({ cwd: join(DIST, dir) })) nestedFiles.push(dir + "/" + file.replaceAll("\\", "/"));
}
for (const rel of nestedFiles) nestedVersion.set(rel, await hashOf(rel));
const leafVersion = new Map<string, string>();
for (const name of await readdir(DIST)) if (/\.(svg|png|ico)$/.test(name)) leafVersion.set(name, await hashOf(name));
const NESTED_REF = /((?:href|src|content)=\\?["']|url\(\\?["']?|["'])\/((?:fonts|_site)\/[\w./-]+\.(?:css|js|svg|png|woff2))(?=(?:#[\w-]+)?\\?["')])/g;
const LEAF_REF = /(url\(\\?["']?)\/([\w.-]+\.(?:svg|png|ico))(?=\\?["')])/g;
const stampNested = (text: string) => text.replace(NESTED_REF, (all, lead: string, path: string) => (nestedVersion.has(path) ? lead + "/" + path + "?v=" + nestedVersion.get(path) : all));
const styleFiles = [...nestedFiles.filter((f) => f.endsWith(".css")), ...(await readdir(DIST)).filter((f) => f.endsWith(".css"))];
for (let round = 0; round < 3; round++) {
  for (const rel of styleFiles) {
    const text = await readFile(join(DIST, rel), "utf8");
    const next = stampNested(text).replace(LEAF_REF, (all, lead: string, name: string) => (leafVersion.has(name) ? lead + "/" + name + "?v=" + leafVersion.get(name) : all));
    if (next !== text) await writeFile(join(DIST, rel), next, "utf8");
    if (nestedVersion.has(rel)) nestedVersion.set(rel, await hashOf(rel));
  }
}
for (const name of ["app.js", "editor-pages-ui.js"]) await writeFile(join(DIST, name), stampNested(await readFile(join(DIST, name), "utf8")), "utf8");
// Assets are cached for hours without a versioned URL, so stamp each local .css/.js and brand image reference with its content hash.
const assetVersion = new Map<string, string>();
for (const name of await readdir(DIST)) {
  if (/\.(css|js|svg|png|ico|webmanifest)$/.test(name) && name !== "_worker.js" && name !== "sw.js") assetVersion.set(name, Bun.hash(await readFile(join(DIST, name))).toString(36).slice(0, 8));
}
// A #fragment (<use href="/wordmark-symbol.svg#w">) stays after the version. Absolute https://notes.example.com/ URLs (og:image on the
// public pages) are stamped too, so a new og.png gets a new URL and link previews stop reusing the cached card (#118).
const stampAssets = (text: string) => stampNested(text.replace(/((?:href|src|content)=\\?["'](?:https:\/\/notes\.example\.com)?|url\(\\?["']?)\/([\w.-]+\.(?:css|js|svg|png|ico|webmanifest))(?=(?:#[\w-]+)?\\?["')])/g, (all, lead: string, name: string) => assetVersion.has(name) ? lead + "/" + name + "?v=" + assetVersion.get(name) : all));
// Versioned files are served immutable (gate/static-cache.ts), so style.css is stamped before its own hash: a tokens.css change must change style.css?v=.
await writeFile(join(DIST, "style.css"), stampAssets(await readFile(join(DIST, "style.css"), "utf8")), "utf8");
assetVersion.set("style.css", Bun.hash(await readFile(join(DIST, "style.css"))).toString(36).slice(0, 8));
// Keyed by path without the leading slash (gate/static-cache.ts).
const staticVersions: Record<string, string> = {};
for (const [path, hash] of Object.entries(imageVersions)) staticVersions[path.slice(1)] = hash;
for (const [name, hash] of assetVersion) staticVersions[name] = hash;
for (const [path, hash] of nestedVersion) staticVersions[path] = hash;
for (const [name, versions] of Object.entries(lazyVersions)) for (const [ext, hash] of Object.entries(versions)) staticVersions["lazy/" + name + "." + ext] = hash;
for (const [name, hash] of Object.entries(uiVersions)) staticVersions["lazy/ui-" + name.replace(".", "-") + "." + name.split(".").pop()] = hash;
const offlineSource = await readFile(join(ROOT, "offline-sw.js"), "utf8");
const offlineShell = [...assetVersion].filter(([name]) => /\.(css|js|svg|png|ico)$/.test(name)).map(([name, hash]) => "/" + name + "?v=" + hash);
offlineShell.push(...Object.entries(imageVersions).filter(([path]) => /^\/img\/(icons|avatars)\//.test(path)).map(([path, hash]) => path + "?v=" + hash));
const offlineLazy = Object.entries(lazyVersions).flatMap(([name, versions]) => Object.entries(versions).map(([ext, hash]) => "/lazy/" + name + "." + ext + "?v=" + hash));
offlineLazy.push(...[...nestedVersion].filter(([path]) => /\.(js|css)$/.test(path)).map(([path, hash]) => "/" + path + "?v=" + hash));
const offlineVersion = Bun.hash(offlineSource + workerOut + JSON.stringify(offlineShell) + JSON.stringify(offlineLazy)).toString(36);
const serviceWorkerSource = offlineSource + "\nconst offline = createOfflineWorker({ caches, origin: self.location.origin, fetch: request => fetch(request), report: error => console.error(error), unregister: () => self.registration.unregister(), cookieId: () => self.cookieStore ? self.cookieStore.get(\"acard_id\").then(c => c ? c.value : null) : undefined, notify: (message, id) => self.clients.matchAll({ type: \"window\" }).then(list => list.forEach(client => { if (!id || offline.identity(client.id) === id) client.postMessage(message); })) }, " + JSON.stringify({ version: offlineVersion, shell: offlineShell, lazy: offlineLazy }) + ");\n" +
  // A new worker takes over at once: a broken older one must not keep control while any tab stays open.
  'self.addEventListener("install", event => event.waitUntil(offline.install().finally(() => self.skipWaiting())));\n' +
  'self.addEventListener("activate", event => event.waitUntil(offline.activate().then(() => self.clients.claim())));\n' +
  'self.addEventListener("message", event => { if (event.data?.type === "acard-id" && event.source?.id) event.waitUntil(offline.identify(event.data.id, event.source.id)); });\n' +
  'self.addEventListener("fetch", event => event.respondWith(offline.handle(event.request, promise => event.waitUntil(promise), event.clientId, event.resultingClientId).catch(() => fetch(event.request))));\n';
const serviceWorkerBuild = await Bun.build({ entrypoints: ["sw.js"], files: { "sw.js": serviceWorkerSource }, minify: true, format: "esm" });
if (!serviceWorkerBuild.success) throw new AggregateError(serviceWorkerBuild.logs, "service worker minify failed");
await writeFile(join(DIST, "sw.js"), await serviceWorkerBuild.outputs[0].text(), "utf8");
// 예전 마커 조립 결과는 그대로 두고, 에이전트 입구(OAuth·MCP SDK 를 쓰는 모듈)와 함께 한 파일로 묶는다.
const CORE = join(ROOT, ".build", "acard-core.js");
await mkdir(join(ROOT, ".build"), { recursive: true });
const buildSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().trim() || "dev";
const buildInfo = { sha: buildSha, version: new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10).replace(/-/g, ".") + "-" + buildSha };
await writeFile(CORE, "globalThis.ACARD_STATIC_VERSIONS = " + JSON.stringify(staticVersions) + ";\nglobalThis.ACARD_BUILD = " + JSON.stringify(buildInfo) + ";\n" + stampAssets(workerOut), "utf8");
const bundled = await Bun.build({
  entrypoints: [join(ROOT, "gate", "agent-entry.ts")],
  format: "esm",
  target: "browser",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:workers"],
  minify: false,
  plugins: [{
    name: "acard-core",
    setup(build) {
      build.onResolve({ filter: /[\\/]acard-core\.js$/ }, () => ({ path: CORE }));
    },
  }],
});
if (!bundled.success) throw new Error("agent entry bundle failed:\n" + bundled.logs.map(String).join("\n"));
// The entry (gate/agent-entry.ts, gate/beta.ts, gate/i18n.ts) writes its own tags after the core was stamped.
await writeFile(join(DIST, "_worker.js"), stampAssets(stampChecks(await bundled.outputs[0].text())), "utf8");
// npm 과 같은 모양(package/…)의 tgz 를 만들어 `npx --package=<주소>` 로 바로 설치되게 한다.
const CLI = join(ROOT, "packages", "acard-cli");
const cliFiles: Record<string, Uint8Array> = {};
for (const name of ["package.json", "README.md"]) cliFiles["package/" + name] = await Bun.file(join(CLI, name)).bytes();
for (const dir of ["bin", "src"]) {
  for await (const file of new Bun.Glob("**/*").scan({ cwd: join(CLI, dir) })) cliFiles["package/" + dir + "/" + file.replaceAll("\\", "/")] = await Bun.file(join(CLI, dir, file)).bytes();
}
const cliTar = await new Bun.Archive(cliFiles).bytes();
await Bun.write(join(DIST, "acard-cli.tgz"), Bun.gzipSync(cliTar));
const htmlFiles = (await readdir(DIST, { recursive: true })).filter((f) => f.endsWith(".html"));
for (const file of htmlFiles) await writeFile(join(DIST, file), stampAssets(stampChecks(await readFile(join(DIST, file), "utf8"))), "utf8");
const workerCheck = Bun.spawnSync(["node", "--check", join(DIST, "_worker.js")], { stdout: "pipe", stderr: "pipe" });
if (workerCheck.exitCode !== 0) throw new Error("dist/_worker.js does not parse:\n" + workerCheck.stderr.toString());
console.log("BUILD_OK pages=" + pages.length + " slugs=" + pages.map((p) => p.slug).join(","));
console.log("SEED_OK blocks=" + pages.reduce((sum, p) => sum + p.blocks.length, 0));
for (const p of pages) console.log("  - " + p.slug + " | " + p.title + " | updated " + p.updated + " | toc " + p.toc.length + " | blocks " + p.blocks.length);

const { measurePerformanceBudget, printPerformanceBudget } = await import("./scripts/perf-budget.ts");
const budgetConfig = await Bun.file(join(ROOT, "perf-budget.json")).json();
const budget = await measurePerformanceBudget(DIST, budgetConfig.caps);
printPerformanceBudget(budget);
if (!budget.passed) process.exitCode = 1;
