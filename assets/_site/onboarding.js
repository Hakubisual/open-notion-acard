const T = (k) => (window.ACARD_T || {})[k] || k;
const $ = (id) => document.getElementById(id);
const step1 = $("step1"), step2 = $("step2");
const nameIn = $("display_name"), handleIn = $("handle"), state = $("handle-state");
let handleOk = false, checkSeq = 0, timer;

const show = (form, kind, text) => { const m = form.querySelector(".msg"); m.className = `msg ${kind}`; m.textContent = text; };

function paintAvatar(url, name) {
  const a = $("avatar");
  if (url) { a.style.backgroundImage = `url("${url}")`; a.textContent = ""; $("avatar-cap").textContent = T("js.onb.google"); }
  else { a.style.backgroundImage = ""; a.textContent = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "A").toUpperCase(); $("avatar-cap").textContent = T("js.onb.initial"); }
}
let avatarUrl = null;

// Required consents (#166): "agree to all" ticks every box, and the ticked values travel as body.consent; the server
// refuses a request without them, so this only saves a round trip.
const wireConsent = (box) => {
  if (!box) return () => [];
  const all = box.querySelector("[data-consent-all]");
  const items = [...box.querySelectorAll('input[name="consent"]')];
  all.addEventListener("change", () => items.forEach((i) => { i.checked = all.checked; }));
  items.forEach((i) => i.addEventListener("change", () => { all.checked = items.every((x) => x.checked); }));
  return () => (box.hidden || items.some((i) => !i.checked) ? null : items.map((i) => i.value));
};
const consentBox = step1.querySelector(".consent");
const consent = wireConsent(consentBox);
// Ticks made on the sign-up page before Google sign-in (assets/_site/auth.js); without them the box is shown here.
let carried = null;
try { carried = JSON.parse(sessionStorage.getItem("acard-signup-consent") || "null"); } catch {}

function goto(n) {
  step1.hidden = n !== 1; step2.hidden = n !== 2; $("step3").hidden = n !== 3;
  $("back").hidden = n !== 2;
  $("step-no").textContent = `${n} / 3`;
  $("bar2").classList.toggle("on", n >= 2);
  $("bar3").classList.toggle("on", n === 3);
  scrollTo(0, 0);
  if (n === 3) startConnect();
}

const MCP = location.origin + "/mcp";
const AGENTS = [
  { id: "claude", name: "Claude Code", code: `claude mcp add --transport http acard ${MCP}`, ok: true },
  { id: "codex", name: "Codex", code: `codex mcp add acard --url ${MCP}`, verified: true },
  { id: "cursor", name: "Cursor", file: "~/.cursor/mcp.json", code: JSON.stringify({ mcpServers: { acard: { url: MCP } } }) },
  { id: "desktop", name: "Claude Desktop", code: MCP },
  { id: "omo", name: "OMO", file: "~/.omo/agent/mcp.json", code: JSON.stringify({ mcpServers: { acard: { type: "http", url: MCP } } }) },
  { id: "opencode", name: "opencode", file: "opencode.json", code: JSON.stringify({ mcp: { acard: { type: "remote", url: MCP } } }) },
  { id: "gemini", name: "Gemini CLI", code: `gemini mcp add --transport http acard ${MCP}` },
  { id: "vscode", name: "VS Code", code: `code --add-mcp '${JSON.stringify({ name: "acard", type: "http", url: MCP })}'` },
];
const ICONS = {"claude":"<path d=\"m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z\" fill=\"#D97757\"/>","cursor":"<path d=\"M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23\" fill=\"currentColor\"/>","gemini":"<path d=\"M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81\" fill=\"#8E75B2\"/>","opencode":"<path d=\"M22 24H2V0h20zM17 4.8H7v14.4h10z\" fill=\"currentColor\"/>","codex":"<circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"m8 10 3 2-3 2M13 15h3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>","omo":"<circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"currentColor\"/><circle cx=\"9\" cy=\"12\" r=\"1.6\" fill=\"var(--bg,#fff)\"/><circle cx=\"15\" cy=\"12\" r=\"1.6\" fill=\"var(--bg,#fff)\"/>","vscode":"<path d=\"M17 3 8 11.5 4 8.5 2.5 9.5v5L4 15.5l4-3L17 21l4.5-2V5Z\" fill=\"#2f80d1\"/><path d=\"M17 7.5 10.5 12 17 16.5Z\" fill=\"var(--bg,#fff)\"/>"};
let picked = AGENTS[0], pollTimer = null, waitSince = 0, connected = false;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function pick(a) {
  picked = a;
  for (const b of $("agents").children) b.setAttribute("aria-checked", String(b.dataset.id === a.id));
  $("cmd").textContent = a.code;
  $("term-file").textContent = a.file ?? "terminal";
  const steps = a.ok ? ["js.onb.s3.c1", "js.onb.s3.c2", "js.onb.s3.c3"] : [a.file ? "js.onb.s3.g1file" : "js.onb.s3.g1", "js.onb.s3.g2", "js.onb.s3.g3"];
  $("how").innerHTML = steps.map((k) => `<li>${esc(T(k))}</li>`).join("");
  $("unverified").hidden = !!(a.ok || a.verified);
}

function showConnected(s) {
  connected = true;
  $("wait").hidden = true; $("tips").hidden = true; $("stuck").hidden = true; $("skip3").hidden = true; $("done").hidden = false;
  $("done-text").textContent = T("js.onb.connected").replace("{client}", s.client || picked.name);
  if (s.pages && s.pages.length) {
    $("done-sub").textContent = T("js.onb.projectStarted").replace("{project}", s.project || "");
    $("made").innerHTML = s.pages.map((p) => `<li><a href="/${encodeURIComponent(p.slug)}/">${esc(p.title)}</a></li>`).join("");
  }
}

async function poll() {
  try {
    const r = await fetch("/api/first-run", { cache: "no-store" });
    if (r.ok) {
      const s = await r.json();
      if (s.connectedAt) showConnected(s);
      if (s.state === "project_set") { clearInterval(pollTimer); pollTimer = null; }
    }
  } catch {}
  if (!connected && Date.now() - waitSince > 60000) $("tips").hidden = false;
}

function startConnect() {
  if (pollTimer) return;
  waitSince = Date.now();
  setTimeout(() => { if (!connected) $("stuck").hidden = false; }, 20000);
  fetch("/api/first-run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "waiting_connect" }) }).catch(() => {});
  poll();
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, 2000);
}

for (const a of AGENTS) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "agent"; b.dataset.id = a.id; b.setAttribute("role", "radio");
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[({ claude: "claude", codex: "codex", cursor: "cursor", desktop: "claude", omo: "omo", opencode: "opencode", gemini: "gemini", vscode: "vscode" })[a.id]] + "</svg>";
  b.append(a.name);
  b.addEventListener("click", () => pick(a));
  $("agents").appendChild(b);
}
pick(AGENTS[0]);
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(picked.code); $("copy").lastChild.textContent = T("js.onb.copied"); }
  catch { getSelection().selectAllChildren($("cmd")); }
  setTimeout(() => { $("copy").lastChild.textContent = T("js.onb.copy"); }, 1800);
});
for (const id of ["later", "skip3"]) $(id).addEventListener("click", () => { navigator.sendBeacon?.("/api/first-run", new Blob([JSON.stringify({ state: "dismissed" })], { type: "application/json" })); });

async function checkHandle() {
  const h = handleIn.value.trim().toLowerCase();
  const seq = ++checkSeq;
  handleOk = false;
  if (!h) { state.className = "handle-state"; state.textContent = ""; return; }
  const res = await fetch(`/api/handle?h=${encodeURIComponent(h)}`);
  const body = await res.json().catch(() => ({}));
  if (seq !== checkSeq) return;
  handleOk = body.status === "ok";
  state.className = `handle-state ${handleOk ? "ok" : "err"}`;
  state.textContent = body.message ?? T("js.onb.handleFail");
}

handleIn.addEventListener("input", () => {
  handleIn.value = handleIn.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  clearTimeout(timer); timer = setTimeout(checkHandle, 300);
});
nameIn.addEventListener("input", () => { if (!avatarUrl) paintAvatar(null, nameIn.value); });

async function save(payload, form) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { show(form, "err", body.message ?? T("js.onb.saveFail")); return false; }
    return true;
  } catch { show(form, "err", T("js.network")); return false; }
  finally { btn.disabled = false; }
}

step1.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!nameIn.value.trim()) { show(step1, "err", T("js.onb.nameReq")); nameIn.focus(); return; }
  clearTimeout(timer); await checkHandle();
  if (!handleOk) { handleIn.focus(); return; }
  const payload = { display_name: nameIn.value, handle: handleIn.value };
  if (!consentBox.hidden) {
    payload.consent = consent();
    if (!payload.consent) { show(step1, "err", T("js.consent.required")); return; }
  } else if (carried) payload.consent = carried;
  if (await save(payload, step1)) { try { sessionStorage.removeItem("acard-signup-consent"); } catch {} goto(2); }
});

const ORDER = ["board", "progress", "blog", "notes"];
async function finish(presets, next) {
  const btn = step2.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (presets.length) {
      const res = await fetch("/api/home/starter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ presets: presets.filter((p) => p !== "progress") }) });
      if (!res.ok) { show(step2, "err", T("js.onb.saveFail")); return; }
    }
    const widgets = ORDER.filter((k) => presets.includes(k));
    if (await save({ home_layout: { widgets }, finish: true }, step2)) next ? location.assign(next) : goto(3);
  } catch { show(step2, "err", T("js.network")); }
  finally { btn.disabled = false; }
}
step2.addEventListener("submit", (e) => {
  e.preventDefault();
  const picked = [...step2.querySelectorAll("input[name=preset]:checked")].map((i) => i.value);
  if (!picked.length) { show(step2, "err", T("js.onb.pick")); return; }
  finish(picked);
});
$("skip").addEventListener("click", () => finish([]));
$("import").addEventListener("click", (e) => { e.preventDefault(); finish([], "/import"); });
$("back").addEventListener("click", () => goto(1));

(async () => {
  const res = await fetch("/api/profile");
  if (res.status === 401) { location.replace("/login"); return; }
  if (!res.ok) { location.replace("/?gate=error"); return; }
  const { profile, suggest, consent_needed } = await res.json();
  consentBox.hidden = !consent_needed || Array.isArray(carried);
  if (new URLSearchParams(location.search).get("step") === "connect" && profile?.onboarded_at) { goto(3); return; }
  const src = profile ?? suggest;
  avatarUrl = src.avatar_url;
  nameIn.value = src.display_name ?? "";
  handleIn.value = src.handle ?? "";
  paintAvatar(avatarUrl, nameIn.value);
  for (const w of profile?.home_layout?.widgets ?? []) { const box = step2.querySelector(`input[value="${w}"]`); if (box) box.checked = true; }
  if (handleIn.value) checkHandle();
})();
