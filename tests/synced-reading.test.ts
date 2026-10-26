import { afterEach, beforeEach, expect, test } from "bun:test";
import { setup } from "./db-harness";
import { assembleWorkerSource } from "./assemble-worker";
import { impReadZip } from "../import-zip";

const workerSource = assembleWorkerSource().replace("return Object.assign(__worker, { acardHost });", "return Object.assign(__worker, { acardHost, exportTest: exportPage });");

const MEDIA = "abcd1234abcd1234";
let h: ReturnType<typeof setup>;
const row = (id: string, type: string, text = "", indent = 0, meta: any = null) => ({ id, type, text, indent, meta });
async function blocks(slug: string, values: ReturnType<typeof row>[]) {
  await h.env.DB.prepare("DELETE FROM blocks WHERE page = ?").bind(slug).run();
  for (const [ord, b] of values.entries()) await h.env.DB.prepare("INSERT INTO blocks (page,id,ord,type,text,checked,indent,meta) VALUES (?,?,?,?,?,0,?,?)")
    .bind(slug, b.id, ord, b.type, b.text, b.indent, b.meta ? JSON.stringify(b.meta) : null).run();
}
async function guest(source = false, copy = false) {
  const token = "g".repeat(43);
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  await h.env.DB.prepare("INSERT INTO share_sessions (token_hash,email,links,created,expires) VALUES (?,?,?,?,?)").bind(hash, "reader@test.dev", "[]", Date.now(), Date.now() + 60000).run();
  for (const slug of source ? ["reference", "source"] : ["reference"]) {
    await h.env.DB.prepare("INSERT INTO share_rules (id,page,principal,role,created) VALUES (?,?,?,?,?)").bind("guest-" + slug, slug, "email:reader@test.dev", "read", Date.now()).run();
    await h.env.DB.prepare("INSERT INTO share_pages (page,allow_export) VALUES (?,?)").bind(slug, slug === "reference" || copy ? 1 : 0).run();
  }
  return Reflect.get(h.worker, "acardHost").trust({ ...h.env, ACARD_GUEST_TOKEN: token });
}
async function request(path: string, env: any) {
  return h.worker.fetch(new Request("https://notes.test" + path), env);
}
async function link(slug = "reference") {
  const response = await h.call("PUT", "/api/page/" + slug + "/access/general", { mode: "link", role: "read" });
  expect(response.status).toBe(200);
  return response.data.link.url as string;
}
beforeEach(async () => {
  h = setup({ worker: new Function(workerSource)() });
  h.env.MEDIA = { getWithMetadata: async () => ({ value: new Uint8Array([1, 2]).buffer, metadata: { mime: "image/png", name: "private.png" } }) };
  for (const slug of ["reference", "source"]) expect((await h.call("POST", "/api/pages", { slug, title: slug })).status).toBe(200);
  await blocks("source", [
    row("root", "synced", "", 0, { synced: { v: 1, source: null } }),
    row("heading", "heading1", "Shared heading", 1),
    row("text", "paragraph", "PRIVATE_SENTINEL", 1, { richText: [{ text: "PRIVATE_SENTINEL", bold: true }] }),
    row("todo", "to_do", "Review", 1),
    row("action", "button", "Create", 1, { actions: [{ type: "create_row", database: "private-db" }] }),
    row("image", "image", "picture", 1, { src: "/media/" + MEDIA }),
    row("frame", "html", "<p>PRIVATE_FRAME</p>", 1),
    row("outside", "paragraph", "OUTSIDE_SENTINEL"),
  ]);
  await blocks("reference", ["one", "two"].map(id => row(id, "synced", "", 0, { synced: { v: 1, source: { page: "source", block: "root" } } })));
});
afterEach(() => h.sqlite.close());

test("resolved GET returns scoped readonly rich HTML without action hooks", async () => {
  const response = await h.call("GET", "/api/page/reference/synced");
  expect(response.status).toBe(200);
  const [one, two] = response.data.resolved;
  expect(one).toMatchObject({ status: "available", source: { page: "source", block: "root" }, editable: true });
  expect(one.source_updated).toBeNumber();
  expect(one.html).toContain("<strong>PRIVATE_SENTINEL</strong>");
  expect(one.html).not.toMatch(/data-check=|data-button=|data-suggest=|OUTSIDE_SENTINEL/);
  expect(one.html).not.toContain("/lazy/buttons.js");
  const ids = [...(one.html + two.html).matchAll(/\bid="([^"]+)"/g)].map((m: RegExpMatchArray) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("reader expands source and scopes duplicate anchors without mutable reference controls", async () => {
  const response = await h.call("GET", "/reference/");
  expect(response.status).toBe(200);
  expect(response.data).toContain("<strong>PRIVATE_SENTINEL</strong>");
  expect(response.data).not.toMatch(/data-check=|data-button=|OUTSIDE_SENTINEL/);
  const ids = [...response.data.matchAll(/\bid="([^"]+)"/g)].map((m: RegExpMatchArray) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("canonical reader keeps its own source checkbox binding", async () => {
  const response = await h.call("GET", "/source/");
  expect(response.status).toBe(200);
  expect(response.data).toContain('data-check="todo"');
});

test("synced builtin parts carry their runtime instead of waiting for an absent parent loader", async () => {
  await blocks("source", [row("root", "synced", "", 0, { synced: { v: 1, source: null } }),
    row("part", "part", JSON.stringify({ items: [{ label: "Status", value: "Ready" }] }), 1, { part: "badge", v: 1 })]);
  const response = await h.call("GET", "/api/page/reference/synced");
  expect(response.status).toBe(200);
  expect(response.data.resolved[0].html).toContain("go({acpCode:");
});

test("guest reader and resolved HTML fail closed then reflect source permission", async () => {
  const env = await guest();
  const denied = await (await request("/reference/", env)).text();
  expect(denied).toContain("synced-unavailable");
  expect(denied).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_FRAME|abcd1234abcd1234/);
  expect(await (await request("/api/page/reference/synced", env)).json()).toMatchObject({ resolved: [{ id: "one", status: "unavailable" }, { id: "two", status: "unavailable" }] });
  await h.env.DB.prepare("INSERT INTO share_rules (id,page,principal,role,created) VALUES ('source-read','source','email:reader@test.dev','read',1)").run();
  expect(await (await request("/reference/", env)).text()).toContain("PRIVATE_SENTINEL");
});

test("portable HTML markdown and print materialize authorized source without target metadata", async () => {
  for (const path of ["/api/export?slug=reference&format=md", "/api/export?slug=reference&format=html", "/print/reference/"]) {
    const response = await h.call("GET", path);
    expect(response.status).toBe(200);
    expect(response.data).toContain("PRIVATE_SENTINEL");
    expect(response.data).not.toMatch(/OUTSIDE_SENTINEL|data-check=|data-button=/);
  }
});

test("restricted exports require source copy permission and never leak fallback targets", async () => {
  const env = await guest(true);
  for (const format of ["md", "html", "acard-md"]) {
    const text = await (await request("/api/export?slug=reference&format=" + format, env)).text();
    expect(text).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_FRAME|abcd1234abcd1234|\/source\/|"source"/);
    expect(text).toContain("Synced content unavailable");
  }
  expect(await (await request("/print/reference/", env)).text()).not.toContain("PRIVATE_SENTINEL");
  await h.env.DB.prepare("UPDATE share_pages SET allow_export = 1 WHERE page = 'source'").run();
  expect(await (await request("/api/export?slug=reference&format=md", env)).text()).toContain("PRIVATE_SENTINEL");
});

test("agent portable acard export narrows source independently and restricted ZIP is refused", async () => {
  await h.env.DB.prepare("INSERT INTO share_rules (id,page,principal,role,created) VALUES ('agent-source','source','agent:name:reader','none',1)").run();
  const env = { ...h.env, ACARD_SAVE_PRINCIPAL: { name: "reader", scopes: ["read"] } };
  const exportPage = Reflect.get(h.worker, "exportTest");
  const response = await exportPage(h.env.DB, new URL("https://notes.test/api/export?slug=reference&format=acard-md"), env);
  const text = await response.text();
  expect(text).not.toMatch(/PRIVATE_SENTINEL|\/source\/|"source"/);
  expect(text).toContain("Synced content unavailable");
  expect((await exportPage(h.env.DB, new URL("https://notes.test/api/export?scope=all&format=zip"), env)).status).toBe(403);
});

test("workspace backup preserves references and includes canonical source media once", async () => {
  await h.env.DB.prepare("INSERT INTO media (id,page,name,mime,bytes,created) VALUES (?,'source','private.png','image/png',2,1)").bind(MEDIA).run();
  const response = await Reflect.get(h.worker, "exportTest")(h.env.DB, new URL("https://notes.test/api/export?scope=all&format=zip"), h.env);
  expect(response.status).toBe(200);
  const { entries } = await impReadZip(new Uint8Array(await response.arrayBuffer()));
  const textOf = async (name: string) => new TextDecoder().decode(await entries.find(entry => entry.path === name)!.read());
  expect(await textOf("reference.md")).toContain('"source":{"page":"source","block":"root"}');
  expect(await textOf("source.md")).toContain("PRIVATE_SENTINEL");
  expect(entries.filter(entry => entry.path.startsWith("files/" + MEDIA))).toHaveLength(1);
  const env = await guest(true, true);
  expect((await request("/api/export?scope=all&format=zip", env)).status).toBe(401);
});

test("one public token cannot borrow another token's source access for text media or frames", async () => {
  const url = await link();
  await link("source");
  const response = await h.call("GET", url, undefined, true);
  expect(response.status).toBe(200);
  expect(response.data).toContain("synced-unavailable");
  expect(response.data).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_FRAME|abcd1234abcd1234/);
  expect((await h.call("GET", url + "/media/" + MEDIA, undefined, true)).status).toBe(404);
  expect((await h.call("GET", url + "/frame/frame", undefined, true)).status).toBe(404);
});

test("public source expansion binds frame and signed media reads to the same token", async () => {
  await h.env.DB.prepare("UPDATE pages SET parent = 'reference' WHERE slug = 'source'").run();
  const url = await link();
  const response = await h.call("GET", url, undefined, true);
  expect(response.status).toBe(200);
  expect(response.data).toContain("PRIVATE_SENTINEL");
  expect(response.data).not.toContain("OUTSIDE_SENTINEL");
  const frame = /src="([^"]+\/frame\/[^"?]+)"/.exec(response.data)?.[1];
  const media = new RegExp('src="([^" ]+/media/' + MEDIA + '[^" ]*)"').exec(response.data)?.[1]?.replaceAll("&amp;", "&");
  expect(frame).toBeTruthy();
  expect(media).toBeTruthy();
  expect((await h.call("GET", frame!, undefined, true)).data).toContain("PRIVATE_FRAME");
  expect((await h.call("GET", media!, undefined, true)).status).toBe(200);
  await h.env.DB.prepare("INSERT INTO share_pages (page,inherit) VALUES ('source',0)").run();
  expect((await h.call("GET", frame!, undefined, true)).status).toBe(404);
  expect((await h.call("GET", media!, undefined, true)).status).toBe(404);
});
