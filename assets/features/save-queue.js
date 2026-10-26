(function (root) {
  "use strict";
  var PREFIX = "acard-save-queue:";
  var copy = function (value) { return JSON.parse(JSON.stringify(value)); };
  function recordKey(entry) { return entry.writerId || entry.archiveId ? "writer:" + JSON.stringify([entry.writerId || "", entry.slug, entry.archiveId || ""]) : entry.slug; }
  function decoded(entry) {
    if (!entry.page_slug) return entry;
    var row = Object.assign({}, entry, { slug: entry.page_slug });
    delete row.page_slug;
    return row;
  }
  function delay(attempt) { return Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5))); }

  // Journal first; bounded IndexedDB steps and tombstones preserve pending edits.
  var STEP_MS = 2000;
  function within(promise, fallback) {
    return new Promise(function (resolve) {
      var done = false, timer = setTimeout(function () { finish(fallback); }, STEP_MS);
      function finish(value) { if (!done) { done = true; clearTimeout(timer); resolve(value); } }
      Promise.resolve(promise).then(finish, function () { finish(fallback); });
    });
  }
  function opened(request) {
    return new Promise(function (resolve) {
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () { db.close(); };
        resolve(db);
      };
      request.onerror = function (event) { if (event && event.preventDefault) event.preventDefault(); resolve(null); };
      request.onblocked = function () {};
    });
  }
  function storage(local, indexed, identity) {
    if (!identity) return { read: function () { return []; }, write: function () {} };
    var prefix = PREFIX + identity + ":", name = "acard-save-queue:" + identity;
    function open(version) {
      var request;
      try { request = version ? indexed.open(name, version) : indexed.open(name); } catch (_) { return Promise.resolve(null); }
      request.onupgradeneeded = function () { if (!request.result.objectStoreNames.contains("pages")) request.result.createObjectStore("pages", { keyPath: "slug" }); };
      return opened(request).then(function (db) { if (db) return db; request.onsuccess = function () { request.result.close(); }; return null; });
    }
    function readAll(db) {
      return new Promise(function (resolve, reject) {
        var request = db.transaction("pages").objectStore("pages").getAll();
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    }
    function repair(db) {
      if (!db) return null;
      if (!db.objectStoreNames.contains("pages")) { var next = db.version + 1; db.close(); return within(open(next), null); }
      // An unreadable database may still hold the only copy of a foreign draft.
      return within(readAll(db).then(function () { return db; }, function () { db.close(); return null; }), null);
    }
    var database = indexed ? within(open(1).then(function (db) { return db || within(open(0), null); }).then(repair), null) : Promise.resolve(null);
    function journal() {
      var records = [];
      if (local) for (var i = 0; i < local.length; i++) {
        var key = local.key(i);
        if (key && key.indexOf(prefix) === 0) records.push(JSON.parse(local.getItem(key)));
      }
      return records;
    }
    return {
      read: function () {
        return database.then(function (db) {
          if (!db) return journal().map(decoded);
          return within(new Promise(function (resolve, reject) {
            var request;
            try { request = db.transaction("pages").objectStore("pages").getAll(); } catch (_) { resolve(journal()); return; }
            request.onsuccess = function () { try { resolve(request.result.concat(journal())); } catch (error) { reject(error); } };
            request.onerror = function () { try { resolve(journal()); } catch (error) { reject(error); } };
          }), null).then(function (rows) { return (rows || journal()).map(decoded); });
        });
      },
      write: function (entry) {
        if (entry.acard_id !== identity) return Promise.resolve();
        entry = Object.assign({}, entry, { page_slug: entry.slug, slug: recordKey(entry) });
        var durable = false;
        try { if (local) { local.setItem(prefix + entry.slug, JSON.stringify(entry)); durable = true; } } catch (_) {}
        return database.then(function (db) {
          if (!db) { if (!durable) throw new Error("기기에 변경을 보관할 수 없어요. 이 탭을 닫지 마세요."); return; }
          var stored = new Promise(function (resolve, reject) {
            var tx;
            try { tx = db.transaction("pages", "readwrite"); tx.objectStore("pages").put(entry); } catch (error) { if (durable) resolve(); else reject(error); return; }
            tx.oncomplete = function () { resolve(); };
            tx.onerror = tx.onabort = function () { if (durable) resolve(); else reject(tx.error || new Error("기기 저장 공간을 확인해 주세요.")); };
          });
          return durable ? within(stored, undefined) : stored;
        });
      }
    };
  }

  function create(options) {
    var records = new Map(), active = new Map(), writes = new Map(), texts = new Map(), recovery = new Map(), sequence = 0, suspended = false;
    var identity = options.identity || "", writerId = options.writerId || "";
    var now = options.now || Date.now;
    var invalidated = false;
    function validSession() { if (options.isCurrent && !options.isCurrent()) invalidated = true; return !invalidated; }
    function changed() { if (options.changed) options.changed(); }
    function persist(entry, text) {
      records.set(entry.slug, entry);
      // The serialized payload of the live record, so a repeat enqueue compares strings instead of re-stringifying.
      if (text) texts.set(entry.slug, text); else texts.delete(entry.slug);
      var pending;
      try { pending = Promise.resolve(identity ? options.storage.write(copy(entry)) : undefined); }
      catch (error) { pending = Promise.reject(error); }
      writes.set(entry.slug, pending);
      // Expose errors to the UI without creating an unhandled rejected promise.
      pending.catch(function (error) { if (options.error) options.error(error); });
      changed();
      return pending;
    }
    function next() { sequence = Math.max(sequence + 1, now() * 1000); return sequence; }
    function entries() { return Array.from(records.values()).filter(function (entry) { return entry.payload; }); }
    function enqueue(slug, payload) {
      if (!validSession()) return null;
      var old = records.get(slug), text = JSON.stringify(payload);
      if (old && old.payload) {
        if (!texts.has(slug)) texts.set(slug, JSON.stringify(old.payload));
        if (texts.get(slug) === text) return old;
      }
      var entry = { slug: slug, acard_id: identity, writerId: writerId, base_updated: payload.base_updated, payload: JSON.parse(text), sequence: next(), updated: now(), attempts: 0, nextAt: 0,
        blocked: old && old.base_updated === payload.base_updated ? old.blocked : 0 };
      persist(entry, text);
      return entry;
    }
    async function remove(entry) {
      if (!validSession()) return;
      var tombstone = { slug: entry.slug, acard_id: identity, writerId: writerId, sequence: next(), payload: null };
      // Keep the live draft until its tombstone is durable, including quota failures.
      if (identity) await options.storage.write(copy(tombstone));
      if (validSession() && records.get(entry.slug).sequence === entry.sequence) {
        records.set(entry.slug, tombstone);
        texts.delete(entry.slug);
      }
      changed();
    }
    function attempt(slug, force) {
      if (active.has(slug)) return active.get(slug);
      if (suspended || !validSession()) return Promise.resolve(null);
      var entry = records.get(slug);
      if (!entry || !entry.payload || entry.acard_id !== identity || !Number.isSafeInteger(entry.base_updated) || entry.blocked || (!force && entry.nextAt > now())) return Promise.resolve(null);
      var run = Promise.resolve(writes.get(slug)).then(function () {
        if (suspended || !validSession()) return null;
        return options.send(slug, copy(entry.payload));
      }).then(async function (response) {
        if (!response || !validSession()) return null;
        var current = records.get(slug);
        if (response.ok) {
          var result = await response.clone().json();
          if (!validSession()) return null;
          if (Number.isSafeInteger(result.updated)) {
            if (options.saved) options.saved(slug, entry.payload, result.updated);
            current = records.get(slug);
            // Only our acknowledged write can rebase newer typing.
            if (current.sequence !== entry.sequence && current.base_updated === entry.base_updated) {
              await persist(Object.assign({}, current, { base_updated: result.updated, payload: Object.assign({}, current.payload, { base_updated: result.updated }) }));
            }
          }
        }
        if (current.sequence !== entry.sequence) {
          if (response.status === 409 && current.base_updated === entry.base_updated) await persist(Object.assign({}, current, { blocked: 409 }));
          return response;
        }
        if (response.ok && !suspended) await remove(entry);
        else if (response.ok) return response;
        else if (response.status >= 400 && response.status < 500) {
          await persist(Object.assign({}, entry, { blocked: response.status }));
        } else {
          await persist(Object.assign({}, entry, { attempts: entry.attempts + 1, nextAt: now() + delay(entry.attempts) }));
        }
        return response;
      }, async function (error) {
        if (validSession() && records.get(slug).sequence === entry.sequence) {
          await persist(Object.assign({}, entry, { attempts: entry.attempts + 1, nextAt: now() + delay(entry.attempts) }));
        }
        throw error;
      }).finally(function () { active.delete(slug); changed(); });
      active.set(slug, run);
      changed();
      return run;
    }
    function recover(stored) {
      stored.forEach(function (entry) {
        if (entry.acard_id !== identity || (!entry.archiveId && (entry.writerId || "") === writerId)) return;
        var key = recordKey(entry), current = recovery.get(key);
        if (!current || entry.sequence >= current.sequence) recovery.set(key, entry);
      });
    }
    var queue = {
      ready: Promise.resolve(identity ? options.storage.read() : []).then(function (stored) {
        if (!validSession()) return;
        // Recovery may finish after this tab edited or acknowledged a save. Its
        // shared snapshot is never a continuation of those local edits.
        var local = new Set(records.keys());
        recover(stored);
        stored.forEach(function (entry) {
          if (entry.acard_id !== identity || (entry.writerId || "") !== writerId || entry.archiveId) return;
          sequence = Math.max(sequence, entry.sequence);
          if (local.has(entry.slug)) return;
          var current = records.get(entry.slug);
          if (!current || entry.sequence >= current.sequence) { records.set(entry.slug, entry); texts.delete(entry.slug); }
        });
        changed();
      }),
      enqueue: enqueue, entries: entries, attempt: attempt, remove: remove,
      get: function (slug) { return records.get(slug); },
      busy: function () { return active.size > 0; },
      suspended: function () { return suspended || !validSession(); },
      resume: function () { if (validSession()) suspended = false; changed(); },
      recoveryDrafts: function () {
        if (!validSession()) return Promise.resolve([]);
        return Promise.resolve(options.storage.read()).then(function (stored) {
          if (!validSession()) return [];
          recover(stored);
          return copy(Array.from(recovery.values()).filter(function (entry) { return entry.payload; }));
        });
      },
      restoreDraft: async function (draft) {
        await queue.ready;
        if (!validSession() || draft.acard_id !== identity || !draft.payload || !Number.isSafeInteger(draft.base_updated)
          || draft.payload.base_updated !== draft.base_updated || active.size || entries().length) throw Error("Draft recovery unavailable");
        var source = (await queue.recoveryDrafts()).find(function (entry) {
          return recordKey(entry) === recordKey(draft) && entry.sequence === draft.sequence && JSON.stringify(entry.payload) === JSON.stringify(draft.payload);
        });
        if (!source || !validSession() || active.size || entries().length) throw Error("Draft recovery unavailable");
        suspended = true;
        var entry = enqueue(source.slug, source.payload);
        await writes.get(source.slug);
        if (!validSession() || records.get(source.slug) !== entry) throw Error("Draft changed while recovering");
        return copy(entry);
      },
      archiveAndClear: async function (slug, settle) {
        suspended = true;
        changed();
        await queue.ready;
        await Promise.all(Array.from(active.values()).map(function (request) { return request.catch(function () {}); }));
        if (settle) await settle();
        var entry = records.get(slug);
        if (!entry || !entry.payload) return null;
        await writes.get(slug);
        if (!validSession()) throw Error("Draft identity changed");
        if (records.get(slug).sequence !== entry.sequence) throw Error("Draft changed while archiving");
        var archive = Object.assign({}, copy(entry), { archiveId: String(next()), archived: now() });
        if (!identity) throw Error("Draft identity unavailable");
        await options.storage.write(copy(archive));
        if (!validSession()) throw Error("Draft identity changed");
        recovery.set(recordKey(archive), archive);
        if (records.get(slug).sequence !== entry.sequence) throw Error("Draft changed while archiving");
        await remove(entry);
        if (records.get(slug).payload) throw Error("Draft changed while archiving");
        return copy(archive);
      },
      block: function (entry) { return validSession() ? persist(Object.assign({}, entry, { blocked: 409 })) : Promise.resolve(); },
      flush: function (force) {
        return Promise.all(entries().map(function (entry) { return attempt(entry.slug, force).catch(function () {}); }));
      }
    };
    return queue;
  }
  root.AcardSaveQueue = { create: create, storage: storage, delay: delay, within: within };
  var editor = root.AcardEditor;
  if (!editor || document.documentElement?.dataset.acardLocal !== undefined) return;
  var previous = editor.transport, timer, initialized = false, recovering = false, storageError = "", edited = false, notBefore = 0, idlePending = false;
  var identity = document.querySelector('meta[name="acard-id"]')?.content || "";
  var writerId = editor.writerId || (editor.coreEditing ? (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) : "");
  editor.writerId = writerId;
  var local;
  try { local = root.localStorage; } catch (_) {}
  var epoch = local && local.getItem("acard-cache-epoch"), invalidated = false;
  function isCurrent() {
    var cookie = /(?:^|;\s*)acard_id=([^;]*)/.exec(document.cookie || "");
    if (!identity || !cookie || cookie[1] !== identity || document.querySelector('meta[name="acard-id"]')?.content !== identity
      || (local && local.getItem("acard-cache-epoch")) !== epoch) invalidated = true;
    return !invalidated;
  }
  var readyResolve, readyReject;
  var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
  ready.catch(function () {});
  var queue = create({
    identity: identity,
    writerId: writerId,
    isCurrent: isCurrent,
    storage: storage(local, root.indexedDB, identity),
    send: function (slug, payload) { idlePending = true; return previous.call(editor, slug, payload); },
    saved: function (slug, payload, updated) { if (slug === editor.slug && editor.state.baseUpdated === payload.base_updated) { editor.state.baseUpdated = updated; editor.state.offlineBase = false; } },
    changed: function () { if (queue) update(); },
    error: function (error) { storageError = error.message; update(); }
  });
  function update() {
    if (!queue || !initialized) return;
    clearTimeout(timer);
    if (!isCurrent()) { editor.setSave("로그인 정보가 바뀌었어요. 새로고침해 주세요.", true); return; }
    var pending = queue.entries();
    var blocked = pending.find(function (entry) { return entry.blocked; });
    var text = storageError || (blocked ? (blocked.blocked === 409
      ? "저장 충돌 - 기기에 보관했어요. 서버 내용을 확인해 주세요."
      : "저장 중단 (" + blocked.blocked + ") - 기기에 보관했어요. 로그인과 권한을 확인해 주세요.")
      : pending.length ? (navigator.onLine === false ? "오프라인 - " + pending.length + "개 대기 중" : recovering || pending.some(function (entry) { return entry.attempts; }) ? "저장 안 된 변경을 다시 보내는 중" : "저장 중…") : editor.state.offlineBase ? "오프라인 · 기기에 저장된 페이지" : "저장됨");
    var element = document.getElementById("save-state");
    if (element && ((element.dataset && element.dataset.text) ?? element.textContent) !== text) editor.setSave(text, !!pending.length || !!storageError);
    if (!pending.length && !editor.state.saving && JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks }) === acknowledged) editor.state.dirty = false;
    var due = pending.filter(function (entry) { return !entry.blocked && Number.isSafeInteger(entry.base_updated); });
    if (due.length && !queue.busy() && !queue.suspended() && navigator.onLine !== false) {
      timer = setTimeout(function () { commit(); queue.flush(false).then(settled); }, Math.max(0, Math.max(notBefore, Math.min.apply(null, due.map(function (entry) { return entry.nextAt; }))) - Date.now()));
    }
  }
  var acknowledged = "";
  function settled() {
    if (!isCurrent()) { update(); return; }
    if (!pendingChange && (!queue.get(editor.slug) || !queue.get(editor.slug).payload)) {
      acknowledged = JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks });
    }
    recovering = false;
    update();
    if (idlePending && !queue.suspended() && canAdoptRemote()) {
      idlePending = false;
      root.dispatchEvent(new CustomEvent("saveQueueIdle", { detail: { slug: editor.slug } }));
    }
  }
  // Typing emits "change" per keystroke. The journal takes the first edit at once and later ones at most every
  // CHANGE_MS (the blocks array is live, so the commit holds the newest text); a save, pagehide, visibility
  // change or the queue's own flush timer commits the rest first, so nothing waits on the timer.
  var CHANGE_MS = 300, pendingChange = null, changeTimer = null, captured = 0;
  function capture(payload) {
    if (!isCurrent()) return;
    edited = true;
    pendingChange = null;
    if (changeTimer) { clearTimeout(changeTimer); changeTimer = null; }
    captured = Date.now();
    queue.enqueue(editor.slug, Object.assign({}, payload, { base_updated: editor.state.baseUpdated }));
  }
  function commit() { changeTimer = null; if (pendingChange) capture(pendingChange); }
  function captureSoon(payload) {
    if (!isCurrent()) return;
    edited = true;
    pendingChange = payload;
    if (changeTimer) return;
    var wait = captured + CHANGE_MS - Date.now();
    if (wait <= 0) commit();
    else changeTimer = setTimeout(commit, wait);
  }
  function canAdoptRemote() {
    return isCurrent() && initialized && !storageError && !pendingChange && !editor.state.saving && !queue.busy() && !queue.entries().length;
  }
  editor.saveQueue = {
    ready: ready, isCurrent: isCurrent, refreshStatus: update,
    stageRecovery: function (draft) {
      commit();
      if (!initialized || storageError || editor.state.dirty || editor.state.saving || draft.slug !== editor.slug) return Promise.reject(Error("Draft recovery unavailable"));
      return queue.restoreDraft(draft);
    },
    canAdoptRemote: canAdoptRemote,
    continueDraft: function () { if (editor.state.dirty) capture({ title: editor.state.title, blocks: editor.state.blocks }); queue.resume(); },
    acceptRemote: function (snapshot) {
      if (!canAdoptRemote()) return false;
      acknowledged = JSON.stringify({ title: snapshot.page ? snapshot.page.title : snapshot.title, blocks: snapshot.blocks });
      queue.resume();
      return true;
    },
    archiveAndClear: function () {
      commit();
      if (editor.state.dirty) capture({ title: editor.state.title, blocks: editor.state.blocks });
      return queue.archiveAndClear(editor.slug, async function () {
        if (editor.whenSaveSettled) await editor.whenSaveSettled();
        else if (editor.state.saving) throw Error("Core save is still active");
        commit();
      }).then(function (archive) {
        commit();
        if (queue.entries().length) throw Error("Draft changed while archiving");
        return archive;
      });
    },
    recoveryDrafts: function () { return queue.ready.then(function () { return queue.recoveryDrafts(); }); }
  };
  editor.on("change", function (payload) { notBefore = Date.now() + 750; captureSoon(payload); });
  editor.on("beforeSave", capture);
  editor.transport = function (slug, payload) {
    queue.enqueue(slug, payload);
    return queue.ready.then(function () { return queue.attempt(slug, false); }).then(function (response) {
      if (response && response.ok && queue.get(slug).payload) return queue.attempt(slug, true);
      return response;
    }).then(function (response) {
      if (!isCurrent()) return new Response(JSON.stringify({ error: "Draft identity changed" }), { status: 401 });
      if (!response) {
        var entry = queue.get(slug);
        return new Response(JSON.stringify({ error: "저장 중단 - 기기에 보관했어요." }), { status: entry && entry.blocked || 503 });
      }
      return response.clone();
    }).finally(settled);
  };
  editor.on("saved", settled);
  editor.on("saveFailed", function () { recovering = false; update(); });
  editor.on("ready", function () {
    return queue.ready.then(async function () {
      if (!isCurrent()) throw Error("Draft identity changed");
      var entry = queue.get(editor.slug);
      if (entry && entry.payload && !edited) {
        editor.state.title = entry.payload.title;
        editor.state.blocks = copy(entry.payload.blocks);
        editor.state.dirty = true;
        editor.state.baseUpdated = entry.base_updated;
        editor.render();
        if (!Number.isSafeInteger(entry.base_updated) || editor.base && entry.base_updated !== editor.base.updated) await queue.block(entry);
        else recovering = !entry.blocked;
      }
      if (edited && editor.state.dirty) capture({ title: editor.state.title, blocks: editor.state.blocks });
      if (!isCurrent()) throw Error("Draft identity changed");
      if (storageError) throw Error(storageError);
      initialized = true;
      update();
      readyResolve();
      if (navigator.onLine !== false) await queue.flush(false);
      settled();
    }).catch(function (error) { storageError = error.message; initialized = true; readyReject(error); update(); });
  });
  // Core callers also write status after rejecting save(); keep the durable state visible.
  var status = document.getElementById("save-state");
  if (status) new MutationObserver(function () { if (initialized && queue.entries().length) update(); }).observe(status, { childList: true });
  function flush() {
    if (!isCurrent()) { update(); return; }
    commit();
    if (!initialized) return;
    if (editor.state.dirty) capture({ title: editor.state.title, blocks: editor.state.blocks });
    queue.flush(true).then(settled);
  }
  root.addEventListener("online", flush);
  root.addEventListener("storage", function (event) {
    if (event.key !== "acard-cache-epoch" && event.key !== null) return;
    invalidated = true;
    clearTimeout(timer); clearTimeout(changeTimer);
    readyReject(Error("Draft identity changed"));
    update();
  });
  root.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", flush);
})(typeof window === "undefined" ? globalThis : window);
