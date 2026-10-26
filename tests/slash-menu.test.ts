import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The pure part of the slash / insert menu (#99): search, ranking and grouping in the lazy easy-insert chunk.
const source = readFileSync(new URL("../assets/features/lazy/easy-insert.js", import.meta.url), "utf8");
const core = source.slice(source.indexOf("  // slash-core:"), source.indexOf("  // slash-core end"));
const editor = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const blockTypes = new Function(editor.slice(editor.indexOf("  var BLOCK_TYPES = ["), editor.indexOf("  var easy = null;")) + "return BLOCK_TYPES;")() as Entry[];
type Entry = { type: string; label: string; hint: string; ico: string; aliases?: string };
type Section = { key: string; title: string; items: Entry[] };
const lib = new Function(core + "return { slashSections, slashScore, slashGroupOf, slashRemember, slashDesc };")() as {
  slashSections(items: Entry[], query: string, recents?: string[], freq?: Record<string, number>): Section[];
  slashScore(entry: Entry, query: string): number;
  slashGroupOf(entry: Entry): string;
  slashRemember(recents: string[], freq: Record<string, number>, type: string): { recents: string[]; freq: Record<string, number> };
  slashDesc(entry: Entry): string;
};
// Same shape as components.js slashItems().
const components: Entry[] = [
  { type: "component:stat", label: "지표 카드", hint: "숫자 하나 크게", ico: "#", aliases: "지표 숫자 통계 kpi stat metric stat 지표 카드" },
  { type: "component:empty", label: "빈 상태", hint: "비어 있을 때 안내", ico: "○", aliases: "빈상태 empty 안내 비어있음 empty 빈 상태" },
];
const all = blockTypes.concat(components);
// Same shape as parts/page.js slashItems() (#38).
const parts: Entry[] = [
  { type: "part:table", label: "표 (합계 자동)", hint: "부품", ico: "", aliases: "부품 part 표 합계 자동 table sum table" },
  { type: "part:dag", label: "흐름도 (DAG)", hint: "부품", ico: "", aliases: "부품 part 흐름도 dag 단계 구조 flow pipeline dag" },
  { type: "part:weekly-card", label: "주간 판매 카드 v2", hint: "내 부품", ico: "", aliases: "부품 part weekly-card", mine: true } as Entry,
];
const types = (sections: Section[]) => sections.flatMap((s) => s.items.map((e) => e.type));
const first = (q: string) => types(lib.slashSections(all, q))[0];

test("no query: four groups in order, every item once, catalog order kept inside a group", () => {
  const sections = lib.slashSections(all, "");
  expect(sections.map((s) => s.title)).toEqual(["기본 블록", "컴포넌트", "미디어·임베드", "고급"]);
  expect(types(sections).sort()).toEqual(all.map((e) => e.type).sort());
  expect(sections[0].items.slice(0, 3).map((e) => e.type)).toEqual(["paragraph", "heading1", "heading2"]);
  expect(sections[1].items.map((e) => e.type)).toEqual(["component:stat", "component:empty"]);
  expect(sections[2].items.map((e) => e.type)).toContain("image");
  expect(sections[3].items.map((e) => e.type)).toEqual(expect.arrayContaining(["code", "database", "equation"]));
});

test("parts sit in their own 부품 and 내 부품 groups right after the basic blocks, and search finds them", () => {
  const sections = lib.slashSections(all.concat(parts), "");
  expect(sections.map((s) => s.title)).toEqual(["기본 블록", "부품", "내 부품", "컴포넌트", "미디어·임베드", "고급"]);
  expect(sections[1].items.map((e) => e.type)).toEqual(["part:table", "part:dag"]);
  expect(sections[2].items.map((e) => e.type)).toEqual(["part:weekly-card"]);
  expect(types(lib.slashSections(all.concat(parts), "부품"))).toEqual(expect.arrayContaining(["part:table", "part:dag", "part:weekly-card"]));
  expect(types(lib.slashSections(all.concat(parts), "흐름도"))[0]).toBe("part:dag");
});

test("every block has a one-line description", () => {
  for (const entry of all) expect(lib.slashDesc(entry).length, entry.type).toBeGreaterThan(1);
});

test("recent and frequent items lead a 자주 쓰는 section (max 5), and stay in their own group too", () => {
  const sections = lib.slashSections(all, "", ["callout", "image"], { to_do: 9, image: 3, callout: 1 });
  expect(sections[0]).toMatchObject({ key: "frequent", title: "자주 쓰는" });
  expect(sections[0].items.map((e) => e.type)).toEqual(["to_do", "image", "callout"]);
  expect(sections.find((s) => s.key === "media")!.items.map((e) => e.type)).toContain("image");
  const many = lib.slashSections(all, "", ["a", "b"].concat(blockTypes.slice(0, 8).map((e) => e.type)));
  expect(many[0].items).toHaveLength(5);
  expect(lib.slashSections(all, "")[0].key).toBe("basic");
});

test("Korean, English, initial consonants and component aliases all match", () => {
  expect(first("제목")).toBe("heading1");
  expect(first("할 일")).toBe("to_do");
  expect(first("heading")).toBe("heading1");
  expect(first("todo")).toBe("to_do");
  expect(first("checkbox")).toBe("to_do");
  expect(first("ㅈㅁ")).toBe("heading1");
  expect(first("인")).toBe("quote");
  expect(first("kpi")).toBe("component:stat");
  expect(first("metric")).toBe("component:stat");
  expect(first("stat")).toBe("component:stat");
  expect(first("빈")).toBe("component:empty");
  expect(first("youtube")).toBe("video");
  expect(first("latex")).toBe("equation");
  // Half-composed syllable while the IME is still typing 목차.
  expect(first("목ㅊ")).toBe("toc");
  expect(types(lib.slashSections(all, "zzqx"))).toEqual([]);
});

// #152: in English the menu shows "To-do" (i18n-app.js rewrites the Korean label), and typing what is shown found nothing.
test("typing the label shown in English or Chinese finds that block first", () => {
  for (const lang of ["en", "zh"]) {
    const dict = JSON.parse(readFileSync(new URL("../assets/i18n/app-" + lang + ".json", import.meta.url), "utf8"));
    (globalThis as any).window = { AcardLang: { text: (s: string) => dict[s] || s } };
    try {
      for (const entry of blockTypes) expect(first(dict[entry.label] || entry.label), lang + " " + entry.type).toBe(entry.type);
      if (lang === "en") { expect(first("To-do")).toBe("to_do"); expect(first("to-do")).toBe("to_do"); }
    } finally { delete (globalThis as any).window; }
  }
  expect(first("To-do")).toBe("to_do");
});

test("a query keeps only matches, best item first, and orders groups by their best item", () => {
  const sections = lib.slashSections(all, "표");
  expect(sections[0].items[0].type).toBe("database");
  expect(types(sections)).toEqual(expect.arrayContaining(["database", "table"]));
  expect(types(sections)).not.toContain("paragraph");
  expect(sections.some((s) => s.key === "frequent")).toBe(false);
  // Exact label beats prefix beats alias; personal use only breaks ties inside a tier.
  const entry = blockTypes.find((e) => e.type === "heading1")!;
  expect(lib.slashScore(entry, "제목 1")).toBeGreaterThan(lib.slashScore(entry, "제목"));
  expect(lib.slashScore(entry, "제목")).toBeGreaterThan(lib.slashScore(entry, "h1"));
  expect(types(lib.slashSections(all, "제목", [], { heading3: 12 }))[0]).toBe("heading3");
  expect(types(lib.slashSections(all, "제목 1", [], { heading3: 12 }))[0]).toBe("heading1");
});

test("remember moves the type to the front, counts uses and caps both lists", () => {
  let state = { recents: [] as string[], freq: {} as Record<string, number> };
  for (const t of ["a", "b", "a", "c", "d", "e", "f", "g"]) state = lib.slashRemember(state.recents, state.freq, t);
  expect(state.recents).toEqual(["g", "f", "e", "d", "c", "a"]);
  expect(state.freq.a).toBe(2);
  let big = { recents: [] as string[], freq: Object.fromEntries(Array.from({ length: 30 }, (_, i) => ["t" + i, 5])) };
  big = lib.slashRemember(big.recents, big.freq, "new");
  expect(Object.keys(big.freq).length).toBeLessThanOrEqual(25);
  expect(big.freq.new).toBe(1);
});

test("groups: components, media and advanced types land in their group", () => {
  expect(lib.slashGroupOf({ type: "component:x", label: "", hint: "", ico: "" })).toBe("component");
  expect(lib.slashGroupOf({ type: "bookmark", label: "", hint: "", ico: "" })).toBe("media");
  expect(lib.slashGroupOf({ type: "db_ref", label: "", hint: "", ico: "" })).toBe("advanced");
  expect(lib.slashGroupOf({ type: "callout", label: "", hint: "", ico: "" })).toBe("basic");
});
