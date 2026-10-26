// Automatic backups: the local app writes <data>/backups/auto-*.zip on its own (test interval) and keeps the newest 7.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive } from "../gate/archive";

const APP = join(import.meta.dir, "..", "dist");
const children: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const child of children) { child.kill(); await child.exited; }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function boot(port: number, intervalMs: number) {
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "acard-auto-"));
  dirs.push(dataDir);
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "local", "main.ts")], {
    env: { ...process.env, ACARD_DATA_DIR: dataDir, ACARD_APP_DIR: APP, ACARD_PORT: String(port), ACARD_CLOUD_URL: "", ACARD_BACKUP_INTERVAL_MS: String(intervalMs) },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  for (let seen = ""; !seen.includes("READY");) {
    const { value, done } = await reader.read();
    if (done) throw new Error("local server exited: " + seen);
    seen += new TextDecoder().decode(value);
  }
  const base = "http://127.0.0.1:" + port;
  return { dataDir, call: (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { origin: base, ...(init.headers as Record<string, string>) } }) };
}

const autoFiles = (dataDir: string) => { try { return readdirSync(join(dataDir, "backups")).filter((n) => /^auto-\d{8}-\d{6}\.zip$/.test(n)); } catch { return []; } };

// Boots the local app and waits for its first auto check 3 s after start (3.3-5.5 s alone), so bun's 5 s default is too
// tight under full-suite load; 30 s leaves room for the 20 s backup wait to fail with its own message.
test("with a short interval the local app saves an auto backup by itself, readable as an archive, and reports its time", async () => {
  const local = await boot(47961, 60_000);
  const made = await (await local.call("/api/pages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "자동 백업 대상" }) })).json() as { slug: string };
  await new Promise<void>((resolve, reject) => {
    const stateFile = join(local.dataDir, "auto-backup.json");
    const watcher = watch(local.dataDir, () => { if (existsSync(stateFile)) { watcher.close(); clearTimeout(limit); resolve(); } });
    const limit = setTimeout(() => { watcher.close(); reject(new Error("no auto backup within 20 s")); }, 20_000);
    if (existsSync(stateFile)) { watcher.close(); clearTimeout(limit); resolve(); }
  });
  const status = await (await local.call("/__local/archive/auto")).json() as any;
  expect(status.intervalMs).toBe(60_000);
  expect(status.local.name).toMatch(/^auto-\d{8}-\d{6}\.zip$/);
  expect(typeof status.local.at).toBe("number");
  expect(autoFiles(local.dataDir)).toEqual([status.local.name]);
  const parts = await readArchive(new Uint8Array(await Bun.file(join(local.dataDir, "backups", status.local.name)).arrayBuffer()));
  expect(parts.tables.get("pages")!.map((p) => p.slug)).toContain(made.slug);
  const again = await (await local.call("/__local/archive/auto")).json() as any;
  expect(again.local.name).toBe(status.local.name);
  expect(again.next).toBe(status.local.at + 60_000);
}, 30_000);

test("only the newest 7 auto backups stay; restore safety copies are left alone", async () => {
  const local = await boot(47962, 3_600_000);
  mkdirSync(join(local.dataDir, "backups"), { recursive: true });
  writeFileSync(join(local.dataDir, "backups", "before-restore-20260101-0000.zip"), "x");
  for (let i = 0; i < 9; i++) expect((await local.call("/__local/archive/auto", { method: "POST" })).status).toBe(200);
  const files = autoFiles(local.dataDir).sort();
  expect(files.length).toBe(7);
  expect(readdirSync(join(local.dataDir, "backups"))).toContain("before-restore-20260101-0000.zip");
  const status = await (await local.call("/__local/archive/auto")).json() as any;
  expect(status.files[0]).toBe(files[files.length - 1]);
}, 15_000); // boots the local app and writes 9 archives (0.6-2.6 s alone); the 5 s default is too tight under full-suite load
