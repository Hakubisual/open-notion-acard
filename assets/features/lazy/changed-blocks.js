(function () {
  var editor = window.AcardEditor;
  if (!editor) return;
  var saved = new Map();
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      var result = {};
      Object.keys(value).sort().forEach(function (key) { result[key] = stable(value[key]); });
      return result;
    }
    return value;
  }
  function hash(block) {
    var text = JSON.stringify(stable({ id: block.id, type: block.type || "paragraph", text: block.text || "",
      checked: block.checked === true, indent: block.indent || 0, meta: block.meta || null }));
    var value = 5381;
    for (var i = 0; i < text.length; i++) value = ((value << 5) + value + text.charCodeAt(i)) | 0;
    return value >>> 0;
  }
  function remember(slug, title, blocks, updated) {
    var state = { title: title, updated: updated, order: blocks.map(function (block) { return block.id; }),
      hashes: new Map(blocks.map(function (block) { return [block.id, hash(block)]; })) };
    saved.set(slug, state);
    return state;
  }
  async function read(slug) {
    var current = await editor.api("/page/" + encodeURIComponent(slug));
    return remember(slug, current.page.title, current.blocks, current.page.updated);
  }
  if (editor.on) editor.on("remoteAdopted", function (snapshot) { remember(editor.slug, snapshot.title, snapshot.blocks, snapshot.updated); });
  editor.provide("changed-blocks", { send: async function (slug, payload) {
    // Freeze the submitted state before an asynchronous read or network send.
    payload = JSON.parse(JSON.stringify(payload));
    if (!Number.isSafeInteger(payload.base_updated)) return new Response(JSON.stringify({ error: "불러오지 못했어요 · 읽기 전용. 새로고침해 주세요." }), { status: 428 });
    var base = saved.get(slug);
    if (!base && slug === editor.slug && editor.base) base = remember(slug, editor.base.title, editor.base.blocks, editor.base.updated);
    if (editor.state && editor.state.recoveredDraft && base && base.updated !== payload.base_updated) base = await read(slug);
    if (!base) base = await read(slug);
    if (base.updated !== payload.base_updated) return new Response(JSON.stringify({ error: "conflict", updated: base.updated }), { status: 409 });
    var next = new Map(payload.blocks.map(function (block) { return [block.id, hash(block)]; }));
    var order = payload.blocks.map(function (block) { return block.id; });
    var delta = { base_updated: base.updated, upserts: [], deletes: base.order.filter(function (id) { return !next.has(id); }) };
    payload.blocks.forEach(function (block, ord) {
      if (base.hashes.get(block.id) !== next.get(block.id)) delta.upserts.push(Object.assign({}, block, { ord: ord }));
    });
    if (JSON.stringify(order) !== JSON.stringify(base.order)) delta.order = order;
    if (payload.title !== base.title) delta.title = payload.title;
    if (!delta.upserts.length && !delta.deletes.length && !delta.order && delta.title === undefined) {
      return new Response(JSON.stringify({ ok: true, updated: base.updated, blocks: order.length }));
    }
    if (editor.saveQueue && !editor.saveQueue.isCurrent()) throw Error("Draft identity unavailable");
    var response = await fetch("/api/page/" + encodeURIComponent(slug) + "/blocks", {
      method: "PATCH", headers: { "content-type": "application/json", "x-acard-client": editor.clientId || "" }, body: JSON.stringify(delta)
    });
    if (response.ok) {
      var result = await response.clone().json();
      // The server moved column blocks (notion-parity C13), so the next delta must start from what it stored.
      if (result.reshaped) await read(slug);
      else remember(slug, payload.title, payload.blocks, result.updated);
    }
    return response;
  } });
})();
