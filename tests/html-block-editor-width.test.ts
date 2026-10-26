// #151: on a 390px phone the HTML block's source box, caption/alt inputs and preview ran past the block's right edge -
// the one-column phone grid used 1fr (min-content wide), so a textarea/input wider than the block widened the column.
// Mounts the shipped lazy/visuals.js chunk with lazy/visuals.css (the bytes the site serves, built from editor-next/ by
// scripts/build-editor-next.ts) in a WebView at block widths seen on phones.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const css = ["assets/tokens.css", "assets/features/lazy/visuals.css"].map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
let code = "";
let server: ReturnType<typeof Bun.serve>;
let view: Bun.WebView;
const page = (width: number) => `<!doctype html><html><head><meta charset="utf-8"><style>${css} body{margin:0} #host{width:${width}px;box-sizing:border-box}</style></head>
<body><div id="host"></div><script>window.AcardEditor={provide:function(n,a){window.__visuals=a}};</script><script src="/visuals.js"></script>
<script>__visuals.mount(document.getElementById("host"),{id:"x1",type:"html",text:'<div style="padding:16px">PQA HTML PASS</div>',meta:{caption:"PQA HTML caption"}},function(){});</script></body></html>`;

beforeAll(async () => {
  code = readFileSync(join(ROOT, "assets/features/lazy/visuals.js"), "utf8");
  server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/visuals.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
    return new Response(page(Number(url.searchParams.get("w"))), { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  view = new Bun.WebView({ width: 390, height: 844 });
}, 30000);
afterAll(async () => { await view?.close(); server?.stop(true); });

for (const width of [262, 200]) {
  test(`HTML block editor at a ${width}px block: source, caption, alt and preview stay inside the block`, async () => {
    await view.navigate(server.url.origin + "/?w=" + width);
    const over = await view.evaluate(`(() => {
      const grid = document.querySelector(".acv-grid"), edge = grid.getBoundingClientRect().right;
      return [...grid.querySelectorAll(".acv-source, .acv-field input, .acv-preview, .acv-hint")].filter((e) => e.getBoundingClientRect().right > edge + 0.5)
        .map((e) => e.className + ":" + Math.round(e.getBoundingClientRect().right) + ">" + Math.round(edge));
    })()`);
    expect(await view.evaluate(`document.querySelectorAll(".acv-source, .acv-field input, .acv-preview").length`)).toBe(4);
    expect(over).toEqual([]);
  }, 20000);
}
