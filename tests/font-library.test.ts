import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PAGE_FONTS } from "../editor-pages.js";
import { memberAssetAllowed } from "../gate/tenancy";
import { setup } from "./db-harness";

const ROOT = join(import.meta.dir, "..");
const catalog = JSON.parse(readFileSync(join(ROOT, "assets/fonts/catalog.json"), "utf8"));

test("the server accepts exactly the page fonts the catalog lists, old values included", () => {
  expect(catalog.fonts.map((f: { id: string }) => f.id).sort()).toEqual([...PAGE_FONTS].sort());
  for (const old of ["default", "serif", "mono", "report"]) expect(PAGE_FONTS).toContain(old);
});

test("every catalog font has the agreed fields and its CSS and preview face exist", () => {
  const preview = readFileSync(join(ROOT, "assets/fonts/lib/preview.css"), "utf8");
  const groups = new Set(catalog.groups.map((g: { id: string }) => g.id));
  for (const f of catalog.fonts) {
    expect(Object.keys(f)).toEqual(expect.arrayContaining(["id", "label", "category", "cssFamily", "weights", "glyphs", "headingOnly", "previewCss"]));
    expect(groups.has(f.category)).toBe(true);
    if (f.css) expect(existsSync(join(ROOT, "assets", f.css))).toBe(true);
    expect(preview).toContain("@font-face{" + f.previewCss + ";");
    if (!f.headingOnly) expect(f.glyphs).toBe(11172);
  }
});

test("each font's CSS points only at files that exist and sets font-display swap", () => {
  for (const f of catalog.fonts.filter((x: { css: string | null }) => x.css && x.css.startsWith("/fonts/lib/"))) {
    const css = readFileSync(join(ROOT, "assets", f.css), "utf8");
    const urls = [...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(statSync(join(ROOT, "assets", url)).size).toBeGreaterThan(0);
    for (const face of css.match(/@font-face\{[^}]*src:url[^}]*\}/g) ?? []) expect(face).toContain("font-display:swap");
  }
});

test("a shared link draws the page in its picked font; a default page carries no font library CSS", async () => {
  const css = readFileSync(join(ROOT, "assets/fonts/lib/batang.css"), "utf8");
  const h = setup({ assets: { "/style.css": "body{}", "/lazy/checks.css": "", "/fonts/lib/batang.css": css } });
  try {
    for (const [slug, font] of [["picked", "batang"], ["plain", "default"]]) {
      expect((await h.call("POST", "/api/pages", { title: "T " + slug, slug })).status).toBe(200);
      expect((await h.call("PUT", "/api/page/" + slug, { title: "T " + slug, blocks: [{ id: "p1", type: "paragraph", text: "본문" }] })).status).toBe(200);
      expect((await h.call("PUT", "/api/page/" + slug + "/settings", { font })).status).toBe(200);
      const link = (await h.call("POST", "/api/page/" + slug + "/share")).data as { url: string };
      const html = await (await h.worker.fetch(new Request("https://notes.test" + link.url), h.env)).text();
      expect(html.includes('.sv-main article,')).toBe(font === "batang");
      expect(html.includes('font-family:"Acard Gowun Batang"')).toBe(font === "batang");
      expect(html).not.toContain('#main[data-font="batang"]');
    }
  } finally { h.sqlite.close(); }
  expect(memberAssetAllowed("/fonts/lib/batang.css")).toBe(true);
  expect(memberAssetAllowed("/fonts/lib/../catalog.json")).toBe(false);
});

test("every page loads the Pretendard Hangul pieces up front, swapped in, so no syllable falls back to the system font", async () => {
  const pieces = readFileSync(join(ROOT, "assets/fonts/fonts.css"), "utf8");
  const covered = new Set<number>();
  for (const range of pieces.matchAll(/unicode-range:([^}]+)\}/g)) for (const part of range[1].split(",")) {
    const [a, b] = part.replace("U+", "").split("-").map((x) => parseInt(x, 16));
    for (let c = a; c <= (b ?? a); c++) covered.add(c);
  }
  for (let c = 0xac00; c <= 0xd7a3; c++) expect(covered.has(c)).toBe(true);
  for (const css of [pieces, readFileSync(join(ROOT, "assets/tokens.css"), "utf8"), readFileSync(join(ROOT, "assets/_site/type.css"), "utf8")])
    for (const face of css.match(/@font-face\{[^}]*src:url[^}]*\}/g) ?? []) expect(face).toContain("font-display:swap");
  for (const file of [...new Bun.Glob("assets/_site/*.html").scanSync(ROOT), "assets/agents.html", "assets/gallery.html"])
    expect(readFileSync(join(ROOT, file), "utf8")).toContain('<link rel="stylesheet" href="/fonts/fonts.css">');
  for (const loader of ["assets/app.js", "assets/editor-pages-ui.js"]) expect(readFileSync(join(ROOT, loader), "utf8").split("\n")[0]).toContain('c("/fonts/fonts.css")})(document,window);');

  const h = setup({ assets: { "/style.css": "body{}", "/lazy/checks.css": "", "/fonts/fonts.css": pieces } });
  try {
    expect((await h.call("POST", "/api/pages", { title: "승인", slug: "shared" })).status).toBe(200);
    expect((await h.call("PUT", "/api/page/shared", { title: "승인", blocks: [{ id: "p1", type: "paragraph", text: "공유한 사람이 승인하면" }] })).status).toBe(200);
    const link = (await h.call("POST", "/api/page/shared/share")).data as { url: string };
    const html = await (await h.worker.fetch(new Request("https://notes.test" + link.url), h.env)).text();
    expect(html).toContain('font-family:"Pretendard Variable";font-display:swap;font-weight:45 920;src:url(/fonts/pretendard/90.woff2)');
  } finally { h.sqlite.close(); }
  // Member workspaces read assets through memberAssets: a refused fonts.css would inline nothing on their shared pages.
  expect(memberAssetAllowed("/fonts/fonts.css")).toBe(true);
  expect(memberAssetAllowed("/fonts/catalog.json")).toBe(false);
});

test("member workspaces and the local server get every shipped font file (#145)", () => {
  // The local server (desktop app, self-host edition) reads all assets through memberAssets; a refused woff2 is a 404 and
  // the page falls back to system fonts.
  let files = 0;
  for (const found of new Bun.Glob("assets/fonts/**/*.{woff2,css}").scanSync(ROOT)) {
    files++;
    expect(memberAssetAllowed("/" + found.replaceAll("\\", "/").replace(/^assets\//, ""))).toBe(true);
  }
  expect(files).toBeGreaterThan(500);
  for (const bad of ["/fonts/../notes-seed.json", "/fonts/lib/../../search-index.json.woff2", "/fonts/x.woff2/../db-seed.json", "/fonts/Pretendard.WOFF2"]) expect(memberAssetAllowed(bad)).toBe(false);
});

test("new font files stay inside the planned caps (600 files, 25 MB)", () => {
  let files = 0, bytes = 0;
  for (const found of new Bun.Glob("assets/fonts/lib/**/*.woff2").scanSync(ROOT)) { files++; bytes += statSync(join(ROOT, found)).size; }
  for (const found of new Bun.Glob("assets/fonts/serif/*-700-normal.woff2").scanSync(ROOT)) { files++; bytes += statSync(join(ROOT, found)).size; }
  expect(files).toBeLessThanOrEqual(600);
  expect(bytes).toBeLessThanOrEqual(25 * 1024 * 1024);
});
