import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bylineHtml, renderBlocks } from "../block-html.js";
import { setup } from "./db-harness";

const ROOT = join(import.meta.dir, "..");
const css = (name: string) => readFileSync(join(ROOT, name), "utf8");
const rule = (source: string, selector: string) => new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(source)?.[1] ?? "";

test("byline (#102): agent and date first, tags in one pill group, the first topic tag is the accent pill", () => {
  const html = bylineHtml({ agent: "도리", updated: "2026-10-21T01:00:00Z", tags: "공개, 기획서, 제품" });
  expect(/<span class="who">[\s\S]*?<\/span>([^<]+)<\/span>/.exec(html)?.[1]).toBe("도리가 씀");
  const pills = /<span class="pills">([\s\S]*)<\/span><\/p>$/.exec(html)?.[1] ?? "";
  expect([...pills.matchAll(/class="chip t-(\w+)"/g)].map((m) => m[1])).toEqual(["neutral", "accent", "neutral"]);
  expect(html.indexOf('class="when"')).toBeLessThan(html.indexOf('class="pills"'));
  expect(bylineHtml({ agent: "AI", updated: "2026-10-21" })).not.toContain("pills");
});

test("byline (#110): my own page reads 내가 씀 and a Korean name with a final consonant takes 이", () => {
  const who = (agent: string) => /<span class="who">[\s\S]*?<\/span>([^<]+)<\/span>/.exec(bylineHtml({ agent, updated: "2026-10-21" }))?.[1];
  expect(["나", "민준", "도리", "오너", "Claude Code", "AI"].map(who)).toEqual(["내가 씀", "민준이 씀", "도리가 씀", "오너가 씀", "Claude Code가 씀", "AI가 씀"]);
});

test("page polish is CSS only: renderBlocks keeps its loading markup and the rhythm/skeleton rules use tokens", () => {
  expect(renderBlocks([{ id: "j", type: "journal", text: "" }], { page: { slug: "x" } })).toContain('<p class="journal-loading">작업 기록을 불러오는 중이에요…</p>');
  const body = css("assets/acard-body.css");
  expect(rule(body, ".reader .blocks > h2")).toContain("var(--space-12)");
  expect(rule(body, ".reader .blocks > :is(p, ul, ol)")).toContain("var(--space-4)");
  const style = css("assets/style.css");
  const skeleton = rule(style, ".pnone[data-pending], .blocks .journal-loading");
  expect(skeleton).toContain("color: transparent");
  expect(skeleton).toContain("var(--bg-soft)");
  expect(rule(style, ".rnone, .pnone:not([data-pending])")).toContain("display: grid");
  expect(rule(css("assets/ui/home.css"), ".home-empty")).toContain("var(--color-surface-soft)");
});

let h: ReturnType<typeof setup>;
beforeEach(() => { h = setup(); });
afterEach(() => h.sqlite.close());

test("published page (#102): date and access pill in the byline, reader block rhythm inlined", async () => {
  expect((await h.call("POST", "/api/pages", { title: "Plan", slug: "plan" })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/plan", { title: "Plan", blocks: [{ id: "h", type: "heading2", text: "Step" }, { id: "p", type: "paragraph", text: "Body" }] })).status).toBe(200);
  const link = (await h.call("POST", "/api/page/plan/share")).data as { url: string };
  const response = await h.worker.fetch(new Request("https://notes.test" + link.url, { headers: { cookie: "acard_lang=ko" } }), h.env);
  expect(response.status).toBe(200);
  const html = await response.text();
  const meta = /<p class="sv-meta">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  expect(meta).toMatch(/^<span class="sv-when"><svg[^>]*>[\s\S]*?<\/svg><span>[^<]+에 수정됨<\/span><\/span><span class="sv-pill"><span class="sv-pill-in"><svg/);
  expect(meta).toContain("읽기 전용");
  expect(html).toContain(".sv-main .blocks>h2{margin:var(--space-12) 0 var(--space-3)}");
  expect(html).toContain(".sv-icon{display:grid;place-items:center;width:88px;height:88px;margin:-44px 0 var(--space-6)");
});

test("shared page words follow the reader's language: English by default, Korean for a Korean browser or choice (acard-landing-english-shots)", async () => {
  expect((await h.call("POST", "/api/pages", { title: "Plan", slug: "plan" })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/plan", { title: "Plan", blocks: [{ id: "a", type: "heading2", text: "One" }, { id: "b", type: "heading2", text: "Two" }] })).status).toBe(200);
  const url = ((await h.call("PUT", "/api/page/plan/access/general", { mode: "link", role: "read" })).data as any).link.url as string;
  const open = async (headers: Record<string, string> = {}) => h.worker.fetch(new Request("https://notes.test" + url, { headers }), h.env);
  const en = await open();
  const page = await en.text();
  expect(en.headers.get("content-language")).toBe("en");
  expect(page).toContain('<html lang="en">');
  expect(/<p class="sv-meta">([\s\S]*?)<\/p>/.exec(page)?.[1]).toMatch(/<span>Edited [A-Z][a-z]+ \d{1,2}, \d{4}<\/span>[\s\S]*Share link · Read-only/);
  expect(page).toContain(">Request edit access</a><small>When the owner approves, you get an invite link and code by email.</small>");
  expect(page).toContain("<summary>Contents</summary>");
  // No Korean outside the author's own text on an English page.
  expect(page.replace(/<style>[\s\S]*?<\/style>/g, "").match(/[\uac00-\ud7a3]+/g)).toBeNull();
  for (const headers of [{ "accept-language": "ko-KR,ko;q=0.9" }, { cookie: "acard_lang=ko" }] as Record<string, string>[]) {
    const ko = await (await open(headers)).text();
    expect(ko).toContain('<html lang="ko">');
    expect(ko).toContain("공유 링크 · 읽기 전용");
    expect(ko).toContain(">편집 권한 요청</a>");
  }
  // An explicit English choice beats a Korean browser.
  expect(await (await open({ cookie: "acard_lang=en", "accept-language": "ko-KR" })).text()).toContain("Share link · Read-only");
  // Phone: the hairline before the pill is dropped (it would hang alone once the pill wraps) and the ask button sits 8 px
  // under the meta row (24 px phone margin minus 16) instead of touching the pill.
  const phone = /@media \(max-width:640px\)\{[^@]*/.exec(page)?.[0] ?? "";
  expect(phone).toContain(".sv-meta .sv-when+.sv-pill{padding-left:0;border-left:0}");
  expect(phone).toContain(".sv-edit{margin-top:calc(var(--space-6) * -1 + var(--space-2))}");
});
