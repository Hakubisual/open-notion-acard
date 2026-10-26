(() => {
  registerFeature({ api: async ({ path, method, request, db, helpers }) => {
    const match = /^\/api\/page\/([^/]+)\/blocks$/.exec(path);
    if (!match) return null;
    const { json } = helpers;
    if (method !== "PATCH") return json({ error: "지원하지 않는 방법이에요." }, 405);
    let slug;
    try { slug = resolveSlug(decodeURIComponent(match[1])); }
    catch { return json({ error: "주소를 읽지 못했어요." }, 400); }
    const body = await request.json().catch(() => null);
    const validId = id => typeof id === "string" && id.length > 0 && id.length <= 60;
    if (!body || !Number.isSafeInteger(body.base_updated) || body.base_updated < 0
      || !Array.isArray(body.upserts) || !Array.isArray(body.deletes)
      || body.upserts.length > 2000 || body.deletes.length > 2000
      || body.upserts.some(block => !block || !validId(block.id) || !Number.isInteger(block.ord) || block.ord < 0 || block.ord >= 2000)
      || body.deletes.some(id => !validId(id))
      || new Set(body.upserts.map(block => block.id)).size !== body.upserts.length
      || new Set(body.deletes).size !== body.deletes.length
      || body.upserts.some(block => body.deletes.includes(block.id))
      || (body.order !== undefined && (!Array.isArray(body.order) || body.order.length > 2000 || body.order.some(id => !validId(id)) || new Set(body.order).size !== body.order.length))
      || (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim()))) {
      return json({ error: "변경한 블록과 기준 버전을 확인해 주세요." }, 400);
    }
    const current = await readPage(db, slug);
    if (!current) return json({ error: "없는 페이지예요." }, 404);
    const conflict = async () => { const current = await readPage(db, slug); return json({ error: "conflict", updated: current?.page.updated, current }, 409); };
    if (current.page.updated !== body.base_updated) return conflict();
    // The same raw snapshot as captureEditorVersion preserves opaque metadata,
    // settings and links for the existing history restore route.
    const snapshot = await snapshotPage(db, slug);
    if (!snapshot || snapshot.page.updated !== body.base_updated) return conflict();
    const old = new Map(snapshot.blocks.map(block => [block.id, block]));
    if (body.deletes.some(id => !old.has(id))) return json({ error: "없는 블록이에요." }, 400);
    const raw = new Map(current.blocks.map(block => [block.id, block]));
    for (const id of body.deletes) raw.delete(id);
    for (const block of body.upserts) raw.set(block.id, block);
    guardSyncedWrite((body.order ?? current.blocks.map(block => block.id)).map(id => raw.get(id)).filter(Boolean), slug, current.blocks);
    const buttons = new Set();
    const upserts = await guardButtonBlocks(db, current.blocks, humanMarkSaves(current.blocks, normaliseBlocks(body.upserts), Date.now(), await humanAgentPage(db, slug)), buttons);
    const blocks = new Map(current.blocks.map(block => [block.id, block]));
    for (const id of body.deletes) blocks.delete(id);
    for (const block of upserts) blocks.set(block.id, block);
    const order = body.order ?? current.blocks.map(block => block.id);
    if (blocks.size > 2000 || order.length !== blocks.size || order.some(id => !blocks.has(id))
      || body.upserts.some(block => order[block.ord] !== block.id)) return json({ error: "블록 순서를 확인해 주세요." }, 400);
    let ordered = order.map(id => blocks.get(id));
    // Column structure is a whole-page rule (notion-parity C13): run it on the merged list and store every block it
    // moved, including ancestors the client did not send because they did not change on its side.
    let deletes = body.deletes, saves = upserts, finalOrder = order;
    const structured = globalThis.ColumnsModel.clampColumnsDepth(ordered);
    const reshaped = structured !== ordered;
    if (reshaped) {
      const keep = new Set(structured.map(block => block.id));
      const sent = new Set(upserts.map(block => block.id));
      deletes = body.deletes.concat(ordered.filter(block => !keep.has(block.id) && old.has(block.id)).map(block => block.id));
      saves = structured.filter(block => sent.has(block.id) || block !== blocks.get(block.id));
      finalOrder = structured.map(block => block.id);
      ordered = structured;
    }
    guardSyncedWrite(ordered, slug, current.blocks);
    const title = body.title === undefined ? snapshot.page.title : body.title.trim().slice(0, 200);
    const updated = Math.max(Date.now(), body.base_updated + 1);
    const hash = blocksHash(ordered);
    const version = crypto.randomUUID();
    // The history row is the transaction's claim token. A writer that loses
    // the compare-and-swap cannot mutate blocks, links, title or history.
    const guard = "EXISTS (SELECT 1 FROM editor_history WHERE id = ?)";
    const statements = [db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE slug = ? AND updated = ? AND hash IS ?) AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ?)")
      .bind(version, slug, snapshot.page.title, Date.now(), JSON.stringify(snapshot), slug, body.base_updated, snapshot.page.hash, slug)];
    for (const id of deletes) statements.push(db.prepare(`DELETE FROM blocks WHERE page = ? AND id = ? AND ${guard}`).bind(slug, id, version));
    saves.forEach(block => {
      statements.push(db.prepare(`INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard} ON CONFLICT(page, id) DO UPDATE SET ord = excluded.ord, type = excluded.type, text = excluded.text, checked = excluded.checked, indent = excluded.indent, meta = excluded.meta`)
        .bind(slug, block.id, finalOrder.indexOf(block.id), block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null, version));
    });
    const touched = new Set(saves.map(block => block.id));
    finalOrder.forEach((id, ord) => {
      if (!touched.has(id) && old.get(id).ord !== ord) statements.push(db.prepare(`UPDATE blocks SET ord = ? WHERE page = ? AND id = ? AND ${guard}`).bind(ord, slug, id, version));
    });
    // Links belong to pages, not blocks. Diff the union so deleting a mention
    // does not remove a backlink still referenced by an untouched block.
    const beforeLinks = new Set(snapshot.links.map(link => link.dst));
    const afterLinks = new Set(linksOf(ordered));
    for (const dst of beforeLinks) if (!afterLinks.has(dst)) statements.push(db.prepare(`DELETE FROM links WHERE src = ? AND dst = ? AND ${guard}`).bind(slug, dst, version));
    for (const dst of afterLinks) if (!beforeLinks.has(dst)) statements.push(db.prepare(`INSERT OR IGNORE INTO links (src, dst) SELECT ?, ? WHERE ${guard}`).bind(slug, dst, version));
    statements.push(db.prepare(`UPDATE pages SET title = ?, updated = ?, source = 'editor', hash = ? WHERE slug = ? AND ${guard}`).bind(title, updated, hash, slug, version));
    // issue 107: who saved each new button action list (a press later runs with no more than that person's permission).
    for (const id of buttons) statements.push(buttonSaverStatement(db, blockButtonKey(slug, id), { sql: guard, binds: [version] }));
    const result = await db.batch(statements);
    if (!Number(result[0]?.meta?.changes)) return conflict();
    if (body.title !== undefined) await syncPageTitleToRow(db, slug, title);
    const page = { ...snapshot.page, title, updated, source: "editor", hash };
    for (const hook of ACARD_FEATURES.afterSave) {
      try { await hook(db, slug, ordered, page); }
      catch (error) { console.error("Feature afterSave failed", error); }
    }
    return json({ ok: true, updated, hash, blocks: ordered.length, ...(reshaped ? { reshaped: true } : {}) });
  } });
})();
