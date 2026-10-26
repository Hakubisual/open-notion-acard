import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const source = await Bun.file(new URL("../assets/features/lazy/recent-cache.js", import.meta.url)).text();
const context = { Promise };
runInNewContext(source, context);
const { touch, race } = context.AcardRecentCache;
test("explicit local mode uses the server without locking or accessing hosted caches", async () => {
  let feature;
  const local = { Promise, document: { documentElement: { dataset: { acardLocal: "" } }, querySelector: () => null },
    AcardEditor: { provide: (_name, value) => { feature = value; } } };
  runInNewContext(source, local);
  const data = { page: { title: "Local" }, blocks: [] };
  expect(await feature.load(Promise.resolve(data))).toBe(data);
  await expect(feature.load(Promise.reject(Error("server unavailable")))).rejects.toThrow("server unavailable");
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("LRU keeps thirty pages and tree, touching a page protects it", () => {
  let entries = touch([], "/tree", { pages: [] });
  for (let i = 0; i < 30; i++) entries = touch(entries, String(i), { title: String(i) });
  entries = touch(entries, "0", { title: "touched" });
  entries = touch(entries, "30", { title: "new" });
  expect(entries).toHaveLength(31);
  expect(entries.find(e => e.key === "1")).toBeUndefined();
  expect(entries.find(e => e.key === "0").value.title).toBe("touched");
  expect(entries.find(e => e.key === "/tree")).toBeDefined();
});

for (const [name, cached, server] of [
  ["older", { updated: 1 }, { updated: 2 }],
  ["newer", { updated: 3 }, { updated: 2 }],
  ["identical", { updated: 2 }, { updated: 2 }],
]) test(`server authority wins against ${name} cache`, async () => {
  const request = deferred(), painted = deferred(), events = [];
  const run = race(Promise.resolve(cached), request.promise, (...event) => { events.push(event); painted.resolve(); });
  await painted.promise;
  expect(events[0]).toEqual([cached, "loading"]);
  request.resolve(server);
  expect(await run).toEqual(server);
  expect(events[1]).toEqual([server, "ready", name !== "identical"]);
});

test("late cache never replaces a server response", async () => {
  const cached = deferred(), events = [];
  await race(cached.promise, Promise.resolve({ title: "server" }), (...event) => events.push(event));
  cached.resolve({ title: "stale" });
  await cached.promise;
  expect(events).toEqual([[{ title: "server" }, "ready", true]]);
});

test("missing or unavailable cache still loads server", async () => {
  for (const cached of [Promise.resolve(null), Promise.reject(Error("storage denied"))]) {
    const events = [];
    await race(cached, Promise.resolve({ title: "server" }), (...event) => events.push(event));
    expect(events).toEqual([[{ title: "server" }, "ready", true]]);
  }
});

test("server error retains cached content without unlocking even when cache is late", async () => {
  const cached = deferred(), failed = deferred(), events = [];
  const run = race(cached.promise, failed.promise, (...event) => events.push(event));
  const rejected = run.catch(error => error);
  failed.reject(Error("offline"));
  cached.resolve({ title: "cached" });
  expect((await rejected).message).toBe("offline");
  expect(events).toEqual([[{ title: "cached" }, "loading"], [{ title: "cached" }, "offline"]]);
});
