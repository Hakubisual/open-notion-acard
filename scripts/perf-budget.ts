import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type BudgetMetrics = {
  readerRaw: number;
  readerGzip: number;
  editorRaw: number;
  editorGzip: number;
  totalRaw: number;
};

const labels: Record<keyof BudgetMetrics, string> = {
  readerRaw: "읽기 첫 화면 / Reader raw",
  readerGzip: "읽기 첫 화면 / Reader gzip",
  editorRaw: "편집 첫 화면 / Editor raw",
  editorGzip: "편집 첫 화면 / Editor gzip",
  totalRaw: "전체 클라이언트 / Total raw",
};

// Query strings identify versions, not additional files. External assets are not local bytes.
function localAsset(reference: string, owner: string): string | null {
  const base = new URL(owner, "https://acard.invalid/");
  const url = new URL(reference, base);
  if (url.origin !== base.origin || !/\.(css|js)$/i.test(url.pathname)) return null;
  return decodeURIComponent(url.pathname.slice(1));
}

async function firstScreen(dist: string, page: string) {
  const files = new Set([page]);
  const add = (reference: string, owner: string) => {
    const file = localAsset(reference, owner);
    if (file) files.add(file);
  };
  const html = await readFile(join(dist, page), "utf8");
  await new HTMLRewriter().on("script[src], link[href]", {
    element(element) {
      add(element.getAttribute(element.tagName === "script" ? "src" : "href")!, page);
    },
  }).transform(new Response(html)).text();

  let raw = 0;
  let gzip = 0;
  // Set iteration also visits newly discovered imports, once each (including cycles).
  for (const file of files) {
    const bytes = await readFile(join(dist, file));
    raw += bytes.byteLength;
    gzip += Bun.gzipSync(bytes, { level: 9 }).byteLength;
    if (file.endsWith(".css")) {
      const css = bytes.toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)|"([^"]+)"|'([^']+)')/gi)) {
        add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], file);
      }
    }
  }
  return { raw, gzip, files: [...files].sort() };
}

// lazyChunkCaps: a named lazy chunk that may be larger than lazyMaxRaw (each one has a dated entry in perf-budget.json).
export type BudgetCaps = BudgetMetrics & { lazyMaxRaw: number; lazyChunkCaps?: Record<string, number> };

export async function measurePerformanceBudget(dist: string, caps: BudgetCaps) {
  for (const key of [...Object.keys(labels), "lazyMaxRaw"] as (keyof BudgetCaps)[]) {
    if (!Number.isSafeInteger(caps[key]) || caps[key] < 0) {
      throw new Error("잘못된 성능 한도 / Invalid performance cap: " + key);
    }
  }
  const [reader, editor] = await Promise.all([
    firstScreen(dist, "index.html"),
    firstScreen(dist, "editor.html"),
  ]);
  let totalRaw = 0;
  const lazy = new Map<string, number>();
  for await (const file of new Bun.Glob("**/*.{js,css,html}").scan({ cwd: dist, onlyFiles: true })) {
    if (file.replaceAll("\\", "/").split("/").at(-1) === "_worker.js") continue;
    const bytes = Bun.file(join(dist, file)).size;
    totalRaw += bytes;
    const chunk = /^lazy\/([^/]+)\.(?:js|css)$/.exec(file.replaceAll("\\", "/"));
    if (chunk) lazy.set(chunk[1], (lazy.get(chunk[1]) || 0) + bytes);
  }
  const measured: BudgetMetrics = {
    readerRaw: reader.raw, readerGzip: reader.gzip,
    editorRaw: editor.raw, editorGzip: editor.gzip, totalRaw,
  };
  const rows: { key: string; label: string; bytes: number; cap: number; passed: boolean }[] = (Object.keys(labels) as (keyof BudgetMetrics)[]).map((key) => ({
    key, label: labels[key], bytes: measured[key], cap: caps[key],
    passed: measured[key] <= caps[key],
  }));
  for (const [name, bytes] of [...lazy].sort()) {
    const cap = caps.lazyChunkCaps?.[name] ?? caps.lazyMaxRaw;
    rows.push({ key: "lazy/" + name, label: "지연 기능 / Lazy " + name, bytes, cap, passed: bytes <= cap });
  }
  return { measured, rows, passed: rows.every((row) => row.passed), files: { reader: reader.files, editor: editor.files } };
}

export function printPerformanceBudget(result: Awaited<ReturnType<typeof measurePerformanceBudget>>) {
  console.log("성능 예산 / Performance budget (bytes; gzip level 9, per file)");
  console.log("항목 / Metric | 측정 / Measured | 한도 / Cap | 여유 / Remaining | 결과 / Result");
  console.log("--- | ---: | ---: | ---: | ---");
  for (const row of result.rows) {
    console.log(`${row.label} | ${row.bytes} | ${row.cap} | ${row.cap - row.bytes} | ${row.passed ? "통과 / PASS" : "초과 / FAIL"}`);
  }
  console.log(result.passed ? "PERF_BUDGET_OK 성능 예산 통과" : "PERF_BUDGET_EXCEEDED 성능 예산 초과 / Performance budget exceeded");
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const config = await Bun.file(join(root, "perf-budget.json")).json();
  const result = await measurePerformanceBudget(join(root, "dist"), config.caps);
  printPerformanceBudget(result);
  if (!result.passed) process.exitCode = 1;
}
