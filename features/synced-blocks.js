// Inlined worker helpers. Resolution is response data, never persisted block metadata.
const SYNCED_NAME = /^[\p{L}\p{N}_-]+$/u;
const syncedName = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && SYNCED_NAME.test(value);
const syncedObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const syncedStoredMeta = block => typeof block.meta === "string" ? parseJson(block.meta, null) : block.meta;

function cleanSyncedMeta(meta) {
  if (!syncedObject(meta) || Object.keys(meta).some(key => key !== "synced")) return null;
  const value = meta.synced;
  if (!syncedObject(value) || Object.keys(value).length !== 2 || value.v !== 1 || !("source" in value)) return null;
  if (value.source === null) return { synced: { v: 1, source: null } };
  const source = value.source;
  if (!syncedObject(source) || Object.keys(source).length !== 2 || !syncedName(source.page, 160) || !syncedName(source.block, 60)) return null;
  return { synced: { v: 1, source: { page: source.page, block: source.block } } };
}

// null means valid; errors are machine-readable and do not expose another page's content.
function validateSyncedBlocks(blocks, slug) {
  if (!Array.isArray(blocks) || blocks.length > 2000) return { error: "invalid_structure" };
  const ids = new Set();
  let parent = null;
  for (const block of blocks) {
    if (!block || typeof block.id !== "string" || !block.id || block.id.length > 60 || ids.has(block.id)
      || !Number.isInteger(block.indent) || block.indent < 0 || block.indent > 6) return { error: "invalid_structure" };
    ids.add(block.id);
    if (parent && block.indent <= parent.indent) parent = null;
    const meta = syncedStoredMeta(block);
    if (block.type !== "synced") {
      if (meta && Object.prototype.hasOwnProperty.call(meta, "synced")) return { error: "invalid_synced" };
      if (parent?.reference) return { error: "invalid_synced" };
      continue;
    }
    const clean = cleanSyncedMeta(meta);
    if (!clean || parent || !syncedName(block.id, 60) || block.text !== "" || clean.synced.source?.page === slug) return { error: "invalid_synced" };
    parent = { indent: block.indent, reference: clean.synced.source !== null };
  }
  return null;
}

function syncedEnd(blocks, start) {
  let end = start + 1;
  while (end < blocks.length && blocks[end].indent > blocks[start].indent) end++;
  return end;
}

// Generic saves may retain references, but creation/retargeting uses the dual-page authorized API.
function guardSyncedWrite(blocks, slug, previous = []) {
  if (![...blocks, ...previous].some(block => block?.type === "synced" || syncedStoredMeta(block ?? {})?.synced)) return;
  const complete = blocks.map(block => ({ ...block, indent: block.indent ?? 0 }));
  const invalid = validateSyncedBlocks(complete, slug);
  if (invalid) throw new AgentError(invalid.error, 400);
  const existing = new Map(previous.filter(block => block.type === "synced").map(block => [block.id, cleanSyncedMeta(syncedStoredMeta(block))?.synced.source]));
  for (const block of complete) {
    if (block.type !== "synced") continue;
    const source = cleanSyncedMeta(syncedStoredMeta(block)).synced.source;
    const old = existing.get(block.id);
    if (source && (!old || old.page !== source.page || old.block !== source.block)) throw new AgentError("synced_reference_requires_api", 400);
  }
}

function syncedDecoded(blocks) {
  return blocks.map(block => ({ id: block.id, type: block.type, text: block.text, checked: block.checked === true || block.checked === 1,
    indent: block.indent, ...(block.meta ? { meta: syncedStoredMeta(block) } : {}) }));
}

// Import payloads have no authority to attach to workspace sources. Validate before sanitizers can
// erase invalid metadata or children, then keep unavailable references as ordinary visible content.
function importSyncedBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  guardSyncedWrite(blocks, null, blocks);
  return blocks.map(block => block.type === "synced" && cleanSyncedMeta(syncedStoredMeta(block)).synced.source
    ? { id: block.id, type: "paragraph", text: "Synced content unavailable", indent: block.indent ?? 0 } : block);
}

async function syncedAllowed(db, slug, options, write = false) {
  const principal = options?.principal;
  if (!principal || !["owner", "guest", "agent", "token"].includes(principal.kind)) return false;
  // Public tokens have exactly the caller-supplied visible set. Never infer owner access from the DB wrapper.
  if (principal.kind === "token") return !write && options.visible instanceof Set && options.visible.has(slug);
  if (db.acardVisible && !db.acardVisible.has(slug)) return false;
  if (principal.kind === "guest" && (!db.acardVisible || !db.acardRoles)) return false;
  if (db.acardRoles && !["read", "comment", "edit", "full"].includes(db.acardRoles.get(slug))) return false;
  if (write && !canWriteSlug(db, slug)) return false;
  if (principal.kind === "agent") {
    try { return (await narrowAgent(db, principal, slug)).scopes.includes(write ? "write" : "read"); }
    catch (error) { if (error.status === 403) return false; throw error; }
  }
  return true;
}

async function syncedCopyAllowed(db, slug, options) {
  if (!(await syncedAllowed(db, slug, options))) return false;
  if (options.principal.kind === "owner" && !db.acardRoles) return true;
  if (options.principal.kind === "agent" && !db.acardRoles) return true;
  if (options.principal.kind === "token") return options.exportable instanceof Set && options.exportable.has(slug);
  // Match share.js pageFlag/shareChain: a positive export flag on the inheritance chain grants copying.
  const seen = new Set();
  for (let page = slug; page && !seen.has(page) && seen.size < 2000;) {
    seen.add(page);
    const row = await db.prepare("SELECT p.parent, s.inherit, s.allow_export FROM pages p LEFT JOIN share_pages s ON s.page = p.slug WHERE p.slug = ? AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = p.slug)").bind(page).first();
    if (!row) return false;
    if (Number(row.allow_export) === 1) return true;
    if (row.inherit !== null && row.inherit !== undefined && Number(row.inherit) === 0) return false;
    page = row.parent;
  }
  return false;
}

async function resolveSyncedBlocks(db, slug, blocks, options = {}) {
  const instances = Array.isArray(blocks) ? blocks.filter(block => block?.type === "synced") : [];
  if (!instances.length) return [];
  const unavailable = () => instances.slice(0, 2000).map(block => ({ id: block.id, status: "unavailable" }));
  if (validateSyncedBlocks(blocks, slug) || !(await syncedAllowed(db, slug, options))
    || (options.export && !(await syncedCopyAllowed(db, slug, options)))) return unavailable();
  const targets = new Set(instances.map(block => cleanSyncedMeta(syncedStoredMeta(block)).synced.source?.page ?? slug));
  // No recursive expansion: a canonical source may contain no synced descendant, so even corrupt cycles terminate.
  if (targets.size > 32) return unavailable();
  const pages = new Map(await Promise.all([...targets].map(async page => {
    if (!(await syncedAllowed(db, page, options)) || (options.export && !(await syncedCopyAllowed(db, page, options)))) return [page, null];
    const found = await readPage(db, page);
    return [page, found && !validateSyncedBlocks(found.blocks, page) ? found : null];
  })));
  const out = [];
  let expanded = 0;
  for (const instance of instances) {
    const target = cleanSyncedMeta(syncedStoredMeta(instance)).synced.source ?? { page: slug, block: instance.id };
    const found = pages.get(target.page), index = found?.blocks.findIndex(block => block.id === target.block) ?? -1;
    const wrapper = index < 0 ? null : found.blocks[index];
    if (!wrapper || wrapper.type !== "synced" || cleanSyncedMeta(wrapper.meta)?.synced.source !== null) {
      out.push({ id: instance.id, status: "unavailable" }); continue;
    }
    const content = found.blocks.slice(index + 1, syncedEnd(found.blocks, index));
    expanded += content.length;
    if (expanded > 2000) return unavailable();
    const editable = await syncedAllowed(db, slug, options, true) && await syncedAllowed(db, target.page, options, true);
    out.push({ id: instance.id, status: "available", source: target, source_updated: found.page.updated, editable,
      blocks: content.map(block => ({ ...block, indent: block.indent - wrapper.indent - 1 })) });
  }
  return out;
}

(() => {
  registerFeature({ api: async ({ path, method, request, db, env, helpers }) => {
    const match = /^\/api\/page\/([^/]+)\/synced(?:\/([^/]+)(\/detach)?)?$/.exec(path);
    if (!match) return null;
    const { json } = helpers;
    let slug, instanceId;
    try { slug = decodeURIComponent(match[1]); instanceId = match[2] ? decodeURIComponent(match[2]) : null; }
    catch { return json({ error: "invalid_page" }, 400); }
    if (!syncedName(slug, 160) || (instanceId && !syncedName(instanceId, 60))) return json({ error: "invalid_page" }, 400);
    const options = { principal: env.ACARD_SAVE_PRINCIPAL ? { ...env.ACARD_SAVE_PRINCIPAL, kind: "agent" }
      : { kind: isGuest(env) || db.acardRoles || db.acardVisible ? "guest" : "owner" } };
    if (!(await syncedAllowed(db, slug, options))) return json({ error: "unavailable" }, 404);
    if (method === "GET" && !instanceId) {
      const found = await readPage(db, slug);
      if (!found) return json({ error: "unavailable" }, 404);
      const resolved = await resolveSyncedBlocks(db, slug, found.blocks, options);
      return json({ updated: found.page.updated, resolved: resolved.map(item => item.status === "available"
        ? { ...item, html: renderBlocks(materializeSyncedBlocks([{ id: item.id, type: "synced", indent: 0 }], [item]), { page: { readOnly: true } }) }
        : item) });
    }
    let operation = method === "POST" && !instanceId ? "create" : method === "PATCH" && instanceId && !match[3] ? "edit"
      : method === "POST" && match[3] ? "detach" : null;
    if (!operation) return json({ error: "method_not_allowed" }, 405);
    if (!(await syncedAllowed(db, slug, options, true))) return json({ error: "write_required" }, 403);
    const body = await request.json().catch(() => null);
    if (operation === "create" && body?.undo !== undefined) operation = "undo";
    const version = value => Number.isSafeInteger(value) && value >= 0;
    const allowed = operation === "create" ? ["base_updated", "source_updated", "ids", "source", "beforeId"]
      : operation === "edit" ? ["base_updated", "source_updated", "blocks"] : operation === "undo" ? ["base_updated", "source_updated", "undo"] : ["base_updated", "source_updated"];
    if (!syncedObject(body) || Object.keys(body).some(key => !allowed.includes(key)) || !version(body.base_updated)) return json({ error: "invalid_synced" }, 400);
    const current = await readPage(db, slug);
    if (!current) return json({ error: "unavailable" }, 404);
    const from = await snapshotPage(db, slug);
    if (!from || validateSyncedBlocks(from.blocks, slug)) return json({ error: "invalid_structure" }, 400);
    if (from.page.updated !== body.base_updated || current.page.updated !== body.base_updated) return json({ error: "conflict" }, 409);
    const snapshots = new Map([[slug, from]]);
    let undoSnapshot = null, undoReceipt = null;
    let target = null, targetSnapshot = from, wrapper, start, end, block = null;
    if (operation === "undo") {
      if (!syncedName(body.undo, 60)) return json({ error: "invalid_receipt" }, 400);
      const row = await db.prepare("SELECT snapshot FROM editor_history WHERE id = ?").bind(body.undo).first();
      undoSnapshot = row && parseJson(row.snapshot, null);
      undoReceipt = undoSnapshot?.syncedOperation;
      if (!undoReceipt || undoReceipt.reference.page !== slug || undoSnapshot.page.slug !== undoReceipt.page ||
        ![slug, undoReceipt.source.page].includes(undoReceipt.page)) return json({ error: "invalid_receipt" }, 400);
      if (undoReceipt.reference_updated !== body.base_updated || undoReceipt.source_updated !== body.source_updated) return json({ error: "conflict" }, 409);
      target = undoReceipt.source;
      instanceId = undoReceipt.reference.block;
    } else if (operation === "create" && body.source !== undefined) {
      const meta = cleanSyncedMeta({ synced: { v: 1, source: body.source } });
      if (!meta?.synced.source || body.ids !== undefined || body.source.page === slug) return json({ error: "invalid_synced" }, 400);
      target = meta.synced.source;
    } else if (operation !== "create") {
      const instance = from.blocks.find(block => block.id === instanceId && block.type === "synced");
      if (!instance) return json({ error: "unavailable" }, 404);
      target = cleanSyncedMeta(syncedStoredMeta(instance)).synced.source ?? { page: slug, block: instance.id };
      if (operation === "detach" && target.page === slug) return json({ error: "invalid_synced" }, 400);
    }
    if (target) {
      if (!version(body.source_updated)) return json({ error: "invalid_synced" }, 400);
      if (!(await syncedAllowed(db, target.page, options))) return json({ error: "unavailable" }, operation === "edit" || operation === "undo" ? 403 : 404);
      if ((operation === "edit" || undoReceipt?.page === target.page) && !(await syncedAllowed(db, target.page, options, true))) return json({ error: "write_required" }, 403);
      if (operation === "detach" && !(await syncedCopyAllowed(db, target.page, options))) return json({ error: "copy_required" }, 403);
      if (operation === "undo" && (undoReceipt.originalOperation ?? undoReceipt.operation) === "detach" && !(await syncedCopyAllowed(db, target.page, options))) return json({ error: "copy_required" }, 403);
      const found = target.page === slug ? current : await readPage(db, target.page);
      if (!found) return json({ error: "unavailable" }, 404);
      targetSnapshot = target.page === slug ? from : await snapshotPage(db, target.page);
      if (!targetSnapshot || validateSyncedBlocks(targetSnapshot.blocks, target.page)) return json({ error: "unavailable" }, 404);
      snapshots.set(target.page, targetSnapshot);
      if (targetSnapshot.page.updated !== body.source_updated || found.page.updated !== body.source_updated) return json({ error: "conflict" }, 409);
      start = targetSnapshot.blocks.findIndex(block => block.id === target.block);
      wrapper = targetSnapshot.blocks[start];
      if (operation !== "undo") {
        if (!wrapper || wrapper.type !== "synced" || cleanSyncedMeta(syncedStoredMeta(wrapper))?.synced.source !== null) return json({ error: "unavailable" }, 404);
        end = syncedEnd(targetSnapshot.blocks, start);
      }
    }
    let changedSlug = slug, next, copied = [], buttons = new Set();
    if (operation === "undo") {
      changedSlug = undoReceipt.page;
      if (snapshots.get(changedSlug).page.updated !== undoReceipt.updated || validateSyncedBlocks(undoSnapshot.blocks, changedSlug)) return json({ error: "conflict" }, 409);
      const currentBlocks = syncedDecoded(snapshots.get(changedSlug).blocks), restored = syncedDecoded(undoSnapshot.blocks);
      if (options.principal.kind === "agent") {
        markRefusal({ ...current, blocks: currentBlocks }, currentBlocks.map(block => block.id));
        await guardAgentButtons(db, options.principal, currentBlocks, restored);
      }
      await guardButtonBlocks(db, currentBlocks, restored, buttons);
      next = undoSnapshot.blocks.map((block, index) => ({ ...block, meta: JSON.stringify(restored[index].meta) === JSON.stringify(syncedStoredMeta(block))
        ? block.meta : restored[index].meta ? JSON.stringify(restored[index].meta) : null }));
    } else if (operation === "create" && !target) {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 2000 || new Set(body.ids).size !== body.ids.length
        || body.ids.some(id => !from.blocks.some(block => block.id === id)) || body.beforeId !== undefined || body.source_updated !== undefined) return json({ error: "invalid_selection" }, 400);
      const selected = new Set(body.ids), ranges = [];
      for (let i = 0; i < from.blocks.length; i++) if (selected.has(from.blocks[i].id)) {
        const stop = syncedEnd(from.blocks, i); ranges.push([i, stop]); i = stop - 1;
      }
      const first = ranges[0][0], last = ranges[ranges.length - 1][1], depth = from.blocks[first].indent;
      if (ranges.some(([at], i) => from.blocks[at].indent !== depth || (i && at !== ranges[i - 1][1]))
        || from.blocks.slice(first, last).some(block => block.type === "synced")) return json({ error: "invalid_selection" }, 400);
      if (options.principal.kind === "agent") markRefusal(current, from.blocks.slice(first, last).map(block => block.id));
      block = { id: crypto.randomUUID(), type: "synced", text: "", checked: 0, indent: depth, meta: JSON.stringify({ synced: { v: 1, source: null } }) };
      next = [...from.blocks.slice(0, first), block, ...from.blocks.slice(first, last).map(block => ({ ...block, indent: block.indent + 1 })), ...from.blocks.slice(last)];
      target = { page: slug, block: block.id };
    } else if (operation === "create") {
      const at = body.beforeId === undefined ? from.blocks.length : from.blocks.findIndex(block => block.id === body.beforeId);
      if (at < 0) return json({ error: "invalid_selection" }, 400);
      block = { id: crypto.randomUUID(), type: "synced", text: "", checked: 0, indent: at === from.blocks.length ? 0 : from.blocks[at].indent,
        meta: JSON.stringify({ synced: { v: 1, source: target } }) };
      next = [...from.blocks.slice(0, at), block, ...from.blocks.slice(at)];
    } else if (operation === "edit") {
      if (validateSyncedBlocks(body.blocks, target.page) || body.blocks.some(block => block.type === "synced" || typeof block.type !== "string" || typeof block.text !== "string")) return json({ error: "invalid_structure" }, 400);
      const outside = new Set(targetSnapshot.blocks.filter((_, i) => i <= start || i >= end).map(block => block.id));
      if (body.blocks.some(block => outside.has(block.id) || block.indent + wrapper.indent + 1 > 6)) return json({ error: "invalid_structure" }, 400);
      const old = syncedDecoded(targetSnapshot.blocks.slice(start + 1, end));
      let content = normaliseBlocks(body.blocks).map(block => ({ ...block, indent: block.indent + wrapper.indent + 1 }));
      if (options.principal.kind === "agent") {
        content = humanGuard(old, content, options.principal.name, targetSnapshot.settings?.ai).blocks;
        await guardAgentButtons(db, options.principal, old, content);
      } else content = humanMarkSaves(old, content, Date.now(), await humanAgentPage(db, target.page));
      content = await guardButtonBlocks(db, old, content, buttons);
      next = [...targetSnapshot.blocks.slice(0, start + 1), ...content.map(block => ({ ...block, checked: block.checked ? 1 : 0, meta: block.meta ? JSON.stringify(block.meta) : null })), ...targetSnapshot.blocks.slice(end)];
      changedSlug = target.page;
    } else {
      const at = from.blocks.findIndex(block => block.id === instanceId), depth = from.blocks[at].indent;
      if (options.principal.kind === "agent") markRefusal(current, [instanceId]);
      copied = targetSnapshot.blocks.slice(start + 1, end).map(block => ({ original: block.id, block: { ...block, id: crypto.randomUUID(), indent: block.indent - wrapper.indent - 1 + depth } }));
      const guarded = syncedDecoded(copied.map(copy => copy.block));
      const originalMeta = guarded.map(block => JSON.stringify(block.meta));
      if (options.principal.kind === "agent") await guardAgentButtons(db, options.principal, [], guarded);
      if (options.principal.kind !== "owner" || db.acardRoles) await guardButtonBlocks(db, [], guarded, buttons);
      guarded.forEach((block, i) => {
        if (JSON.stringify(block.meta) !== originalMeta[i]) copied[i].block.meta = block.meta ? JSON.stringify(block.meta) : null;
      });
      const content = copied.map(copy => copy.block);
      if (!content.length) content.push({ id: crypto.randomUUID(), type: "paragraph", text: "", checked: 0, indent: depth, meta: null });
      next = [...from.blocks.slice(0, at), ...content, ...from.blocks.slice(at + 1)];
    }
    if (validateSyncedBlocks(next, changedSlug) || globalThis.ColumnsModel.clampColumnsDepth(next) !== next) return json({ error: "invalid_structure" }, 400);
    const before = snapshots.get(changedSlug), now = Date.now(), updated = Math.max(now, before.page.updated + 1), history = crypto.randomUUID();
    const sourceUpdated = target.page === changedSlug ? updated : targetSnapshot.page.updated;
    const referenceUpdated = slug === changedSlug ? updated : from.page.updated;
    const receipt = { operation, history, page: changedSlug, updated, source: target,
      reference: { page: slug, block: instanceId ?? block.id }, source_updated: sourceUpdated, reference_updated: referenceUpdated,
      ...(undoReceipt ? { originalOperation: undoReceipt.originalOperation ?? undoReceipt.operation } : {}),
      ids: copied.map(copy => copy.block.id) };
    const guard = "EXISTS (SELECT 1 FROM editor_history WHERE id = ?)";
    const expected = [...snapshots].sort(([a], [b]) => a.localeCompare(b));
    // Sorted row locks + one claim over ALL observed versions and hashes; every mutation depends on that claim.
    const statements = expected.map(([page]) => db.prepare("UPDATE pages SET updated = updated WHERE slug = ?").bind(page));
    const claims = expected.map(() => "EXISTS (SELECT 1 FROM pages WHERE slug = ? AND updated = ? AND hash IS ?) AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ?)").join(" AND ");
    statements.push(db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) SELECT ?, ?, ?, ?, ? WHERE " + claims)
      .bind(history, changedSlug, before.page.title, now, JSON.stringify({ ...before, syncedOperation: receipt }),
        ...expected.flatMap(([page, snapshot]) => [page, snapshot.page.updated, snapshot.page.hash, page])));
    statements.push(db.prepare(`DELETE FROM blocks WHERE page = ? AND ${guard}`).bind(changedSlug, history));
    next.forEach((block, ord) => statements.push(db.prepare(`INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(changedSlug, block.id, ord, block.type, block.text, block.checked, block.indent, block.meta ?? null, history)));
    const decoded = syncedDecoded(next), oldLinks = new Set(before.links.map(link => link.dst)), newLinks = new Set(linksOf(decoded));
    for (const dst of oldLinks) if (!newLinks.has(dst)) statements.push(db.prepare(`DELETE FROM links WHERE src = ? AND dst = ? AND ${guard}`).bind(changedSlug, dst, history));
    for (const dst of newLinks) if (!oldLinks.has(dst)) statements.push(db.prepare(`INSERT OR IGNORE INTO links (src, dst) SELECT ?, ? WHERE ${guard}`).bind(changedSlug, dst, history));
    statements.push(db.prepare(`UPDATE pages SET updated = ?, source = 'editor', hash = NULL WHERE slug = ? AND ${guard}`).bind(updated, changedSlug, history));
    for (const id of buttons) statements.push(buttonSaverStatement(db, blockButtonKey(changedSlug, id), { sql: guard, binds: [history] }));
    // Owner copies retain guest provenance. Restricted copies were checked and recorded as the copier above.
    for (const copy of copied) if (copy.block.type === "button" && !buttons.has(copy.block.id)) {
      statements.push(db.prepare(`INSERT INTO db_button_savers (button, kind, session, email, roles, saved) SELECT ?, kind, session, email, roles, saved FROM db_button_savers WHERE button = ? AND ${guard}`)
        .bind(blockButtonKey(slug, copy.block.id), blockButtonKey(target.page, copy.original), history));
      // A legacy button without provenance gets the copier's authority, never an implicit owner upgrade.
      const missing = `${guard} AND NOT EXISTS (SELECT 1 FROM db_button_savers WHERE button = ?)`;
      statements.push(buttonSaverStatement(db, blockButtonKey(slug, copy.block.id), { sql: missing, binds: [history, blockButtonKey(slug, copy.block.id)] }));
    }
    const result = await db.batch(statements);
    if (!Number(result[expected.length]?.meta?.changes)) return json({ error: "conflict" }, 409);
    for (const hook of ACARD_FEATURES.afterSave) {
      try { await hook(db, changedSlug, decoded, { ...before.page, updated, source: "editor", hash: null }); }
      catch (error) { console.error("Feature afterSave failed", error); }
    }
    return json({ ok: true, updated, source_updated: sourceUpdated, reference_updated: referenceUpdated, receipt,
      ...(block ? { block: syncedDecoded([block])[0] } : {}),
      ...(operation === "edit" ? { blocks: decoded.slice(start + 1, syncedEnd(decoded, start)).map(block => ({ ...block, indent: block.indent - wrapper.indent - 1 })) } : {}) });
  } });
})();
