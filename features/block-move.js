(() => {
  registerFeature({ api: async ({ path, method, request, db, env, helpers }) => {
    const match = /^\/api\/page\/([^/]+)\/move-blocks$/.exec(path);
    if (!match) return null;
    const { json } = helpers;
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => null);
    const validId = id => typeof id === "string" && id.length > 0 && id.length <= 60;
    const validVersion = value => Number.isSafeInteger(value) && value >= 0;
    if (!body || typeof body.target !== "string" || !body.target.trim() || body.target.length > 200
      || !validVersion(body.source_updated) || !validVersion(body.target_updated)
      || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 2000
      || body.ids.some(id => !validId(id)) || new Set(body.ids).size !== body.ids.length
      || (body.beforeId !== undefined && !validId(body.beforeId))
      || (body.undo !== undefined && (!validId(body.undo) || body.beforeId !== undefined))) {
      return json({ error: "invalid_move" }, 400);
    }
    let source, target;
    try { source = resolveSlug(decodeURIComponent(match[1])); target = resolveSlug(body.target); }
    catch { return json({ error: "invalid_page" }, 400); }
    if (!source || !target || source === target) return json({ error: "invalid_target" }, 400);
    // The route gate only checks its source. Reuse the same write resolver as row/button writes for BOTH pages.
    // A trusted guest without its role map must never be mistaken for an owner.
    if ((isGuest(env) && !db.acardRoles) || !canWriteSlug(db, source) || !canWriteSlug(db, target)) {
      return json({ error: "write_required" }, 401);
    }
    if (env.ACARD_SAVE_PRINCIPAL) {
      for (const slug of [source, target]) if (!(await narrowAgent(db, env.ACARD_SAVE_PRINCIPAL, slug)).scopes.includes("write")) {
        return json({ error: "write_required" }, 403);
      }
    }
    const current = await Promise.all([readPage(db, source), readPage(db, target)]);
    if (current.some(page => !page)) return json({ error: "page_not_found" }, 404);
    const conflict = async () => {
      const versions = await Promise.all([source, target].map(slug => db.prepare("SELECT updated FROM pages WHERE slug = ?").bind(slug).first()));
      return json({ error: "conflict", source_updated: versions[0]?.updated, target_updated: versions[1]?.updated }, 409);
    };
    if (current[0].page.updated !== body.source_updated || current[1].page.updated !== body.target_updated) return conflict();
    const [from, to] = await Promise.all([snapshotPage(db, source), snapshotPage(db, target)]);
    if (!from || !to || from.page.updated !== body.source_updated || to.page.updated !== body.target_updated) return conflict();
    const selected = new Set(body.ids), moved = [], roots = [];
    let sourceBlocks, targetBlocks, filler = null;
    if (body.undo !== undefined) {
      // Undo is a reference to our immutable server-side history, not client-supplied replacement content.
      // Both post-move versions must still be current, so undo cannot erase a later edit on either page.
      const row = await db.prepare("SELECT snapshot FROM editor_history WHERE id = ? AND page = ?").bind(body.undo, target).first();
      const original = row && parseJson(row.snapshot, null), move = original?.blockMove;
      if (!move || move.target !== source || move.source_updated !== body.target_updated || move.target_updated !== body.source_updated
        || move.ids.length !== selected.size || move.ids.some(id => !selected.has(id))) return json({ error: "invalid_receipt" }, 400);
      const other = await db.prepare("SELECT snapshot FROM editor_history WHERE id = ? AND page = ?").bind(move.target_history, source).first();
      const destination = other && parseJson(other.snapshot, null);
      if (!destination) return json({ error: "receipt_not_found" }, 404);
      moved.push(...from.blocks.filter(block => selected.has(block.id)));
      if (moved.length !== selected.size) return json({ error: "invalid_receipt" }, 400);
      sourceBlocks = destination.blocks;
      targetBlocks = original.blocks;
    } else {
      if (body.ids.some(id => !from.blocks.some(block => block.id === id))) return json({ error: "block_not_found" }, 400);
      // A selected ancestor subsumes selected descendants; each root carries its entire contiguous subtree.
      for (let index = 0; index < from.blocks.length; index++) {
        const root = from.blocks[index];
        if (!selected.has(root.id)) continue;
        let end = index + 1;
        while (end < from.blocks.length && from.blocks[end].indent > root.indent) end++;
        roots.push({ id: root.id, ord: index, indent: root.indent, beforeId: from.blocks[end]?.id ?? null });
        moved.push(...from.blocks.slice(index, end));
        index = end - 1;
      }
      // Canonical identities include their page; moving one would orphan every reference.
      if (moved.some(block => block.type === "synced" && cleanSyncedMeta(parseJson(block.meta, null))?.synced.source === null)) return json({ error: "synced_source_move" }, 400);
      const ids = new Set(moved.map(block => block.id));
      const subpages = new Set(moved.map(block => parseJson(block.meta, null)?.subpage).filter(Boolean));
      const ancestors = new Set();
      for (let slug = target; slug && !ancestors.has(slug);) {
        if (subpages.has(slug)) return json({ error: "target_in_selection" }, 400);
        ancestors.add(slug);
        if (!subpages.size) break;
        slug = (await db.prepare("SELECT parent FROM pages WHERE slug = ?").bind(slug).first())?.parent;
      }
      if (ids.has(body.beforeId)) return json({ error: "target_in_selection" }, 400);
      if (to.blocks.some(block => ids.has(block.id))) return json({ error: "duplicate_destination_id" }, 409);
      const at = body.beforeId === undefined ? to.blocks.length : to.blocks.findIndex(block => block.id === body.beforeId);
      if (at < 0) return json({ error: "destination_block_not_found" }, 400);
      const depth = body.beforeId === undefined ? 0 : to.blocks[at].indent;
      let offset = 0;
      const rootIds = new Set(roots.map(root => root.id));
      const placed = moved.map(block => {
        if (rootIds.has(block.id)) offset = depth - block.indent;
        return { ...block, indent: block.indent + offset };
      });
      sourceBlocks = from.blocks.filter(block => !ids.has(block.id));
      targetBlocks = [...to.blocks.slice(0, at), ...placed, ...to.blocks.slice(at)];
      if (!sourceBlocks.length) {
        filler = crypto.randomUUID();
        sourceBlocks.push({ id: filler, type: "paragraph", text: "", checked: 0, indent: 0, meta: null });
      }
    }
    if (validateSyncedBlocks(sourceBlocks, source) || validateSyncedBlocks(targetBlocks, target)
      || sourceBlocks.length > 2000 || targetBlocks.length > 2000
      || [...sourceBlocks, ...targetBlocks].some(block => block.indent < 0 || block.indent > 6)
      || globalThis.ColumnsModel.clampColumnsDepth(sourceBlocks) !== sourceBlocks
      || globalThis.ColumnsModel.clampColumnsDepth(targetBlocks) !== targetBlocks) return json({ error: "invalid_structure" }, 400);
    const now = Date.now(), sourceUpdated = Math.max(now, body.source_updated + 1), targetUpdated = Math.max(now, body.target_updated + 1);
    const sourceHistory = crypto.randomUUID(), targetHistory = crypto.randomUUID();
    const ids = moved.map(block => block.id);
    const savedFrom = { ...from, blockMove: { target, target_history: targetHistory, ids, source_updated: sourceUpdated, target_updated: targetUpdated } };
    const guard = "EXISTS (SELECT 1 FROM editor_history WHERE id = ?)";
    // Sorted row locks serialize overlapping moves on Postgres; SQLite/D1 serializes the batch itself.
    // The single claim checks BOTH versions/hashes before either history or any content can change.
    const statements = [source, target].sort().map(slug => db.prepare("UPDATE pages SET updated = updated WHERE slug = ?").bind(slug));
    statements.push(db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE slug = ? AND updated = ? AND hash IS ?) AND EXISTS (SELECT 1 FROM pages WHERE slug = ? AND updated = ? AND hash IS ?) AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ? OR page = ?)")
      .bind(sourceHistory, source, from.page.title, now, JSON.stringify(savedFrom), source, body.source_updated, from.page.hash, target, body.target_updated, to.page.hash, source, target));
    statements.push(db.prepare(`INSERT INTO editor_history (id, page, title, created, snapshot) SELECT ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(targetHistory, target, to.page.title, now, JSON.stringify(to), sourceHistory));
    // Preserve action provenance when a button changes page; moving a guest's button cannot grant owner powers.
    for (const block of moved) {
      if (block.type !== "button") continue;
      const oldKey = blockButtonKey(source, block.id), newKey = blockButtonKey(target, block.id);
      statements.push(db.prepare(`DELETE FROM db_button_savers WHERE button = ? AND ${guard}`).bind(newKey, sourceHistory));
      statements.push(db.prepare(`INSERT INTO db_button_savers (button, kind, session, email, roles, saved) SELECT ?, kind, session, email, roles, saved FROM db_button_savers WHERE button = ? AND ${guard}`).bind(newKey, oldKey, sourceHistory));
      statements.push(db.prepare(`DELETE FROM db_button_savers WHERE button = ? AND ${guard}`).bind(oldKey, sourceHistory));
    }
    const decoded = blocks => blocks.map(block => ({ ...block, checked: block.checked === 1, meta: block.meta ? parseJson(block.meta, null) : null }));
    const pages = [[source, sourceBlocks, from, sourceUpdated], [target, targetBlocks, to, targetUpdated]];
    for (const [slug, blocks, snapshot, updated] of pages) {
      statements.push(db.prepare(`DELETE FROM blocks WHERE page = ? AND ${guard}`).bind(slug, sourceHistory));
      blocks.forEach((block, ord) => statements.push(db.prepare(`INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
        .bind(slug, block.id, ord, block.type, block.text, block.checked, block.indent, block.meta, sourceHistory)));
      const before = new Set(snapshot.links.map(link => link.dst)), after = new Set(linksOf(decoded(blocks)));
      for (const dst of before) if (!after.has(dst)) statements.push(db.prepare(`DELETE FROM links WHERE src = ? AND dst = ? AND ${guard}`).bind(slug, dst, sourceHistory));
      for (const dst of after) if (!before.has(dst)) statements.push(db.prepare(`INSERT OR IGNORE INTO links (src, dst) SELECT ?, ? WHERE ${guard}`).bind(slug, dst, sourceHistory));
      statements.push(db.prepare(`UPDATE pages SET updated = ?, source = 'editor', hash = NULL WHERE slug = ? AND ${guard}`).bind(updated, slug, sourceHistory));
    }
    const result = await db.batch(statements);
    if (!Number(result[2]?.meta?.changes)) return conflict();
    for (const [slug, blocks, snapshot, updated] of pages) {
      for (const hook of ACARD_FEATURES.afterSave) {
        try { await hook(db, slug, decoded(blocks), { ...snapshot.page, updated, source: "editor", hash: null }); }
        catch (error) { console.error("Feature afterSave failed", error); }
      }
    }
    return json({ ok: true, source_updated: sourceUpdated, target_updated: targetUpdated,
      receipt: { source, target, ids, roots, placement: moved.map(block => ({ id: block.id, ord: block.ord, indent: block.indent })), filler,
        source_updated: sourceUpdated, target_updated: targetUpdated, source_history: sourceHistory, target_history: targetHistory,
        inverse: { path: "/api/page/" + encodeURIComponent(target) + "/move-blocks",
          body: { target: source, ids, source_updated: targetUpdated, target_updated: sourceUpdated, undo: sourceHistory } } } });
  } });
})();
