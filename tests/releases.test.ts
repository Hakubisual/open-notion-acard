import { expect, test } from "bun:test";
import { releaseRoute, withReleaseInfo } from "../gate/releases";
import { DICTS, LANGS, translateHtml } from "../gate/i18n";

const config = { repo: "example/releases", win: { version: "0.1.1", date: "2026-10-22" } };
const linuxConfig = { ...config, linux: { version: "0.2.0", date: "2026-10-24" } };
const get = (path: string, fetcher: typeof fetch = fetch) => releaseRoute(new Request("https://notes.example.com" + path), path, config, fetcher);
const asset = (version: string, file: string) => `https://github.com/example/releases/releases/download/v${version}/${file}`;

test("download buttons redirect to the current installer, and a platform without a build goes back to the page", async () => {
  const win = await get("/download/windows");
  expect(win!.status).toBe(302);
  expect(win!.headers.get("location")).toBe(asset("0.1.1", "Acard-0.1.1-win-x64.exe"));
  expect((await get("/download/mac-arm64"))!.headers.get("location")).toBe("/download");
  expect((await get("/download/linux"))!.status).toBe(404);
  for (const path of ["/download/linux-appimage", "/download/linux-tar"]) {
    const pending = await get(path);
    expect(pending!.headers.get("location")).toBe("/download");
    expect(pending!.headers.get("cache-control")).toBe("no-store");
  }
});

test("the update feed serves the current version's latest.yml and the files it names redirect to that version", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(url);
    return new Response("version: 0.1.1\npath: Acard-0.1.1-win-x64.exe\n");
  }) as unknown as typeof fetch;
  const feed = await get("/releases/win/latest.yml", fetcher);
  expect(feed!.status).toBe(200);
  expect(await feed!.text()).toContain("version: 0.1.1");
  expect(seen).toEqual([asset("0.1.1", "latest.yml")]);
  expect((await get("/releases/win/Acard-0.1.1-win-x64.exe.blockmap"))!.headers.get("location")).toBe(asset("0.1.1", "Acard-0.1.1-win-x64.exe.blockmap"));
  expect((await get("/releases/mac/latest-mac.yml", fetcher))!.status).toBe(404);
  expect((await get("/releases/win/..%2Fsecret"))!.status).toBe(404);
  expect(await get("/releasesx/win/latest.yml")).toBeNull();
});

test("the download page shows the version of a published platform and the pending note of the other", async () => {
  const html = '<p><span data-release-version="win">-</span><a data-release-ready="win">dl</a><i data-release-pending="win">soon</i>'
    + '<span data-release-version="mac">-</span><a data-release-ready="mac">mac</a><i data-release-pending="mac">mac soon</i></p>';
  const out = await withReleaseInfo(new Response(html, { headers: { "content-type": "text/html" } }), config).text();
  expect(out).toBe('<p><span data-release-version="win">0.1.1</span><a data-release-ready="win">dl</a><span data-release-version="mac">-</span><i data-release-pending="mac">mac soon</i></p>');
});

test("Linux downloads use the architecture names emitted by electron-builder 26", async () => {
  for (const [path, file] of [
    ["/download/linux-appimage", "Acard-0.2.0-linux-x86_64.AppImage"],
    ["/download/linux-tar", "Acard-0.2.0-linux-x64.tar.gz"],
  ]) {
    const response = await releaseRoute(new Request("https://notes.example.com" + path), path, linuxConfig);
    expect(response!.status).toBe(302);
    expect(response!.headers.get("location")).toBe(asset("0.2.0", file));
    expect(response!.headers.get("cache-control")).toBe("public, max-age=300");
  }
});

test("Linux feed supports GET and HEAD, and old release artifacts keep their own version", async () => {
  const path = "/releases/linux/latest-linux.yml";
  const body = "version: 0.2.0\nfiles:\n  - url: Acard-0.2.0-linux-x86_64.AppImage\n    sha512: checksum\n";
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(url);
    return new Response(body);
  }) as unknown as typeof fetch;
  for (const method of ["GET", "HEAD"]) {
    const response = await releaseRoute(new Request("https://notes.example.com" + path, { method }), path, linuxConfig, fetcher);
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    expect(response!.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response!.text()).toBe(method === "HEAD" ? "" : body);
  }
  expect(seen).toEqual([asset("0.2.0", "latest-linux.yml"), asset("0.2.0", "latest-linux.yml")]);
  for (const file of ["Acard-0.1.0-linux-x86_64.AppImage", "Acard-0.1.0-linux-x64.tar.gz", "Acard-0.1.0-linux-x86_64.AppImage.blockmap"]) {
    const artifactPath = "/releases/linux/" + file;
    const response = await releaseRoute(new Request("https://notes.example.com" + artifactPath), artifactPath, linuxConfig, fetcher);
    expect(response!.headers.get("location")).toBe(asset("0.1.0", file));
    expect(response!.headers.get("cache-control")).toBe("public, max-age=86400");
  }
  expect(seen).toHaveLength(2);
});

test("Linux feeds reject unpublished or invalid versions, missing upstream files and invalid paths", async () => {
  const path = "/releases/linux/latest-linux.yml";
  const request = new Request("https://notes.example.com" + path);
  let fetched = false;
  const missing = (async () => { fetched = true; return new Response(null, { status: 404 }); }) as unknown as typeof fetch;
  expect((await releaseRoute(request, path, config, missing))!.status).toBe(404);
  expect((await releaseRoute(request, path, { ...linuxConfig, linux: { version: "invalid", date: "2026-10-24" } }, missing))!.status).toBe(404);
  expect(fetched).toBe(false);
  expect((await releaseRoute(request, path, linuxConfig, missing))!.status).toBe(404);
  expect(fetched).toBe(true);
  expect((await get("/releases/linux/latest.yml"))!.status).toBe(404);
  expect((await get("/releases/linux/..%2Fsecret"))!.status).toBe(404);
  expect(await releaseRoute(new Request(request, { method: "POST" }), path, linuxConfig, missing)).toBeNull();
});

test("the localized Linux card exposes downloads only after a Linux release is configured", async () => {
  const html = await Bun.file(new URL("../assets/_site/download.html", import.meta.url)).text();
  for (const lang of LANGS) {
    for (const key of ["dl.linux.req", "dl.linux.appimage", "dl.linux.tar", "dl.linux.run"]) {
      expect(DICTS[lang][key]).toBeDefined();
    }
    for (const published of [false, true]) {
      const localized = translateHtml(new Response(html, { headers: { "content-type": "text/html" } }), lang);
      const out = await withReleaseInfo(localized, published ? linuxConfig : config).text();
      const card = /<section class="dl-card" id="linux">([\s\S]*?)<\/section>/.exec(out)![1];
      expect(card.includes('href="/download/linux-appimage"')).toBe(published);
      expect(card.includes('href="/download/linux-tar"')).toBe(published);
      expect(card.includes('data-release-pending="linux"')).toBe(!published);
      expect(card).toContain(`<span data-release-version="linux">${published ? "0.2.0" : "-"}</span>`);
      expect(card).toContain(DICTS[lang]["dl.linux.run"]);
    }
  }
});
