import { describe, expect, test } from "bun:test";
import "../components/index.js";
import { getComponent, renderComponentBlock } from "../component-registry.js";

const dgfIds = ["diagram-cycle", "diagram-pyramid", "diagram-roadmap", "diagram-kanban"];
const dgfRender = (ui: string, data: unknown) => renderComponentBlock({ type: "component", text: typeof data === "string" ? data : JSON.stringify(data), meta: { ui } });
const dgfCount = (html: string, cls: string) => (html.match(new RegExp('class="' + cls + '"', "g")) || []).length;
const dgfStages = (n: number) => Array.from({ length: n }, (_, i) => ({ title: "단계 " + i, text: "설명", icon: "○" }));

describe("diagram flow components", () => {
  test("registered samples, presets, schemas and aliases follow the diagram contract", () => {
    for (const id of dgfIds) {
      const c = getComponent(id)!;
      expect(c.family).toBe("diagram");
      expect(c.slash.aliases).toMatch(/[가-힣]/);
      expect(c.slash.aliases).toMatch(/[a-z]{3}/);
      expect(c.slash.ico).toBeTruthy();
      expect(c.description).toBeTruthy();
      for (const key of c.schema.required) expect(c.defaults[key]).toBeDefined();
      for (const preset of ["report", "friendly", "paper", "showcase"]) {
        expect(c.presets[preset]).toBeDefined();
        const html = dgfRender(id, { ...c.sample, preset });
        expect(html).toContain('data-ui="' + id + '"');
        expect(html).not.toContain("ui-fallback");
        expect(html).toContain('<figure');
        if (id !== "diagram-kanban") expect(html).toContain('role="img" aria-labelledby=');
        if (preset === "paper") expect(html).toContain("vk-numbered");
      }
    }
  });

  test("empty and malformed nested data never throw", () => {
    for (const id of dgfIds) {
      for (const data of [{}, "{ broken", { stages: [null, false, []], levels: [null], lanes: [null], periods: {}, bars: [null], columns: [null] }]) {
        const html = dgfRender(id, data);
        expect(html).not.toContain("ui-fallback");
        expect(html).toContain('class="vk-empty"');
      }
      expect(dgfRender(id, "{ broken")).toContain('data-ui-invalid="1"');
    }
  });

  test("every string field is escaped, including SVG titles and card attributes", () => {
    const evil = '\"><img src=x onerror=alert(1)><script>bad</script>';
    for (const id of dgfIds) {
      const poison = (value: unknown): unknown => typeof value === "string" ? evil : Array.isArray(value) ? value.map(poison) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, poison(v)])) : value;
      const data = { ...(poison(getComponent(id)!.sample) as object), source: evil, figure: true };
      const html = dgfRender(id, data);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("ui-fallback");
      expect(html).toContain("&lt;");
    }
  });

  test("cycle bounds, circle separation and closing curved arrows hold for 3–8 stages", () => {
    for (const n of [3, 4, 5, 6, 7, 8, 10]) {
      const html = dgfRender("diagram-cycle", { stages: dgfStages(n) });
      const circles = [...html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
      expect(circles.length).toBe(Math.min(n, 8));
      expect(dgfCount(html, "dgf-cycle-arrow")).toBe(circles.length);
      circles.forEach(([x, y, r], i) => {
        expect(x - r).toBeGreaterThanOrEqual(0); expect(x + r).toBeLessThanOrEqual(320);
        expect(y - r).toBeGreaterThanOrEqual(0); expect(y + r).toBeLessThanOrEqual(320);
        const next = circles[(i + 1) % circles.length];
        expect(Math.hypot(x - next[0], y - next[1])).toBeGreaterThan(r + next[2] + 10);
      });
      expect(html).not.toMatch(/NaN|Infinity/);
    }
    expect(dgfRender("diagram-cycle", { stages: dgfStages(2) })).toContain('class="vk-empty"');
    const a = dgfRender("diagram-cycle", getComponent("diagram-cycle")!.sample), b = dgfRender("diagram-cycle", getComponent("diagram-cycle")!.sample);
    expect(a.match(/<marker id="([^"]+)/)![1]).not.toBe(b.match(/<marker id="([^"]+)/)![1]);
  });

  test("cycle stage labels are never cut: long ko/en/zh titles wrap or grow the circles, and the visible text is the whole title", () => {
    const sets: [string, string, string][][] = [
      [["🌑", "지구 그림자 진입", "배터리 히터가 켜진다"], ["🔋", "전압 급강하", "3.3 V 아래로 순간 하락"], ["🔁", "와치독 재부팅", "컴퓨터가 멈췄다고 판단"], ["☀️", "햇빛 구간 충전", "다시 안전 모드로 깨어남"]],
      [["🌑", "Enter Earth's shadow", "The battery heater turns on"], ["🔋", "Voltage dips", "Drops below 3.3 V for a moment"], ["🔁", "Watchdog reboot", "Thinks the computer froze"], ["☀️", "Charge in sunlight", "Wakes up in safe mode again"]],
      [["🌑", "进入地球阴影区", "电池加热器开启"], ["🔋", "电压骤降", "瞬间跌破 3.3 V"], ["🔁", "看门狗重启", "判断计算机已死机"], ["☀️", "在日照区充电", "再次以安全模式唤醒"]],
      [["⚙", "Configure the deployment pipeline for production", "Every step is checked twice"], ["▤", "Supercalifragilisticexpialidocious", ""], ["⌕", "검토하고 다시 계획을 세우는 아주 긴 단계 이름입니다", "설명"], ["▥", "短", "短"], ["♧", "一二三四五六七八九十一二三四五六七八九十", "说明"]],
    ];
    const unesc = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const bare = (s: string) => s.replace(/\s/g, "");
    sets.forEach((set, k) => {
      const html = dgfRender("diagram-cycle", { stages: set.map(([icon, title, text]) => ({ icon, title, text })) });
      expect(html).not.toContain("…");
      const [, , vw, vh] = html.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
      const stages = [...html.matchAll(/<g class="dgf-stage"[^>]*>(.*?)<\/g>/g)].map((m) => m[1]);
      const circles = [...html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
      circles.forEach(([x, y, r], i) => {
        expect(r).toBeLessThanOrEqual(52);
        expect(x - r).toBeGreaterThanOrEqual(0); expect(x + r).toBeLessThanOrEqual(vw);
        expect(y - r).toBeGreaterThanOrEqual(0); expect(y + r).toBeLessThanOrEqual(vh);
        const next = circles[(i + 1) % circles.length];
        expect(Math.hypot(x - next[0], y - next[1])).toBeGreaterThan(r + next[2] + 10);
      });
      stages.forEach((g, i) => {
        // Only the drawn <text> lines count; the <title> tooltip always held the whole label.
        const label = [...g.matchAll(/<text[^>]*class="dgf-label"[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1])).join("");
        const [, title, text] = set[i];
        const listed = html.includes("dgf-cycle-notes") && html.includes("<b>" + title.replace(/'/g, "&#39;") + "</b>");
        if (k < 3) expect(bare(label)).toBe(bare(title)); // the satellite post's real labels all fit inside their circles
        else expect(label === "" ? listed : bare(label) === bare(title)).toBe(true);
        const note = [...g.matchAll(/<text[^>]*class="dgc-muted"[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1]));
        if (note.length) expect(note).toEqual([text]);
        else if (text) expect(listed).toBe(true);
      });
    });
  });

  test("pyramid levels widen monotonically with one note connector per level", () => {
    for (const n of [3, 4, 6, 8]) {
      const html = dgfRender("diagram-pyramid", { levels: dgfStages(n).map((s) => ({ title: s.title, note: "긴 설명 ".repeat(30) })) });
      const polygons = [...html.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1].split(" ").map((point) => point.split(",").map(Number)));
      const count = Math.min(n, 6);
      expect(polygons.length).toBe(count * 2);
      for (const drawing of [polygons.slice(0, count), polygons.slice(count)]) {
        let previous = 0;
        for (const p of drawing) { const width = p[2][0] - p[3][0]; expect(width).toBeGreaterThan(previous); previous = width; }
      }
      expect((html.match(/r="3"/g) || []).length).toBe(count * 2);
      expect(html).not.toMatch(/NaN|Infinity/);
    }
    expect(dgfRender("diagram-pyramid", { levels: [{}] })).toContain('class="vk-empty"');
  });

  test("roadmap uses inclusive endpoints, packs overlaps, clips ranges and rejects bad indexes", () => {
    const data = { lanes: [{ name: "개발" }], periods: ["1", "2", "3", "4"], now: 0, bars: [
      { lane: 0, start: -3, end: 0, label: "a" }, { lane: 0, start: 0, end: 1, label: "b", status: "done" },
      { lane: 0, start: 1, end: 9, label: "c" }, { lane: 0, start: 3, end: 2 }, { lane: 2, start: 0, end: 1 },
      { lane: 0, start: .5, end: 1 }, { lane: "0", start: 0, end: 1 }, { lane: 0, start: 4, end: 8 },
    ] };
    const html = dgfRender("diagram-roadmap", data);
    expect(dgfCount(html, "dgf-bar")).toBe(6);
    expect(html).toContain('data-start="0" data-end="0" data-track="0"');
    expect(html).toContain('data-start="0" data-end="1" data-track="1"');
    expect(html).toContain('data-start="1" data-end="3" data-track="0"');
    expect(dgfCount(html, "dgf-now")).toBe(2);
    expect(dgfCount(dgfRender("diagram-roadmap", { ...data, now: 4 }), "dgf-now")).toBe(0);
    expect(dgfRender("diagram-roadmap", { ...data, periods: [] })).toContain('class="vk-empty"');
    expect(dgfRender("diagram-roadmap", { ...data, bars: [] })).not.toContain("ui-fallback");
  });

  test("kanban counts valid cards and confines keyboard scrolling to its region", () => {
    const html = dgfRender("diagram-kanban", { columns: [{ title: "할 일", cards: [null, [], { title: "작업", tone: "invalid" }] }, { title: "완료", cards: [] }] });
    expect(dgfCount(html, "dgf-card")).toBe(1);
    expect(html).toContain('aria-label="1개 작업">1');
    expect(html).toContain('aria-label="0개 작업">0');
    expect(html).toContain('role="region" tabindex="0" aria-label=');
    expect(html).toContain("var(--color-neutral-bg)");
    const css = getComponent("diagram-kanban")!.css;
    expect(css).toContain("overflow-x:auto"); expect(css).toContain("scroll-snap-type:x mandatory");
    expect(css).toContain("@container"); expect(css).toContain("@media print"); expect(css).toContain("overflow:visible");
    expect(dgfCount(dgfRender("diagram-kanban", { columns: Array.from({ length: 10 }, () => ({ cards: Array.from({ length: 30 }, () => ({})) })) }), "dgf-card")).toBe(8 * 24);
  });

  test("component CSS uses tokens and no scripts or motion are required", () => {
    for (const id of dgfIds) {
      const c = getComponent(id)!;
      expect(c.css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|border-radius:\s*[0-9.]+px|font-size:\s*[0-9.]+px/);
      expect(dgfRender(id, c.sample)).not.toMatch(/<script|onclick=|onload=/);
    }
  });
});
