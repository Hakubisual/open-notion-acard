// /__local/cloud: the local app's "내 데이터" screen. Backup file out/in, account connect, publish, cloud backups.
export function cloudPage(): Response {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>내 데이터 · Acard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/tokens.css">
<style>
body{margin:0;font-family:var(--font-sans,system-ui,sans-serif);background:var(--bg,#fafaf9);color:var(--fg,#1c1917)}
main{max-width:760px;margin:0 auto;padding:32px 20px 80px}
a.back{color:var(--muted,#78716c);text-decoration:none;font-size:14px}
h1{font-size:26px;margin:14px 0 6px}h2{font-size:18px;margin:0 0 6px}
.lead{color:var(--muted,#78716c);margin:0 0 24px;line-height:1.6}
section{background:var(--surface,#fff);border:1px solid var(--line,#e7e5e4);border-radius:12px;padding:20px;margin:0 0 16px}
section p{margin:6px 0 12px;line-height:1.6;color:var(--muted,#57534e)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,.btn{font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid var(--line,#d6d3d1);background:var(--surface,#fff);color:inherit;cursor:pointer;text-decoration:none}
button.primary{background:var(--accent,#7c3aed);border-color:var(--accent,#7c3aed);color:#fff}
button:disabled{opacity:.5;cursor:default}
select,input[type=file]{font:inherit;font-size:14px;max-width:100%}
select{padding:7px;border-radius:8px;border:1px solid var(--line,#d6d3d1);background:var(--surface,#fff);color:inherit}
.msg{min-height:20px;font-size:14px;margin-top:10px;word-break:break-all}.msg.err{color:#b91c1c}.msg.ok{color:#15803d}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:var(--line,#f5f5f4)}
ul.list{list-style:none;padding:0;margin:8px 0 0}ul.list li{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--line,#f0efee);font-size:14px;flex-wrap:wrap}
ul.list a{color:var(--accent,#7c3aed);word-break:break-all}
.auto{font-size:14px;margin:12px 0 0}.auto strong{color:var(--fg,#1c1917)}
.guide{border-left:3px solid var(--accent,#7c3aed);padding:8px 12px;background:var(--bg,#faf5ff);border-radius:6px}
.guide .incl{margin:4px 0 8px;padding-left:20px;line-height:1.7}.guide a{color:var(--accent,#7c3aed)}
</style></head><body><main>
<a class="back" href="/">← 내 페이지로</a>
<h1>내 데이터</h1>
<p class="lead">문서는 이 PC 에 저장돼요. 가입 없이 계속 무료로 쓸 수 있고, 백업 파일 하나로 언제든 옮길 수 있어요.</p>

<section id="local"><h2>백업 파일</h2>
<p>모든 페이지·이미지·설정을 zip 파일 하나로 저장해요. 다른 PC 의 Acard 에서 "백업 파일로 복원"으로 그대로 열려요.</p>
<div class="row"><a class="btn" id="export" href="/__local/archive/export" download>백업 파일 내려받기</a>
<label class="btn" for="file">백업 파일로 복원…</label><input id="file" type="file" accept=".zip,application/zip" hidden></div>
<p class="auto" id="auto-line">자동 백업 확인 중…</p>
<div class="msg" id="local-msg" role="status"></div></section>

<section id="agents"><h2>AI 에이전트 연결 (로컬 MCP)</h2>
<p>MCP 를 쓰는 AI 에이전트를 이 PC 의 문서에 연결해요. 아래 주소를 MCP 서버로 추가하면 돼요.</p>
<div class="row"><code id="mcp-url"></code><button id="copy-mcp">복사</button></div>
<p style="font-size:13px">Claude Code: <code id="mcp-cmd"></code><br>Codex: <code id="mcp-cmd-codex"></code></p></section>

<section id="account" hidden><h2>notes.example.com 연결 <span class="badge" id="state">확인 중</span></h2>
<p id="account-text">연결하면 웹에 게시하고, 클라우드에 백업할 수 있어요. 로그인은 브라우저에서 해요.</p>
<div class="row" id="account-actions"></div>
<div class="guide" id="guide" hidden></div>
<div class="msg" id="account-msg" role="status"></div></section>

<section id="publish" hidden><h2>웹에 게시</h2>
<p>고른 페이지와 그 아래 페이지, 들어 있는 이미지를 공개 링크로 올려요. 원본은 이 PC 에 그대로 있어요.</p>
<div class="row"><select id="page" aria-label="게시할 페이지"></select><button class="primary" id="do-publish">게시</button></div>
<ul class="list" id="pubs"></ul><div class="msg" id="publish-msg" role="status"></div></section>

<section id="sync" hidden><h2>여러 기기 동기화 <span class="badge" id="sync-state">꺼짐</span></h2>
<p>같은 notes.example.com 계정에 연결한 다른 PC 와 페이지를 자동으로 맞춰요. 같은 곳을 두 PC 에서 동시에 고치면 나중에 고친 쪽이 남고, 다른 쪽 내용은 "충돌 사본" 페이지로 남아요.</p>
<div class="row"><button class="primary" id="sync-toggle">동기화 켜기</button><button id="sync-now" hidden>지금 맞추기</button></div>
<p class="auto" id="sync-line"></p><div class="msg" id="sync-msg" role="status"></div></section>

<section id="cloud" hidden><h2>클라우드 백업</h2>
<p>백업 파일을 notes.example.com 에 올려 두고, 새 PC 에서 받아 복원해요. 최근 몇 개만 남아요.</p>
<div class="row"><button class="primary" id="do-backup">지금 백업 올리기</button><button id="do-import">notes.example.com 데이터 가져오기</button></div>
<ul class="list" id="backups"></ul><div class="msg" id="cloud-msg" role="status"></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const say = (id, text, ok) => { const m = $(id); m.textContent = text || ""; m.className = "msg " + (ok === true ? "ok" : ok === false ? "err" : ""); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function call(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error === "subscription_required" ? "구독이 필요해요. 아래 안내에서 구독하면 무엇이 열리는지 볼 수 있어요." : data.error || "실패했어요 (" + res.status + ")"), { data, status: res.status });
  return data;
}
function confirmRestore(what) { return confirm(what + "\\n\\n지금 데이터는 먼저 backups 폴더에 저장한 뒤 바꿔요. 계속할까요?"); }
$("file").onchange = async () => {
  const file = $("file").files[0]; $("file").value = "";
  if (!file || !confirmRestore(file.name + " 으로 복원할까요?")) return;
  say("local-msg", "복원하는 중…");
  try { const r = await call("/__local/archive/import", { method: "POST", body: file }); say("local-msg", "복원했어요. 페이지 " + (r.tables.pages ?? 0) + "개, 파일 " + r.media + "개.", true); }
  catch (e) { say("local-msg", e.message, false); }
};
function guide(g) {
  const box = $("guide");
  if (!g) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = "<strong>" + esc(g.title) + "</strong><p>" + esc(g.text) + "</p>"
    + (Array.isArray(g.includes) ? '<ul class="incl">' + g.includes.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" : "")
    + "<p>" + esc(g.price) + " · " + esc(g.contact) + "</p>"
    + (g.compareUrl ? '<p><a href="' + esc(g.compareUrl) + '" target="_blank" rel="noopener">노션·옵시디언과 비교 →</a></p>' : "")
    + (g.checkout ? '<div class="row"><button class="primary" id="subscribe">구독하기</button></div>' : "");
  if (g.checkout) $("subscribe").onclick = subscribe;
}
// The checkout opens in the system browser (the desktop window sends outside addresses there); this page then watches
// the subscription and turns publish on when the payment webhook has arrived.
async function subscribe() {
  say("account-msg", "결제 화면을 여는 중…");
  try {
    const r = await call("/__local/cloud/checkout", { method: "POST" });
    window.open(r.url, "_blank", "noopener");
    say("account-msg", "브라우저에서 결제를 마치면 이 화면에서 게시가 바로 켜져요.");
    waitSubscribed();
  } catch (e) { say("account-msg", e.message, false); }
}
function waitSubscribed() {
  const until = Date.now() + 30 * 60_000;
  const timer = setInterval(async () => {
    if (Date.now() > until) return clearInterval(timer);
    const s = await call("/__local/cloud/status").catch(() => null);
    if (s && s.account && s.account.subscription && s.account.subscription.active) { clearInterval(timer); say("account-msg", "구독이 켜졌어요. 이제 게시할 수 있어요.", true); refresh().catch((e) => say("account-msg", e.message, false)); }
  }, 3000);
}
async function loadPages() {
  const tree = await call("/api/tree");
  const rows = (tree.pages || tree.tree || tree || []).filter ? (tree.pages || tree.tree || tree) : [];
  $("page").innerHTML = rows.filter((p) => p.kind !== "db_row").map((p) => '<option value="' + esc(p.slug) + '">' + esc(p.title || p.slug) + "</option>").join("");
}
async function loadPubs() {
  const r = await call("/__local/cloud/publications");
  $("pubs").innerHTML = (r.publications || []).map((p) => "<li><span>" + esc(p.title) + ' <span class="badge">' + esc(p.status === "live" ? "공개 중" : p.status === "taken_down" ? "운영자가 내림" : "내림") + "</span></span>"
    + (p.status === "live" ? '<span><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.url) + '</a> <button data-unpub="' + esc(p.slug) + '">내리기</button></span>' : "") + "</li>").join("") || "<li>아직 게시한 페이지가 없어요.</li>";
}
async function loadBackups() {
  const r = await call("/__local/cloud/backups");
  $("backups").innerHTML = (r.backups || []).map((b) => "<li><span>" + esc(b.name) + " · " + Math.ceil(b.bytes / 1024) + 'KB</span><button data-restore="' + esc(b.name) + '">이 백업으로 복원</button></li>').join("") || "<li>올린 백업이 없어요.</li>";
}
async function refresh() {
  const s = await call("/__local/cloud/status");
  const actions = $("account-actions");
  if (!s.enabled) { $("account").hidden = true; $("publish").hidden = $("cloud").hidden = $("sync").hidden = true; return; }
  $("account").hidden = false;
  if (!s.connected) {
    $("state").textContent = s.expired ? "다시 연결 필요" : "연결 안 됨";
    actions.innerHTML = '<button class="primary" id="connect">notes.example.com 연결</button>';
    $("connect").onclick = async () => {
      try { const r = await call("/__local/cloud/connect", { method: "POST" }); say("account-msg", "브라우저에서 로그인하고 허용을 누르면 이 화면으로 돌아와요."); location.href = r.authorizeUrl; waitConnected(); }
      catch (e) { say("account-msg", e.message, false); }
    };
    $("publish").hidden = $("cloud").hidden = $("sync").hidden = true; guide(null); return;
  }
  const account = s.account || {};
  const sub = account.subscription || {};
  $("state").textContent = sub.active ? "구독 중" : sub.status === "grace" ? "만료 유예" : "연결됨";
  $("account-text").textContent = (s.email || account.email || "notes.example.com 계정") + " 에 연결돼 있어요." + (sub.until ? " 구독 기간: " + sub.until.slice(0, 10) + " 까지" : "");
  actions.innerHTML = '<button id="disconnect">연결 끊기</button>' + (sub.manageUrl ? ' <a class="btn" id="manage" target="_blank" rel="noopener">구독 관리</a>' : "");
  if (sub.manageUrl) $("manage").href = sub.manageUrl;
  $("disconnect").onclick = async () => { await call("/__local/cloud/disconnect", { method: "POST" }); refresh(); };
  guide(account.guide);
  $("publish").hidden = $("cloud").hidden = $("sync").hidden = false;
  $("do-publish").disabled = $("do-backup").disabled = !sub.active;
  if (!sub.active) { say("publish-msg", "구독하면 게시할 수 있어요. 무엇이 열리는지는 위 안내에 있어요."); say("cloud-msg", "구독하면 클라우드에 백업할 수 있어요."); }
  syncActive = Boolean(sub.active); loadSync();
  await Promise.all([loadPages(), loadPubs().catch((e) => say("publish-msg", e.message, false)), loadBackups().catch((e) => say("cloud-msg", e.message, false))]);
}
$("do-publish").onclick = async () => {
  say("publish-msg", "올리는 중…");
  try { const r = await call("/__local/cloud/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: $("page").value }) }); say("publish-msg", "게시했어요: " + r.url, true); loadPubs(); }
  catch (e) { say("publish-msg", e.message, false); if (e.data && e.data.guide) { guide(e.data.guide); $("guide").scrollIntoView({ block: "center" }); } }
};
$("pubs").onclick = async (ev) => {
  const slug = ev.target.dataset && ev.target.dataset.unpub; if (!slug || !confirm("게시를 내릴까요? 원본은 그대로 있어요.")) return;
  try { await call("/__local/cloud/publish/" + encodeURIComponent(slug), { method: "DELETE" }); say("publish-msg", "내렸어요.", true); loadPubs(); } catch (e) { say("publish-msg", e.message, false); }
};
$("do-backup").onclick = async () => {
  say("cloud-msg", "올리는 중…");
  try { const r = await call("/__local/cloud/backups", { method: "POST" }); say("cloud-msg", "올렸어요: " + r.name, true); loadBackups(); } catch (e) { say("cloud-msg", e.message, false); }
};
$("backups").onclick = async (ev) => {
  const name = ev.target.dataset && ev.target.dataset.restore; if (!name || !confirmRestore(name + " 으로 복원할까요?")) return;
  say("cloud-msg", "내려받아 복원하는 중…");
  try { const r = await call("/__local/cloud/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); say("cloud-msg", "복원했어요. 페이지 " + (r.tables.pages ?? 0) + "개.", true); } catch (e) { say("cloud-msg", e.message, false); }
};
$("do-import").onclick = async () => {
  if (!confirmRestore("notes.example.com 에 있는 내 데이터로 이 PC 의 데이터를 바꿀까요?")) return;
  say("cloud-msg", "notes.example.com 에서 내려받는 중…");
  try { const r = await call("/__local/cloud/import-cloud", { method: "POST" }); say("cloud-msg", "가져왔어요. 페이지 " + (r.tables.pages ?? 0) + "개.", true); } catch (e) { say("cloud-msg", e.message, false); }
};
const when = (ms) => { const d = new Date(ms), now = new Date(); const hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }); return d.toDateString() === now.toDateString() ? "오늘 " + hm : (d.getMonth() + 1) + "월 " + d.getDate() + "일 " + hm; };
const every = (ms) => ms >= 86400000 ? "하루에 한 번" : ms >= 3600000 ? Math.round(ms / 3600000) + "시간마다" : Math.max(1, Math.round(ms / 60000)) + "분마다";
async function loadAuto() {
  const a = await call("/__local/archive/auto").catch(() => null);
  if (!a) return;
  const local = a.local && !a.local.error ? "<strong>마지막 백업: " + esc(when(a.local.at)) + "</strong>" : a.local && a.local.error ? "마지막 백업 실패: " + esc(a.local.error) : "아직 자동 백업이 없어요";
  const cloud = a.cloud && a.cloud.name ? " · 클라우드: " + esc(when(a.cloud.at)) : "";
  $("auto-line").innerHTML = local + cloud + "<br>" + esc(every(a.intervalMs)) + " 이 PC 의 backups 폴더에 저장하고 최근 " + a.keep + "개를 남겨요." + (a.cloud && a.cloud.name ? " 구독 중이면 클라우드에도 올려요." : "");
}
loadAuto(); setInterval(loadAuto, 30000);
let syncActive = false, syncOn = false;
async function loadSync() {
  const s = await call("/__local/cloud/sync").catch(() => null);
  if (!s) return;
  syncOn = s.enabled;
  $("sync-state").textContent = s.enabled ? (s.last && s.last.error ? "오류" : "켜짐") : "꺼짐";
  $("sync-toggle").textContent = s.enabled ? "동기화 끄기" : "동기화 켜기";
  $("sync-toggle").className = s.enabled ? "" : "primary";
  $("sync-toggle").disabled = !s.enabled && !syncActive;
  $("sync-now").hidden = !s.enabled;
  const last = s.last ? (s.last.error ? "마지막 동기화 실패: " + esc(s.last.error) : "<strong>마지막 동기화: " + esc(when(s.last.at)) + "</strong> · 받은 페이지 " + s.last.pulled + "개, 보낸 페이지 " + s.last.pushed + "개") : (s.enabled ? "곧 처음 맞춰요…" : (syncActive ? "켜면 " + Math.round(s.intervalMs / 1000) + "초마다 맞춰요." : "구독 중인 계정에서 켤 수 있어요."));
  // #136: every PC shows the same count - a conflict found on one PC reaches the others with its page.
  const recent = (s.recent || []).map((c) => '<li><a href="/edit/' + esc(encodeURIComponent(c.copy || c.slug)) + '">' + esc(c.title) + "</a> · " + esc(when(c.at)) + (c.copy ? " · 다른 쪽 내용은 '(충돌 사본)'에 있어요" : " · 나중에 고친 값이 남았어요") + "</li>").join("");
  $("sync-line").innerHTML = last + (s.conflicts ? "<br><strong>충돌 " + s.conflicts + "건</strong> · 같은 곳을 두 PC 에서 고친 곳이에요. 최근 충돌:<ul class='list'>" + recent + "</ul>" : "");
}
$("sync-toggle").onclick = async () => {
  say("sync-msg", syncOn ? "끄는 중…" : "켜고 처음 맞추는 중…");
  try { await call("/__local/cloud/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !syncOn }) }); say("sync-msg", syncOn ? "껐어요." : "켰어요.", true); } catch (e) { say("sync-msg", e.message, false); }
  loadSync();
};
$("sync-now").onclick = async () => { say("sync-msg", "맞추는 중…"); try { await call("/__local/cloud/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now: true }) }); say("sync-msg", "", true); } catch (e) { say("sync-msg", e.message, false); } loadSync(); };
setInterval(() => { if (!$("sync").hidden) loadSync(); }, 10000);
$("mcp-url").textContent = location.origin + "/mcp";
$("mcp-cmd").textContent = "claude mcp add --transport http acard " + location.origin + "/mcp";
$("mcp-cmd-codex").textContent = "codex mcp add acard --url " + location.origin + "/mcp";
$("copy-mcp").onclick = () => navigator.clipboard.writeText(location.origin + "/mcp").then(() => { $("copy-mcp").textContent = "복사됨"; });
// The desktop app opens the login in the system browser and stays on this page, so it watches for the callback.
function waitConnected() {
  const until = Date.now() + 15 * 60_000;
  const timer = setInterval(async () => {
    if (Date.now() > until) return clearInterval(timer);
    const s = await call("/__local/cloud/status").catch(() => null);
    if (s && s.connected) { clearInterval(timer); say("account-msg", "연결했어요.", true); refresh().catch((e) => say("account-msg", e.message, false)); }
  }, 2000);
}
if (new URLSearchParams(location.search).get("connected")) say("account-msg", "연결했어요. 이 창을 닫고 Acard 앱으로 돌아가도 돼요.", true);
refresh().catch((e) => say("account-msg", e.message, false));
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" } });
}
