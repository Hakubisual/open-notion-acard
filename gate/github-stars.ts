// GET /api/github/stars: the landing's GitHub button shows the public repository's star count (acard-indosaram-landing).
// One GitHub call per 10 minutes for the whole site, not one per visitor (unauthenticated GitHub allows 60 an hour per
// IP, and Cloudflare's egress IPs are shared, so that limit is often spent already): the answer lives in the edge cache
// (caches.default), shared by every Worker instance in that location, and shields.io's JSON badge (its own token pool)
// answers when GitHub refuses. A failed
// call is remembered for 90 s and the last good number keeps being served meanwhile; with no good number yet the
// answer is {stars:null} and the page shows the icon without a number.
export const STARS_REPO = "Hakubisual/open-notion-acard";
export const STARS_FRESH_MS = 10 * 60_000;
export const STARS_FAIL_MS = 90_000;
const KEY = "https://acard-github-stars.internal/v1/" + STARS_REPO;

type Saved = { stars: number | null; at: number; retryAt?: number };
type CacheLike = { match(key: Request): Promise<Response | undefined>; put(key: Request, res: Response): Promise<void> };

export function starsLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return String(Math.floor(n / 100) / 10) + "k";
  if (n < 1_000_000) return Math.floor(n / 1000) + "k";
  return String(Math.floor(n / 100_000) / 10) + "M";
}

async function read(cache: CacheLike): Promise<Saved | null> {
  const hit = await cache.match(new Request(KEY)).catch(() => undefined);
  return hit ? ((await hit.json().catch(() => null)) as Saved | null) : null;
}

const write = (cache: CacheLike, saved: Saved) =>
  cache.put(new Request(KEY), new Response(JSON.stringify(saved), { headers: { "content-type": "application/json", "cache-control": "public, max-age=604800" } })).catch(() => {});

async function fromGitHub(fetcher: typeof fetch): Promise<number | null> {
  const res = await fetcher("https://api.github.com/repos/" + STARS_REPO, {
    headers: { accept: "application/vnd.github+json", "user-agent": "notes.example.com", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(4000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { stargazers_count?: unknown } | null;
  const n = body?.stargazers_count;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

export function parseShields(message: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(String(message ?? "").trim());
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "M" ? 1_000_000 : 1));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function fromShields(fetcher: typeof fetch): Promise<number | null> {
  const res = await fetcher("https://img.shields.io/github/stars/" + STARS_REPO + ".json", { headers: { "user-agent": "notes.example.com" }, signal: AbortSignal.timeout(4000) }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { value?: unknown; message?: unknown } | null;
  return parseShields(body?.value ?? body?.message);
}

export async function githubStars(cache: CacheLike, fetcher: typeof fetch = fetch, now = Date.now()): Promise<number | null> {
  const saved = await read(cache);
  if (saved && saved.stars !== null && now - saved.at < STARS_FRESH_MS) return saved.stars;
  if (saved?.retryAt && now < saved.retryAt) return saved.stars;
  const stars = (await fromGitHub(fetcher)) ?? (await fromShields(fetcher));
  if (stars !== null) { await write(cache, { stars, at: now }); return stars; }
  await write(cache, { stars: saved?.stars ?? null, at: saved?.at ?? 0, retryAt: now + STARS_FAIL_MS });
  return saved?.stars ?? null;
}

export async function githubStarsResponse(cache: CacheLike, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  const stars = await githubStars(cache, fetcher, now);
  return new Response(JSON.stringify({ repo: STARS_REPO, stars, label: stars === null ? null : starsLabel(stars) }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
