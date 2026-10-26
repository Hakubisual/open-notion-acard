import { describe, expect, test } from "bun:test";
import "../components/index.js";
import "../assets/editor-model.js";
import { renderComponentBlock, uiDataIsEnglish } from "../component-registry.js";
import { renderBlocks } from "../block-html.js";

// The words a component draws itself follow the language of its data (acard-example-pages-rewrite: the English example
// pages showed 목표, 개 작업, 각주, 참고문헌 ... inside English charts). Korean data keeps every Korean word.
const draw = (ui: string, data: unknown) => renderComponentBlock({ type: "component", text: JSON.stringify(data), meta: { ui } });
const visible = (html: string) => html.replace(/<(style|title|desc)[\s\S]*?<\/\1>/g, "").replace(/<table class="vk-sr"[\s\S]*?<\/table>/g, "").replace(/<[^>]+>/g, " ");

const cases: [string, unknown, unknown][] = [
  ["chart-gauge", { label: "Diesel left", value: 58, max: 120, target: 40 }, { label: "남은 경유", value: 58, max: 120, target: 40 }],
  ["chart-funnel", { stages: [{ label: "Recorded", value: 203 }, { label: "Decoded", value: 11 }] }, { stages: [{ label: "녹음", value: 203 }, { label: "해독", value: 11 }] }],
  ["chart-heatmap", { rows: ["Morning", "Night"], cols: ["Low floors", "High floors"], values: [[39, 73], [17, 31]] }, { rows: ["아침", "밤"], cols: ["저층", "고층"], values: [[39, 73], [17, 31]] }],
  ["chart-boxplot", { title: "Wait by presses", groups: [{ label: "Once", values: [1, 2, 3, 4, 5] }] }, { title: "누른 횟수별 대기", groups: [{ label: "한 번", values: [1, 2, 3, 4, 5] }] }],
  ["diagram-kanban", { columns: [{ title: "Doing", cards: [{ title: "Check the stoves" }] }] }, { columns: [{ title: "하는 중", cards: [{ title: "난로 보기" }] }] }],
  ["block-code", { filename: "cw.py", code: "print('hi')" }, { filename: "cw.py", code: "print('안녕')" }],
  ["block-references", { references: [{ authors: "Feller, W.", year: 1971, title: "Probability Theory" }] }, { references: [{ authors: "김민서", year: 2024, title: "디지털 노트" }] }],
  ["block-footnotes", { notes: [{ id: "1", text: "The survey ran for five days." }] }, { notes: [{ id: "1", text: "설문은 닷새 동안 받았다." }] }],
  ["ix-countup", { numbers: [{ value: 520, label: "Altitude", suffix: " km" }] }, { numbers: [{ value: 520, label: "고도", suffix: " km" }] }],
];

describe("component words follow the data's language", () => {
  test("English data draws no Hangul and is marked lang=en", () => {
    for (const [ui, en] of cases) {
      const html = draw(ui, en);
      expect(html).toContain(' lang="en"');
      expect(visible(html)).not.toMatch(/[가-힣]/);
    }
  });
  test("Korean data keeps the Korean words and no lang mark", () => {
    const expected: Record<string, string> = { "chart-gauge": "목표 40", "chart-funnel": "이전 대비", "chart-heatmap": "적음", "diagram-kanban": "1개 작업", "block-code": "코드 블록", "block-references": "참고문헌", "block-footnotes": "각주", "ix-countup": "숫자 카운트업", "chart-boxplot": "중앙값" };
    for (const [ui, , ko] of cases) {
      const html = draw(ui, ko);
      expect(html).not.toContain(' lang="en"');
      expect(html).toContain(expected[ui]);
    }
  });
  test("data with only ids and numbers stays Korean", () => {
    expect(uiDataIsEnglish({ value: 58, max: 120, tone: "info", preset: "paper" })).toBe(false);
    expect(uiDataIsEnglish({ label: "Mixed 혼합" })).toBe(false);
    expect(uiDataIsEnglish({ label: "Firewood" })).toBe(true);
  });
  test("table of contents heading and image figure follow their text", () => {
    const blocks = (h: string, img: string) => [{ id: "t", type: "toc", text: "" }, { id: "h", type: "heading2", text: h }, { id: "h2", type: "heading2", text: h + " 2" }, { id: "i", type: "image", text: img, meta: { src: "/media/abc" } }];
    const en = renderBlocks(blocks("Results", "The rooftop station") as any, { page: { readOnly: true }, pages: [] });
    expect(en).toContain("<h3>Contents</h3>");
    expect(en).toContain('<figure class="img" lang="en"');
    const ko = renderBlocks(blocks("결과", "옥상 지상국") as any, { page: { readOnly: true }, pages: [] });
    expect(ko).toContain("<h3>목차</h3>");
    expect(ko).not.toContain('lang="en"');
  });
});
