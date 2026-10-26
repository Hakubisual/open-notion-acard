// Public desktop downloads and the auto-update feed (acard-next-10 items 1, 9, 10).
// The installers live in the public GitHub repository named in desktop-release.json (this repository is private), as one
// release per version tagged v<version>. desktop-release.json at the repository root is the one place that says which
// version is current for each platform; publishing = upload the release there, then bump the version and deploy.
//   GET /download                         the download page (assets/_site/download.html), versions filled in here
//   GET /download/<windows|mac-arm64|mac-x64|linux-appimage|linux-tar>   302 to the current installer
//   GET /releases/<win|mac|linux>/latest*.yml   electron-updater feed of the current version (copied from the release)
//   GET /releases/<win|mac|linux>/Acard-<ver>-* 302 to that version's file (installer, archive, blockmap) named by the feed
import release from "../desktop-release.json";

export type Platform = "win" | "mac" | "linux";
type ReleaseConfig = { repo: string } & Partial<Record<Platform, { version: string; date: string }>>;

export const RELEASE = release as ReleaseConfig;

const VERSION = /^\d+\.\d+\.\d+$/;
const DOWNLOADS: Record<string, { platform: Platform; file: (version: string) => string }> = {
  windows: { platform: "win", file: (v) => `Acard-${v}-win-x64.exe` },
  "mac-arm64": { platform: "mac", file: (v) => `Acard-${v}-mac-arm64.dmg` },
  "mac-x64": { platform: "mac", file: (v) => `Acard-${v}-mac-x64.dmg` },
  // electron-builder 26's getArtifactArchName maps x64 to x86_64 for AppImage, but not tar.gz.
  "linux-appimage": { platform: "linux", file: (v) => `Acard-${v}-linux-x86_64.AppImage` },
  "linux-tar": { platform: "linux", file: (v) => `Acard-${v}-linux-x64.tar.gz` },
};
const FEEDS: Record<Platform, string> = { win: "latest.yml", mac: "latest-mac.yml", linux: "latest-linux.yml" };

export function currentVersion(platform: Platform, config: ReleaseConfig = RELEASE): string | null {
  const version = config[platform]?.version;
  return version && VERSION.test(version) ? version : null;
}

export function assetUrl(version: string, file: string, config: ReleaseConfig = RELEASE): string {
  return `https://github.com/${config.repo}/releases/download/v${version}/${encodeURIComponent(file)}`;
}

const redirectTo = (location: string, maxAge: number) =>
  new Response(null, { status: 302, headers: { location, "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });
const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

// Returns null for paths it does not own, so the caller keeps routing.
export async function releaseRoute(request: Request, path: string, config: ReleaseConfig = RELEASE, fetcher: typeof fetch = fetch): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const download = /^\/download\/([\w-]+)\/?$/.exec(path);
  if (download) {
    const target = DOWNLOADS[download[1]];
    if (!target) return notFound();
    const version = currentVersion(target.platform, config);
    return version ? redirectTo(assetUrl(version, target.file(version), config), 300) : redirectTo("/download", 0);
  }
  const feed = /^\/releases\/(win|mac|linux)\/([^/]+)$/.exec(path);
  if (!feed) return null;
  const platform = feed[1] as Platform;
  const file = decodeURIComponent(feed[2]);
  if (file === FEEDS[platform]) {
    const version = currentVersion(platform, config);
    if (!version) return notFound();
    const upstream = await fetcher(assetUrl(version, file, config), { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
    if (!upstream.ok) return notFound();
    const body = await upstream.text();
    return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  const named = /^Acard-(\d+\.\d+\.\d+)-[\w.-]+$/.exec(file);
  if (!named) return notFound();
  return redirectTo(assetUrl(named[1], file, config), 86400);
}

export function withReleaseInfo(res: Response, config: ReleaseConfig = RELEASE): Response {
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  return new HTMLRewriter()
    .on("[data-release-version]", {
      element(el) {
        const platform = el.getAttribute("data-release-version") as Platform;
        el.setInnerContent(currentVersion(platform, config) ?? "-");
      },
    })
    .on("[data-release-date]", {
      element(el) {
        const platform = el.getAttribute("data-release-date") as Platform;
        el.setInnerContent(config[platform]?.date ?? "-");
      },
    })
    .on("[data-release-ready]", {
      element(el) {
        if (!currentVersion(el.getAttribute("data-release-ready") as Platform, config)) el.remove();
      },
    })
    .on("[data-release-pending]", {
      element(el) {
        if (currentVersion(el.getAttribute("data-release-pending") as Platform, config)) el.remove();
      },
    })
    .transform(res);
}
