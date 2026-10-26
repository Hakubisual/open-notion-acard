const $ = (id) => document.getElementById(id);
const form = $("step1"), nameIn = $("display_name"), handleIn = $("handle"), state = $("handle-state");
const msg = form.querySelector(".msg");
const show = (kind, text) => { msg.className = `msg ${kind}`; msg.textContent = text; };
let seq = 0, timer, original = "", myEmail = "";

async function checkHandle() {
  const h = handleIn.value.trim().toLowerCase();
  const my = ++seq;
  if (!h) { state.className = "handle-state"; state.textContent = ""; return false; }
  const body = await (await fetch(`/api/handle?h=${encodeURIComponent(h)}`)).json().catch(() => ({}));
  if (my !== seq) return false;
  const ok = body.status === "ok";
  state.className = `handle-state ${ok ? "ok" : "err"}`;
  state.textContent = h === original && ok ? "지금 쓰는 주소예요" : body.message ?? "주소를 확인하지 못했어요.";
  return ok;
}

handleIn.addEventListener("input", () => {
  handleIn.value = handleIn.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
  clearTimeout(timer); timer = setTimeout(checkHandle, 300);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearTimeout(timer);
  if (!(await checkHandle())) { handleIn.focus(); return; }
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: nameIn.value, handle: handleIn.value, lang: $("lang").value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { show("err", body.message ?? "저장하지 못했어요."); return; }
    original = body.profile.handle;
    show("ok", "저장했어요.");
    if ($("lang").value !== (window.ACARD_LANG || "ko")) location.reload();
  } catch { show("err", "네트워크 연결을 확인해 주세요."); }
  finally { btn.disabled = false; }
});

(async () => {
  const res = await fetch("/api/profile");
  if (res.status === 401) { location.replace("/login"); return; }
  if (!res.ok) { show("err", "프로필을 불러오지 못했어요. 잠시 후 다시 열어 주세요."); return; }
  const { email, profile } = await res.json();
  if (!profile) { location.replace("/onboarding"); return; }
  $("me-email").textContent = myEmail = email || "";
  nameIn.value = profile.display_name;
  handleIn.value = original = profile.handle;
  $("lang").value = profile.lang || window.ACARD_LANG || "ko";
  const a = $("avatar");
  if (profile.avatar_url) a.style.backgroundImage = `url("${profile.avatar_url}")`;
  else a.textContent = profile.display_name.trim()[0]?.toUpperCase() ?? "A";
  const saved = profile.home_layout?.widgets ?? [];
  homeOn = new Set(saved);
  homeOrder = [...saved, ...homeOrder.filter((k) => !saved.includes(k))];
  paintHome();
  checkHandle();
})();

const HOME_NAMES = { board: "작업 보드", progress: "진행 현황", blog: "블로그", notes: "작업 노트" };
let homeOrder = ["board", "progress", "blog", "notes"], homeOn = new Set();
function paintHome() {
  const list = $("home-widgets");
  list.innerHTML = "";
  homeOrder.forEach((k, i) => {
    const li = document.createElement("li");
    li.className = homeOn.has(k) ? "on" : "";
    li.dataset.k = k;
    li.innerHTML = `<label><input type="checkbox" ${homeOn.has(k) ? "checked" : ""}><span>${HOME_NAMES[k]}</span></label><button type="button" data-move="-1" aria-label="위로" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" data-move="1" aria-label="아래로" ${i === homeOrder.length - 1 ? "disabled" : ""}>↓</button>`;
    list.append(li);
  });
}
$("home-widgets").addEventListener("change", (e) => { const k = e.target.closest("li").dataset.k; e.target.checked ? homeOn.add(k) : homeOn.delete(k); paintHome(); });
$("home-widgets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-move]"); if (!b) return;
  const i = homeOrder.indexOf(b.closest("li").dataset.k), j = i + Number(b.dataset.move);
  [homeOrder[i], homeOrder[j]] = [homeOrder[j], homeOrder[i]]; paintHome();
});
$("home-save").addEventListener("click", async () => {
  const msg = $("home-msg"), btn = $("home-save");
  const widgets = homeOrder.filter((k) => homeOn.has(k));
  btn.disabled = true;
  try {
    const add = widgets.filter((k) => k !== "progress");
    if (add.length) { const r = await fetch("/api/home/starter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ presets: add }) }); if (!r.ok) throw r; }
    const res = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ home_layout: { widgets } }) });
    if (!res.ok) throw res;
    msg.className = "msg ok"; msg.textContent = "홈을 저장했어요.";
  } catch { msg.className = "msg err"; msg.textContent = "저장하지 못했어요."; }
  finally { btn.disabled = false; }
});

// 사이드바 보기 (#16): saved right away on the workspace; the sidebar reads it with its tree.
const sideViews = $("side-views"), sideMsg = $("side-view-msg");
const paintView = (v) => sideViews.querySelectorAll("label").forEach((l) => { const i = l.querySelector("input"); i.checked = i.value === v; l.classList.toggle("on", i.checked); });
fetch("/api/folders/view").then((r) => (r.ok ? r.json() : null)).then((d) => paintView(d?.view ?? "project")).catch(() => paintView("project"));
sideViews.addEventListener("change", async (e) => {
  const view = e.target.value;
  paintView(view);
  try {
    const r = await fetch("/api/folders/view", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ view }) });
    if (!r.ok) throw r;
    sideMsg.className = "msg ok"; sideMsg.textContent = "저장했어요.";
  } catch { sideMsg.className = "msg err"; sideMsg.textContent = "저장하지 못했어요."; }
});

const guideMsg = $("guide-msg");
const postGuide = async (action) => {
  const r = await fetch("/api/guide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  if (!r.ok) throw r;
  return r.json();
};
const guideFail = () => { guideMsg.className = "msg err"; guideMsg.textContent = "저장하지 못했어요."; };
fetch("/api/guide").then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !d.enabled) return;
  $("guide-state").textContent = d.done ? "시작 가이드를 모두 마쳤어요." : d.active && !d.hidden ? d.count + " / 4 완료" : "처음 쓰는 화면을 짧게 다시 안내해요.";
  $("guide-hide").hidden = !(d.active && !d.done);
  $("guide").hidden = false;
}).catch(() => {});
$("guide-restart").addEventListener("click", async () => {
  const btn = $("guide-restart");
  btn.disabled = true;
  try { await postGuide("restart"); location.assign(document.querySelector(".onb-back")?.getAttribute("href") || "/home/"); } catch { btn.disabled = false; guideFail(); }
});
$("guide-hide").addEventListener("click", async () => {
  try {
    await postGuide("hide");
    guideMsg.className = "msg ok"; guideMsg.textContent = "홈에서 가이드를 숨겼어요.";
    $("guide-hide").hidden = true;
  } catch { guideFail(); }
});

fetch("/api/media-usage").then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || typeof d.used !== "number") return;
  const mb = (n) => (n / 1e6 < 10 ? (n / 1e6).toFixed(1) : Math.round(n / 1e6).toLocaleString("ko-KR")) + "MB";
  const size = (n) => (n >= 1e9 ? Number((n / 1e9).toFixed(1)) + "GB" : mb(n));
  const tier = { free: "무료", beta: "베타", pass: "무료이용권", paid: "구독" }[d.tier];
  $("media-usage-used").textContent = (d.quota ? size(d.used) + " / " + size(d.quota) + " 사용 중" : size(d.used) + " 사용 중") + (tier ? " · " + tier + " 한도" : "");
  $("media-usage").dataset.tier = d.tier || "";
  $("media-usage-bar").style.width = d.quota ? Math.min(100, (d.used / d.quota) * 100).toFixed(1) + "%" : "0%";
  $("media-usage-rule").textContent = "아이콘·표지 이미지는 png, jpg, webp, gif, avif 로 한 장에 " + mb(d.fileLimit) + " 까지 올릴 수 있어요.";
  $("media-usage").hidden = false;
}).catch(() => {});

fetch("/api/cloud/plan").then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !Array.isArray(d.includes)) return;
  const until = d.until ? new Date(d.until).toLocaleDateString("ko-KR") : "";
  const discount = d.pending && d.pending.kind === "discount";
  const pending = d.pending ? (discount ? "정식 오픈시 PRO 6개월 50% 할인" : "정식 오픈시 PRO 1개월 무료") : "";
  const state = pending || (d.comp ? { active: "PRO 무료이용권", grace: "무료이용권 끝남 · 유예 기간" }[d.status] : { active: "구독 중", grace: "구독 끝남 · 유예 기간", expired: "구독 끝남", none: "무료 (로컬판·웹 베타)" }[d.status]);
  const span = (text) => { const s = document.createElement("span"); s.textContent = text; return s; };
  $("plan-state").replaceChildren(span(state || "무료 (로컬판·웹 베타)"), ...(d.status === "active" && until ? [span(" · "), span(until + "까지")] : []));
  $("plan").dataset.comp = d.comp ? "1" : "";
  $("plan-includes").replaceChildren(...d.includes.map((text) => { const li = document.createElement("li"); li.textContent = text; return li; }));
  $("plan-note").replaceChildren(span(discount ? "정식 오픈 후 구독할 때 적용돼요." : d.pending ? "베타가 끝나면 자동으로 열려요." : (d.comp && d.active ? "무료이용권으로 열린 PRO 기능이에요. 끝나도 내 데이터는 지워지지 않아요." : d.active ? "구독으로 열린 기능이에요." : "구독하면 열리는 기능이에요")), ...(d.active ? [] : [span(" · "), span(d.price)]));
  const actions = [];
  const link = (href, text, primary) => { const a = document.createElement("a"); a.className = "btn" + (primary ? " btn-primary" : ""); a.href = href; a.textContent = text; return a; };
  if (d.checkout) actions.push(link("/billing/checkout", "구독하기", true));
  else if (!d.active) actions.push(link("/download", "로컬판에서 구독하기", false));
  if (d.manageUrl) actions.push(link(d.manageUrl, "구독 관리", false));
  actions.push(link(d.compareUrl, "노션·옵시디언과 비교", false));
  $("plan-actions").replaceChildren(...actions);
  $("plan").hidden = false;
}).catch(() => {});

fetch("/api/me/ai-usage").then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !d.usage) return;
  const cap = (v) => (v === null || v === undefined ? "제한 없음" : Number(v).toLocaleString("ko-KR") + "회");
  const month = d.limits.callsPerMonth ?? null;
  $("ai-usage-month").textContent = "이번 달 AI 사용 " + Number(d.usage.month).toLocaleString("ko-KR") + (month === null ? "회" : "/" + cap(month));
  $("ai-usage-day").textContent = "오늘 " + Number(d.usage.day).toLocaleString("ko-KR") + "/" + cap(d.limits.callsPerDay);
  $("ai-usage").hidden = false;
}).catch(() => {});

// 계정 삭제 (#170): typing the account email or the word 삭제 (delete / 删除 for the translated page) unlocks the button;
// POST /api/account/delete removes everything and clears the session cookies, then the page shows the done screen.
const delForm = $("delete-form"), delInput = $("delete-confirm"), delGo = $("delete-go"), delMsg = $("delete-msg");
const delWords = ["삭제", "delete", "删除"];
const delReady = () => { const v = delInput.value.trim().toLowerCase(); return delWords.includes(v) || (!!myEmail && v === myEmail.toLowerCase()); };
$("delete-open").addEventListener("click", () => { delForm.hidden = false; $("delete-open").hidden = true; delInput.focus(); });
$("delete-cancel").addEventListener("click", () => { delForm.hidden = true; $("delete-open").hidden = false; delInput.value = ""; delGo.disabled = true; delMsg.className = "msg"; });
delInput.addEventListener("input", () => { delGo.disabled = !delReady(); });
delForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!delReady()) return;
  delGo.disabled = true;
  try {
    const res = await fetch("/api/account/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    if (!res.ok) {
      delMsg.className = "msg err";
      delMsg.textContent = res.status === 403 ? "오너 계정은 여기서 지울 수 없어요." : res.status === 401 ? "로그인이 끝났어요. 다시 로그인한 뒤 지워 주세요." : "계정을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.";
      delGo.disabled = false;
      return;
    }
    if (window.caches) await caches.delete("acard-recent-cache").catch(() => undefined);
    $("deleted-tpl").closest(".auth-box").replaceChildren($("deleted-tpl").content.cloneNode(true));
    document.querySelector(".onb-back")?.remove();
    window.scrollTo(0, 0);
  } catch {
    delMsg.className = "msg err"; delMsg.textContent = "네트워크 연결을 확인해 주세요.";
    delGo.disabled = false;
  }
});
