import { describe, expect, test } from "bun:test";
import { markdownToBlocks, blocksToMarkdown, acardMarkdown, acardMetaDocument } from "../markdown-blocks.ts";
import "../assets/editor-model.js";
import "../assets/columns-model.js";
import { renderBlocks } from "../block-html.js";
import { listComponents, componentMarkdown } from "../component-registry.js";
import "../components/index.js";

// Golden round trip for every block a page can hold: markdown -> blocks -> markdown is byte-equal, and the reader HTML
// of the re-imported blocks equals the HTML of the first import. Components come from the registry, so every component
// a later wave adds is covered by its sample without editing this file.
const F = "```";
const BLOCKS: Record<string, string> = {
  paragraph: "그냥 문장 **굵게** `코드` [링크](https://notes.example.com)",
  heading1: "# 큰 제목", heading2: "## 중간 제목", heading3: "### 작은 제목", heading4: "#### 가장 작은 제목",
  bulleted: "- 항목\n  - 안쪽 항목", numbered: "1. 첫째\n2. 둘째", to_do: "- [ ] 할 일\n- [x] 끝낸 일",
  toggle: "- [toggle] 접기\n\n  속 문단", callout: "> [!tip] 먼저 볼 것\n> 둘째 줄", quote: "> 인용 첫 줄\n> 둘째 줄",
  code: F + "js\nlet a = 1;\n" + F, divider: "---",
  database: "| 이름 | 상태 |\n| --- | --- |\n| 노트 | 진행 |", table: "| 재료 | 양 |\n| === | === |\n| 밀가루 | 200g |",
  image: '![고양이 사진](/media/abc "60")', video: "- [video] https://youtu.be/x", audio: "- [audio] /media/song",
  file: "- [file] /media/doc 보고서.pdf", embed: "- [embed] https://maps.google.com/x", bookmark: "https://developer.mozilla.org/ko/",
  columns: ":::cols\n왼쪽 열\n---\n오른쪽 열\n:::", equation: "$$\n\\sum_{i=1}^{n} i\n$$", toc: "- [toc]", breadcrumb: "- [breadcrumb]",
  button: "- [button] 홈으로 | /", progress: "- [progress] 70 이번 주 진행", db_ref: "- [db_ref] mcp-master-facet",
  diagram: F + 'mermaid {"caption":"흐름","alt":"세 단계"}\nflowchart LR\n  A[작성] --> B{검토} -->|통과| C([배포])\n' + F,
  sequence: F + "mermaid\nsequenceDiagram\n  A->>B: 요청\n  B-->>A: 응답\n" + F,
  chart: F + 'acard-chart {"caption":"월별 방문자"}\n{"type":"bar","labels":["1월","2월"],"series":[{"name":"방문자","data":[120,180]}]}\n' + F,
  visual: F + 'acard-visual {"height":240}\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n' + F,
  part: F + 'acard-part {"part":"chart","v":1}\n{"title":"매출","items":[{"label":"1월","value":3}]}\n' + F,
};

const shape = (blocks: any[]) => blocks.map(({ type, text, indent, checked, meta }) => ({ type, text, indent: indent || 0, checked: !!checked, meta: meta ?? null }));
const html = (blocks: any[]) => renderBlocks(blocks, { page: { slug: "golden" }, pages: [] }).replace(/id="block-[^"]+"/g, 'id="block-x"').replace(/uitab-[a-z0-9]+-[a-z0-9]+/g, "uitab-x").replace(/\bvk[a-z]+-[a-z0-9]+/g, "vkid");

function golden(name: string, markdown: string) {
  test(name + ": markdown -> blocks -> markdown is byte-equal and the reader HTML is unchanged", () => {
    const first = markdownToBlocks(markdown);
    expect(first.length).toBeGreaterThan(0);
    const md = blocksToMarkdown(first);
    const again = markdownToBlocks(md).map((b, i) => ({ ...b, id: first[i] && first[i].id }));
    expect(shape(again)).toEqual(shape(first));
    expect(blocksToMarkdown(again)).toBe(md);
    expect(html(again)).toBe(html(first));
    const doc = acardMetaDocument(acardMarkdown("t", first));
    expect(shape(markdownToBlocks(doc.body, { meta: true }))).toEqual(shape(first));
  });
}

describe("golden round trip: block types", () => {
  for (const [name, md] of Object.entries(BLOCKS)) golden(name, md);
});

for (const type of ["bulleted", "numbered"] as const) for (const open of [false, true]) {
  test(`${type} list fold ${open}: metadata round trip preserves descendants and reader HTML`, () => {
    const first = [
      { id: "parent", type, text: "Parent", indent: 0, meta: { open } },
      { id: "child", type: "numbered" as const, text: "Child", indent: 1, meta: { open: false } },
      { id: "grandchild", type: "paragraph" as const, text: "Grandchild", indent: 2 },
      { id: "sibling", type, text: "Sibling", indent: 0 },
    ];
    const markdown = blocksToMarkdown(first, { meta: true });
    expect(markdown).toBe(`${type === "numbered" ? "1." : "-"} Parent\n<!--acard {"open":${open}}-->\n\n  1. Child\n  <!--acard {"open":false}-->\n\n    Grandchild\n\n${type === "numbered" ? "2." : "-"} Sibling`);
    const again = markdownToBlocks(markdown, { meta: true }).map((block, i) => ({ ...block, id: first[i].id }));
    expect(shape(again)).toEqual(shape(first));
    expect(blocksToMarkdown(again, { meta: true })).toBe(markdown);
    expect(html(again)).toBe(html(first));
    const document = acardMetaDocument(acardMarkdown("Folded lists", first));
    expect(shape(markdownToBlocks(document.body, { meta: true }))).toEqual(shape(first));
    expect(blocksToMarkdown(first)).not.toContain("<!--acard");
  });
}

describe("golden round trip: every registered component", () => {
  test("the registry is not empty", () => expect(listComponents().length).toBeGreaterThanOrEqual(11));
  for (const c of listComponents()) {
    golden("component " + c.id + " sample", componentMarkdown(c.id, c.sample));
    for (const preset of Object.keys(c.presets)) golden("component " + c.id + " preset " + preset, componentMarkdown(c.id, { ...c.sample, preset }));
  }
});

test("one page with every block type and every component keeps order, depth and HTML through a round trip", () => {
  const page = [...Object.values(BLOCKS), ...listComponents().map((c) => componentMarkdown(c.id, c.sample))].join("\n\n");
  const first = markdownToBlocks(page);
  const again = markdownToBlocks(blocksToMarkdown(first)).map((b, i) => ({ ...b, id: first[i] && first[i].id }));
  expect(shape(again)).toEqual(shape(first));
  expect(html(again)).toBe(html(first));
  expect(html(first)).not.toContain('class="ui-fallback"');
});
