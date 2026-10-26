import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Owner 2026-10-25 (slack C0C91GZDVC7 1792929477.276289): the site shows no Discord link. Admin screens keep the invite
// copy; the waitlist "Discord username" field and the privacy policy wording are not links, so they never match.
const root = join(import.meta.dir, "..");
const LINK = /discord\.(gg|com)|discordapp/i;

test("public assets and site strings carry no Discord link", () => {
  const files = [
    ...new Bun.Glob("assets/**/*.{html,js,json,svg,css}").scanSync({ cwd: root }),
    ...new Bun.Glob("src/i18n/*.json").scanSync({ cwd: root }),
  ].filter((f) => !/[\\/]admin-[^\\/]+$/.test(f));
  expect(files.length).toBeGreaterThan(50);
  const hits = files.filter((f) => LINK.test(readFileSync(join(root, f), "utf8")));
  expect(hits).toEqual([]);
});
