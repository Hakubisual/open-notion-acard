(function (root) {
  "use strict";
  var NAME = "acard-recent-cache", KEY = "/__recent-cache", EPOCH = "acard-cache-epoch";
  var id = root.document?.querySelector('meta[name="acard-id"]')?.content;
  var member = typeof id === "string" && /^[0-9a-f]{16}$/.test(id);
  NAME += "-" + id;
  var sb = root.document && (root.AcardLazy || {}).scrollbars;
  if (sb) root.document.head.appendChild(Object.assign(root.document.createElement("script"), { src: "/lazy/scrollbars.js?v=" + sb.js }));
  function touch(entries, key, value) {
    var next = entries.filter(function (entry) { return entry.key !== key; });
    next.push({ key: key, value: value });
    var pages = next.filter(function (entry) { return entry.key !== "/tree"; });
    return next.filter(function (entry) { return entry.key === "/tree" || pages.indexOf(entry) >= pages.length - 30; });
  }
  function race(cached, server, show) {
    var finished = false, visible;
    var read = Promise.resolve(cached).catch(function () { return null; }).then(function (value) {
      if (!finished && value) { visible = value; show(value, "loading"); }
    });
    return Promise.resolve(server).then(function (value) {
      finished = true;
      show(value, "ready", JSON.stringify(visible) !== JSON.stringify(value));
      return value;
    }, function (error) {
      return read.then(function () { finished = true; show(visible, "offline"); throw error; });
    });
  }
  var api = { touch: touch, race: race };
  root.AcardRecentCache = api;
  var editor = root.AcardEditor;
  if (!editor) return;
  // Local servers own persistence and do not issue hosted account identities.
  if (document.documentElement?.dataset.acardLocal !== undefined) {
    api.load = function (server) { return server; };
    editor.provide("recent-cache", api);
    return;
  }
  var epoch = localStorage.getItem(EPOCH), stopped = false;
  function current() {
    var cookie = /(?:^|;\s*)acard_id=([^;]*)/.exec(document.cookie || "");
    return !stopped && member && cookie && cookie[1] === id && localStorage.getItem(EPOCH) === epoch
      && document.querySelector('meta[name="acard-id"]')?.content === id;
  }
  // Another tab holding the lock or a stuck CacheStorage must not keep the editor locked: give up after 2 s.
  function access(change) {
    if (!member || !root.caches || !navigator.locks) return Promise.resolve(null);
    return Promise.race([new Promise(function (resolve) { setTimeout(resolve, 2000, null); }), navigator.locks.request(NAME, async function () {
      if (!current()) return null;
      for (var name of await caches.keys()) if (name.startsWith("acard-recent-cache") && name !== NAME) await caches.delete(name);
      var cache = await caches.open(NAME), response = await cache.match(KEY);
      var entries = response ? await response.json() : [];
      if (!current()) return null;
      var result = change(entries);
      if (result.entries) await cache.put(KEY, new Response(JSON.stringify(result.entries)));
      return current() ? result.value : null;
    }).catch(function () { return null; })]);
  }
  function read(key) {
    return access(function (entries) {
      var entry = entries.find(function (item) { return item.key === key; });
      return { value: entry && entry.value, entries: entry ? touch(entries, key, entry.value) : null };
    });
  }
  function write(key, value) { return access(function (entries) { return { entries: touch(entries, key, value) }; }); }
  var doc = document.getElementById("doc"), side = document.getElementById("sidebar");
  function lock(on) {
    doc.inert = side.inert = on;
    document.getElementById("more").inert = on;
    editor.state.cacheLocked = on;
  }
  // Capture before document keyboard shortcuts can mutate cached state.
  root.addEventListener("keydown", function (event) {
    if (editor.state.cacheLocked && event.key !== "Tab") { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  root.addEventListener("storage", function (event) {
    if (event.key === EPOCH || event.key === null) { stopped = true; lock(true); doc.replaceChildren(); side.replaceChildren(); location.replace("/"); }
  });
  api.load = function (server, preview, tree) {
    lock(true);
    editor.setSave("불러오는 중…", true);
    var treeDone = false;
    read("/tree").then(function (data) { if (data && !treeDone && current()) tree(data); });
    editor.api("/tree").then(function (data) { treeDone = true; if (current()) tree(data); return write("/tree", data); }).catch(function () {});
    var key = "/page/" + encodeURIComponent(editor.slug);
    var cached, offline = false;
    var cachedPage = read(key).then(function (record) {
      cached = record;
      return record && record.version === 1 ? record.snapshot : record;
    });
    return race(cachedPage, server, function (data, state) {
      if (!current()) return;
      // Rendering can normalize blocks in place. The cached edit base must retain the exact server snapshot.
      if (state === "loading") { preview(JSON.parse(JSON.stringify(data))); document.documentElement.dataset.recentCache = "loading"; }
      if (state === "ready") { lock(false); document.documentElement.dataset.recentCache = "ready"; }
      if (state === "offline") {
        document.documentElement.dataset.recentCache = "offline";
        editor.setSave(navigator.onLine === false ? "오프라인 · 읽기 전용. 다시 연결한 뒤 새로고침해 주세요." : "불러오지 못했어요 · 읽기 전용. 새로고침해 주세요.", true);
      }
    }).catch(function (error) {
      var data = cached && cached.snapshot, page = data && data.page;
      var unavailable = error && (error.acardFailure === "offline-cache" && error.acardIdentity === id
        || error.acardFailure === "network" && navigator.onLine === false);
      if (!editor.coreEditing || !unavailable || !current() || !cached || cached.version !== 1 || cached.identity !== id || cached.epoch !== epoch || cached.key !== key
        || !page || page.slug !== editor.slug || page.kind !== "note" || data.dbRow || typeof page.title !== "string"
        || !Number.isSafeInteger(page.updated) || page.updated < 0 || !Array.isArray(data.blocks)
        || data.blocks.some(function (block) { return !block || typeof block.id !== "string" || !block.id || typeof block.type !== "string" || typeof block.text !== "string"; })
        || new Set(data.blocks.map(function (block) { return block.id; })).size !== data.blocks.length
        || !editor.saveQueue || !editor.saveQueue.ready || !editor.saveQueue.isCurrent()) throw error;
      offline = true;
      editor.base = { title: page.title, blocks: JSON.parse(JSON.stringify(data.blocks)), updated: page.updated };
      editor.state.baseUpdated = page.updated;
      editor.state.offlineBase = true;
      // Returning the snapshot lets normal startup emit ready. Do not unlock until its asynchronous queue restore finishes.
      editor.saveQueue.ready.then(function () {
        if (!current() || !editor.saveQueue.isCurrent()) return;
        lock(false);
        document.documentElement.dataset.recentCache = "offline-editable";
        editor.saveQueue.refreshStatus();
      }).catch(function (failure) { lock(true); editor.setSave(failure.message, true); });
      return JSON.parse(JSON.stringify(data));
    }).then(function (data) {
      if (stopped) throw Error("로그아웃됨");
      if (!offline) write(key, { version: 1, identity: id, epoch: epoch, key: key, snapshot: JSON.parse(JSON.stringify(data)) });
      return data;
    });
  };
  editor.provide("recent-cache", api);
})(typeof window === "undefined" ? globalThis : window);
