// acard-home-first (owner, slack C0C91GZDVC7 1792775590.830599 / 1792775656.669249): signed-in visitors get the landing
// with 내 홈으로 / 내 보드로 가기 pointing at /home/. The only input is "is there a session" - no beta, plan or sign-up date.
import { t, type Lang } from "./i18n";
import type { Session } from "./tenancy";

export const HOME_PATH = "/home/";

type HandleEnv = { readonly SUPABASE_URL?: string; readonly SUPABASE_SERVICE_ROLE_KEY?: string };

// Service-role read of one id by an exact, format-checked handle; null when unknown or the lookup fails.
export async function handleOwner(env: HandleEnv, handle: string): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/profiles?select=id&limit=1&handle=eq." + encodeURIComponent(handle), { headers: { apikey: key, authorization: "Bearer " + key } }).catch(() => null);
  const rows = res?.ok ? ((await res.json().catch(() => null)) as { id?: unknown }[] | null) : null;
  return Array.isArray(rows) && typeof rows[0]?.id === "string" ? rows[0].id : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function avatarHtml(session: Session): string {
  const meta = session.user.user_metadata ?? {};
  const picture = [meta.avatar_url, meta.picture].find((v): v is string => typeof v === "string" && /^https:\/\/[^\s"'<>]+$/.test(v));
  if (picture) return '<img class="my-avatar" src="' + esc(picture) + '" alt="" width="28" height="28" referrerpolicy="no-referrer">';
  const name = [meta.full_name, meta.name, session.user.email].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "";
  const initial = /[\p{L}\p{N}]/u.exec(name)?.[0].toUpperCase() ?? "";
  return '<span class="my-avatar" aria-hidden="true">' + esc(initial) + "</span>";
}

const STYLE = "<style>.nav-right .my-home{gap:10px;padding:0 18px 0 8px}.my-avatar{width:28px;height:28px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.22);color:inherit;font-size:var(--fs-14);font-weight:700;object-fit:cover}@media (max-width:760px){.nav-right .my-home{padding:0 14px 0 6px;gap:8px}.my-avatar{width:24px;height:24px;font-size:var(--fs-13)}}</style>";

// The top bar part (header.nav), also used on the public pages that share the landing's bar (gate/site-nav-html.ts).
export function myHomeNav(rewriter: HTMLRewriter, session: Session): HTMLRewriter {
  const avatar = avatarHtml(session);
  return rewriter
    .on("head", { element(el) { el.append(STYLE, { html: true }); } })
    .on("body", { element(el) { el.setAttribute("data-session", "1"); } })
    .on(".nav-right a.login-link, .nav-right a.invite-link", { element(el) { el.remove(); } })
    .on('.nav-right a[href="/signup"]', {
      element(el) {
        const short = (el.getAttribute("class") ?? "").includes("m-only");
        el.setAttribute("href", HOME_PATH);
        el.setAttribute("class", "btn btn-primary my-home " + (short ? "m-only-inline" : "d-only"));
        el.setAttribute("data-my-home", "header");
        el.removeAttribute("data-i18n");
        el.setInnerContent(avatar + '<span data-i18n="' + (short ? "land.myHomeShort" : "land.myHome") + '">내 홈으로</span>', { html: true });
      },
    })
    .on('.site-menu a[href="/login"]', { element(el) { el.setAttribute("href", HOME_PATH); el.setAttribute("data-i18n", "land.myHome"); el.setAttribute("data-my-home", "menu"); } });
}

// The public pages with the landing's bar (/compare, /download, /guide) get the landing's bar steps on the bar only: 내 홈으로
// for a signed-in visitor, and in the closed beta the WAITLIST buttons pointing at the landing's form.
export function rewriteSiteNav(res: Response, session: Session | null, closedBeta: boolean): Response {
  if (session) return myHomeNav(new HTMLRewriter(), session).transform(res);
  if (!closedBeta) return res;
  return new HTMLRewriter()
    .on('header.nav a[href="/signup"]', { element(el) { el.setAttribute("href", "/#waitlist"); el.setAttribute("data-beta", "1"); } })
    .transform(res);
}

export function rewriteMyHome(res: Response, session: Session): Response {
  const board = (el: Element) => {
    el.setAttribute("href", HOME_PATH);
    el.removeAttribute("data-beta");
    el.removeAttribute("data-cta");
    el.removeAttribute("data-i18n-html");
    el.setAttribute("data-i18n", "land.myBoard");
    el.setAttribute("data-my-home", "board");
    el.setInnerContent("내 보드로 가기");
  };
  return myHomeNav(new HTMLRewriter(), session)
    .on('main a[href="/signup"]:not(.m-plan), .hero-cta a[href="/beta?from=landing"]', { element: board })
    .on('a.m-plan[href="/signup"]', { element(el) { el.setAttribute("href", HOME_PATH); el.removeAttribute("data-cta"); el.setAttribute("data-my-home", "board"); } })
    .on('a.m-plan span[data-i18n-html="land.m.cloud"]', { element(el) { el.removeAttribute("data-i18n-html"); el.setAttribute("data-i18n", "land.myBoard"); el.setInnerContent("내 보드로 가기"); } })
    .on("#waitlist, .hero-pass", { element(el) { el.remove(); } })
    .transform(res);
}

// profiles.handle format (migration 029).
export const HANDLE_PATH = /^\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/?$/;
export const handleFromPath = (path: string): string | null => {
  const h = HANDLE_PATH.exec(path)?.[1];
  return h && !h.includes("--") ? h : null;
};

// Security: names only the address the visitor typed - no display name, no page titles, nothing from the workspace.
export function handleNoticePage(handle: string, lang: Lang, signedIn: boolean): Response {
  const action = signedIn
    ? '<a class="btn btn-primary" href="' + HOME_PATH + '">' + esc(t(lang, "land.myHome")) + "</a>"
    : '<a class="btn btn-primary" href="/login?next=' + encodeURIComponent("/" + handle + "/") + '">' + esc(t(lang, "land.nav.login")) + "</a>";
  const html = '<!doctype html><html lang="' + (lang === "zh" ? "zh-CN" : lang) + '"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>' + esc(t(lang, "handle.title")) + ' - Acard</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/_site/styles.css"><link rel="stylesheet" href="/_site/auth.css"><style>.handle-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:32px}.handle-actions .btn{height:52px;padding:0 24px;font-size:var(--fs-17)}.handle-at{font-family:var(--mono);color:var(--ink-2)}</style></head><body><main class="auth" data-handle-notice="1"><div class="auth-box">' +
    '<a class="auth-logo" href="/"><svg class="wordmark" viewBox="0 0 375.59 100" role="img" aria-label="Acard" focusable="false"><use href="/wordmark-symbol.svg#w"/></svg></a>' +
    "<h1>" + esc(t(lang, "handle.title")) + '</h1><p class="sub"><span class="handle-at">notes.example.com/' + esc(handle) + "</span><br>" + esc(t(lang, "handle.sub")) + "</p>" +
    '<div class="handle-actions">' + action + '<a class="btn" href="/">' + esc(t(lang, "handle.browse")) + "</a></div></div></main></body></html>";
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "content-language": lang } });
}
