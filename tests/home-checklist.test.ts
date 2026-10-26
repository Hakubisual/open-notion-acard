import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../assets/ui/home.js", import.meta.url), "utf8");
const renderSource = source.slice(source.indexOf("  function checklistHtml("), source.indexOf("  async function render("));
const render = (checklist: any, collapsed = "0") => runInNewContext(renderSource + "\nchecklistHtml(checklist)", {
  checklist, icon: () => "", esc: (s: string) => s.replaceAll("&", "&amp;"), href: (s: string) => "/" + encodeURIComponent(s) + "/",
  localStorage: { getItem: () => collapsed },
});

test("home checklist renders four direct targets with actual progress and remembers collapse", () => {
  const html = render({ page: true, agent: false, import: false, share: false, shareSlug: "my page" });
  expect(html.match(/data-step=/g)).toHaveLength(4);
  expect(html).toContain('aria-valuenow="1"');
  expect(html).toContain('style="width:25%"');
  expect(html).toMatch(/href="\/edit\/page-[a-z0-9]+\/\?new&amp;create"/);
  expect(html).toContain('href="/settings/agents/"');
  expect(html).toContain('href="/import"');
  expect(html).toContain('href="/my%20page/?share=1"');
  expect(html).toContain('aria-expanded="true"');
  expect(render({}, "1")).toContain('id="home-checklist-body" hidden');
  expect(render({ page: true, agent: true, import: true, share: true })).toContain('id="home-checklist-body" hidden');
});

test("the checklist share target opens the existing dialog once on arrival", () => {
  const code = readFileSync(new URL("../assets/features/lazy/reader-enhancements.js", import.meta.url), "utf8");
  const start = code.indexOf("  function openSharedPage()");
  const end = code.indexOf("})();", start);
  const location = { href: "https://notes.test/newest/?share=1" };
  const events: Record<string, Function> = {};
  let opened = 0;
  runInNewContext(code.slice(start, end), {
    URL, location, history: { state: {}, replaceState: (_: any, __: string, href: string) => { location.href = href; } },
    document: { getElementById: () => ({ click: () => { opened++; } }), addEventListener: (name: string, fn: Function) => { events[name] = fn; } },
  });
  expect(opened).toBe(1);
  events["acard:page-fresh"]();
  expect(opened).toBe(1);
  expect(location.href).toBe("https://notes.test/newest/");
});

const guide = (g: any, data: any = { recent: [{ slug: "note-1", kind: "note" }], checklist: { shareSlug: "note-1" } }) => runInNewContext(renderSource + "\nguideHtml(g, data)", {
  g, data, icon: () => "", esc: (s: string) => s.replaceAll("&", "&amp;"), href: (s: string) => "/" + encodeURIComponent(s) + "/", localStorage: { getItem: () => "0" },
});
const steps = (done: string[]) => Object.fromEntries(["page", "slash", "search", "share", "agent", "import"].map((k) => [k, done.includes(k)]));

test("an active guide shows all four steps at once with real progress, a resume button and 그만보기", () => {
  const html = guide({ enabled: true, active: true, count: 1, steps: steps(["page"]), done: false, skipped: false });
  expect(html.match(/class="wg-step"/g)).toHaveLength(4);
  expect(html).toContain("1 / 4 완료");
  expect(html).toContain('aria-valuenow="1"');
  expect(html).toContain("data-guide-skip");
  expect(html).toContain('data-guide-resume href="/edit/note-1/"');
  expect(html).not.toContain("home-check-step");
  expect(html).toContain('href="/settings/agents/"');
  expect(html).toContain('href="/import"');
});

test("the share step opens the reader page only, never the auto-opening ?share=1 link", () => {
  expect(guide({ enabled: true, active: true, count: 0, steps: steps([]) })).toMatch(/data-step="share"[^>]*href="\/note-1\/"/);
  expect(guide({ enabled: true, active: true, count: 0, steps: steps([]) })).not.toContain("share=1");
});

test("after 그만보기 home keeps a slim n/4 bar with 이어서 하기 and no way to close it", () => {
  const html = guide({ enabled: true, active: true, count: 2, steps: steps(["page", "slash"]), skipped: true });
  expect(html).toContain('class="ui-card wg-bar"');
  expect(html).toContain("2 / 4 완료");
  expect(html).toContain("data-guide-resume");
  expect(html).not.toContain("data-guide-skip");
});

test("off, hidden, finished or never-started guides give the home back to the old checklist", () => {
  for (const g of [null, { enabled: false, active: false }, { enabled: true, active: false }, { enabled: true, active: true, done: true, celebrate: false, steps: steps(["page", "slash", "search", "share"]), count: 4 }]) expect(guide(g)).toBe("");
  expect(guide({ enabled: true, active: true, done: true, celebrate: true, count: 4, steps: steps(["page", "slash", "search", "share"]) })).toContain("data-guide-feedback");
});

test("the finish card names the right-click tools and the Tab palette only when /api/guide says they are on (#149)", () => {
  const finished = { enabled: true, active: true, done: true, celebrate: true, count: 4, steps: steps(["page", "slash", "search", "share"]) };
  const on = guide({ ...finished, editTools: "블록 위에서 오른쪽 클릭 = 블록 도구, 빈 줄에서 Tab = 기능 찾기" });
  expect(on).toContain("data-guide-tools");
  expect(on).toContain("빈 줄에서 Tab = 기능 찾기</p>");
  for (const g of [finished, { ...finished, editTools: null }]) expect(guide(g)).not.toContain("data-guide-tools");
  expect(guide({ enabled: true, active: true, count: 1, steps: steps(["page"]), editTools: "x" })).not.toContain("data-guide-tools");
});
