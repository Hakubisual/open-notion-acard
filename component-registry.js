// Acard component registry (ds10). A component is a block of type "component" whose text is JSON data and whose
// meta.ui names the component. In markdown it is a fence:
//   ```acard-ui {"ui":"stat"}
//   {"label":"가입 전환율","value":"18.4%","delta":"+12%"}
//   ```
// Components live in components/*.js (one file per family); each calls registerComponent. ONE registration gives a component everything it needs:
//   render(data, h)  -> reader / share / export HTML (server-side, no script, follows tokens.css light/dark)
//   schema           -> JSON-schema-like description agents read through the catalog (list_components)
//   defaults         -> values used at render time when a field is missing or malformed (stored data is never changed)
//   sample           -> example data the catalog, slash menu and gallery insert
//   slash            -> { label, hint, ico, aliases } for the editor's slash / insert menu
// Unknown components and malformed JSON never break a page: they draw a quiet fallback card (renderComponentBlock).
// Used by block-html.js (reader + export), features/share.js (published pages), the editor (window.AcardComponents,
// dist/component-html.js) and the agent catalog. Dependency-free: build.ts and tests/assemble-worker.ts inline it and
// every components/*.js file (sorted) into the worker and the browser copy; bun imports components/index.js.

export const COMPONENT_FENCE = "acard-ui";
export const COMPONENT_ID = /^[a-z][a-z0-9-]{1,39}$/;
const UI_MAX_ITEMS = 24;

function uiEsc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Plain text with **bold** and `code` only; components never take raw HTML from data.
function uiRich(value) {
  return uiEsc(value).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(MEASURED|CLAIMED|ESTIMATED)\]/g, (_, kind) => '<span class="ev ev-' + kind.toLowerCase() + '">' + kind + "</span>");
}

function uiStr(value, fallback, max = 400) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.slice(0, max) : fallback;
}

function uiOneOf(value, list, fallback) {
  return list.includes(value) ? value : fallback;
}

function uiList(value, max = UI_MAX_ITEMS) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

// Tones every component shares; each maps to tokens.css --color-<tone>-bg/fg.
export const UI_TONES = ["neutral", "info", "success", "warning", "danger", "accent"];

// The words a component draws itself (axis names, "목표", "각주", counts) follow the language of its own data: data
// written in English with no Hangul reads in English, anything else in Korean as before. h.t(ko, en) picks one; h.en
// tells which. renderComponentBlock sets it per block, so an English page draws English chrome without any page setting.
export function uiDataIsEnglish(data) {
  const text = JSON.stringify(data ?? "");
  return !/[\uac00-\ud7a3\u3131-\u318e]/.test(text) && /[A-Za-z]{3}/.test(text.replace(/"(?:ui|preset|palette|tone|kind|style|state|variant|size|height|key|status|art|pattern|color|icon|language)":"[^"]*"|"[A-Za-z]+":/g, ""));
}
// What the page around a component knows (renderComponentBlock's second argument, set only while it draws):
//   page.footnotes - Map note id -> number, in the order the page's text cites [^id] (block-html.js footnoteOrder)
//   page.heading   - text of the heading right above the block; titleShown(t) is false when the block's own title repeats it
// Without it (editor previews, the catalog) every component draws as it always did.
export function headingKey(text) {
  return String(text ?? "").replace(/<[^>]*>|[*_`]/g, "").replace(/^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
const uiHelpers = { esc: uiEsc, rich: uiRich, str: uiStr, oneOf: uiOneOf, list: uiList, TONES: UI_TONES, en: false, t: (ko, en) => (uiHelpers.en ? en : ko), page: null,
  titleShown: (title) => !(uiHelpers.page && uiHelpers.page.heading && headingKey(title) === headingKey(uiHelpers.page.heading)) };

// Shared drawing code for a family (the chart engine, diagram layout) joins the helpers every render gets as h.<name>.
// Files load sorted, so a helper file is named components/_<name>.js and registers before the components using it.
// A name is set once; the ds10 helper names can never be replaced.
export function registerHelpers(name, helpers) {
  if (!/^[a-z][a-zA-Z0-9]{1,30}$/.test(String(name)) || !helpers || typeof helpers !== "object") throw new Error("helpers need a name (a-z, 2-31 chars) and an object");
  if (Object.prototype.hasOwnProperty.call(uiHelpers, name)) throw new Error("helper name already taken: " + name);
  uiHelpers[name] = Object.freeze({ ...helpers });
  return uiHelpers[name];
}

// Persona presets (visual kit): a component may give partial data for each; data.preset picks one.
//   report   - office reports: KPI first, compact, delta colors, a source line
//   friendly - students, teachers, blogs: pastel, rounded, emoji icons
//   paper    - theses and research: grayscale + colorblind-safe marks, figure numbers, axis labels
//   showcase - designers: large visuals, generous spacing
export const UI_PRESETS = ["report", "friendly", "paper", "showcase"];

// Families group components in the slash menu, the catalog and the editor's lazy chunks. A def without one is "basic".
export const UI_FAMILIES = ["basic", "chart", "diagram", "interactive", "block", "asset"];

const uiRegistry = new Map();

// def: { id, name, description, schema, defaults, sample, slash: { label, hint, ico, aliases }, css, render(data, h) }
// css is the component's own rules (tokens.css variables only); componentCss() joins them for the page.
// Optional (visual kit, additive - every def above keeps working unchanged):
//   family   one of UI_FAMILIES (default "basic")
//   presets  { report?, friendly?, paper?, showcase? } -> partial data merged under the stored data when data.preset names it
export function registerComponent(def) {
  if (!def || !COMPONENT_ID.test(def.id)) throw new Error("component id must be a-z0-9- (2-40 chars): " + (def && def.id));
  if (typeof def.render !== "function") throw new Error("component " + def.id + " needs render(data, h)");
  const family = UI_FAMILIES.includes(def.family) ? def.family : "basic";
  const presets = def.presets && typeof def.presets === "object" ? Object.fromEntries(UI_PRESETS.filter((p) => def.presets[p] && typeof def.presets[p] === "object").map((p) => [p, def.presets[p]])) : {};
  uiRegistry.set(def.id, Object.freeze({ ...def, family, presets, defaults: def.defaults || {}, sample: def.sample || def.defaults || {}, slash: def.slash || { label: def.name, hint: def.description, ico: "▦" } }));
  return uiRegistry.get(def.id);
}

// Rules every component of a family shares (axes, legends, figure captions for charts). A page carries them once,
// before the first component of that family; componentCss(ids) includes them for the families of those ids.
const uiFamilyCss = new Map();
export function registerFamilyCss(family, css) {
  if (!UI_FAMILIES.includes(family) || typeof css !== "string") throw new Error("family css needs one of " + UI_FAMILIES.join(", ") + " and a string");
  uiFamilyCss.set(family, css);
}
export function familyCss(family) {
  return uiFamilyCss.get(family) || "";
}

export function getComponent(id) {
  return uiRegistry.get(id) || null;
}

// listComponents(family?) - every component, or only one family's.
export function listComponents(family) {
  const all = [...uiRegistry.values()];
  return family ? all.filter((c) => c.family === family) : all;
}

// The short line agents see in the MCP tool description: basic names in full, each other family folded to
// prefix-{a,b,c} so the line stays short as families grow.
export function componentNames() {
  const basic = listComponents("basic").map((c) => c.id);
  const grouped = UI_FAMILIES.filter((f) => f !== "basic").map((f) => {
    const ids = listComponents(f).map((c) => c.id);
    if (!ids.length) return "";
    const prefix = ids[0].slice(0, ids[0].indexOf("-") + 1);
    return ids.every((id) => id.startsWith(prefix)) ? prefix + "{" + ids.map((id) => id.slice(prefix.length)).join(",") + "}" : ids.join(", ");
  }).filter(Boolean);
  return basic.concat(grouped).join(", ");
}

// Catalog entries for agents (list_components / GET /api/v1/components): schema, defaults and a ready-to-paste example.
export function componentCatalog(id) {
  const pick = (c) => ({ id: c.id, name: c.name, description: c.description, schema: c.schema || { type: "object" }, defaults: c.defaults, sample: c.sample, markdown: componentMarkdown(c.id, c.sample), family: c.family, ...(Object.keys(c.presets).length ? { presets: Object.keys(c.presets) } : {}) });
  if (id) { const c = getComponent(id); return c ? pick(c) : null; }
  return listComponents().map(pick);
}

export function componentMarkdown(id, data) {
  return "```" + COMPONENT_FENCE + " " + JSON.stringify({ ui: id }) + "\n" + JSON.stringify(data ?? {}, null, 2) + "\n```";
}

// Data for rendering: parsed JSON merged over defaults. Malformed JSON gives { ok: false } and the defaults.
export function componentData(block) {
  const comp = getComponent(String((block && block.meta && block.meta.ui) || ""));
  let parsed = null, ok = true;
  const text = String((block && block.text) || "").trim();
  if (text) {
    try { parsed = JSON.parse(text); } catch { ok = false; }
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) { ok = false; parsed = null; }
  }
  const preset = comp && parsed && comp.presets[parsed.preset] ? comp.presets[parsed.preset] : null;
  return { comp, ok, data: { ...(comp ? comp.defaults : {}), ...(preset || {}), ...(parsed || {}) } };
}

// Footnote references (acard-footnote-fix): body text cites a note as [^id] (the markdown footnote mark), id being a
// block-footnotes note id. Numbers follow the order the text first cites each note, so moving a sentence renumbers the
// page. A page without a footnotes block, or a mark naming no note, gets an empty map and its text stays as written.
export const FOOTNOTE_REF = /\[\^([A-Za-z0-9_-]{1,100})\]/g;
const FOOTNOTE_TEXT_TYPES = new Set(["paragraph", "heading1", "heading2", "heading3", "heading4", "bulleted", "numbered", "to_do", "toggle", "callout", "quote"]);
export function footnoteOrder(blocks) {
  const list = Array.isArray(blocks) ? blocks : [], notes = new Set(), order = new Map();
  for (const block of list) {
    if (!block || block.type !== "component" || !block.meta || block.meta.ui !== "block-footnotes") continue;
    const notesData = componentData(block).data.notes;
    for (const note of Array.isArray(notesData) ? notesData : []) if (note && typeof note.id === "string") notes.add(note.id);
  }
  if (!notes.size) return order;
  for (const block of list) {
    if (!block || !FOOTNOTE_TEXT_TYPES.has(block.type) || typeof block.text !== "string") continue;
    for (const match of block.text.matchAll(FOOTNOTE_REF)) if (notes.has(match[1]) && !order.has(match[1])) order.set(match[1], order.size + 1);
  }
  return order;
}

// Fallback card for anything the reader cannot draw: an unknown block type, an unknown component, or a component whose
// renderer throws. It shows what the block is and its text, never raw HTML, so a rollback or a typo never breaks a page.
export function fallbackCardHtml(kind, text) {
  const body = String(text || "").trim();
  return '<div class="ui-fallback" role="note"><span class="ui-fallback-kind">' + uiEsc(kind) + "</span>" +
    (body ? '<pre class="ui-fallback-text">' + uiEsc(body.length > 600 ? body.slice(0, 600) + "…" : body) + "</pre>" : '<span class="ui-fallback-empty">이 블록은 이 화면에서 아직 그릴 수 없어요.</span>') + "</div>";
}

export function renderComponentBlock(block, page) {
  const { comp, ok, data } = componentData(block);
  const ui = String((block && block.meta && block.meta.ui) || "");
  if (!comp) return fallbackCardHtml(ui ? "컴포넌트 " + ui : "컴포넌트", block && block.text);
  try {
    // Malformed JSON still draws the component with its defaults, flagged for the editor (data-ui-invalid).
    const preset = UI_PRESETS.includes(data.preset) ? ' data-preset="' + data.preset + '"' : "";
    const en = uiDataIsEnglish(data);
    uiHelpers.en = en;
    uiHelpers.page = page && typeof page === "object" ? page : null;
    try {
      return '<div class="ui ui-' + comp.id + '" data-ui="' + comp.id + '"' + (en ? ' lang="en"' : "") + preset + (ok ? "" : ' data-ui-invalid="1"') + ">" + comp.render(data, uiHelpers) + "</div>";
    } finally {
      uiHelpers.en = false;
      uiHelpers.page = null;
    }
  } catch {
    return fallbackCardHtml("컴포넌트 " + comp.id, block && block.text);
  }
}

export const COMPONENT_BASE_CSS = ".ui{margin:var(--space-4) 0}.ui-fallback{margin:var(--space-3) 0;padding:var(--space-3) var(--space-4);border:1px dashed var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-soft);color:var(--color-text-dim);font-size:var(--fs-13)}.ui-fallback-kind{display:inline-block;margin-bottom:var(--space-1);padding:0 var(--space-2);border-radius:var(--radius-pill);background:var(--color-neutral-bg);color:var(--color-neutral-fg);font-size:var(--fs-12);font-weight:600}.ui-fallback-text{margin:var(--space-1) 0 0;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:var(--fs-12);background:none;padding:0}.ui-fallback-empty{display:block}.ui-btn{display:inline-flex;align-items:center;gap:var(--space-2);height:var(--control-h-md);padding:0 var(--space-4);border-radius:var(--radius-sm);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font-size:var(--fs-14);font-weight:600;text-decoration:none}.ui-btn.primary{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-on-accent)}";

// Every rule a page with components needs: the base, then each component's css in registration order.
// componentCss(ids) keeps the same order but only for the components named (a page carries what it uses).
export function componentCss(ids) {
  const only = ids ? new Set(ids) : null;
  const picked = listComponents().filter((c) => !only || only.has(c.id));
  // ds10 (basic) rules first, in registration order; then each other family's shared rules followed by its components.
  const basic = picked.filter((c) => c.family === "basic").map((c) => c.css || "").join("");
  const rest = [...new Set(picked.filter((c) => c.family !== "basic").map((c) => c.family))]
    .map((f) => familyCss(f) + picked.filter((c) => c.family === f).map((c) => c.css || "").join("")).join("");
  return COMPONENT_BASE_CSS + basic + rest;
}

// The rules one component adds on top of the base ("" for an unknown id).
export function componentOwnCss(id) {
  const c = getComponent(id);
  return c ? c.css || "" : "";
}

// Component ids a rendered HTML string uses (data-ui="..."), in first-use order.
export function componentIdsIn(html) {
  return [...new Set([...String(html || "").matchAll(/data-ui="([a-z][a-z0-9-]{1,39})"/g)].map((m) => m[1]))];
}
