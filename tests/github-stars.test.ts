// The landing's GitHub star count (gate/github-stars.ts): one GitHub call per 10 minutes through a shared cache, a
// failure remembered for 90 s, the last good number kept on errors, and nothing shown when there was never a number.
import { expect, test } from "bun:test";
import { githubStars, githubStarsResponse, parseShields, starsLabel, STARS_FAIL_MS, STARS_FRESH_MS } from "../gate/github-stars";

function memoryCache() {
  const map = new Map<string, string>();
  return {
    match: async (key: Request) => (map.has(key.url) ? new Response(map.get(key.url)) : undefined),
    put: async (key: Request, res: Response) => { map.set(key.url, await res.text()); },
  };
}
function github(answers: (number | "fail" | "throw")[], shields: (string | "fail")[] = []) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    if (String(url).startsWith("https://img.shields.io/")) {
      const s = shields.shift();
      return s === undefined || s === "fail" ? new Response("down", { status: 503 }) : Response.json({ label: "stars", message: s, value: s });
    }
    calls.push(String(url));
    const a = answers.shift();
    if (a === "throw") throw new Error("network down");
    if (a === "fail" || a === undefined) return new Response("rate limited", { status: 403 });
    return Response.json({ stargazers_count: a });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("first call asks GitHub once; within 10 minutes the cached number is served without a call", async () => {
  const cache = memoryCache(), gh = github([15, 99]);
  expect(await githubStars(cache, gh.fetcher, 0)).toBe(15);
  expect(await githubStars(cache, gh.fetcher, STARS_FRESH_MS - 1)).toBe(15);
  expect(gh.calls).toEqual(["https://api.github.com/repos/Hakubisual/open-notion-acard"]);
  expect(await githubStars(cache, gh.fetcher, STARS_FRESH_MS)).toBe(99);
  expect(gh.calls.length).toBe(2);
});

test("a failed refresh keeps the last good number and waits 90 s before trying again", async () => {
  const cache = memoryCache(), gh = github([15, "fail", 16]);
  await githubStars(cache, gh.fetcher, 0);
  const t = STARS_FRESH_MS + 5;
  expect(await githubStars(cache, gh.fetcher, t)).toBe(15);
  expect(await githubStars(cache, gh.fetcher, t + STARS_FAIL_MS - 1)).toBe(15);
  expect(gh.calls.length).toBe(2);
  expect(await githubStars(cache, gh.fetcher, t + STARS_FAIL_MS)).toBe(16);
  expect(gh.calls.length).toBe(3);
});

test("with no good number yet a failure answers null (icon without a number) and is not retried for 90 s", async () => {
  const cache = memoryCache(), gh = github(["throw", 7]);
  const res = await githubStarsResponse(cache, gh.fetcher, 1000);
  expect(await res.json()).toEqual({ repo: "Hakubisual/open-notion-acard", stars: null, label: null });
  expect(await githubStars(cache, gh.fetcher, 1000 + STARS_FAIL_MS - 1)).toBeNull();
  expect(gh.calls.length).toBe(1);
  expect(await githubStars(cache, gh.fetcher, 1000 + STARS_FAIL_MS)).toBe(7);
});

test("when GitHub refuses (rate limit on shared egress IPs) the shields.io badge answers, and that is cached too", async () => {
  const cache = memoryCache(), gh = github(["fail", 99], ["15"]);
  expect(await githubStars(cache, gh.fetcher, 0)).toBe(15);
  expect(await githubStars(cache, gh.fetcher, STARS_FRESH_MS - 1)).toBe(15);
  expect(gh.calls.length).toBe(1);
});

test("shields.io values: plain, k and M", () => {
  expect(["15", "1.2k", "96k", "1.3M", "", "n/a", undefined].map(parseShields)).toEqual([15, 1200, 96000, 1300000, null, null, null]);
});

test("a malformed GitHub body counts as a failure", async () => {
  const cache = memoryCache();
  const fetcher = (async () => Response.json({ stargazers_count: "lots" })) as unknown as typeof fetch;
  expect(await githubStars(cache, fetcher, 0)).toBeNull();
});

test("the answer is browser-cacheable JSON with the short label", async () => {
  const res = await githubStarsResponse(memoryCache(), github([1234]).fetcher, 0);
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await res.json()).toEqual({ repo: "Hakubisual/open-notion-acard", stars: 1234, label: "1.2k" });
});

test("labels: exact under 1000, one decimal (rounded down) under 10k, then whole k and M", () => {
  expect([0, 15, 999, 1000, 1299, 9999, 12_345, 999_999, 1_250_000].map(starsLabel)).toEqual(["0", "15", "999", "1k", "1.2k", "9.9k", "12k", "999k", "1.2M"]);
});
