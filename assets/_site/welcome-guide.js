(() => {
  const STEPS = ["page", "slash", "search", "share"];
  const OFF = "acard-guide-off";
  const path = location.pathname;
  if (/^\/(onboarding|settings|import|login|signup|beta|guide)(\/|$)/.test(path)) return;
  try { if (sessionStorage.getItem(OFF) === "1") return; } catch {}
  const $ = (s) => document.querySelector(s);
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const pick = (...sels) => { for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el)) return el; return null; };
  const narrow = () => innerWidth < 900;
  const post = (body) => fetch("/api/guide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const homeHref = () => { const a = document.querySelector(".side-nav a[href], .side-brand a.brand[href], .thumbbar a[href]"); return (a && a.getAttribute("href")) || "/home/"; };
  const off = () => { try { sessionStorage.setItem(OFF, "1"); } catch {} };

  function chooseStep(view, where, small) {
    const step = STEPS.find((k) => !view.steps[k]);
    if (!step) return null;
    const onEditor = /^\/edit\//.test(where);
    const n = STEPS.indexOf(step) + 1;
    if (step === "page") return onEditor
      ? { step, n, target: "#title", title: "AI가 쓴 마크다운을 여기에 붙여 넣어 보세요", body: "제목 한 줄만 써도 첫 페이지가 생겨요" }
      : { step, n, target: small ? "[data-new-page]" : ".fd-ib[aria-haspopup=menu], .side-new[data-act=new], .side-add[data-act=new], #new-page", title: "첫 페이지를 만들어 보세요", body: "제목만 써도 돼요" };
    if (step === "slash") return onEditor
      ? { step, n, target: "#blocks .blk .text", title: "/ 를 눌러 메뉴를 열어 보세요", body: "표·할 일·제목 같은 블록을 고를 수 있어요" }
      : { step, n, target: small ? "[data-new-page]" : ".fd-ib[aria-haspopup=menu], .side-new[data-act=new], .side-add[data-act=new], #new-page", title: "새 페이지에서 / 를 눌러 보세요", body: "빈 줄에서 / 를 누르면 메뉴가 열려요" };
    if (step === "search") return { step, n, target: small ? "[data-open=palette]" : "#palette-open, #palette-open-editor, .side-search", title: "검색을 열어 보세요", body: small ? "아래 검색을 눌러요" : "Ctrl+K 로 어디서든 열려요" };
    return { step, n, target: "#share", title: "공유 창을 열어 보세요", body: "링크는 아직 만들지 않아요. 열어 보기만 해요" };
  }
  const L = (k) => (window.ACARD_T && window.ACARD_T[k]) || "";
  function landingCopy(g, fresh) {
    if (fresh) return { k: L("js.guide.k"), t: L("js.guide.newTitle"), b: L("js.guide.newBody"), go: L("js.guide.go") };
    if (g && g.active && !g.done) return { k: L("js.guide.count").replace("{n}", String(g.count || 0)), t: L("js.guide.resumeTitle"), b: L("js.guide.resumeBody"), go: L("js.guide.resume") };
    return null;
  }
  // Phone placement (#150): w x h coach next to target rect r inside viewport vp, below it (pointer up) or above it
  // (pointer down), off the fixed rects in avoid (피드백, agent button, tab bar). No usable target: a sheet above them.
  function spot(r, w, h, vp, avoid) {
    const m = 8, gap = 12;
    const floor = Math.min(vp.h, ...avoid.filter((a) => a.top > vp.h / 2).map((a) => a.top));
    if (!r || r.bottom <= 0 || r.top >= vp.h || (!r.width && !r.height)) return { side: "sheet", left: m, top: Math.max(m, floor - m - h), floor };
    const left = Math.max(m, Math.min(r.left, vp.w - w - m));
    const hit = (top) => avoid.some((a) => a.left < left + w && a.right > left && a.top < top + h && a.bottom > top);
    const below = r.bottom + gap, above = r.top - gap - h;
    const fitsBelow = below + h <= vp.h - m, fitsAbove = above >= m;
    const side = fitsBelow && !hit(below) ? "below" : fitsAbove && !hit(above) ? "above" : fitsBelow ? "below" : fitsAbove ? "above" : "sheet";
    if (side === "sheet") return { side, left: m, top: Math.max(m, floor - m - h), floor };
    const px = Math.max(14, Math.min(r.left + Math.min(16, r.width / 2) - left - 6, w - 26));
    return { side, left, top: side === "below" ? below : above, px };
  }
  window.AcardGuide = { chooseStep, landingCopy, spot };

  const css = `.wg-coach{position:fixed;z-index:58;width:min(340px,calc(100vw - 16px));padding:14px 16px 10px;border:1px solid var(--color-border,var(--line));border-radius:var(--radius-md);background:var(--color-raised,var(--bg));color:var(--color-text,var(--fg));box-shadow:var(--shadow-lg);font:var(--fs-14,14px)/1.5 var(--font-body,system-ui,sans-serif)}
.wg-coach[hidden]{display:none}.wg-coach .wg-k{margin:0 0 4px;color:var(--color-accent,var(--accent));font-size:var(--fs-12,12px);font-weight:700}
.wg-coach .wg-t{margin:0;font-size:var(--fs-16,16px);font-weight:700}.wg-coach .wg-b{margin:2px 0 10px;color:var(--color-text-dim,var(--fg-dim))}
.wg-coach .wg-f{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid var(--color-border,var(--line))}
.wg-coach button,.wg-coach a{min-height:32px;padding:0 6px;border:0;background:none;color:var(--color-text-dim,var(--fg-dim));font:inherit;cursor:pointer;text-decoration:none;border-radius:var(--radius-xs)}
.wg-coach .wg-go{color:var(--color-accent,var(--accent));font-weight:600}.wg-coach :focus-visible{outline:2px solid var(--color-accent,var(--accent));outline-offset:2px}
.wg-dots{display:flex;gap:6px}.wg-dots i{width:7px;height:7px;border-radius:50%;background:var(--color-border,var(--line))}.wg-dots i.on{background:var(--color-accent,var(--accent))}
.wg-ring{outline:2px solid var(--color-accent,var(--accent))!important;outline-offset:3px;border-radius:var(--radius-xs)}
.wg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wg-coach.wg-site{--color-raised:var(--bg);--color-text:var(--ink);--color-text-dim:var(--muted);--color-border:var(--line);--color-accent:var(--accent);--radius-md:14px;--radius-xs:6px;--shadow-lg:0 12px 32px rgba(30,28,50,.18)}
.wg-coach.wg-site .wg-go{display:inline-flex;align-items:center;white-space:nowrap;padding:0 12px;border-radius:8px;background:var(--accent);color:#fff}
@media (max-width:899px){.wg-coach.wg-sheet{width:calc(100vw - 16px)}.wg-coach button,.wg-coach a{min-height:44px}}
.wg-coach.wg-below::before,.wg-coach.wg-above::before{content:"";position:absolute;left:var(--wg-px,16px);width:11px;height:11px;background:var(--color-raised,var(--bg));border:solid var(--color-border,var(--line));transform:rotate(45deg)}
.wg-coach.wg-below::before{top:-7px;border-width:1px 0 0 1px}.wg-coach.wg-above::before{bottom:-7px;border-width:0 1px 1px 0}
@media (prefers-reduced-motion:no-preference){.wg-coach{transition:opacity .15s ease}}`;

  let box, live, current, ring, raf = 0, view, siteMode = false;
  function mount() {
    const style = document.createElement("style"); style.textContent = css; document.head.append(style);
    box = document.createElement("section");
    box.className = "wg-coach"; box.hidden = true; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "시작 가이드");
    live = document.createElement("p"); live.className = "wg-sr"; live.setAttribute("role", "status");
    document.body.append(box, live);
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (visible($("#slash")) || visible($("#palette")) || document.querySelector("dialog[open]")) return;
      e.preventDefault(); skip();
    });
    addEventListener("resize", place); addEventListener("scroll", place, true);
    if (window.visualViewport) visualViewport.addEventListener("resize", place);
  }
  function placeNarrow() {
    const vv = window.visualViewport;
    const vp = { w: innerWidth, h: vv ? Math.min(innerHeight, vv.offsetTop + vv.height) : innerHeight };
    const avoid = [...document.querySelectorAll(".fbt, .agent-fab, .thumbbar")].filter(visible).map((el) => el.getBoundingClientRect());
    const t = current ? pick(current.target) : null;
    box.classList.remove("wg-sheet", "wg-below", "wg-above");
    const s = spot(t && t.getBoundingClientRect(), box.offsetWidth, box.offsetHeight, vp, avoid);
    if (s.side === "sheet") { box.classList.add("wg-sheet"); box.style.top = Math.max(8, s.floor - 8 - box.offsetHeight) + "px"; }
    else { box.classList.add("wg-" + s.side); box.style.setProperty("--wg-px", s.px + "px"); box.style.top = s.top + "px"; }
    box.style.left = s.left + "px";
  }
  function place() {
    if (raf || !box || box.hidden) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (narrow()) return placeNarrow();
      if (!current) return;
      box.classList.remove("wg-sheet", "wg-below", "wg-above");
      const t = pick(current.target);
      const r = t ? t.getBoundingClientRect() : { left: innerWidth / 2 - 170, bottom: 120, top: 120 };
      const h = box.offsetHeight;
      const below = r.bottom + 10 + h < innerHeight;
      box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + "px";
      box.style.top = (below ? r.bottom + 10 : Math.max(8, r.top - h - 10)) + "px";
    });
  }
  function show(s) {
    current = s;
    if (ring) ring.classList.remove("wg-ring");
    const t = pick(s.target);
    const shareElsewhere = s.step === "share" && !t;
    const searchElsewhere = s.step === "search" && !t;
    const recent = shareElsewhere ? [...document.querySelectorAll("#sidebar .tree a[href], .sidebar .tree a[href], #tree a[href]")].map((a) => a.getAttribute("href")).find((h) => h && h !== "/" && h !== homeHref() && !/^\/edit\//.test(h)) || (/^\/edit\/([^/]+)/.exec(path) || [])[1] && "/" + (/^\/edit\/([^/]+)/.exec(path) || [])[1] + "/" : searchElsewhere ? homeHref() : null;
    if (shareElsewhere && !recent) { box.hidden = true; return; }
    const title = shareElsewhere ? "아무 페이지나 열어 공유를 눌러 보세요" : searchElsewhere ? "홈에서 검색을 열어 보세요" : s.title;
    box.innerHTML = `<p class="wg-k"></p><p class="wg-t"></p><p class="wg-b"></p><div class="wg-f"><button type="button" data-guide-skip>그만보기</button>${recent ? '<a class="wg-go" data-guide-open></a>' : ""}<span class="wg-dots" aria-hidden="true">${STEPS.map((k) => `<i class="${view.steps[k] || k === s.step ? "on" : ""}"></i>`).join("")}</span></div>`;
    box.querySelector(".wg-k").textContent = "시작 가이드 " + s.n + " / 4";
    box.querySelector(".wg-t").textContent = title;
    box.querySelector(".wg-b").textContent = s.body;
    if (recent) { const a = box.querySelector("[data-guide-open]"); a.href = recent; a.textContent = searchElsewhere ? "홈으로" : "페이지 열기"; }
    box.querySelector("[data-guide-skip]").addEventListener("click", skip);
    if (t) { ring = t; t.classList.add("wg-ring"); }
    if (t && narrow() && !visible($(".wg-card"))) { const r = t.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= innerHeight) t.scrollIntoView({ block: "center" }); }
    if (visible($(".wg-card"))) { box.hidden = true; live.textContent = "시작 가이드 " + view.count + " / 4 완료"; return; }
    box.hidden = false;
    live.textContent = "시작 가이드 " + view.count + " / 4 완료";
    place();
  }
  function hide() { if (box) box.hidden = true; if (ring) ring.classList.remove("wg-ring"); }
  async function skip() {
    if (siteMode) return hide();
    hide(); off();
    const resume = $("[data-guide-resume]");
    if (resume) resume.focus();
    await post({ action: "skip" });
  }
  async function done(step) {
    if (view.steps[step]) return;
    view.steps[step] = true; view.count += 1;
    const next = await post({ action: "step", step });
    if (next) view = next;
    live.textContent = view.count + " / 4 완료";
    if (view.done) return celebrate();
    next1();
  }
  function celebrate() {
    off();
    // issue 149: the new editing tools in one line (text from /api/guide), only when they are on.
    box.innerHTML = '<p class="wg-k"></p><p class="wg-t">시작 가이드를 모두 마쳤어요</p><p class="wg-b">불편한 점이 있으면 화면 캡처로 알려 주세요</p>' + (view.editTools ? '<p class="wg-b" data-guide-tools></p>' : "") + '<div class="wg-f"><button type="button" class="wg-go" data-guide-feedback>피드백 보내기</button><a href="/guide">자세한 사용법</a><button type="button" data-guide-close aria-label="닫기">닫기</button></div>';
    box.querySelector(".wg-k").textContent = "시작 가이드 " + 4 + " / 4";
    if (view.editTools) box.querySelector("[data-guide-tools]").textContent = view.editTools;
    box.querySelector("[data-guide-feedback]").addEventListener("click", () => { const f = $(".fbt"); hide(); if (f) f.click(); });
    box.querySelector("[data-guide-close]").addEventListener("click", hide);
    box.hidden = false; if (ring) ring.classList.remove("wg-ring");
    current = null;
    if (narrow()) return placeNarrow(), post({ action: "celebrated" });
    box.style.top = "64px"; box.style.left = Math.max(8, innerWidth - box.offsetWidth - 16) + "px";
    post({ action: "celebrated" });
  }
  function watch(sel, cb) {
    const el = $(sel);
    if (!el) return;
    new MutationObserver(() => { if (!el.hidden) cb(); }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
  }
  function next1() {
    const s = chooseStep(view, path, narrow());
    if (!s) return hide();
    show(s);
  }
  function wire() {
    watch("#slash", () => done("slash"));
    watch("#palette", () => done("search"));
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#share")) return;
      let tries = 0;
      const check = () => { if (document.querySelector("dialog.shd[open]")) return done("share"); if (++tries < 10) setTimeout(check, 300); };
      setTimeout(check, 300);
    }, true);
  }
  async function startLanding() {
    const [g, p] = await Promise.all([
      fetch("/api/guide", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/profile", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!g || !g.enabled) return;
    const copy = landingCopy(g, Boolean(p && (!p.profile || !p.profile.onboarded_at)));
    if (!copy || !copy.t) return;
    siteMode = true; mount(); box.classList.add("wg-site");
    const t = pick("[data-my-home=header]", "[data-my-home=menu]", "[data-my-home]");
    box.innerHTML = '<p class="wg-k"></p><p class="wg-t"></p><p class="wg-b"></p><div class="wg-f"><button type="button" data-guide-skip></button><a class="wg-go wg-primary" data-guide-home></a></div>';
    box.querySelector(".wg-k").textContent = copy.k;
    box.querySelector(".wg-t").textContent = copy.t;
    box.querySelector(".wg-b").textContent = copy.b;
    const go = box.querySelector("[data-guide-home]"); go.textContent = copy.go; go.href = (t && t.getAttribute("href")) || "/home/";
    const close = box.querySelector("[data-guide-skip]"); close.textContent = L("js.guide.close"); close.addEventListener("click", hide);
    current = { target: "[data-my-home=header], [data-my-home=menu], [data-my-home]" };
    if (t) { ring = t; t.classList.add("wg-ring"); }
    box.hidden = false; place();
  }
  async function start() {
    if (document.body && document.body.dataset.session === "1" && $("[data-my-home]")) return startLanding();
    const r = await fetch("/api/guide", { cache: "no-store" }).catch(() => null);
    view = r && r.ok ? await r.json().catch(() => null) : null;
    if (!view || !view.enabled || !view.active || view.done) { if (!view || !view.skipped) off(); return; }
    if (view.skipped) return;
    mount(); wire();
    const notice = $(".ab-notice details[open]");
    if (notice) notice.addEventListener("toggle", () => { if (!notice.open) next1(); }, { once: true });
    else next1();
  }
  if (document.readyState === "complete") setTimeout(start, 400); else addEventListener("load", () => setTimeout(start, 400), { once: true });
})();
