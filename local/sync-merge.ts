// Three-way merge of one page for multi-device sync (docs/local-first.md 14장 충돌 규칙).
// base = the copy both devices last agreed on (null on a first connect), local = this PC, remote = the server copy.
// Edits to different blocks or fields are combined. When the same block was changed differently on both sides (or
// changed on one side and deleted on the other), the page edited last wins as a whole and the other side's full page is
// returned as `copy`, which the caller saves as a "(충돌 사본)" page, so no content is lost. On a database or row page the
// definition and the cells still merge in that case (#136): only the body text goes to the copy.
// A database page carries its definition (properties, views, templates, rules, form) and a row page its cells and
// outgoing relation links; they merge per item id and per property id. When the same item or cell was changed
// differently on both sides, the side edited last wins without a copy and `clash` is set so the caller can report it.

export type SyncBlock = { id: string; type: string; text: string; checked: number; indent: number; meta: string | null };
type Item = Record<string, unknown>;
export type SyncDatabase = Item & { id: string; props: Item[]; views: Item[]; templates: Item[]; rules?: Item[]; forms?: Item | null };
export type SyncRow = { id: string; database_id: string; props: string | null; ord: number; created: number; updated: number; relations: Item[] };
export type SyncDoc = {
  page: { slug: string; title: string; parent: string | null; ord: number; kind: string; updated: number };
  blocks: SyncBlock[];
  links: string[];
  settings: Record<string, unknown> | null;
  view: Record<string, unknown> | null;
  tags: string[];
  database?: SyncDatabase;
  row?: SyncRow;
  // Conflicts the sending PC found on this page, so the other PCs can count them too (#136). Not part of the content.
  conflicts?: SyncConflict[];
};
export type SyncConflict = { id: string; at: number; slug: string; title: string; copy: string | null };
export type Side = { deleted: boolean; doc: SyncDoc | null };
export type MergeResult = { deleted: boolean; doc: SyncDoc | null; copy: SyncDoc | null; winner: "local" | "remote" | "merged"; clash: boolean };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const blockBody = (b: SyncBlock | undefined) => (b ? [b.type, b.text, Number(b.checked) ? 1 : 0, Number(b.indent) || 0, b.meta ?? null] : null);
const sameBlock = (a: SyncBlock | undefined, b: SyncBlock | undefined) => same(blockBody(a), blockBody(b));

function pick<T>(base: T, local: T, remote: T, localNewer: boolean): T {
  if (same(local, remote) || same(remote, base)) return local;
  if (same(local, base)) return remote;
  return localNewer ? local : remote;
}

type Clash = { hit: boolean };
function choose<T>(base: T, local: T, remote: T, localNewer: boolean, clash: Clash): T {
  if (same(local, remote) || same(remote, base)) return local;
  if (same(local, base)) return remote;
  clash.hit = true;
  return localNewer ? local : remote;
}

function mergeById<T>(base: T[] | undefined, local: T[], remote: T[], key: (x: T) => string, localNewer: boolean, clash: Clash): T[] {
  const index = (list: T[] | undefined) => new Map((list ?? []).map((x) => [key(x), x]));
  const b = index(base), l = index(local), r = index(remote);
  return [...new Set([...l.keys(), ...r.keys()])].map((id) => choose(b.get(id), l.get(id), r.get(id), localNewer, clash)).filter((x): x is T => x !== undefined);
}

const parsed = (text: string | null | undefined): Item | null => { try { const v = JSON.parse(text ?? "null"); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };

function mergeRow(b: SyncRow | undefined, l: SyncRow | undefined, r: SyncRow | undefined, localNewer: boolean, clash: Clash): SyncRow | undefined {
  if (!l || !r) return l ?? r;
  if (l.id !== r.id) return choose(b, l, r, localNewer, clash);
  const base = b && b.id === l.id ? b : undefined;
  const bp = parsed(base?.props) ?? {}, lp = parsed(l.props), rp = parsed(r.props);
  const props = lp && rp
    ? JSON.stringify(Object.fromEntries([...new Set([...Object.keys(lp), ...Object.keys(rp)])].map((k) => [k, choose(bp[k], lp[k], rp[k], localNewer, clash)]).filter(([, v]) => v !== undefined)))
    : choose(base?.props, l.props, r.props, localNewer, clash);
  const groups = (list: Item[] | undefined) => [...(list ?? []).reduce((m, x) => m.set(String(x.prop_id), [...(m.get(String(x.prop_id)) ?? []), x]), new Map<string, Item[]>())].map(([prop, links]) => ({ prop, links }));
  const relations = mergeById(groups(base?.relations), groups(l.relations), groups(r.relations), (g) => g.prop, localNewer, clash).flatMap((g) => g.links)
    .sort((x, y) => String(x.prop_id).localeCompare(String(y.prop_id)) || String(x.dst_row).localeCompare(String(y.dst_row)));
  return { id: l.id, database_id: l.database_id, props, ord: choose(base?.ord, l.ord, r.ord, localNewer, clash) ?? l.ord, created: choose(base?.created, l.created, r.created, localNewer, clash) ?? l.created, updated: Math.max(l.updated, r.updated), relations };
}

function mergeDatabase(b: SyncDatabase | undefined, l: SyncDatabase | undefined, r: SyncDatabase | undefined, localNewer: boolean, clash: Clash): SyncDatabase | undefined {
  if (!l || !r) return l ?? r;
  if (l.id !== r.id) return choose(b, l, r, localNewer, clash);
  const base = b && b.id === l.id ? b : undefined;
  const lists = new Set(["props", "views", "templates", "rules", "forms"]);
  const out: Item = {};
  for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) if (!lists.has(k)) out[k] = k === "updated" ? Math.max(Number(l[k]) || 0, Number(r[k]) || 0) : choose(base?.[k], l[k], r[k], localNewer, clash);
  const byId = (k: "props" | "views" | "templates") => mergeById(base?.[k], l[k], r[k], (x) => String(x.id), localNewer, clash);
  const merged = { ...out, id: l.id, props: byId("props"), views: byId("views"), templates: byId("templates") } as SyncDatabase;
  if (l.rules && r.rules) merged.rules = mergeById(base?.rules, l.rules, r.rules, (x) => String(x.id), localNewer, clash);
  else if (l.rules ?? r.rules) merged.rules = l.rules ?? r.rules;
  if (l.forms !== undefined && r.forms !== undefined) merged.forms = choose(base?.forms, l.forms, r.forms, localNewer, clash) ?? null;
  else if ((l.forms ?? r.forms) !== undefined) merged.forms = l.forms ?? r.forms;
  return merged;
}

function mergeBlocks(base: SyncBlock[] | null, local: SyncBlock[], remote: SyncBlock[]): SyncBlock[] | null {
  const b = new Map((base ?? []).map((x) => [x.id, x]));
  const l = new Map(local.map((x) => [x.id, x]));
  const r = new Map(remote.map((x) => [x.id, x]));
  const kept = new Map<string, SyncBlock>();
  for (const id of new Set([...l.keys(), ...r.keys()])) {
    const lb = l.get(id), rb = r.get(id), bb = b.get(id);
    if (lb && rb) {
      if (sameBlock(lb, rb) || sameBlock(rb, bb)) kept.set(id, lb);
      else if (sameBlock(lb, bb)) kept.set(id, rb);
      else return null;
    } else if (lb) {
      if (!bb) kept.set(id, lb);
      else if (!sameBlock(lb, bb)) return null;
    } else if (rb) {
      if (!bb) kept.set(id, rb);
      else if (!sameBlock(rb, bb)) return null;
    }
  }
  const baseOrder = (base ?? []).map((x) => x.id).filter((id) => l.has(id));
  const localKeepsBaseOrder = same(local.map((x) => x.id).filter((id) => b.has(id)), baseOrder);
  const [primary, secondary] = localKeepsBaseOrder ? [remote, local] : [local, remote];
  const order = primary.map((x) => x.id).filter((id) => kept.has(id));
  const placed = new Set(order);
  secondary.forEach((x, i) => {
    if (placed.has(x.id) || !kept.has(x.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const k = order.indexOf(secondary[j].id); if (k >= 0) { at = k + 1; break; } }
    order.splice(at, 0, x.id);
    placed.add(x.id);
  });
  return order.map((id) => kept.get(id)!);
}

export function mergePage(base: Side | null, local: Side, remote: Side): MergeResult {
  const stamp = (d: SyncDoc | null) => Math.max(d?.page.updated ?? 0, d?.row?.updated ?? 0, Number(d?.database?.updated) || 0);
  const localNewer = stamp(local.doc) > stamp(remote.doc);
  if (local.deleted && remote.deleted) return { deleted: true, doc: remote.doc ?? local.doc, copy: null, winner: "remote", clash: false };
  // A deleted page loses to an edit on the other side: the edit wins and the page comes back.
  if (remote.deleted) return { deleted: false, doc: local.doc, copy: null, winner: "local", clash: false };
  if (local.deleted) return { deleted: false, doc: remote.doc, copy: null, winner: "remote", clash: false };
  const l = local.doc!, r = remote.doc!, b = base && !base.deleted ? base.doc : null;
  const blocks = mergeBlocks(b ? b.blocks : null, l.blocks, r.blocks);
  const clash: Clash = { hit: false };
  const database = mergeDatabase(b?.database, l.database, r.database, localNewer, clash);
  const row = mergeRow(b?.row, l.row, r.row, localNewer, clash);
  if (!blocks) {
    const [win, lose] = localNewer ? [l, r] : [r, l];
    const doc: SyncDoc = { ...win };
    if (database) doc.database = database;
    if (row) doc.row = row;
    return { deleted: false, doc, copy: lose, winner: localNewer ? "local" : "remote", clash: clash.hit };
  }
  const field = <K extends keyof SyncDoc["page"]>(k: K) => pick(b?.page[k], l.page[k], r.page[k], localNewer);
  const doc: SyncDoc = {
    page: { slug: l.page.slug, title: String(field("title")), parent: (field("parent") as string | null) ?? null, ord: Number(field("ord")), kind: l.page.kind, updated: Math.max(l.page.updated, r.page.updated) },
    blocks,
    links: [...new Set([...l.links, ...r.links])].sort(),
    settings: pick(b?.settings ?? null, l.settings, r.settings, localNewer),
    view: pick(b?.view ?? null, l.view, r.view, localNewer),
    tags: pick(b?.tags ?? [], l.tags, r.tags, localNewer),
  };
  if (database) doc.database = database;
  if (row) doc.row = row;
  return { deleted: false, doc, copy: null, winner: "merged", clash: clash.hit };
}
