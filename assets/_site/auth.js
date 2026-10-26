const T = (k) => (window.ACARD_T || {})[k] || k;
const form = document.querySelector("form[data-action]");
const msg = form.querySelector(".msg");
const button = form.querySelector('button[type="submit"]');
const action = form.dataset.action;

const show = (kind, text) => { msg.className = `msg ${kind}`; msg.textContent = text; };

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
const consent = wireConsent(form.querySelector(".consent"));
// Sign-up is Google only (#173): it leaves this page, and the ticks are kept for the onboarding step that records them
// (gate/account.ts). The sign-up form has no fields and no submit button.
const CONSENT_KEY = "acard-signup-consent";

// #45: the sidebar keeps its last tree in localStorage under this epoch; whoever signs in next starts without it.
try { localStorage.setItem("acard-cache-epoch", String(Date.now())); } catch {}
navigator.serviceWorker?.controller?.postMessage({ type: "acard-id", id: null });
const cleared = window.caches ? caches.keys().then(names => Promise.all(names.map(name => caches.delete(name)))).catch(() => {}) : Promise.resolve();

const params = new URLSearchParams(location.search);
if (params.get("e") === "link") show("err", T("js.auth.link"));
if (params.get("e") === "oauth") show("err", T("js.auth.oauth"));
if (params.get("reset") === "1") show("ok", T("js.auth.resetDone"));
if (params.get("deleted") === "1") show("ok", T("js.auth.deleted"));

const next = (() => { const n = params.get("next") || "/"; return n.startsWith("/") && !n.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(n) ? n : "/"; })();
const google = document.querySelector(".btn-google");
if (google && next !== "/") google.href = "/api/auth/google?next=" + encodeURIComponent(next);
if (google && action === "signup") google.addEventListener("click", (event) => {
  const agreed = consent();
  if (!agreed) { event.preventDefault(); show("err", T("js.consent.required")); return; }
  try { sessionStorage.setItem(CONSENT_KEY, JSON.stringify(agreed)); } catch {}
});
document.querySelectorAll('.switch a[href="/login"], .switch a[href="/signup"]').forEach((a) => {
  if (next !== "/") a.href += "?next=" + encodeURIComponent(next);
});

const done = {
  login: () => location.assign(next),
  forgot: () => show("ok", T("js.auth.forgotDone")),
  reset: () => location.assign("/login?reset=1"),
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!done[action]) return;
  const data = Object.fromEntries(new FormData(form));
  delete data.consent;
  button.disabled = true;
  try {
    await Promise.race([cleared, new Promise(resolve => setTimeout(resolve, 2000))]);
    const res = await fetch(`/api/auth/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { show("err", body.message ?? T("js.generic")); return; }
    done[action]();
  } catch {
    show("err", T("js.network"));
  } finally {
    button.disabled = false;
  }
});
