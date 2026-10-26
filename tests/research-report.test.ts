import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadTemplates } from "../features/templates.build";
import "../assets/editor-model.js";
import "../assets/columns-model.js";
import { EVIDENCE_CSS, REPORT_CSS, renderBlocks } from "../block-html.js";
import { blocksToMarkdown, markdownToBlocks } from "../markdown-blocks";
import { visualBlockHtml, VISUAL_CSP } from "../visual-html.js";
import { cookie, setup } from "./db-harness";

// Research report page style (acard-research-report, owner 2026-10-22; acard-report-plain 2026-10-23): page setting font
// "report" keeps the normal Acard page look and adds numbered equations and figures. Evidence tags draw on every page.
const ROOT = join(import.meta.dir, "..");
let h: ReturnType<typeof setup>;
beforeEach(() => { h = setup(); });
afterEach(() => h.sqlite.close());

const blocks = [
  { id: "p1", type: "paragraph", text: "결론 한 줄" },
  { id: "q1", type: "quote", text: "원래 질문" },
  { id: "e1", type: "equation", text: "y = a x" },
];
async function page(slug: string, font?: string) {
  expect((await h.call("POST", "/api/pages", { title: "T " + slug, slug })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/" + slug, { title: "T " + slug, blocks })).status).toBe(200);
  if (font) expect((await h.call("PUT", "/api/page/" + slug + "/settings", { font })).status).toBe(200);
}
async function reader(path: string) {
  const response = await h.worker.fetch(new Request("https://notes.test" + path, { headers: { cookie: await cookie() } }), h.env);
  return { status: response.status, html: await response.text() };
}

test("a report page gets the report class and its numbering rules; the byline stays below the title like any page", async () => {
  await page("study", "report");
  const { status, html } = await reader("/study/");
  expect(status).toBe(200);
  expect(html).toMatch(/<main id="main" class="[^"]*\brp\b[^"]*" data-font="report">/);
  expect(html).toContain("<style>" + REPORT_CSS + "</style>");
  expect(html).not.toContain("tokens-report.css");
  expect(html.indexOf("<h1>T study</h1>")).toBeLessThan(html.indexOf('class="byline"'));
});

test("pages without the setting render exactly as before: no report class, rules or moved byline", async () => {
  await page("plain");
  await page("serif", "serif");
  for (const slug of ["plain", "serif"]) {
    const { html } = await reader("/" + slug + "/");
    expect(html).not.toContain(REPORT_CSS);
    expect(html).not.toContain("tokens-report.css");
    expect(html).not.toMatch(/class="[^"]*\brp\b/);
    expect(html.indexOf("<h1>T " + slug + "</h1>")).toBeLessThan(html.indexOf('class="byline"'));
  }
});

test("the shared link of a report page carries the same style; another shared page does not", async () => {
  await page("study", "report");
  await page("plain");
  for (const [slug, on] of [["study", true], ["plain", false]] as const) {
    const link = (await h.call("POST", "/api/page/" + slug + "/share")).data as { url: string };
    const response = await h.worker.fetch(new Request("https://notes.test" + link.url), h.env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.includes(REPORT_CSS)).toBe(on);
    expect(/<div class="sv-wrap[^"]*\brp\b/.test(html)).toBe(on);
  }
});

test("agents set the style with front matter style: report and read it back", async () => {
  const { createAgentToken, ensureAgentSchema } = await import("../agent-api.js");
  await h.call("GET", "/api/v1/me");
  await ensureAgentSchema(h.env.DB);
  const { token } = await createAgentToken(h.env.DB, { name: "Claude Code", scopes: ["read", "write"] });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await h.worker.fetch(new Request("https://notes.test" + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), h.env);
    return { status: r.status, data: await r.json() as any };
  };
  const made = await api("POST", "/api/v1/pages", { markdown: "---\ntitle: 커피\nstyle: report\n---\n결론 [ESTIMATED]\n" });
  expect(made.status).toBe(201);
  expect((await h.call("GET", "/api/page/" + encodeURIComponent(made.data.slug) + "/settings")).data.settings.font).toBe("report");
  const read = await api("GET", "/api/v1/pages/" + encodeURIComponent(made.data.slug));
  expect(read.data.markdown).toContain("\nstyle: report\n");
  expect(read.data.markdown).toContain("결론 [ESTIMATED]");
  const other = await api("POST", "/api/v1/pages", { markdown: "---\ntitle: 보통\nstyle: fancy\n---\n본문\n" });
  expect((await h.call("GET", "/api/page/" + encodeURIComponent(other.data.slug) + "/settings")).data.settings.font).toBe("default");
});

test("the setting only takes known values", async () => {
  await page("study");
  expect((await h.call("PUT", "/api/page/study/settings", { font: "paper" })).status).toBe(400);
  expect((await h.call("PUT", "/api/page/study/settings", { font: "report" })).data.settings.font).toBe("report");
});

test("report rules are scoped to .rp, only number blocks and leave the page look alone", () => {
  for (const rule of REPORT_CSS.split("}").filter((r) => r.includes("{") && !r.trim().startsWith("@media"))) {
    const selector = rule.slice(0, rule.indexOf("{")).replace(/^@media[^{]*\{/, "");
    expect(selector.includes(".rp")).toBe(true);
  }
  expect(REPORT_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/);
  expect(REPORT_CSS).not.toMatch(/font-family|background|--content-width|--rp-|\bh[1-4]\b|blockquote|byline|statrow|stable|callout/);
  expect(EVIDENCE_CSS).not.toMatch(/font-family|--rp-/);
  expect(existsSync(join(ROOT, "assets/tokens-report.css"))).toBe(false);
});

test("evidence labels: [MEASURED] [CLAIMED] [ESTIMATED] draw as tags in text, tables and tiles; other brackets stay text", () => {
  const md = ["평균 60°C [MEASURED], 권장 57.8°C [CLAIMED], 11.5분 [ESTIMATED], [measured] [OTHER]", "", "| 값 | 라벨 |", "| === | === |", "| 60 | [MEASURED] |", "",
    '```acard-ui {"ui":"stat-row"}', '{"items":[{"label":"도달 [ESTIMATED]","value":"11.5분","note":"k [MEASURED]"}]}', "```"].join("\n");
  const blocks = markdownToBlocks(md).map((b, i) => ({ ...b, id: "b" + i }));
  const html = renderBlocks(blocks, { pages: [] });
  const tags = [...html.matchAll(/<span class="ev ev-(\w+)">(\w+)<\/span>/g)].map((m) => m[1] + ":" + m[2]);
  expect(tags).toEqual(["measured:MEASURED", "claimed:CLAIMED", "estimated:ESTIMATED", "measured:MEASURED", "estimated:ESTIMATED", "measured:MEASURED"]);
  expect(html).toContain("[measured] [OTHER]");
  expect(html.match(/<style>/g)?.filter(Boolean).length).toBeGreaterThan(0);
  expect(html.split(EVIDENCE_CSS).length - 1).toBe(1);
  expect(blocksToMarkdown(blocks)).toBe(md);
  expect(renderBlocks([{ id: "x", type: "paragraph", text: "no label" }], { pages: [] })).not.toContain(EVIDENCE_CSS);
});

test("evidence labels reach the print page and the shared link (head style, since shared bodies drop <style>)", async () => {
  expect((await h.call("POST", "/api/pages", { title: "E", slug: "ev" })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/ev", { title: "E", blocks: [{ id: "p", type: "paragraph", text: "값 [CLAIMED]" }] })).status).toBe(200);
  const print = await reader("/print/ev/");
  expect(print.html).toContain('<span class="ev ev-claimed">CLAIMED</span>');
  expect(print.html).toContain("print-color-adjust:exact");
  const link = (await h.call("POST", "/api/page/ev/share")).data as { url: string };
  const shared = await (await h.worker.fetch(new Request("https://notes.test" + link.url), h.env)).text();
  expect(shared).toContain('<span class="ev ev-claimed">CLAIMED</span>');
  expect(shared.slice(0, shared.indexOf("</head>"))).toContain(EVIDENCE_CSS);
});

test("footnote references survive the shared link: the superscript links, the note's back link and the head style", async () => {
  const notes = { id: "n", type: "component", text: JSON.stringify({ notes: [{ id: "1", text: "설문은 단새" }] }), meta: { ui: "block-footnotes" } };
  expect((await h.call("POST", "/api/pages", { title: "F", slug: "fn" })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/fn", { title: "F", blocks: [{ id: "p", type: "paragraph", text: "61%였다.[^1]" }, notes] })).status).toBe(200);
  const link = (await h.call("POST", "/api/page/fn/share")).data as { url: string };
  const shared = await (await h.worker.fetch(new Request("https://notes.test" + link.url), h.env)).text();
  expect(shared).toContain('61%였다.<sup class="fnref"><a href="#fn-1" id="fnref-1">1</a></sup>');
  expect(shared).toContain('<a class="blt-back" href="#fnref-1"');
  expect(shared.slice(0, shared.indexOf("</head>"))).toContain(".fnref{");
});

test("function names like \\ln draw as upright text, not as an unknown command", async () => {
  const { equationHtml } = await import("../equation-html.js");
  const html = equationHtml("t = \\frac{1}{k} \\ln x + \\sin y");
  expect(html).toContain('<span class="mtext">ln</span>');
  expect(html).toContain('<span class="mtext">sin</span>');
  expect(html).not.toContain("munk");
  expect(equationHtml("\\foo")).toContain('<span class="munk">\\foo</span>');
});

test("report pages number equations and captioned figures with CSS counters, so a moved block renumbers itself", () => {
  expect(REPORT_CSS).toContain(".rp .mathblock{position:relative;counter-increment:rp-eq");
  expect(REPORT_CSS).toContain(".rp .mathblock::after{content:'(' counter(rp-eq) ')'");
  expect(REPORT_CSS).toContain(".rp figure:has(figcaption){counter-increment:rp-fig}");
  expect(REPORT_CSS).toMatch(/\.rp\{[^}]*counter-reset:rp-eq rp-fig/);
});

test("the interactive figure is an html block: opaque-origin sandbox (no allow-same-origin) and a no-network CSP", () => {
  const html = visualBlockHtml({ type: "html", text: "<input type=range id=k><script>fetch('https://x')</script>", meta: { caption: "시뮬레이션", height: 520 } }, "sim");
  const frame = /<iframe[^>]*>/.exec(html)![0];
  expect(/sandbox="([^"]*)"/.exec(frame)![1]).toBe("allow-scripts");
  expect(frame).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
  expect(VISUAL_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:");
  expect(frame).toContain("default-src &#39;none&#39;");
  expect(html).toContain("<figcaption");
});

test("the 연구 보고서 template turns the style on and keeps the report sections", async () => {
  const templates = await loadTemplates(ROOT);
  const research = templates.find((t) => t.id === "research")!;
  expect(research.name).toBe("연구 보고서");
  expect((research as any).settings).toEqual({ font: "report" });
  expect(research.blocks.map((b) => b.type)).toEqual(expect.arrayContaining(["quote", "component", "equation", "table", "divider"]));
  expect(research.blocks.some((b) => /\[(MEASURED|CLAIMED|ESTIMATED)\]/.test(b.text))).toBe(true);
  expect(templates.filter((t) => (t as any).settings).map((t) => t.id)).toEqual(["research"]);
});
