// Light local mode of the desktop app (ACARD_LITE=1, acard-desktop-first-run). Markdown goes in as written and is shown
// as plain readable markdown: no editor bundle, no Acard components or parts, no theme CSS, no write guide / AI polish.
// Those exist only on notes.example.com (web mode) or when a page is published through it. Pages are stored in the same SQLite
// tables and block format as before, so a 0.1.1 data folder opens unchanged; component blocks show as code text.
// Agents reach it through /mcp, /api/v1, /AGENTS.md and /llms.txt with the random token in <data>/agent-token only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { blocksToMarkdown, markdownToBlocks, type Block } from "../markdown-blocks";

export type LiteRun = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
export type CoreCall = (path: string, init?: RequestInit) => Promise<Response>;

// The agent token: 32 random bytes, kept in the data folder, shown only on the AI connection screen, never logged.
export function agentTokens(dataDir: string) {
  const file = join(dataDir, "agent-token");
  let token = "";
  const write = (value: string) => {
    writeFileSync(file, value);
    try { chmodSync(file, 0o600); } catch {}
    token = value;
  };
  const fresh = () => "acl_" + randomBytes(32).toString("base64url");
  if (existsSync(file)) token = readFileSync(file, "utf8").trim();
  if (token.length < 24) write(fresh());
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return {
    get: () => token,
    rotate: () => { write(fresh()); return token; },
    matches: (given: string) => timingSafeEqual(digest(given), digest(token)),
  };
}

// Plain markdown -> HTML. Raw HTML in a page is shown as text; links and images keep only safe schemes.
export function renderMarkdown(markdown: string): string {
  const html = Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true, tagFilter: true, autolinks: true });
  return html
    .replace(/\shref="([^"]*)"/g, (_m, url: string) => ' href="' + (/^(?:https?:|mailto:|\/|#)/i.test(url) ? url : "#") + '"')
    .replace(/\ssrc="([^"]*)"/g, (_m, url: string) => (/^(?:https?:|\/media\/|data:image\/(?:png|jpe?g|gif|webp);)/i.test(url) ? ' src="' + url + '"' : ""));
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// One page for the reader and the editor box: markdown without the hidden block-style lines for reading, with them for
// editing (so colors and callout icons survive a save), plus the rendered HTML.
async function pageView(core: CoreCall, slug: string) {
  const res = await core("/api/page/" + encodeURIComponent(slug));
  if (!res.ok) return null;
  const data = await res.json() as { page: { slug: string; title: string; updated: number; kind: string }; blocks: Block[]; database?: { properties: { id: string; name: string; type: string }[]; rows: { page_title?: string; props?: Record<string, unknown> }[] } };
  let reading = blocksToMarkdown(data.blocks);
  if (data.page.kind === "db" && data.database) {
    const props = data.database.properties;
    const cell = (v: unknown) => String(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    reading = "| " + props.map((p) => cell(p.name)).join(" | ") + " |\n| " + props.map(() => "---").join(" | ") + " |\n"
      + data.database.rows.map((row) => "| " + props.map((p) => cell(p.type === "title" ? row.page_title : row.props?.[p.id])).join(" | ") + " |").join("\n") + "\n";
  }
  return {
    slug: data.page.slug, title: data.page.title, updated: data.page.updated, kind: data.page.kind,
    markdown: blocksToMarkdown(data.blocks, { meta: true }), html: renderMarkdown(reading),
  };
}

// /__local/lite/*: the light reader and editor's API, all on top of the core's own page API.
export async function liteRoute(request: Request, url: URL, core: CoreCall): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const page = /^\/__local\/lite\/page\/([^/]+)$/.exec(url.pathname);
  if (page) {
    const slug = decodeURIComponent(page[1]);
    if (method === "GET") {
      const view = await pageView(core, slug);
      return view ? json(view) : json({ error: "없는 페이지예요." }, 404);
    }
    if (method === "PUT") {
      const body = await request.json().catch(() => null) as { title?: string; markdown?: string; base?: number } | null;
      if (!body || typeof body.markdown !== "string" || !Number.isSafeInteger(body.base)) return json({ error: "요청 형식이 올바르지 않아요." }, 400);
      const blocks = markdownToBlocks(body.markdown, { meta: true });
      const res = await core("/api/page/" + encodeURIComponent(slug), { method: "PUT", body: JSON.stringify({ title: body.title, blocks, base_updated: body.base }) });
      if (res.status === 409) return json({ error: "그사이 다른 곳(AI 등)에서 이 페이지가 바뀌었어요. 다시 불러온 뒤 고쳐 주세요." }, 409);
      if (!res.ok) return json({ error: "저장하지 못했어요 (" + res.status + ")." }, res.status);
      return json(await pageView(core, slug));
    }
    if (method === "DELETE") {
      const res = await core("/api/page/" + encodeURIComponent(slug), { method: "DELETE" });
      return json({ ok: res.ok }, res.ok ? 200 : res.status);
    }
    return json({ error: "지원하지 않는 요청이에요." }, 405);
  }
  if (url.pathname === "/__local/lite/new" && method === "POST") {
    const body = await request.json().catch(() => ({})) as { title?: string };
    const res = await core("/api/pages", { method: "POST", body: JSON.stringify({ title: String(body.title || "").trim() || "새 페이지" }) });
    const created = await res.json() as { slug?: string };
    return res.ok ? json({ slug: created.slug }) : json({ error: "페이지를 만들지 못했어요." }, res.status);
  }
  return null;
}

// The local MCP of the light mode: five tools, markdown in and out, nothing rewritten and nothing recorded on the side.
const INSTRUCTIONS = "Acard (local, on this computer). Pages are plain markdown, stored and shown exactly as you write them: "
  + "headings, lists, '- [ ] ' to-dos, tables, quotes, code fences, links and images. There are no components, parts or "
  + "styles here. list_pages / read_page to look, create_page for a new page, append_to_page to add to one, update_page "
  + "(with expectedUpdated from read_page) to replace one. Never put secrets or tokens in pages.";
export const LITE_AGENT = { name: "AI (로컬)", via: "token" as const, scopes: ["read", "write"] };

export function liteMcp(run: LiteRun) {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String((error as Error)?.message || error) }] });
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    const server = new McpServer({ name: "acard-local", version: "1" }, { instructions: INSTRUCTIONS });
    const tool = (name: string, description: string, shape: z.ZodRawShape, operation: string, readOnly: boolean) =>
      server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } },
        async (input: Record<string, unknown>) => { try { return result(await run(operation, input)); } catch (error) { return failure(error); } });
    const slug = z.string().describe("Page slug from list_pages.");
    const markdown = z.string().describe("Markdown, stored as written. Optional front matter: title, parent.");
    tool("list_pages", "List pages, or search titles and text when query is given.", { query: z.string().optional() }, "listPages", true);
    tool("read_page", "Read one page as markdown, with its updated timestamp.", { slug }, "readPage", true);
    tool("create_page", "Create a page from markdown.", { markdown, title: z.string().optional(), parent: z.string().optional() }, "createPage", false);
    tool("append_to_page", "Add markdown to the end of a page.", { slug, markdown }, "appendToPage", false);
    tool("update_page", "Replace a page's markdown. Pass expectedUpdated from read_page.", { slug, markdown, expectedUpdated: z.number().optional() }, "updatePage", false);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

export function liteAgentsMd(origin: string): string {
  return "# Acard (local)\n\n" + INSTRUCTIONS + "\n\n- MCP (streamable HTTP): " + origin + "/mcp\n- REST: " + origin + "/api/v1/pages "
    + "(GET list, POST {markdown, title?, parent?}), " + origin + "/api/v1/pages/<slug> (GET, PUT {markdown, expectedUpdated}), "
    + origin + "/api/v1/pages/<slug>/append (POST {markdown})\n- Every request needs `Authorization: Bearer <token>` from the Acard app's AI 연결 screen.\n";
}

const SHELL_CSS = `*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:15px/1.65 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#26252c;background:#fff;display:flex}
@media (prefers-color-scheme:dark){body{color:#e8e7ee;background:#1c1b21}nav{background:#232229!important;border-color:#33323a!important}a{color:#a99cf5!important}textarea,input,button{color:inherit;background:#2a2930!important;border-color:#3a3942!important}pre,code{background:#2a2930!important}table td,table th{border-color:#3a3942!important}.muted{color:#9a98a6!important}}
nav{width:260px;flex:none;border-right:1px solid #ececf0;background:#f8f8fa;display:flex;flex-direction:column;height:100%}
nav header{display:flex;align-items:center;gap:8px;padding:16px 16px 8px;font-weight:700}nav header img{height:22px}
nav header small{font-weight:600;color:#6f6c7a;font-size:12px;border:1px solid #d9d8de;border-radius:99px;padding:0 8px}
#tree{flex:1;overflow:auto;padding:4px 8px;margin:0;list-style:none}#tree a{display:block;padding:5px 10px;border-radius:8px;color:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tree a:hover{background:#efeff3}#tree a.on{background:#efecfd;color:#5b47d6}#tree ul{list-style:none;padding-left:14px;margin:0}
nav footer{padding:10px 12px 14px;border-top:1px solid #ececf0;display:grid;gap:4px}
nav footer a,nav footer button{font:inherit;font-size:14px;text-align:left;padding:6px 10px;border-radius:8px;border:0;background:none;color:inherit;cursor:pointer;text-decoration:none}
nav footer a:hover,nav footer button:hover{background:#efeff3}
main{flex:1;overflow:auto;height:100%}article{max-width:760px;margin:0 auto;padding:40px 28px 120px}
.bar{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-bottom:12px}.bar .muted{margin-right:auto;font-size:13px}
button.b{font:inherit;font-size:14px;padding:6px 14px;border-radius:8px;border:1px solid #d9d8de;background:#fff;cursor:pointer}
button.p{background:#6450dc;border-color:#6450dc;color:#fff}
h1.t{font-size:30px;line-height:1.25;margin:0 0 18px}#title{font:700 30px/1.25 inherit;width:100%;border:0;border-bottom:1px solid #ececf0;padding:4px 0;margin:0 0 14px;outline:none;background:none}
#body img{max-width:100%}#body pre{background:#f5f5f7;padding:12px 14px;border-radius:8px;overflow:auto}#body code{font:13px ui-monospace,Consolas,monospace;background:#f5f5f7;padding:1px 4px;border-radius:4px}#body pre code{padding:0;background:none}
#body table{border-collapse:collapse}#body td,#body th{border:1px solid #e3e3e8;padding:6px 10px}#body blockquote{margin:0;padding-left:14px;border-left:3px solid #d9d8de;color:#5f5d69}
#body li.task-list-item{list-style:none;margin-left:-20px;display:flex;gap:8px;align-items:baseline}#body li>p{margin:0}#body li.task-list-item>p{display:inline}#body ul,#body ol{margin:6px 0}
textarea{width:100%;min-height:60vh;font:14px/1.6 ui-monospace,Consolas,monospace;border:1px solid #d9d8de;border-radius:10px;padding:14px;resize:vertical}
.muted{color:#6f6c7a}.msg{min-height:20px;font-size:13px;color:#b42318}.empty{margin-top:20vh;text-align:center}`;

const SHELL_JS = `const $=(id)=>document.getElementById(id);let cur=null,editing=false;
const api=async(path,init={})=>{const r=await fetch(path,{...init,headers:{"content-type":"application/json",...(init.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("실패했어요 ("+r.status+")"));return j};
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const slugOf=()=>{const m=/^\\/(?:edit\\/)?([^/]+)\\/?$/.exec(location.pathname);return m?decodeURIComponent(m[1]):null};
async function tree(){const {pages}=await api("/api/tree");const kids={};for(const p of pages)(kids[p.parent||""]=kids[p.parent||""]||[]).push(p);
const list=(parent)=>(kids[parent]||[]).map((p)=>'<li><a href="/'+encodeURIComponent(p.slug)+'/" data-slug="'+esc(p.slug)+'"'+(cur&&cur.slug===p.slug?' class="on"':'')+'>'+esc((p.icon?p.icon+" ":"")+(p.title||"제목 없음"))+"</a>"+(kids[p.slug]?"<ul>"+list(p.slug)+"</ul>":"")+"</li>").join("");
$("tree").innerHTML=list("");return pages}
function show(){const a=$("page");if(!cur){a.innerHTML='<div class="empty muted"><p>왼쪽에서 페이지를 고르거나 새 페이지를 만들어 보세요.</p></div>';return}
document.title=(cur.title||"Acard")+" - Acard";
if(editing){a.innerHTML='<div class="bar"><span class="muted">마크다운으로 고쳐요. 쓴 그대로 저장돼요.</span><button class="b" id="cancel">취소</button><button class="b p" id="save">저장</button></div><input id="title" aria-label="제목"><textarea id="md" aria-label="본문 마크다운" spellcheck="false"></textarea><div class="msg" id="msg" role="status"></div>';
$("title").value=cur.title;$("md").value=cur.markdown;$("md").focus();$("cancel").onclick=()=>{editing=false;show()};
$("save").onclick=async()=>{try{cur=await api("/__local/lite/page/"+encodeURIComponent(cur.slug),{method:"PUT",body:JSON.stringify({title:$("title").value,markdown:$("md").value,base:cur.updated})});editing=false;show();tree()}catch(e){$("msg").textContent=e.message}};
addEventListener("keydown",function k(e){if((e.ctrlKey||e.metaKey)&&e.key==="s"&&editing){e.preventDefault();$("save").click()}});return}
a.innerHTML='<div class="bar"><span class="muted">'+(cur.kind==="db"?"표는 읽기만 돼요. 고치려면 웹(notes.example.com) 모드를 써요.":"")+'</span><button class="b" id="del">삭제</button>'+(cur.kind==="db"?"":'<button class="b p" id="edit">편집</button>')+'</div><h1 class="t" id="t"></h1><div id="body"></div>';
$("t").textContent=cur.title||"제목 없음";$("body").innerHTML=cur.html;
if($("edit"))$("edit").onclick=()=>{editing=true;show()};
$("del").onclick=async()=>{if(!confirm("이 페이지를 휴지통으로 옮길까요?"))return;await api("/__local/lite/page/"+encodeURIComponent(cur.slug),{method:"DELETE"});cur=null;history.pushState(null,"","/");await tree();show()}}
async function open(slug,push){if(push)history.pushState(null,"","/"+encodeURIComponent(slug)+"/");editing=false;try{cur=await api("/__local/lite/page/"+encodeURIComponent(slug))}catch{cur=null}show();tree()}
async function boot(){const pages=await tree();const s=slugOf();if(s)return open(s,false);if(pages[0])return open(pages[0].slug,true);show()}
document.addEventListener("click",(e)=>{const a=e.target.closest("a[href^='/']");if(!a||a.target||e.ctrlKey||e.metaKey)return;const m=/^\\/([^/]+)\\/$/.exec(a.getAttribute("href"));if(!m||m[1].startsWith("__"))return;e.preventDefault();open(decodeURIComponent(m[1]),true)});
addEventListener("popstate",()=>{const s=slugOf();s?open(s,false):(cur=null,show())});
$("new").onclick=async()=>{const t=prompt("새 페이지 제목","새 페이지");if(t===null)return;const {slug}=await api("/__local/lite/new",{method:"POST",body:JSON.stringify({title:t})});await open(slug,true);editing=true;show()};
let since=0;function live(){const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/api/live?since="+since);
ws.onmessage=async(ev)=>{const m=JSON.parse(ev.data);if(typeof m.id==="number")since=m.id;if(m.type!=="change")return;await tree();if(cur&&!editing&&(!m.slugs||!m.slugs.length||m.slugs.includes(cur.slug)))open(cur.slug,false)};
ws.onclose=()=>setTimeout(live,2000)}
if(navigator.serviceWorker)navigator.serviceWorker.getRegistrations().then((rs)=>rs.forEach((r)=>r.unregister())).catch(()=>{});
boot().then(live);`;

// The light reader/editor page served for every page address (/, /<slug>/, /edit/<slug>/).
export function liteShell(): Response {
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Acard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>' + SHELL_CSS + "</style></head><body>"
    + '<nav><header><img src="/wordmark.svg" alt="Acard"><small>내 컴퓨터</small></header><ul id="tree"></ul><footer>'
    + '<button id="new">+ 새 페이지</button><a href="/__local/skill">AI 연결 (스킬 링크)</a><a href="/__local/cloud">내 데이터 · 백업</a>'
    + '</footer></nav><main><article id="page"></article></main>'
    + "<script>" + SHELL_JS + "</script></body></html>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP } });
}
const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; form-action 'self'; frame-ancestors 'none'";

// /__local/skill: the "Acard 스킬 링크" screen. The token is fetched from /__local/skill/info by this page only.
export function skillPage(): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 연결 · Acard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.6 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#26252c;background:#f6f6f8}
main{max-width:780px;margin:0 auto;padding:28px 20px 80px}a.back{color:#6f6c7a;text-decoration:none;font-size:14px}h1{font-size:26px;margin:12px 0 4px}.lead{color:#5f5d69;margin:0 0 20px}
section{background:#fff;border:1px solid #ececf0;border-radius:14px;padding:20px;margin:0 0 14px}h2{font-size:17px;margin:0 0 4px}section p{margin:4px 0 12px;color:#5f5d69}
.tabs{display:flex;gap:6px;margin:0 0 10px}.tabs button{font:inherit;font-size:13px;padding:4px 12px;border-radius:99px;border:1px solid #d9d8de;background:#fff;cursor:pointer}.tabs button.on{background:#26252c;color:#fff;border-color:#26252c}
.cmd{display:flex;gap:8px;align-items:stretch}.cmd pre{flex:1;margin:0;background:#26252c;color:#f2f1f6;border-radius:10px;padding:12px 14px;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
button.b{font:inherit;font-size:14px;padding:8px 14px;border-radius:10px;border:1px solid #d9d8de;background:#fff;cursor:pointer;white-space:nowrap}button.p{background:#6450dc;border-color:#6450dc;color:#fff}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.msg{min-height:22px;font-size:14px;margin-top:10px}.ok{color:#15803d}.err{color:#b42318}small,.muted{color:#6f6c7a}.welcome{background:#efecfd;border-radius:12px;padding:14px 16px;margin:14px 0 0;color:#3d2fa0}details{margin-top:8px}summary{cursor:pointer;color:#5f5d69}
</style></head><body><main>
<a class="back" href="/" id="back">← 내 페이지로</a>
<p class="welcome" id="welcome" hidden>Acard 를 설치했어요. 문서는 이 컴퓨터에만 저장돼요. 먼저 내 AI 를 붙여 두면 AI 가 쓴 글이 바로 여기 들어와요.</p>
<h1>AI 연결 (아카드 스킬 링크)</h1>
<p class="lead">Claude Code, Codex 같은 내 AI 에 아래 한 줄을 붙이면, AI 가 쓴 마크다운이 이 컴퓨터의 Acard 에 그대로 들어와요. 다듬기나 보정은 하지 않아요.</p>
<section><h2>1. 한 줄 복사해서 터미널에 붙여 넣기</h2>
<p>Claude Code 에 이 컴퓨터의 Acard 를 MCP 서버로 붙여요. 다른 앱은 아래 주소와 헤더를 넣어요.</p>
<div class="tabs" role="tablist"><button data-os="ps">Windows PowerShell</button><button data-os="zsh">macOS · Linux (zsh)</button></div>
<div class="cmd"><pre id="setup"></pre><button class="b p" data-copy="setup">복사</button></div>
<details><summary>Node.js 없이 Claude Code 에만 붙이기</summary><div class="cmd" style="margin-top:8px"><pre id="claude"></pre><button class="b" data-copy="claude">복사</button></div></details>
<details><summary>그 밖의 MCP 앱 (주소와 헤더)</summary><div class="cmd" style="margin-top:8px"><pre id="raw"></pre><button class="b" data-copy="raw">복사</button></div></details>
</section>
<section><h2>2. 연결 확인</h2><p>누르면 이 연결로 "Acard 연결 확인" 페이지를 하나 만들어 봐요. AI 에서 실제로 글을 써 보면 왼쪽 목록에 바로 나타나요.</p>
<div class="row"><button class="b p" id="check">연결 확인</button><span class="muted" id="seen"></span></div><div class="msg" id="msg" role="status"></div></section>
<div class="row" id="later" hidden style="justify-content:flex-end;margin:-4px 0 14px"><a class="b p" href="/" style="text-decoration:none;font-size:15px;padding:10px 18px;border-radius:10px;background:#6450dc;color:#fff">내 페이지로 시작하기 →</a></div>
<section><h2>토큰</h2><p>위 줄에 들어 있는 비밀 값이에요(화면에는 가려져 있고 복사하면 들어가요). 다른 사람에게 보이지 마세요. 새로 만들면 예전 줄로 붙인 AI 는 다시 붙여야 해요.</p>
<div class="row"><button class="b" id="rotate">토큰 새로 만들기</button><small id="port"></small></div></section>
</main><script>
const $=(id)=>document.getElementById(id);let info=null,os=/Mac|Linux|X11/.test(navigator.userAgent)&&!/Windows/.test(navigator.userAgent)?"zsh":"ps";
const call=async(p,i)=>{const r=await fetch(p,i);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("실패했어요 ("+r.status+")"));return j};
const full={};const put=(id,text)=>{full[id]=text;$(id).textContent=text.split(info.token).join(info.token.slice(0,4)+"••••••••")};
function draw(){if(!info)return;const o=info.origin,t=info.token,pkg="--package="+o+"/acard-cli.tgz";
const env=os==="ps"?'$env:ACARD_TOKEN="'+t+'"; ':"ACARD_TOKEN="+t+" ";
put("setup","claude mcp add --transport http --scope user acard-local "+o+'/mcp --header "Authorization: Bearer '+t+'"');
put("claude","claude mcp add --transport http --scope user acard-local "+o+'/mcp --header "Authorization: Bearer '+t+'"');
put("raw","주소: "+o+"/mcp\\n헤더: Authorization: Bearer "+t);
for(const b of document.querySelectorAll("[data-os]"))b.className=b.dataset.os===os?"on":"";
$("port").textContent="이 컴퓨터의 Acard 주소: "+o;$("seen").textContent=info.lastAgentAt?"마지막 AI 접속: "+new Date(info.lastAgentAt).toLocaleString():"아직 AI 가 접속하지 않았어요."}
async function load(){info=await call("/__local/skill/info");draw()}
for(const b of document.querySelectorAll("[data-os]"))b.onclick=()=>{os=b.dataset.os;draw()};
for(const b of document.querySelectorAll("[data-copy]"))b.onclick=async()=>{await navigator.clipboard.writeText(full[b.dataset.copy]||"");const t=b.textContent;b.textContent="복사됨";setTimeout(()=>b.textContent=t,1500)};
$("check").onclick=async()=>{$("msg").className="msg";$("msg").textContent="확인하는 중…";try{const r=await call("/__local/skill/check",{method:"POST"});$("msg").className="msg ok";$("msg").innerHTML='연결이 잘 돼요. <a href="/'+encodeURIComponent(r.slug)+'/">"'+r.title.replace(/[<&]/g,"")+'"</a> 페이지를 만들었어요.';load()}catch(e){$("msg").className="msg err";$("msg").textContent=e.message}};
$("rotate").onclick=async()=>{if(!confirm("토큰을 새로 만들까요? 지금 붙어 있는 AI 는 새 줄로 다시 붙여야 해요."))return;info=await call("/__local/skill/rotate",{method:"POST"});draw()};
if(new URLSearchParams(location.search).get("welcome")){$("welcome").hidden=false;$("later").hidden=false;$("back").textContent="건너뛰기 → 내 페이지"}
load();setInterval(load,5000);
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" } });
}

// /__local/skill/*: info (origin, token, last agent visit), rotate, check (a real MCP create_page through the token).
export async function skillRoute(request: Request, url: URL, tokens: ReturnType<typeof agentTokens>, lastAgentAt: () => number | null): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const info = () => json({ origin: url.origin, token: tokens.get(), lastAgentAt: lastAgentAt() });
  if (url.pathname === "/__local/skill/info" && method === "GET") return info();
  if (url.pathname === "/__local/skill/rotate" && method === "POST") { tokens.rotate(); return info(); }
  if (url.pathname === "/__local/skill/check" && method === "POST") {
    const title = "Acard 연결 확인";
    const res = await fetch(url.origin + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + tokens.get(), accept: "application/json, text/event-stream", "content-type": "application/json", "x-acard-check": "1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_page", arguments: { title, markdown: "AI 연결이 잘 되는지 확인하려고 만든 페이지예요. 지워도 돼요.\n\n- 확인한 때: " + new Date().toISOString() + "\n" } } }),
    }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) as { result?: { isError?: boolean; content?: { text: string }[] } } | null : null;
    const created = data?.result && !data.result.isError ? JSON.parse(data.result.content?.[0]?.text ?? "{}") as { slug?: string } : null;
    return created?.slug ? json({ ok: true, slug: created.slug, title }) : json({ error: "연결을 확인하지 못했어요" + (res ? " (" + res.status + ")" : "") + ". 앱을 다시 켠 뒤 해 보세요." }, 502);
  }
  return null;
}

