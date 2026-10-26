(function () {
  "use strict";
  var editor = window.AcardEditor;
  if (!editor) return;
  var busy = false, pending = null, mounted = new Map(), paints = new WeakMap();
  function endpoint() { return "/page/" + encodeURIComponent(editor.slug) + "/synced"; }
  function node(tag, text) { var el = document.createElement(tag); if (text) el.textContent = text; return el; }
  function snapshot() { return JSON.stringify({ title: editor.state.title, blocks: editor.state.blocks }); }
  async function adopt() {
    var current = await editor.api("/page/" + encodeURIComponent(editor.slug));
    var remote = { title: current.page.title, blocks: current.blocks, updated: current.page.updated };
    if (editor.state.dirty || editor.state.saving || (editor.saveQueue && !editor.saveQueue.acceptRemote(remote))) throw Error("저장된 내용을 다시 불러와 주세요.");
    var selection = editor.captureSelection();
    editor.state.title = remote.title; editor.state.blocks = remote.blocks; editor.state.baseUpdated = remote.updated;
    editor.base = JSON.parse(JSON.stringify(remote));
    editor.remoteHistory(remote, true);
    editor.render(); editor.restoreSelection(selection);
  }
  async function locked(run) {
    if (!editor.coreEditing || busy) throw Error("동기화 작업이 진행 중이에요.");
    busy = true;
    var doc = document.getElementById("doc"), previous = doc.inert;
    doc.inert = true;
    try {
      await editor.lazy("editor-selection");
      await editor.lazy("block-commands");
      await editor.save();
      if (editor.state.dirty || editor.state.saving) throw Error("수정 내용을 먼저 저장해 주세요.");
      return await run();
    } finally { busy = false; doc.inert = previous; }
  }
  function mutate(path, body) {
    return locked(async function () {
      var before = snapshot();
      var result = await editor.api(path, { method: "POST", body: JSON.stringify(Object.assign({}, body, { base_updated: editor.state.baseUpdated })) });
      if (snapshot() !== before || editor.state.dirty) throw Error("동기화는 저장됐어요. 현재 초안을 보관하고 새로고침해 주세요.");
      var receipt = result.receipt;
      await adopt();
      editor.recordExternalEdit(function () {
        return locked(async function () {
          var result = await editor.api(endpoint(), { method: "POST", body: JSON.stringify({ undo: receipt.history, base_updated: receipt.reference_updated, source_updated: receipt.source_updated }) });
          receipt = result.receipt;
          await adopt();
        });
      });
      editor.setSave("동기화 블록을 저장했어요. Ctrl+Z로 되돌릴 수 있어요.", false);
      return receipt;
    });
  }
  function resolve() {
    // Share only requests in flight; re-rendering must not retain revoked source content.
    if (!pending) {
      var request = editor.api(endpoint()).finally(function () { if (pending === request) pending = null; });
      pending = request;
    }
    return pending;
  }
  async function mount(host, block) {
    mounted.set(host, block);
    var paint = {}; paints.set(host, paint);
    host.className = "synced-block";
    host.replaceChildren(node("span", "동기화 블록"));
    if (block.meta && block.meta.synced && block.meta.synced.source === null) return;
    var content = node("div", "불러오는 중…"); content.className = "synced-content"; content.contentEditable = "false";
    host.appendChild(content);
    try {
      var result = await resolve();
      if (paints.get(host) !== paint) return;
      var item = result.resolved.find(function (entry) { return entry.id === block.id; });
      if (!item || item.status !== "available" || typeof item.html !== "string") { content.textContent = "동기화 내용을 볼 수 없어요."; return; }
      content.innerHTML = item.html;
      if (content.querySelector(".acp-frame")) editor.lazy("parts").catch(function () {});
      if (!editor.coreEditing) return;
      var actions = node("div"); actions.className = "synced-actions";
      var link = node("a", "원본 편집"); link.href = "/edit/" + encodeURIComponent(item.source.page) + "/#block-" + encodeURIComponent(item.source.block);
      if (item.editable) actions.appendChild(link);
      var detach = node("button", "동기화 해제"); detach.type = "button"; detach.className = "mini";
      detach.onclick = function () { editor.commands.detachSynced(block.id, item.source_updated).catch(function (error) { editor.setSave(error.message, true); }); };
      actions.appendChild(detach); host.appendChild(actions);
    } catch (error) { if (paints.get(host) === paint) content.textContent = "동기화 내용을 볼 수 없어요."; }
  }
  document.addEventListener("acard:live", function (event) {
    var slugs = event.detail.slugs || [];
    pending = null;
    mounted.forEach(function (block, host) {
      if (!host.isConnected) { mounted.delete(host); return; }
      var source = block.meta && block.meta.synced && block.meta.synced.source;
      if (source && (!slugs.length || slugs.indexOf(source.page) >= 0)) mount(host, block);
    });
  });
  function choose(beforeId) {
    var dialog = node("dialog"); dialog.className = "editor-panel synced-picker";
    var title = node("h2", "동기화 블록 가져오기"), close = node("button", "닫기"); close.type = "button"; close.className = "mini"; close.onclick = function () { dialog.close(); };
    var pages = node("select"), sources = node("select"), status = node("p"), insert = node("button", "넣기");
    pages.setAttribute("aria-label", "원본 페이지"); sources.setAttribute("aria-label", "동기화 원본"); status.setAttribute("role", "status"); insert.type = "button"; insert.className = "mini"; insert.disabled = true;
    editor.state.pages.filter(function (page) { return page.slug !== editor.slug && page.kind !== "db"; }).forEach(function (page) { var option = node("option", page.title); option.value = page.slug; pages.appendChild(option); });
    var version, generation = 0;
    async function load() {
      var mine = ++generation; insert.disabled = true; sources.replaceChildren(); status.textContent = "불러오는 중…";
      if (!pages.value) { status.textContent = "선택할 페이지가 없어요."; return; }
      try {
        var data = await editor.api("/page/" + encodeURIComponent(pages.value) + "/synced");
        if (mine !== generation || !dialog.isConnected) return;
        version = data.updated;
        data.resolved.filter(function (item) { return item.status === "available" && item.source.page === pages.value && item.source.block === item.id; }).forEach(function (item, i) {
          var option = node("option", (item.blocks || []).map(function (block) { return block.text; }).join(" ").slice(0, 80) || "동기화 원본 " + (i + 1)); option.value = item.id; sources.appendChild(option);
        });
        insert.disabled = !sources.options.length; status.textContent = insert.disabled ? "이 페이지에는 동기화 원본이 없어요." : "";
      } catch (error) { if (mine === generation) status.textContent = "원본을 불러올 수 없어요."; }
    }
    pages.onchange = load;
    insert.onclick = async function () {
      insert.disabled = true;
      try { await editor.commands.insertSynced({ page: pages.value, block: sources.value }, version, beforeId); dialog.close(); }
      catch (error) { status.textContent = error.message; insert.disabled = false; }
    };
    dialog.append(title, close, pages, sources, insert, status); dialog.addEventListener("close", function () { generation++; dialog.remove(); }); document.body.appendChild(dialog); dialog.showModal(); load();
    return dialog;
  }
  if (editor.coreEditing) {
    Object.assign(editor.commands, {
      createSynced: function (ids) { return mutate(endpoint(), { ids: ids }); },
      insertSynced: function (source, updated, beforeId) { return mutate(endpoint(), Object.assign({ source: source, source_updated: updated }, beforeId ? { beforeId: beforeId } : {})); },
      detachSynced: function (id, updated) { return mutate(endpoint() + "/" + encodeURIComponent(id) + "/detach", { source_updated: updated }); }
    });
    var items = [
      { id: "synced-create", label: "동기화 블록으로 만들기", run: function (ctx) { var ids = editor.getSelection().blockIds; return editor.commands.createSynced(ids.length ? ids : [ctx.blockId]); } },
      { id: "synced-insert", label: "동기화 블록 가져오기", run: function (ctx) { return choose(ctx.blockId); } }
    ];
    ["contextMenu", "palette"].forEach(function (name) {
      var registry = editor[name] || (editor[name] = {});
      items.forEach(function (item) {
        var entry = Object.assign({ scope: "block", group: "insert" }, item);
        if (registry.register) registry.register(entry); else (registry.queue || (registry.queue = [])).push(entry);
      });
    });
  }
  editor.provide("synced-blocks", { mount: mount });
})();
