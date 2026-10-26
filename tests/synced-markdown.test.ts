import { describe, expect, test } from "bun:test";
import { acardMarkdown, acardMetaDocument, blocksToMarkdown, markdownToBlocks, type Block } from "../markdown-blocks.ts";

const OPEN = '<!--acard synced {"v":1,"id":"sync-root"}-->';
const CLOSE = '<!--acard /synced-->';
const LINK = '[Synced content](/source-page/#block-sync-root)';
const REF_META = '<!--acard {"synced":{"v":1,"source":{"page":"source-page","block":"sync-root"}}}-->';
const REF = LINK + '\n' + REF_META;
const SOURCE = OPEN + '\n\nShared **policy**.\n\n- [x] Reviewed\n\n' + CLOSE;
const source = (indent = 0): Block => ({ id: "sync-root", type: "synced" as Block["type"], text: "", indent, meta: { synced: { v: 1, source: null } } });
const reference = (indent = 0): Block => ({ id: "instance-1", type: "synced" as Block["type"], text: "", indent, meta: { synced: { v: 1, source: { page: "source-page", block: "sync-root" } } } });
// Only non-source IDs are disposable: source identity must survive the actual parser unchanged.
const shape = (blocks: Block[]) => blocks.map(({ id, type, text, indent, checked, meta }) => ({
  ...(type === "synced" && (meta?.synced as any)?.source === null ? { id } : {}),
  type, text, indent: indent || 0, checked: !!checked, meta: meta ?? null,
}));
const parse = (md: string) => markdownToBlocks(md, { meta: true });

describe("synced Markdown identity and byte goldens", () => {
  test("canonical source owns ordinary children and preserves its exact ID", () => {
    const expected: Block[] = [source(), { id: "p", type: "paragraph", text: "Shared **policy**.", indent: 1 }, { id: "t", type: "to_do", text: "Reviewed", checked: true, indent: 1 }];
    expect(blocksToMarkdown(expected, { meta: true })).toBe(SOURCE);
    const blocks = parse(SOURCE);
    expect(blocks[0]).toEqual(source());
    expect(shape(blocks)).toEqual(shape(expected));
    const document = acardMetaDocument(acardMarkdown("Source", blocks));
    expect(document.flagged).toBe(true);
    expect(shape(parse(document.body))).toEqual(shape(expected));
    expect(blocksToMarkdown(parse(document.body), { meta: true })).toBe(SOURCE);
    expect(blocksToMarkdown(blocks)).toBe('Shared **policy**.\n\n- [x] Reviewed');
  });

  test("reference is an exact target with empty text, no copied children, and a readable plain link", () => {
    expect(blocksToMarkdown([reference()], { meta: true })).toBe(REF);
    expect(shape(parse(REF))).toEqual(shape([reference()]));
    expect(blocksToMarkdown(parse(REF), { meta: true })).toBe(REF);
    expect(blocksToMarkdown([reference()])).toBe(LINK);
  });

  test("mixed headings, toggles, columns, media, table, rich content and fences retain order and depth", () => {
    const content = [
      '## Policy\n<!--acard {"toggle":true,"open":false}-->',
      '  **Nested** [link](https://example.com)',
      '- [toggle] Details', '  - [x] Confirmed',
      '<!--acard columns {"widths":[0.6,0.4]}-->', '<!--acard column-->',
      '> [!note] Left', '  - Item', '<!--acard column-->',
      '![Photo](/media/photo "60")', '- [audio] /media/song', '- [db_ref] board',
      '<!--acard /columns-->', '| Name | Value |\n| === | === |\n| A | 1 |',
      '```js\nconst answer = 42;\n```',
    ].join('\n\n');
    const ordinary = parse(content);
    const expected = [source(), ...ordinary.map(b => ({ ...b, indent: (b.indent || 0) + 1 })), { id: "after", type: "paragraph", text: "After", indent: 0 } as Block];
    const md = OPEN + '\n\n' + content + '\n\n' + CLOSE + '\n\nAfter';
    expect(blocksToMarkdown(expected, { meta: true })).toBe(md);
    expect(shape(parse(md))).toEqual(shape(expected));
    expect(blocksToMarkdown(parse(md), { meta: true })).toBe(md);
    expect(blocksToMarkdown(ordinary, { meta: true })).toBe(content);
  });

  test("source in a toggle and source in a column rebase without swallowing siblings", () => {
    const lists: Block[][] = [
      [{ id: "t", type: "toggle", text: "Parent", indent: 0 }, source(1), { id: "p", type: "paragraph", text: "Child", indent: 2 }, { id: "s", type: "paragraph", text: "Sibling", indent: 1 }],
      [{ id: "c", type: "columns", text: "", indent: 0, meta: { widths: [0.5, 0.5] } }, { id: "a", type: "column", text: "", indent: 1 }, source(2), { id: "p", type: "paragraph", text: "Child", indent: 3 }, { id: "b", type: "column", text: "", indent: 1 }, reference(2)],
    ];
    for (const blocks of lists) expect(shape(parse(blocksToMarkdown(blocks, { meta: true })))).toEqual(shape(blocks));
  });

  test("empty sources and adjacent constructs retain their boundaries", () => {
    expect(parse(OPEN + '\n' + CLOSE)[0]).toEqual(source());
    const blocks = parse('Before\n' + OPEN + '\nChild\n' + CLOSE + '\n' + REF + '\nAfter');
    expect(blocks.map(b => [b.type, b.indent, b.text])).toEqual([
      ['paragraph', 0, 'Before'], ['synced', 0, ''], ['paragraph', 1, 'Child'], ['synced', 0, ''], ['paragraph', 0, 'After'],
    ]);
  });
});

describe("synced marker literal conservation", () => {
  const invalid = [
    OPEN, CLOSE, OPEN + '\n\nChild', OPEN.replace('"v":1', '"v":2') + '\n\nChild\n\n' + CLOSE,
    '<!--acard synced {broken}-->\n\nChild\n\n' + CLOSE,
    OPEN.replace('"sync-root"', '"../root"') + '\n\nChild\n\n' + CLOSE,
    OPEN.replace('"sync-root"', '"' + 'x'.repeat(61) + '"') + '\n\nChild\n\n' + CLOSE,
    OPEN.replace('"v":1', '"workspace":"elsewhere","v":1') + '\n\nChild\n\n' + CLOSE,
    OPEN + '\n\n' + OPEN.replace('sync-root', 'inner') + '\n\nChild\n\n' + CLOSE + '\n\n' + CLOSE,
    OPEN + '\n\n' + OPEN.replace('sync-root', 'inner') + '\n\nChild\n\n' + CLOSE,
    OPEN + '\n\n' + REF + '\n\n' + CLOSE,
    REF.replace('"v":1', '"v":9'), REF.replace('"page":"source-page"', '"page":"../private"'),
    REF.replace('"block":"sync-root"', '"block":"x#other"'),
    REF.replace('"source":{', '"workspace":"elsewhere","source":{'),
    REF.replace('"page":"source-page"', '"workspace":"elsewhere","page":"source-page"'),
    REF.replace('"synced":', '"color":"red","synced":'),
    REF.replace(LINK, '[Other content](/source-page/#block-sync-root)'),
    REF.replace(LINK, '[Synced content](/wrong-page/#block-sync-root)'),
    REF.replace('\n', '\n\n'), REF.replace('\n', '\n  '),
    REF + '\n\n  Copied child',
    REF_META, '<!--acard {"synced":{"v":1,"source":null}}-->',
  ];
  for (const [index, md] of invalid.entries()) test('invalid construct ' + index + ' stays literal across a flagged round trip', () => {
    const blocks = parse(md);
    expect(blocks.some(b => b.type === 'synced')).toBe(false);
    expect(blocks.every(b => !b.meta?.synced && !b.meta?.color)).toBe(true);
    for (const line of md.split('\n').filter(line => line.trim())) expect(blocks.map(b => b.text).join('\n')).toContain(line.trim());
    expect(shape(parse(blocksToMarkdown(blocks, { meta: true })))).toEqual(shape(blocks));
  });

  test("unflagged and escaped markers never become synced blocks", () => {
    for (const md of [SOURCE, REF]) expect(markdownToBlocks(md).some(b => b.type === 'synced')).toBe(false);
    const blocks: Block[] = [OPEN, CLOSE, REF_META, '\\' + OPEN].map((text, i) => ({ id: String(i), type: 'paragraph', text, indent: 0 }));
    expect(shape(parse(blocksToMarkdown(blocks, { meta: true })))).toEqual(shape(blocks));
  });

  test("fenced marker text cannot open, close, or invalidate a source", () => {
    for (const fence of ['```', '````', '~~~']) {
      const code = fence + '\n' + OPEN + '\n' + REF + '\n' + CLOSE + '\n' + fence;
      const blocks = parse(code);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('code');
      expect(blocks[0].text).toBe(OPEN + '\n' + REF + '\n' + CLOSE);
      const wrapped = parse(OPEN + '\n\n' + code + '\n\n' + CLOSE);
      expect(wrapped[0]).toEqual(source());
      expect(wrapped[1].type).toBe('code');
      expect(wrapped[1].indent).toBe(1);
      expect(shape(parse(blocksToMarkdown(wrapped, { meta: true })))).toEqual(shape(wrapped));
    }
  });

  test("serializer rejects invalid synced structures rather than exporting copied reference content", () => {
    const invalid: Block[][] = [
      [{ ...reference(), text: 'cached excerpt' }],
      [reference(), { id: 'p', type: 'paragraph', text: 'copied content', indent: 1 }],
      [source(), { ...source(1), id: 'inner' }], [source(), reference(1)],
      [{ ...source(), id: '../bad' }],
      [{ ...reference(), meta: { synced: { v: 2, source: { page: 'source-page', block: 'sync-root' } } } }],
    ];
    for (const blocks of invalid) for (const options of [{}, { meta: true }]) expect(() => blocksToMarkdown(blocks, options)).toThrow();
  });
});
