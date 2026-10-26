import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { measurePerformanceBudget, type BudgetMetrics } from "../scripts/perf-budget.ts";

describe("performance budget", () => {
  let dist: string;
  const files: Record<string, string> = {
    "index.html": '<!doctype html><link rel="stylesheet" href="/css/main.css?v=1"><script src="./reader.js?v=1"></script><script src="reader.js?v=2#same"></script><script src="https://example.com/remote.js"></script><!-- <script src="missing.js"></script> --><h1>읽기</h1>',
    "editor.html": "<!doctype html><link rel='stylesheet' href='css/main.css'><script src=editor.js></script>",
    "css/main.css": '@import url("./tokens.css?v=2"); @import "./tokens.css#same"; /* @import "missing.css"; */ body { color: red; }',
    "css/tokens.css": '@import url("main.css"); :root { --color: red; }',
    "reader.js": 'console.log("reader");',
    "editor.js": 'console.log("editor");',
    "nested/index.html": "<h1>Another page</h1>",
    "_worker.js": "excluded worker".repeat(100),
    "acard-cli.tgz": "excluded archive".repeat(100),
    "notes-seed.json": "excluded seed".repeat(100),
    "img/cover.svg": "excluded image".repeat(100),
  };
  const reader = ["index.html", "css/main.css", "css/tokens.css", "reader.js"];
  const editor = ["editor.html", "css/main.css", "css/tokens.css", "editor.js"];
  const raw = (names: string[]) => names.reduce((sum, name) => sum + Buffer.byteLength(files[name]), 0);
  const gzip = (names: string[]) => names.reduce((sum, name) => sum + gzipSync(files[name], { level: 9 }).byteLength, 0);
  const expected: BudgetMetrics = {
    readerRaw: raw(reader), readerGzip: gzip(reader),
    editorRaw: raw(editor), editorGzip: gzip(editor),
    totalRaw: raw([...new Set([...reader, ...editor, "nested/index.html"])]),
  };

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "acard-perf-budget-"));
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(dist, file)), { recursive: true });
      await writeFile(join(dist, file), content);
    }
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  test("measures unique local resources, CSS imports and nested client files under cap", async () => {
    const caps = { ...Object.fromEntries(Object.entries(expected).map(([key, bytes]) => [key, bytes + 1])) as BudgetMetrics, lazyMaxRaw: 40000 };
    const result = await measurePerformanceBudget(dist, caps);
    expect(result.measured).toEqual(expected);
    expect(result.files.reader).toEqual([...reader].sort());
    expect(result.files.editor).toEqual([...editor].sort());
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((row) => row.passed)).toBe(true);
    expect(result.passed).toBe(true);
  });

  test("accepts a measurement exactly at its cap", async () => {
    expect((await measurePerformanceBudget(dist, { ...expected, lazyMaxRaw: 40000 })).passed).toBe(true);
  });

  test.each(Object.keys(expected) as (keyof BudgetMetrics)[])("fails when %s exceeds its cap", async (key) => {
    const result = await measurePerformanceBudget(dist, { ...expected, lazyMaxRaw: 40000, [key]: expected[key] - 1 });
    expect(result.measured).toEqual(expected);
    expect(result.passed).toBe(false);
    expect(result.rows.filter((row) => !row.passed).map((row) => row.key)).toEqual([key]);
  });

  test("does not silently ignore a missing referenced file", async () => {
    await rm(join(dist, "reader.js"));
    await expect(measurePerformanceBudget(dist, { ...expected, lazyMaxRaw: 40000 })).rejects.toThrow();
  });

  test("rejects a missing cap rather than silently disabling a metric", async () => {
    const caps = { ...expected, lazyMaxRaw: 40000 };
    Reflect.deleteProperty(caps, "totalRaw");
    await expect(measurePerformanceBudget(dist, caps)).rejects.toThrow("totalRaw");
  });

  test("lazy JS and CSS count only in total and share a per-chunk cap", async () => {
    await mkdir(join(dist, "lazy"));
    await writeFile(join(dist, "lazy/chart.js"), "x".repeat(80));
    await writeFile(join(dist, "lazy/chart.css"), "x".repeat(20));
    const caps = { ...expected, totalRaw: expected.totalRaw + 100, lazyMaxRaw: 100 };
    const result = await measurePerformanceBudget(dist, caps);
    expect(result.measured).toEqual({ ...expected, totalRaw: expected.totalRaw + 100 });
    expect(result.files.reader).toEqual([...reader].sort());
    expect(result.files.editor).toEqual([...editor].sort());
    expect(result.passed).toBe(true);
    expect(result.rows.at(-1)).toMatchObject({ key: "lazy/chart", bytes: 100, cap: 100 });
    expect((await measurePerformanceBudget(dist, { ...caps, lazyMaxRaw: 99 })).rows.filter(row => !row.passed).map(row => row.key)).toEqual(["lazy/chart"]);
    expect((await measurePerformanceBudget(dist, { ...caps, lazyMaxRaw: 99, lazyChunkCaps: { chart: 100 } })).passed).toBe(true);
    expect((await measurePerformanceBudget(dist, { ...caps, lazyMaxRaw: 100, lazyChunkCaps: { chart: 99 } })).rows.filter(row => !row.passed).map(row => row.key)).toEqual(["lazy/chart"]);
    expect((await measurePerformanceBudget(dist, { ...caps, totalRaw: caps.totalRaw - 1 })).rows.filter(row => !row.passed).map(row => row.key)).toEqual(["totalRaw"]);
    await expect(measurePerformanceBudget(dist, expected as any)).rejects.toThrow("lazyMaxRaw");
  });
});
