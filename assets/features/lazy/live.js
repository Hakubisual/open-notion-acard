(function () {
  if (window.AcardLive || !window.WebSocket) return;
  var editor = /^\/edit\//.test(location.pathname);
  var slug = decodeURIComponent((location.pathname.match(/^\/(?:edit\/)?([^/]+)\/?$/) || [])[1] || "index");
  if (slug === "home") slug = "index";
  var last = Number(sessionStorage.getItem("acard-live-id") || 0);
  var socket = null, retry = 0, timer = null, hideTimer = null, lastInput = 0, bar = null, pending = false;
  var identity = (document.querySelector('meta[name="acard-id"]') || {}).content || "";
  var channel = null, suspended = false, heartbeat = null;
  if (slug === "home") slug = "index";
  var CID = "c" + Math.random().toString(36).slice(2, 12);
  var api = { events: [], status: "idle", client: CID };
  window.AcardLive = api;
  function adoptRemote(remote) {
    var ed = window.AcardEditor, state = ed.state;
    if (remote.updated < state.baseUpdated) return "stale";
    if (state.dirty || state.saving || (window.AcardEditor.saveQueue && !window.AcardEditor.saveQueue.canAdoptRemote())) return "busy";
    var documentText = JSON.stringify({ title: remote.title, blocks: remote.blocks });
    var same = documentText === JSON.stringify({ title: state.title, blocks: state.blocks });
    if (same && remote.updated === state.baseUpdated) return "unchanged";
    var selection = ed.captureSelection();
    if (window.AcardEditor.saveQueue && !window.AcardEditor.saveQueue.acceptRemote(remote)) return "busy";
    state.title = remote.title; state.blocks = JSON.parse(JSON.stringify(remote.blocks));
    state.baseUpdated = remote.updated;
    window.AcardEditor.base = { title: remote.title, blocks: JSON.parse(JSON.stringify(remote.blocks)), updated: remote.updated };
    ed.remoteHistory(remote);
    if (!same) { ed.render(); ed.restoreSelection(selection); }
    state.dirty = false; ed.setSave("저장됨", false);
    return same ? "unchanged" : "applied";
  }
  if (window.AcardEditor) window.AcardEditor.adoptRemote = adoptRemote;
  if (window.AcardEditor) window.AcardEditor.restoreDraft = async function (draft) {
    var editor = window.AcardEditor;
    await editor.lazy("editor-selection");
    var before = JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks });
    var entry;
    try {
      entry = await editor.saveQueue.stageRecovery(draft);
      if (!editor.saveQueue.isCurrent() || editor.state.dirty || editor.state.saving
        || JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks }) !== before) throw Error("Draft changed while recovering");
    } catch (error) {
      if (editor.state.dirty && editor.saveQueue.isCurrent()) editor.saveQueue.continueDraft();
      throw error;
    }
    var payload = entry.payload;
    editor.state.title = payload.title;
    editor.state.blocks = JSON.parse(JSON.stringify(payload.blocks));
    editor.state.baseUpdated = entry.base_updated;
    editor.state.recoveredDraft = true;
    editor.remoteHistory();
    editor.render();
    editor.state.dirty = true;
    editor.saveQueue.continueDraft();
  };
  if (window.AcardEditor) window.AcardEditor.resolveRemote = async function () {
    var editor = window.AcardEditor;
    try {
      await editor.lazy("editor-selection");
      var archived = await editor.saveQueue.archiveAndClear();
      var before = JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks });
      var data = await editor.api("/page/" + encodeURIComponent(editor.slug));
      if (JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks }) !== before || !editor.saveQueue.canAdoptRemote()) throw Error("수정이 계속되고 있어요. 내 초안은 보관했어요.");
      editor.state.dirty = false;
      var result = editor.adoptRemote({ title: data.page.title, blocks: data.blocks || [], updated: data.page.updated });
      if (result === "busy" || result === "stale") { editor.state.dirty = true; throw Error("새 내용을 다시 확인해 주세요. 내 초안은 보관했어요."); }
      return { result: result, archive: archived };
    } catch (error) { editor.saveQueue.continueDraft(); throw error; }
  };

  document.addEventListener("input", function () { lastInput = Date.now(); }, true);
  document.addEventListener("keydown", function () { lastInput = Date.now(); }, true);

  function dropCachedViews() {
    if (!window.caches) return Promise.resolve();
    return caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return /^acard-pages-/.test(n); }).map(function (n) {
        return caches.open(n).then(function (cache) {
          return cache.keys().then(function (keys) {
            return Promise.all(keys.filter(function (r) { return !/\/api\/page\//.test(r.url); }).map(function (r) { return cache.delete(r); }));
          });
        });
      }));
    }).catch(function () {});
  }

  // One tree read in flight, at most one queued behind it. The read goes past the service worker's stale copy and a
  // read that never settles is given up after 8 s: before this, one hung read left treeBusy set forever, every later
  // notice only queued, and the sidebar stopped following live changes (#17: burst p95 104 s, offline catch-up, restore).
  var treeBusy = null, treeAgain = false;
  function reloadFolders() {
    if (!window.AcardFolders || !window.AcardFolders.reload) { document.dispatchEvent(new CustomEvent("acard:tree-fresh")); return; }
    if (treeBusy) { treeAgain = true; return; }
    // A query string makes the service worker go to the network instead of answering with its stale copy; the read is
    // aborted after 8 s. Most tree reads answer in ~100 ms but a single one now and then stalls for 0.5-2.5 s on the
    // server, so a read with no answer after 400 ms gets a second copy and the first answer wins.
    var ctl = window.AbortController ? new AbortController() : null, guard, hedge;
    var get = function () {
      return fetch("/api/folders/tree?fresh=" + Date.now() + Math.random().toString(36).slice(2, 6), { cache: "no-store", credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
        .then(function (r) { if (!r.ok) throw new Error("tree " + r.status); return r.json(); });
    };
    var read = new Promise(function (ok, bad) {
      var inflight = 0, hedged = false, done = false;
      var fire = function () {
        inflight += 1;
        get().then(function (d) { if (!done) { done = true; clearTimeout(hedge); ok(d); } }, function (e) {
          inflight -= 1;
          if (done) return;
          if (!hedged) { hedged = true; clearTimeout(hedge); fire(); } else if (!inflight) { done = true; bad(e); }
        });
      };
      fire();
      hedge = setTimeout(function () { if (!hedged) { hedged = true; fire(); } }, 400);
    });
    read.then(function () { if (ctl) ctl.abort(); }, function () {});
    var run = Promise.race([
      Promise.resolve().then(function () { return window.AcardFolders.reload(read); }),
      new Promise(function (ok) { guard = setTimeout(function () { if (ctl) ctl.abort(); ok(); }, 8000); }),
    ]).catch(function () {}).then(function () {
      clearTimeout(guard);
      if (treeBusy !== run) return;
      treeBusy = null;
      if (treeAgain) { treeAgain = false; reloadFolders(); }
    });
    treeBusy = run;
  }
  function refreshTree() {
    reloadFolders();
    if (editor && window.AcardEditor && window.AcardEditor.loadTree) window.AcardEditor.loadTree();
    document.dispatchEvent(new CustomEvent("acard:live-home"));
    if (!window.AcardFolders && !editor && document.getElementById("side-tree")) {
      fetch(location.pathname + "?live=" + Date.now(), { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.text() : null; }).then(function (html) {
        var fresh = html && new DOMParser().parseFromString(html, "text/html").getElementById("side-tree");
        var side = document.getElementById("side-tree");
        if (fresh && side && fresh.innerHTML !== side.innerHTML) side.innerHTML = fresh.innerHTML;
      }).catch(function () {});
    }
  }

  function swapReader() {
    if (window.AcardReader && window.AcardReader.refresh) window.AcardReader.refresh();
  }

  function editorState() { return window.AcardEditor && window.AcardEditor.state; }
  function snapshot(state) { return JSON.stringify({ t: state.title, b: state.blocks }); }

  async function applyEditor(data) {
    var ed = window.AcardEditor, state = editorState();
    if (!ed || !state || !data || !data.page) return;
    if (ed.lazy) await ed.lazy("editor-selection");
    var result = ed.adoptRemote({ title: data.page.title, blocks: data.blocks || [], updated: data.page.updated });
    if (result === "busy") { showBar(data); return; }
    hideBar();
  }

  function refreshEditor() {
    var state = editorState();
    if (!state) return;
    fetch("/api/page/" + encodeURIComponent(slug), { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !data.page) return;
      var now = editorState();
      if (snapshot({ title: data.page.title, blocks: data.blocks || [] }) === snapshot(now)) { applyEditor(data); return; }
      // issue 109: this tab's own save also comes back as a notice (the first save can go out before this file set the client
      // id). A version no newer than the one this tab last saved is not someone else's change; one still being saved
      // is checked again once that save settles.
      if (Number.isSafeInteger(now.baseUpdated) && data.page.updated <= now.baseUpdated) { hideBar(); return; }
      if (now.saving && window.AcardEditor && window.AcardEditor.on) {
        var off = [];
        var again = function () { off.forEach(function (f) { f(); }); refreshEditor(); };
        off.push(window.AcardEditor.on("saved", again), window.AcardEditor.on("saveFailed", again));
        return;
      }
      var idle = Date.now() - lastInput > 3000;
      if (!now.dirty && !now.saving && idle) applyEditor(data);
      else showBar(data);
    }).catch(function () {});
  }

  function showBar(data) {
    pending = data;
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "acard-live-bar";
      bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:60;display:flex;gap:10px;align-items:center;padding:8px 10px 8px 14px;border-radius:999px;background:var(--fg,#202733);color:var(--bg,#fff);font:500 var(--fs-14,14px)/1.4 inherit;box-shadow:0 6px 24px rgba(0,0,0,.18)";
      var text = document.createElement("span");
      text.textContent = "새 내용이 있어요";
      var view = document.createElement("button");
      view.type = "button";
      view.textContent = "보기";
      view.style.cssText = "border:0;border-radius:999px;padding:4px 12px;background:var(--accent,#7c5cff);color:#fff;font:inherit;cursor:pointer";
      view.onclick = function () {
        var state = editorState();
        if (state && (state.dirty || !window.AcardEditor.saveQueue.canAdoptRemote())) {
          if (!window.confirm("내 수정은 기기에 초안으로 보관하고 서버 내용을 볼까요?")) return;
          window.AcardEditor.resolveRemote().then(function () { hideBar(); }, function (error) { window.AcardEditor.setSave(error.message, true); });
          return;
        }
        fetch("/api/page/" + encodeURIComponent(slug), { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : pending; }, function () { return pending; }).then(applyEditor);
      };
      bar.append(text, view);
      document.body.appendChild(bar);
    }
    bar.hidden = false;
  }
  function hideBar() { if (bar) bar.hidden = true; pending = null; }
  if (window.AcardEditor && window.AcardEditor.coreEditing) window.AcardEditor.on("ready", function () {
    var editor = window.AcardEditor, menu = document.getElementById("more-menu");
    if (!menu) return;
    var button = document.createElement("button"); button.type = "button"; button.className = "menuitem"; button.textContent = "보관한 초안";
    button.onclick = async function () {
      var drafts = (await editor.saveQueue.recoveryDrafts()).filter(function (draft) { return draft.slug === editor.slug; });
      var dialog = document.createElement("dialog"); dialog.className = "editor-panel";
      var title = document.createElement("h2"); title.textContent = "보관한 초안";
      var close = document.createElement("button"); close.type = "button"; close.className = "mini"; close.textContent = "닫기"; close.onclick = function () { dialog.close(); };
      dialog.append(title, close);
      var note = document.createElement("p"); note.textContent = drafts.length ? "초안을 복구하거나 파일로 보관하세요. 저장 충돌 시 원본 초안은 유지됩니다." : "보관한 초안이 없어요."; dialog.appendChild(note);
      var status = document.createElement("p"); status.setAttribute("role", "status"); dialog.appendChild(status);
      drafts.forEach(function (draft) {
        var row = document.createElement("p"), download = document.createElement("button"); download.type = "button"; download.className = "mini";
        download.textContent = new Date(draft.archived || draft.updated).toLocaleString() + " · " + draft.payload.title;
        download.onclick = function () {
          var url = URL.createObjectURL(new Blob([JSON.stringify(draft.payload, null, 2)], { type: "application/json" }));
          var link = document.createElement("a"); link.href = url; link.download = draft.slug + "-draft.json"; link.click(); URL.revokeObjectURL(url);
        };
        var restore = document.createElement("button"); restore.type = "button"; restore.className = "mini"; restore.textContent = "초안 복구";
        restore.onclick = async function () {
          restore.disabled = true;
          try { await editor.restoreDraft(draft); dialog.close(); }
          catch (error) { status.textContent = editor.state.dirty ? "현재 변경을 저장한 뒤 초안을 복구해 주세요." : error.message; restore.disabled = false; }
        };
        row.append(download, restore); dialog.appendChild(row);
      });
      dialog.addEventListener("close", function () { dialog.remove(); }); document.body.appendChild(dialog); menu.hidden = true; dialog.showModal();
    };
    menu.appendChild(button);
  });

  // Notices that arrive together (a burst of agent writes, the backlog replayed after a reconnect) are applied as one
  // batch on the next frame: one cache sweep, one tree read and at most one page re-read for the whole batch.
  // Notices carry no titles or text by design, so the batch re-reads through the permission-checked APIs.
  var batch = null;
  function handle(event, local) {
    api.events.push({ id: event.id, t: event.t, at: Date.now(), kinds: event.kinds, slugs: event.slugs });
    if (api.events.length > 100) api.events.shift();
    document.dispatchEvent(new CustomEvent("acard:live", { detail: event }));
    if (!local && channel) channel.postMessage(event);
    var kinds = event.kinds || [];
    if (!batch) { batch = { tree: false, page: false }; setTimeout(flush, 16); }
    if (kinds.some(function (k) { return k === "tree" || k === "title" || k === "tags" || k === "journal" || k === "deleted" || k === "page"; })) batch.tree = true;
    var mine = (event.slugs || []).indexOf(slug) >= 0 && event.src !== CID;
    if (mine || (kinds.indexOf("page") >= 0 && !(event.slugs || []).length)) batch.page = true;
  }
  function flush() {
    var b = batch; batch = null;
    if (!b) return;
    // The live re-reads below all go past the service worker cache (query string / no-store), so they start at once
    // while the cached reader copies are dropped beside them.
    dropCachedViews();
    if (b.tree) refreshTree();
    if (b.page) { if (editor) refreshEditor(); else swapReader(); }
  }

  function openChannel() {
    if (channel || !window.BroadcastChannel || !identity) return;
    channel = new BroadcastChannel("acard-live:" + identity);
    channel.onmessage = function (m) { if (m.data && m.data.id > last) { last = m.data.id; sessionStorage.setItem("acard-live-id", String(last)); } handle(m.data || {}, true); };
  }

  function catchUp() {
    handle({ id: last, t: Date.now(), kinds: ["tree", "page"], slugs: [slug] }, true);
  }

  function open() {
    clearTimeout(timer);
    if (socket || document.hidden || suspended) return;
    api.status = "connecting";
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live?since=" + last;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { schedule(); return; }
    socket = ws;
    var reconnecting = retry > 0;
    ws.onmessage = function (m) {
      if (socket !== ws || suspended) return;
      if (m.data === "pong") return;
      var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.type === "hello") {
        retry = 0;
        api.status = "open";
        // Resume: the socket asked for ?since=<last seen id>; the feed replays what we missed from its backlog, or
        // says reset when the gap is past the backlog, and then this tab does one full refresh.
        var missed = msg.missed || [];
        var gap = msg.reset || (reconnecting && !missed.length && msg.id > last);
        last = Math.max(last, msg.id);
        sessionStorage.setItem("acard-live-id", String(last));
        if (gap) catchUp();
        missed.forEach(function (e) { handle(e); });
        return;
      }
      if (msg.type === "change") {
        if (msg.id <= last) return;
        last = msg.id;
        sessionStorage.setItem("acard-live-id", String(last));
        handle(msg);
      }
    };
    ws.onclose = function () { if (socket === ws) { socket = null; api.status = "closed"; schedule(); } };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function schedule() {
    if (document.hidden || suspended) return;
    retry += 1;
    var wait = Math.min(30000, 500 * Math.pow(2, Math.min(retry, 6))) * (0.7 + Math.random() * 0.6);
    timer = setTimeout(open, wait);
  }

  function close() {
    clearTimeout(timer);
    var ws = socket; socket = null;
    if (ws) { ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(1000, "background"); } catch (e) {} }
    api.status = "paused";
  }

  document.addEventListener("visibilitychange", function () {
    clearTimeout(hideTimer);
    if (document.hidden) hideTimer = setTimeout(close, 30000);
    else if (!socket) { retry = 1; open(); }
  });
  // Back online: a socket that looks open may be a dead one from before the drop, so always start a fresh one that
  // resumes from the last seen id.
  window.addEventListener("online", function () { if (socket) close(); retry = 1; open(); });
  window.addEventListener("offline", close);
  function resume() {
    suspended = false; openChannel();
    if (!heartbeat) heartbeat = setInterval(function () { if (socket && socket.readyState === 1) try { socket.send("ping"); } catch (e) {} }, 45000);
    open();
  }
  window.addEventListener("pagehide", function () {
    suspended = true; clearTimeout(hideTimer); close();
    clearInterval(heartbeat); heartbeat = null;
    if (channel) { channel.onmessage = null; channel.close(); channel = null; }
  });
  window.addEventListener("pageshow", resume);
  document.addEventListener("acard:navigated", function (e) {
    if (editor || slug === e.detail.slug) return;
    slug = e.detail.slug; hideBar();
    // The server socket is workspace-scoped; reconnect to renew its authorized subscription on a page change.
    close(); retry = 1; open();
  });

  // Only the client id is handed to the editor: its saves keep going through save-queue and changed-blocks. Replacing
  // editor.transport here gave the tab a second, unqueued sender, and a stale queued draft could land after a newer save.
  if (window.AcardEditor) window.AcardEditor.clientId = CID;
  if (window.AcardEditor && window.AcardEditor.on) window.AcardEditor.on("saved", function () {
    if (channel) channel.postMessage({ id: 0, t: Date.now(), kinds: ["page", "title"], slugs: [slug] });
    if (pending) refreshEditor();
  });
  window.addEventListener("saveQueueIdle", function () { if (pending) refreshEditor(); });

  api.open = open;
  api.close = close;
  resume();
})();
