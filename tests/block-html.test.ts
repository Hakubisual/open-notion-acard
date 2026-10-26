import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToBlocks } from "../markdown-blocks.ts";
import "../assets/editor-model.js";
import "../assets/columns-model.js";
import { renderBlocks, navTree, introSplit, inline } from "../block-html.js";

const ROOT = join(import.meta.dir, "..");

describe("renderBlocks", () => {
  test("inline links escape query strings and labels exactly once (#93)", () => {
    expect(inline('[검색 & 결과](https://ex.com/?a=1&b=2)')).toBe('<a href="https://ex.com/?a=1&amp;b=2" target="_blank" rel="noopener">검색 &amp; 결과</a>');
    expect(inline('[[a&b]] [a & b](/path?a=1&b=2) [anchor](#a&b) **bold & text** `code & text`'))
      .toBe('<a href="/a&amp;b/">a&amp;b</a> <a href="/path?a=1&amp;b=2">a &amp; b</a> <a href="#a&amp;b">anchor</a> <strong>bold &amp; text</strong> <code>code &amp; text</code>');
    expect(inline('[&amp; <tag>](https://ex.com/?q="quoted"&literal=&amp;)')).toBe('<a href="https://ex.com/?q=&quot;quoted&quot;&amp;literal=&amp;amp;" target="_blank" rel="noopener">&amp;amp; &lt;tag&gt;</a>');
    expect(inline('*italics* _also italic_ (*word*) 한글 *기울임* 끝')).toBe('<em>italics</em> <em>also italic</em> (<em>word</em>) 한글 <em>기울임</em> 끝');
    expect(inline('snake_case_name a*b a*b*c 2 * 3 * 4 x_text_ _text_x')).toBe('snake_case_name a*b a*b*c 2 * 3 * 4 x_text_ _text_x');
    expect(inline('`*code* _code_ **code**` https://ex.com/*path*/_file_ [*label*](https://ex.com/*path*/_file_?a=1&b=2)'))
      .toBe('<code>*code* _code_ **code**</code> https://ex.com/*path*/_file_ <a href="https://ex.com/*path*/_file_?a=1&amp;b=2" target="_blank" rel="noopener"><em>label</em></a>');
  });

  test("a link button renders exactly as before; an action button is a <button data-button> that loads the buttons chunk once and is disabled on a read-only page (notion-parity C3)", () => {
    const links = renderBlocks([
      { id: "b1", type: "button", text: "이동", meta: { url: "https://example.com/?a=1&b=2" } },
      { id: "b2", type: "button", text: "", meta: { url: "/home/" } },
      { id: "b3", type: "button", text: "없음", meta: {} },
    ]);
    expect(links).toBe('<span id="block-b1"></span>\n<p class="btnrow"><a class="btn" href="https://example.com/?a=1&amp;b=2">이동</a></p>\n<span id="block-b2"></span>\n<p class="btnrow"><a class="btn" href="/home/">이동</a></p>');
    const actions = [{ type: "confirm", message: "만들까요?" }, { type: "create_row", database: "todo", values: {} }, { type: "open", target: "created" }];
    const live = renderBlocks([
      { id: "a1", type: "button", text: "할 일 추가", meta: { actions, icon: "➕", color: "blue", url: "https://ignored.dev" } },
      { id: "a2", type: "button", text: "둘째", meta: { actions: [{ type: "create_row", database: "todo" }] } },
    ], { page: {} });
    expect(live).toContain('<button type="button" class="btn act btn-blue" data-button="a1" data-confirm="만들까요?"><span class="btn-ico" aria-hidden="true">➕</span>할 일 추가</button>');
    expect(live).toContain('data-button="a2">둘째</button>');
    expect(live).not.toContain("ignored.dev");
    expect(live.match(/\/lazy\/buttons\.js/g)).toHaveLength(1);
    const readOnly = renderBlocks([{ id: "a1", type: "button", text: "추가", meta: { actions } }], { page: { readOnly: true } });
    expect(readOnly).toContain('data-button="a1" data-confirm="만들까요?" disabled>');
    expect(readOnly).not.toContain("/lazy/buttons.js");
  });
  test("source links have escaped stable anchors on paragraphs, headings and nested list items", () => {
    const html = renderBlocks([
      { id: 'p"1', type: "paragraph", text: "본문" },
      { id: "heading", type: "heading1", text: "제목" },
      { id: "parent", type: "bulleted", text: "부모" },
      { id: "child", type: "bulleted", text: "자식", indent: 1 },
    ]);
    expect(html).toContain('<span id="block-p&quot;1"></span>');
    expect(html).toContain('<span id="block-heading"></span>');
    expect(html).toContain('<h2 id="제목">');
    expect(html).toContain('<li><span id="block-parent"></span>부모<ul><li><span id="block-child"></span>자식</li></ul></li>');
  });
  test("토글과 목록의 자식은 부모 안에서 렌더링된다", () => {
    const html = renderBlocks(markdownToBlocks("- [toggle] 부모\n  - 자식\n    - 손자\n\n다음"));
    expect(html.replace(/<span id="block-[^"]*"><\/span>\n?/g, "")).toContain("<summary>부모</summary><ul><li>자식<ul><li>손자</li></ul></li></ul></details>");
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("<p>다음</p>"));
  });
  test("제목에 목차가 가리킬 id를 붙인다", () => {
    const html = renderBlocks(markdownToBlocks("## 인프라 점검\n\n### 백업"));
    expect(html).toContain('<h3 id="인프라-점검">인프라 점검</h3>');
    expect(html).toContain('<h4 id="백업">백업</h4>');
  });

  test("제목 4는 h5 로 그리고 목차에 4단계로 들어간다 (notion-parity C16)", () => {
    const html = renderBlocks(markdownToBlocks("- [toc]\n\n## 위\n\n#### 소제목"));
    expect(html).toContain('<h5 id="소제목">소제목</h5>');
    expect(html).toContain('<li class="lvl5"><a href="#소제목">소제목</a></li>');
    expect(html.match(/\.blocks h5\{/g)!.length).toBe(1);
    expect(renderBlocks(markdownToBlocks("### 셋"))).not.toContain("<style>");
  });

  test("접히는 제목: 자식은 details 안에 한 번만, 접기 끈 제목은 그대로 (notion-parity C7)", () => {
    const blocks = [
      { id: "h", type: "heading2", text: "묶음", meta: { toggle: true } },
      { id: "c1", type: "paragraph", text: "첫 자식", indent: 1 },
      { id: "c2", type: "bulleted", text: "둘째 자식", indent: 1 },
      { id: "n", type: "paragraph", text: "다음" },
    ];
    const html = renderBlocks(blocks as any);
    expect(html).toContain('<details class="toggle heading"><summary><h3 id="묶음">묶음</h3></summary>');
    expect(html.split("첫 자식").length - 1).toBe(1);
    expect(html.split("둘째 자식").length - 1).toBe(1);
    expect(html).not.toContain("block-children");
    expect(html.indexOf("둘째 자식")).toBeLessThan(html.indexOf("</details>"));
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("<p>다음</p>"));
    expect(renderBlocks([{ ...blocks[0], meta: { toggle: true, open: true } }] as any)).toContain('<details class="toggle heading" open>');
    const plain = renderBlocks([{ ...blocks[0], meta: {} }, blocks[1]] as any);
    expect(plain).not.toContain("<details");
    expect(plain).toContain('<div class="block-children">');
    expect(renderBlocks([{ id: "t", type: "toc", text: "" }, ...blocks] as any)).toContain('<li class="lvl3"><a href="#묶음">묶음</a></li>');
    const colored = renderBlocks([{ ...blocks[0], meta: { toggle: true, color: "red_background" } }] as any);
    expect(colored).toContain('<details class="bc-red_background toggle heading">');
  });

  test("같은 제목이 두 번이면 뒤엣것에 번호를 붙인다", () => {
    const html = renderBlocks(markdownToBlocks("## 메모\n\n## 메모"));
    expect(html).toContain('id="메모"');
    expect(html).toContain('id="메모-2"');
  });

  test("할 일은 체크 상태를 그대로 그린다", () => {
    const html = renderBlocks(markdownToBlocks("- [x] 끝난 일\n- [ ] 남은 일"));
    expect(html).toContain('<div class="todo on">');
    expect(html).toContain('<div class="todo">');
  });

  test("할 일 상자와 [ ] 표 칸은 읽기 화면에서 누를 수 있고, 일반 표에는 가짜 선택 상자가 없다 (#34)", () => {
    const todo = renderBlocks(markdownToBlocks("- [ ] 남은 일"));
    expect(todo).toMatch(/<span class="box" role="checkbox" aria-checked="false" tabindex="0" data-check="[^"]+">/);
    const table = renderBlocks(markdownToBlocks("| 완료 | 과목 | 마감 |\n| --- | --- | --- |\n| [ ] | 게임테스트실무 | 10-21 |\n| [x] | 게임UI/UX기획 | 11-02 |"));
    expect(table).not.toContain("table-select");
    expect(table).not.toContain("table-check");
    expect(table.match(/class="cellcheck"[^>]*data-r="0" data-c="0"/)).not.toBeNull();
    expect(table.match(/class="cellcheck on"[^>]*aria-checked="true"[^>]*data-r="1" data-c="0"/)).not.toBeNull();
    expect(renderBlocks(markdownToBlocks("| 과목 | 마감 |\n| --- | --- |\n| 게임테스트실무 | 10-21 |"))).not.toContain("table-check");
  });

  test("체크 칸이 없는 일반 표도 행마다 누를 수 있는 상자가 있고, 읽기 전용 화면에는 없다 (#73)", () => {
    const md = "| 과목 | 마감 |\n| --- | --- |\n| 게임테스트실무 | 10-21 |\n| 게임UI/UX기획 | 11-02 |";
    const html = renderBlocks(markdownToBlocks(md));
    expect(html.match(/<tr>/g)?.length).toBe(3);
    expect(html.match(/class="cellcheck" role="checkbox" aria-checked="false"[^>]*data-c="new"/g)?.length).toBe(2);
    expect(html).toContain('data-r="1" data-c="new"');
    expect(renderBlocks(markdownToBlocks(md), { page: { kind: "note" } })).toContain("/lazy/checks.js");
    expect(renderBlocks(markdownToBlocks(md), { page: { readOnly: true } })).not.toContain("data-check");
    const shared = renderBlocks(markdownToBlocks("- [x] 끝난 일\n\n| 완료 | 과목 |\n| --- | --- |\n| [x] | a |"), { page: { readOnly: true } });
    expect(shared).toContain('class="cellcheck on"');
    expect(shared).toContain('<div class="todo on">');
    expect(shared).not.toContain("data-check");
    expect(renderBlocks(markdownToBlocks("| 완료 | 과목 |\n| --- | --- |\n| [ ] | a |"))).not.toContain('data-c="new"');
  });

  test("콜아웃과 토글과 표를 노션식 마크업으로 그린다", () => {
    const html = renderBlocks(markdownToBlocks("> [!tip] 먼저 볼 것\n\n- [toggle] 접기\n\n| 이름 | 상태 |\n| --- | --- |\n| 노트 | 진행 |"));
    expect(html).toContain('<div class="callout tip"><svg class="ico callout-ico"');
    expect(html).toContain('<div class="callout-body">먼저 볼 것</div></div>');
    expect(html).toContain('<details class="toggle"><summary>접기</summary></details>');
    expect(html).toContain("<table>");
    expect(html).toContain('<td><span class="tag table-status blue">진행</span></td>');
  });

  test("데이터베이스 표만 보기 도구를 표시하고 실제 담당자와 편집 주소를 유지한다", () => {
    const blocks = markdownToBlocks("| 프로젝트 | 상태 | 담당 |\n| --- | --- | --- |\n| 실제 작업 | 마무리 | 오너 |\n| 다음 작업 | 대기 | 도리 |");
    const html = renderBlocks(blocks, { page: { kind: "db", slug: "board" } });
    expect(html).toContain('class="table-toolbar"');
    expect(html).toContain('class="table-tab on"');
    expect(html).toContain('href="/edit/board/"');
    expect(html).toContain('class="tag table-status green"');
    expect(html).toContain('class="tag table-status purple"');
    expect(html).toContain('/img/avatars/owner-96.webp');
    expect(html).toContain('/img/avatars/dori-96.webp');
    expect(html.match(/<td class="table-select">/g)?.length).toBe(2);
    expect(html.match(/<th scope="col">/g)?.length).toBe(3);
    expect(renderBlocks(blocks, { page: { kind: "note", slug: "sample" } })).not.toContain('class="table-toolbar"');
  });

  test("마크다운 데이터베이스 표는 소개 영역 다음에 놓인다", () => {
    const blocks = markdownToBlocks("소개\n\n| 이름 | 상태 |\n| --- | --- |\n| 실제 작업 | 진행 |");
    const [intro, rest] = introSplit(blocks);
    expect(intro).toEqual([blocks[0]]);
    expect(rest).toEqual([blocks[1]]);
  });

  test("정적 프로젝트 표는 완료 상태와 진행률 및 날짜를 렌더링한다", () => {
    const blocks = markdownToBlocks("| 작업 이름 | 담당자 | 상태 | 우선순위 | 진행률 | 마감일 |\n| --- | --- | --- | --- | --- | --- |\n| 검증 | 도리 | 완료 | 높음 | 100 | 2026-11-30 |\n| 확인 | 오너 | 결정 필요 | 낮음 | 0 | |");
    const html = renderBlocks(blocks, { page: { kind: "db", slug: "board" } });
    expect(html).toContain('class="table-check on"');
    expect(html).toContain('class="numwrap complete"');
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('class="tag pink"');
    expect(html).toContain('class="tag gray"');
    expect(html).toContain('2026년 11월 30일');
  });

  test("마크다운 문법이 글자로 새지 않는다", () => {
    const html = renderBlocks(markdownToBlocks("> [!note] 알림\n\n- [toggle] 접기"));
    expect(html).not.toContain("[!note]");
    expect(html).not.toContain("[toggle]");
  });

  test("[[슬러그]] 링크를 만든다", () => {
    const html = renderBlocks(markdownToBlocks("[[infra]] 도 봐"));
    expect(html).toContain('<a href="/infra/">infra</a>');
  });
  test("같은 페이지 제목으로 가는 [글](#id) 링크를 만든다", () => {
    const html = renderBlocks(markdownToBlocks("- [1. 현재 상태](#1-현재-상태)\n\n## 1. 현재 상태"));
    expect(html).toContain('<a href="#1-현재-상태">1. 현재 상태</a>');
    expect(html).toContain('id="1-현재-상태"');
  });
});

describe("navTree", () => {
  test("부모-자식 순서를 지키고 현재 페이지만 표시한다", () => {
    const pages = [
      { slug: "index", title: "홈", parent: null, kind: "note" },
      { slug: "board", title: "현황", parent: null, kind: "db" },
      { slug: "child", title: "하위", parent: "board", kind: "note" },
    ];
    const html = navTree(pages, "board");
    expect(html).toContain('class="on" aria-current="page"');
    expect(html.indexOf("현황")).toBeLessThan(html.indexOf("하위"));
    expect(html).toContain('<span class="dbmark">표</span>');
  });
});

// acard-footnote-fix (owner: "각주가 실제 각주가 아니고 참고문헌 타이틀 중복", slack C0C91GZDVC7 1792923864.529159)
describe("footnotes", () => {
  const notes = (ids: string[]) => ({ id: "fn", type: "component", text: JSON.stringify({ notes: ids.map((id) => ({ id, text: "주석 " + id })) }), meta: { ui: "block-footnotes" } });

  test("[^id] in text links to its note, numbered in citation order, and the note links back", () => {
    const html = renderBlocks([
      { id: "p1", type: "paragraph", text: "first[^b] then[^a]" },
      { id: "p2", type: "bulleted", text: "again[^b], `[^a]` in code, unknown[^zz]" },
      notes(["a", "b", "c"]),
    ], { pages: [] });
    expect(html).toContain('first<sup class="fnref"><a href="#fn-b" id="fnref-b">1</a></sup> then<sup class="fnref"><a href="#fn-a" id="fnref-a">2</a></sup>');
    expect(html).toContain('again<sup class="fnref"><a href="#fn-b">1</a></sup>');
    expect(html).toContain("<code>[^a]</code>");
    expect(html).toContain("unknown[^zz]");
    const list = html.slice(html.indexOf("<ol>"));
    expect(html.match(/\.fnref\{/g)?.length).toBe(1);
    expect([...list.matchAll(/<li id="fn-(\w+)"/g)].map((m) => m[1])).toEqual(["b", "a", "c"]);
    expect(list).toContain('주석 b <a class="blt-back" href="#fnref-b"');
    expect(list).not.toContain('href="#fnref-c"');
    expect(html.match(/\.fnref\{/g)).toHaveLength(1);
  });

  test("a page with a footnotes block but no [^id] draws the list exactly as before", () => {
    const html = renderBlocks([notes(["2", "1"])], { pages: [] });
    expect(html).toContain('<h3 class="blt-title">각주</h3><ol><li id="fn-2" tabindex="-1">주석 2</li><li id="fn-1" tabindex="-1">주석 1</li></ol>');
    expect(html).not.toContain("fnref");
    expect(renderBlocks([{ id: "p1", type: "paragraph", text: "no notes block[^1]" }])).toBe('<span id="block-p1"></span>\n<p>no notes block[^1]</p>');
  });

  test("a heading with the same words right above a references or footnotes block keeps the only title", () => {
    const refs = { id: "r", type: "component", text: JSON.stringify({ references: [{ authors: "김민서", year: 2024, title: "디지털 노트" }] }), meta: { ui: "block-references" } };
    const under = renderBlocks([{ id: "h", type: "heading1", text: "참고문헌" }, refs]);
    expect(under).toContain('<h2 id="참고문헌">참고문헌</h2>');
    expect(under).not.toContain('class="bld-title"');
    expect(renderBlocks([{ id: "h", type: "heading1", text: "6. 참고문헌" }, refs])).not.toContain('class="bld-title"');
    expect(renderBlocks([{ id: "h", type: "heading1", text: "출처" }, refs])).toContain('<div class="bld-title">참고문헌</div>');
    expect(renderBlocks([{ id: "h", type: "heading1", text: "참고문헌" }, { id: "p", type: "paragraph", text: "설명" }, refs])).toContain('<div class="bld-title">참고문헌</div>');
    expect(renderBlocks([{ id: "h", type: "heading1", text: "각주" }, notes(["1"])])).not.toContain('class="blt-title"');
  });
});

describe("worker renderer", () => {
  test("빌드가 만든 워커와 같은 렌더러를 쓴다", () => {
    const source = readFileSync(join(ROOT, "gate", "_worker.js"), "utf8");
    const shared = readFileSync(join(ROOT, "block-html.js"), "utf8");
    expect(source).toContain("//__BLOCK_HTML__");
    expect(source).not.toContain("function renderBlocks");
    const inlined = shared.replace(/^export /gm, "").trim();
    expect(source.replace("//__BLOCK_HTML__", inlined)).toContain("function renderBlocks(blocks");
  });
});

describe("home slug alias", () => {
  test("워커가 home 을 index 로 맞춘다", () => {
    const source = readFileSync(join(ROOT, "gate", "_worker.js"), "utf8");
    expect(source).toContain('function resolveSlug(slug)');
    expect(source).toContain('return slug === "home" ? "index" : slug;');
    expect(source.match(/resolveSlug\(/g).length).toBeGreaterThanOrEqual(4);
  });

  test("빌드가 /home/ 도 같이 만든다", async () => {
    const proc = Bun.spawnSync(["bun", "run", "build.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    const home = await Bun.file(join(ROOT, "dist", "home", "index.html")).text();
    const index = await Bun.file(join(ROOT, "dist", "index.html")).text();
    expect(home).toBe(index);
    expect(home).toContain("Next up");
  }, 120000);
});

describe("block color and callout icon (notion-parity C6)", () => {
  const strip = (h: string) => h.replace(/<span id="block-[^"]*"><\/span>\n?/g, "").replace(/<style>[^<]*<\/style>\n?/g, "");
  test("a colored paragraph, heading and list item carry the bc- class on their own element", () => {
    const html = strip(renderBlocks([
      { id: "a", type: "paragraph", text: "빨강", meta: { color: "red" } },
      { id: "b", type: "heading2", text: "노랑 배경", meta: { color: "yellow_background" } },
      { id: "c", type: "bulleted", text: "파랑", meta: { color: "blue" } },
      { id: "d", type: "toggle", text: "접기", meta: { color: "gray_background" } },
    ] as any));
    expect(html).toContain('<p class="bc-red">빨강</p>');
    expect(html).toContain('<h3 class="bc-yellow_background" id="노랑-배경">');
    expect(html).toContain('<li class="bc-blue">파랑</li>');
    expect(html).toContain('<details class="bc-gray_background toggle">');
  });
  test("the color rules ride along once per page, only when a block uses a color or icon", () => {
    const ctx: any = {};
    const a = renderBlocks([{ id: "a", type: "paragraph", text: "1", meta: { color: "red" } }, { id: "b", type: "toggle", text: "t" }, { id: "c", type: "paragraph", text: "2", indent: 1, meta: { color: "blue_background" } }] as any, ctx);
    const b = renderBlocks([{ id: "d", type: "callout", text: "3", meta: { icon: "🔥" } }] as any, ctx);
    expect((a + b).match(/<style>/g)!.length).toBe(1);
    expect(a).toContain(".bc-blue_background,.blocks .bc-blue_background,.blocks .callout.bc-blue_background{background:var(--tag-blue-bg)}");
    expect(renderBlocks([{ id: "x", type: "paragraph", text: "글" }] as any)).not.toContain("<style>");
    expect(renderBlocks([{ id: "x", type: "bulleted", text: "글", meta: { color: "red" } }] as any)).toContain('<li class="bc-red"><style>');
  });
  test("a callout icon replaces the default line icon", () => {
    const html = renderBlocks([{ id: "x", type: "callout", text: "불", meta: { tone: "note", icon: "🔥", color: "orange_background" } }] as any);
    expect(html).toContain('<span class="callout-ico" aria-hidden="true">🔥</span>');
    expect(html).not.toContain("sparkles");
    expect(html).toContain('class="bc-orange_background callout note"');
  });
  test("an unknown or hostile color name never becomes a class", () => {
    for (const color of ["<script>", 'red" onclick="x', "chartreuse", "default", "red_backgroundx", 7]) {
      const html = renderBlocks([{ id: "x", type: "paragraph", text: "글", meta: { color } }] as any);
      expect(html).not.toContain("bc-");
      expect(html).toContain("<p>글</p>");
    }
    const icon = renderBlocks([{ id: "x", type: "callout", text: "글", meta: { icon: "<img src=x onerror=alert(1)>" } }] as any);
    expect(icon).not.toContain("<img");
  });
  test("a callout with only a tone and pages without color render exactly as before", () => {
    const blocks = markdownToBlocks("> [!warning] 조심\n\n> [!note] 메모\n\n## 제목\n\n- 하나\n- [toggle] 접기\n  - 안\n\n본문");
    const html = renderBlocks(blocks);
    expect(html).toContain('<div class="callout warning">');
    expect(html).toContain('<div class="callout warning"><svg class="ico callout-ico"');
    expect(html).toContain('<div class="callout note"><svg class="ico callout-ico"');
    expect(html).not.toContain("bc-");
    expect(html).toContain("<p>본문</p>");
  });
  test("every block color text token reads at 4.5:1 or more on the page background, light and dark", () => {
    const { BLOCK_COLOR_CSS } = require("../block-html.js");
    const css = readFileSync(join(ROOT, "assets/tokens.css"), "utf8") + "\n" + BLOCK_COLOR_CSS.replace(/\}/g, "}\n").replace(/^html\[/gm, "\nhtml[").replace(/(^|\n)(:root|html\[data-theme="dark"\])\{/g, "\n$2 {");
    const lum = (hex: string) => { const n = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    // Every top-level rule body of one selector, merged in file order (later blocks add tokens such as brown).
    const block = (sel: string) => css.split("\n" + sel + " {").slice(1).map((part) => part.slice(0, part.indexOf("}"))).join("\n");
    const pick = (src: string, name: string) => (new RegExp("--" + name + ":\\s*(#[0-9a-f]{6})", "i").exec(src) || [])[1];
    for (const [theme, src] of [["light", block(":root")], ["dark", block('html[data-theme="dark"]')]] as const) {
      const bg = pick(src, "bg")!; const fg = pick(src, "fg")!;
      for (const c of ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]) {
        const text = pick(src, "tag-" + c + "-fg")!; const soft = pick(src, "tag-" + c + "-bg")!;
        expect([theme, c, ratio(text, bg) >= 4.5]).toEqual([theme, c, true]);
        expect([theme, c + "_background", ratio(fg, soft) >= 4.5]).toEqual([theme, c + "_background", true]);
      }
    }
  });
});

describe("columns and callouts hold blocks (notion-parity C13)", () => {
  const b = (id: string, type: string, indent: number, text = "", meta: any = null) => ({ id, type, text, checked: false, indent, meta });
  const strip = (html: string) => html.replace(/<span id="block-[^"]*"><\/span>\n?/g, "").replace(/\n/g, "");
  test("a callout, a db_ref and a heading render inside their .col", () => {
    const html = strip(renderBlocks([
      b("cs", "columns", 0, "", { widths: [0.6, 0.4] }),
      b("c1", "column", 1), b("co", "callout", 2, "안내"), b("h", "heading2", 2, "왼쪽 제목"),
      b("c2", "column", 1), b("db", "db_ref", 2, "", { database: "x", html: '<div class="db">표</div>' }),
      b("after", "paragraph", 0, "다음"),
    ]));
    const grid = /<div class="cols cols2" style="--cols:0\.6fr 0\.4fr">(.*?)<\/div><p>다음<\/p>/.exec(html);
    expect(grid).not.toBeNull();
    const cols = grid![1].split('<div class="col">').slice(1);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toContain('<div class="callout note">');
    expect(cols[0]).toContain("왼쪽 제목</h3>");
    expect(cols[1]).toContain('<div class="db">표</div>');
    expect(html).not.toContain("block-children");
  });
  test("old text-only columns draw the same text as paragraphs inside .col", () => {
    const html = strip(renderBlocks([b("k", "columns", 0, "", { columns: [{ text: "가\n나" }, { text: "다" }] })]));
    expect(html).toContain('<div class="cols cols2" style="--cols:0.5fr 0.5fr"><div class="col"><p>가</p><p>나</p></div><div class="col"><p>다</p></div></div>');
  });
  test("old columns are converted on read: a block under them lands in the last column", () => {
    const html = strip(renderBlocks([b("k", "columns", 0, "", { columns: [{ text: "가" }, { text: "다" }] }), b("kid", "callout", 1, "안쪽"), b("next", "paragraph", 0, "밖")]));
    const cols = /<div class="cols cols2"[^>]*>(.*?)<\/div><p>밖<\/p>/.exec(html)![1].split('<div class="col">').slice(1);
    expect(cols[1]).toContain("<p>다</p>");
    expect(cols[1]).toContain("안쪽");
    expect(html).not.toContain("block-children");
  });
  test("blocks indented under a callout render inside its callout-body, not after it", () => {
    const html = strip(renderBlocks([b("co", "callout", 0, "상자"), b("l1", "bulleted", 1, "하나"), b("l2", "bulleted", 1, "둘"),
      b("db", "db_ref", 1, "", { html: '<div class="db">표</div>' }), b("next", "paragraph", 0, "밖")]));
    const body = /<div class="callout-body">(.*?)<\/div><\/div><p>밖<\/p>/.exec(html);
    expect(body).not.toBeNull();
    expect(body![1]).toContain("<ul><li>하나</li><li>둘</li></ul>");
    expect(body![1]).toContain('<div class="db">표</div>');
    expect(html).not.toContain("block-children");
  });
});
