// #162: deleting the page you are on from the sidebar ⋯ menu sent you to "/" (the public landing). Runs the shipped
// lazy/folders.js in a WebView against a stub server and waits for the page the browser opens next.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "..", "assets/features/lazy/folders.js"), "utf8");
const page = (p: string, parent: string | null, ord: number) => ({ slug: p, title: "페이지 " + p, parent, ord, kind: "note", tags: [] });
const PAGES = [page("a", null, 10), page("b", null, 20), page("b1", "b", 10)];
const html = (editor: boolean) => `<!doctype html><html><head><meta charset="utf-8"></head><body class="reader">
<aside id="sidebar" class="sidebar">${editor ? '<div id="tree"></div>' : '<div class="side-ws"></div>'}</aside><main></main>
<script>window.AcardLive = { client: "c-test-tab" };</script><script>${script}</script></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let view: Bun.WebView;
let opened: (path: string) => void = () => {};
const trashed: string[][] = [];
const clients: (string | null)[] = [];

beforeAll(async () => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/folders/tree") return Response.json({ pages: PAGES, tags: [], prefs: { open: ["b"], collapsed: [], closed: [] } });
    if (url.pathname === "/api/folders/bulk") { clients.push(req.headers.get("x-acard-client")); trashed.push((await req.json()).slugs); return Response.json({ trashed: 1, batch: "x" }); }
    if (url.pathname.startsWith("/api/")) return Response.json({});
    // The browser's own favicon request is not a navigation; counting it raced the move to the parent.
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
    opened(url.pathname);
    return new Response(html(url.pathname.startsWith("/edit/")), { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  view = new Bun.WebView({ width: 1440, height: 844 });
}, 30000);
afterAll(async () => { await view?.close(); server?.stop(true); });

async function deleteFrom(start: string, slug: string) {
  trashed.length = 0; clients.length = 0;
  const loaded = new Promise<string>((ok) => { opened = ok; });
  await view.navigate(server.url.origin + start);
  await loaded;
  await view.evaluate(`new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("row not drawn")), 5000);
    const go = () => { const b = document.querySelector('.fd-row[data-slug="${slug}"] .fd-more'); if (!b) return; obs.disconnect(); clearTimeout(t); b.click();
      [...document.querySelectorAll('.fd-menu button')].find((x) => x.textContent === "삭제").click(); resolve(true); };
    const obs = new MutationObserver(go); obs.observe(document.body, { subtree: true, childList: true }); go();
  })`);
  const next = new Promise<string>((ok) => { opened = ok; });
  return Promise.race([next, Bun.sleep(5000).then(() => "stayed")]);
}

for (const [start, slug, want] of [
  ["/b1/", "b1", "/b/"],
  ["/edit/b1/", "b1", "/edit/b/"],
  ["/a/", "a", "/home/"],
  ["/edit/a/", "a", "/home/"],
] as const) {
  test(`deleting the open page ${start} lands on ${want}, not the landing`, async () => {
    expect(await deleteFrom(start, slug)).toBe(want);
    expect(trashed).toEqual([[slug]]);
    // Live: without this tab's client id the trash notice made the reader re-read the trashed page, and that failed
    // read reloaded the trashed address over the move to the parent.
    expect(clients).toEqual(["c-test-tab"]);
  }, 20000);
}

test("deleting another page keeps you where you are", async () => {
  expect(await deleteFrom("/b1/", "a")).toBe("stayed");
  expect(trashed).toEqual([["a"]]);
}, 20000);
