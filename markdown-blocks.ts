import "./assets/columns-model.js";
import "./assets/editor-model.js";

// 마크다운 -> 블록 변환기.
// 도리는 마크다운을 쓰고(정본), 오너는 브라우저 에디터에서 같은 페이지를 블록으로 고친다.
// 그래서 마크다운을 블록 목록으로 바꾸는 규칙이 한 곳에만 있어야 한다. 빌드와 시드가 이걸 쓴다.

export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "bulleted"
  | "numbered"
  | "to_do"
  | "toggle"
  | "callout"
  | "quote"
  | "code"
  | "divider"
  | "database"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "embed"
  | "bookmark"
  | "columns"
  | "column"
  | "synced"
  | "table"
  | "equation"
  | "toc"
  | "breadcrumb"
  | "button"
  | "progress"
  | "db_ref"
  | "diagram"
  | "chart"
  | "visual"
  | "html"
  | "part"
  | "component";

// Visual blocks are fenced blocks: ```mermaid / ```acard-chart / ```acard-visual, with an optional JSON meta object
// after the language. Format: research/visuals/format.md.
// ```acard-part {"part":"chart","v":1} holds a part's JSON data; the part's code is a versioned file (#38).
// ```acard-ui {"ui":"stat"} holds a component's JSON data; component-registry.js draws it (ds10).
const VISUAL_FENCES: Record<string, BlockType> = { mermaid: "diagram", "acard-chart": "chart", "acard-visual": "visual", "html-embed": "html", "acard-part": "part", "acard-ui": "component" };
const VISUAL_LANGS: Record<string, string> = { diagram: "mermaid", chart: "acard-chart", visual: "acard-visual", html: "html-embed", part: "acard-part", component: "acard-ui" };
const VISUAL_META_KEYS = ["caption", "alt", "height"];
const PART_META_KEYS = ["part", "v", "theme", "caption", "alt", "height"];
const COMPONENT_META_KEYS = ["ui"];
const fenceMetaKeys = (type: BlockType | string) => type === "part" ? PART_META_KEYS : type === "component" ? COMPONENT_META_KEYS : VISUAL_META_KEYS;

function visualMeta(info: string, part: boolean | BlockType = false): Record<string, unknown> | null {
  if (!info.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(info);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, unknown> = {};
    for (const key of fenceMetaKeys(part === true ? "part" : part || "")) {
      if (key === "snapshot" ? parsed[key] && typeof parsed[key] === "object" && !Array.isArray(parsed[key]) : key === "height" || key === "v" ? Number.isFinite(parsed[key]) : typeof parsed[key] === "string" && parsed[key]) out[key] = parsed[key];
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export type Block = {
  id: string;
  type: BlockType;
  text: string;
  checked?: boolean;
  indent?: number;
  meta?: Record<string, unknown>;
};

export type ParsedPage = {
  title: string;
  slug: string;
  blocks: Block[];
};

let counter = 0;
function nextId(): string {
  counter += 1;
  return "b" + counter.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableDivider(line: string): boolean {
  return /^\s*\|[\s:|=-]+\|\s*$/.test(line);
}

function isSimpleTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.some((cell) => cell.includes("="));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

// Block meta comment (notion-parity C6 C7 C11): in a document whose front matter says acard_meta: 1, the line right after
// a block may be <!--acard {"color":"yellow_background","icon":"🔥","height":480,"toggle":true,"open":false}--> (same
// indentation). Only these keys and values are taken; anything else leaves the line as text. Without the flag (every older
// markdown: imports, seeds, agent writes) such a line stays text exactly as before. In a flagged document a text line that
// itself starts with <!--acard (after any backslashes) gets one more backslash on write and loses one on read.
export type MarkdownOptions = { meta?: boolean };

// A document's acard_meta flag: front matter with the line acard_meta: 1 (and its title, if any). Other front matter and
// documents without it come back with flagged false and the text untouched.
export function acardMetaDocument(markdown: string): { flagged: boolean; title: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!m || !/^acard_meta:\s*1\s*$/m.test(m[1])) return { flagged: false, title: "", body: markdown };
  const title = /^title:\s*(.*)$/m.exec(m[1]);
  let t = title ? title[1].trim() : "";
  if (/^".*"$/.test(t)) { try { t = JSON.parse(t); } catch {} }
  return { flagged: true, title: t, body: markdown.slice(m[0].length) };
}

// Lossless Acard markdown of a page: front matter with the flag, then every block with its meta comment lines.
export function acardMarkdown(title: string, blocks: Block[]): string {
  return "---\ntitle: " + JSON.stringify(String(title)) + "\nacard_meta: 1\n---\n\n" + blocksToMarkdown(blocks, { meta: true }) + "\n";
}
const META_LINE = /^\s*<!--acard (\{.*\})-->\s*$/;
const COLUMNS_OPEN = /^\s*<!--acard columns( (\{.*\}))?-->\s*$/;
const COLUMN_LINE = /^\s*<!--acard column-->\s*$/;
const COLUMNS_CLOSE = /^\s*<!--acard \/columns-->\s*$/;
const SYNCED_OPEN = /^\s*<!--acard synced (\{.*\})-->\s*$/;
const SYNCED_CLOSE = /^\s*<!--acard \/synced-->\s*$/;
const SYNCED_ID = /^[\p{L}\p{N}_-]{1,60}$/u;
const SYNCED_PAGE = /^[\p{L}\p{N}_-]{1,160}$/u;
type SyncedMeta = { v: 1; source: { page: string; block: string } | null };

function syncedMeta(raw: unknown): SyncedMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || Object.keys(value).length !== 2 || !("source" in value)) return null;
  if (value.source === null) return { v: 1, source: null };
  const source = value.source as Record<string, unknown>;
  if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).length !== 2 ||
      typeof source.page !== "string" || !SYNCED_PAGE.test(source.page) ||
      typeof source.block !== "string" || !SYNCED_ID.test(source.block)) return null;
  return { v: 1, source: { page: source.page, block: source.block } };
}

function syncedLink(source: NonNullable<SyncedMeta["source"]>): string {
  return "[Synced content](/" + source.page + "/#block-" + source.block + ")";
}

// Decide complete constructs before consuming anything. A nested or unmatched source invalidates its whole region;
// fenced/equation/legacy-column bodies and escaped markers are opaque. Ordinary columns still use their existing parser.
function syncedMarkers(lines: string[]): { sources: Map<number, { end: number; id: string }>; references: Map<number, SyncedMeta> } {
  const sources = new Map<number, { end: number; id: string }>();
  const references = new Map<number, SyncedMeta>();
  let region: { start: number; depth: number; id: string; invalid: boolean } | null = null;
  let fence: { char: string; size: number; loose: boolean } | null = null;
  let opaque = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (fence) {
      if (fence.loose ? /^```/.test(line) : new RegExp("^" + fence.char + "{" + fence.size + ",}\\s*$").test(line)) fence = null;
      continue;
    }
    const startFence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (startFence) {
      const ticks = startFence[1];
      fence = { char: ticks[0], size: ticks.length, loose: ticks === "```" && !VISUAL_FENCES[startFence[2].trim().split(/\s/)[0]] };
      continue;
    }
    if (opaque) { if (line === opaque) opaque = ""; continue; }
    if (line === "$$") { opaque = "$$"; continue; }
    if (/^:::\s*cols?\d*\s*$/i.test(line)) { opaque = ":::"; continue; }
    if (/^<!--acard synced\b/.test(line)) {
      if (region) { region.depth += 1; region.invalid = true; continue; }
      let id = "";
      const open = SYNCED_OPEN.exec(line);
      try {
        const value = open ? JSON.parse(open[1]) : null;
        if (value?.v === 1 && typeof value.id === "string" && SYNCED_ID.test(value.id) && Object.keys(value).length === 2) id = value.id;
      } catch {}
      region = { start: index, depth: 1, id, invalid: !id };
      continue;
    }
    if (SYNCED_CLOSE.test(line)) {
      if (region && --region.depth === 0) {
        if (!region.invalid && /^ */.exec(lines[region.start])![0] === /^ */.exec(lines[index])![0]) sources.set(region.start, { end: index, id: region.id });
        region = null;
      }
      continue;
    }
    const comment = META_LINE.exec(lines[index]);
    if (!comment) continue;
    try {
      const value = JSON.parse(comment[1]);
      if (!value || typeof value !== "object" || !("synced" in value)) continue;
      if (region) { region.invalid = true; continue; }
      const meta = syncedMeta(value.synced);
      const previous = lines[index - 1];
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && /^ */.exec(lines[next])![0].length > /^ */.exec(lines[index])![0].length) continue;
      if (Object.keys(value).length === 1 && meta?.source && previous?.trim() === syncedLink(meta.source) &&
          /^ */.exec(previous)![0] === /^ */.exec(lines[index])![0]) references.set(index - 1, meta);
    } catch {}
  }
  return { sources, references };
}

// Whether the columns marker at index has its closing marker (nested sets counted) before the document ends.
function columnsClosed(lines: string[], index: number, escaped: Set<number>): boolean {
  let open = 0;
  for (let k = index; k < lines.length; k += 1) {
    if (escaped.has(k)) continue;
    if (COLUMNS_OPEN.test(lines[k])) open += 1;
    else if (COLUMNS_CLOSE.test(lines[k])) { open -= 1; if (!open) return true; }
  }
  return false;
}
const ESCAPED_META = /^(\s*)\\(\\*<!--acard)/;
const COLOR_NAME = /^(gray|brown|orange|yellow|green|blue|purple|pink|red)(_background)?$/;

function cleanBlockMeta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  // Synced comments are a whole construct, never partially applied as ordinary block styling.
  if ("synced" in src) return null;
  const out: Record<string, unknown> = {};
  if (typeof src.color === "string" && COLOR_NAME.test(src.color)) out.color = src.color;
  if (typeof src.icon === "string" && src.icon.trim() && [...src.icon.trim()].length <= 8) out.icon = src.icon.trim();
  if (typeof src.height === "number" && Number.isFinite(src.height)) out.height = Math.min(2000, Math.max(120, Math.round(src.height)));
  if (typeof src.toggle === "boolean") out.toggle = src.toggle;
  if (typeof src.open === "boolean") out.open = src.open;
  const actions = mdButtonActions(src.actions);
  if (actions) out.actions = actions;
  // AI marks (acard-human-edit): the block's own mark and its marked text pieces.
  if (AI_MARK.test(String(src.ai))) out.ai = src.ai;
  const spans = aiTextSpans(src.aiSpans);
  if (spans.length) out.aiSpans = spans;
  return Object.keys(out).length ? out : null;
}

// AI marks (assets/ai-marks.js) in the meta line: the block's own mark and its marked pieces as [mark, markdown text].
const AI_MARK = /^(edit|lock|ref)$/;
function aiTextSpans(list: unknown): [string, string][] {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => Array.isArray(s) && (s[0] === "lock" || s[0] === "ref") && typeof s[1] === "string" && s[1] && s[1].length <= 4000)
    .slice(0, 50).map((s) => [s[0], s[1]]);
}
function aiSpansOf(block: Block): [string, string][] {
  const runs = block.meta?.richText;
  if (!Array.isArray(runs) || !runs.some((run: any) => run && (run.ai === "lock" || run.ai === "ref"))) return aiTextSpans(block.meta?.aiSpans);
  const out: [string, string][] = [];
  runs.forEach((run: any, i: number) => {
    const m = run && (run.ai === "lock" || run.ai === "ref") ? run.ai : null;
    if (!m || !run.text) return;
    const piece = block.type === "code" ? String(run.text) : richRun(run);
    if (out.length && runs[i - 1]?.ai === m) out[out.length - 1][1] += piece;
    else out.push([m, piece]);
  });
  return out;
}

// Button actions (notion-parity C3) in a meta comment: only the five known shapes, at most ten, values a flat object; a
// list with any other shape is dropped as a whole. Whether the writer may target a database is checked when it is saved.
const MD_BUTTON_ACTION_TYPES = ["confirm", "create_row", "open", "update_row", "update_related"];
function mdButtonActions(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) return null;
  const flat = (v: unknown) => v === undefined || (!!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 100);
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    const a = item as Record<string, unknown>;
    if (!a || typeof a !== "object" || MD_BUTTON_ACTION_TYPES.indexOf(a.type as string) < 0) return null;
    if (a.type === "confirm") out.push({ type: "confirm", message: String(a.message ?? "").slice(0, 300) });
    else if (a.type === "open") {
      if (a.target === "url") {
        const url = String(a.url ?? "").trim();
        if (!/^(https?:\/\/|\/(?!\/))/.test(url)) return null;
        out.push({ type: "open", target: "url", url: url.slice(0, 2000) });
      } else out.push({ type: "open", target: "created" });
    } else if (a.type === "create_row") {
      if (typeof a.database !== "string" || !a.database || !flat(a.values)) return null;
      out.push({ type: "create_row", database: a.database, ...(typeof a.template === "string" && a.template ? { template: a.template } : {}), values: a.values || {} });
    } else if (a.type === "update_row") {
      if (!flat(a.values)) return null;
      out.push({ type: "update_row", values: a.values || {} });
    } else {
      if (typeof a.relation !== "string" || !a.relation || !flat(a.values)) return null;
      out.push({ type: "update_related", relation: a.relation, values: a.values || {} });
    }
  }
  return out;
}

// The meta a block writes into its comment line: progress keeps its own color syntax, height only for embeds (visual
// fences carry theirs), open with a toggle heading or explicitly folded list (toggle blocks keep their legacy syntax).
function blockMetaComment(block: Block): Record<string, unknown> | null {
  const meta = (block.meta || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (block.type !== "progress" && typeof meta.color === "string" && COLOR_NAME.test(meta.color)) out.color = meta.color;
  if ((block.type === "callout" || block.type === "button") && typeof meta.icon === "string" && meta.icon.trim() && [...meta.icon.trim()].length <= 8) out.icon = meta.icon.trim();
  if (block.type === "button") { const actions = mdButtonActions(meta.actions); if (actions) out.actions = actions; }
  if (block.type === "embed" && Number(meta.height) > 0) out.height = Math.min(2000, Math.max(120, Math.round(Number(meta.height))));
  if (/^heading[1-4]$/.test(block.type) && meta.toggle === true) { out.toggle = true; out.open = meta.open === true; }
  if (/^(bulleted|numbered)$/.test(block.type) && typeof meta.open === "boolean") out.open = meta.open;
  if (AI_MARK.test(String(meta.ai))) out.ai = meta.ai;
  const spans = aiSpansOf(block);
  if (spans.length) out.aiSpans = spans;
  return Object.keys(out).length ? out : null;
}

export function markdownToBlocks(markdown: string, options: MarkdownOptions = {}): Block[] {
  const originalLines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const lines = originalLines.slice();
  const synced = options.meta ? syncedMarkers(lines) : null;
  const blocks: Block[] = [];
  let i = 0;
  // Meta comment lines are found first (by index) so a later unescape cannot turn text into meta.
  const metaLines = new Map<number, Record<string, unknown>>();
  const escaped = new Set<number>();
  if (options.meta) {
    lines.forEach((line, index) => {
      const m = META_LINE.exec(line);
      if (m) { try { const meta = cleanBlockMeta(JSON.parse(m[1])); if (meta) metaLines.set(index, meta); } catch {} }
      else if (ESCAPED_META.test(line)) { lines[index] = line.replace(ESCAPED_META, "$1$2"); escaped.add(index); }
    });
  }

  const push = (type: BlockType, text: string, extra: Partial<Block> = {}) => {
    const target = /^(video|audio|file|embed|bookmark|button)$/.test(type) ? extra.meta?.url : undefined;
    if (typeof target === "string" && target && !(globalThis as typeof globalThis & { EditorModel: { safeHref(value: string): string } }).EditorModel.safeHref(target)) {
      blocks.push({ id: nextId(), type: "paragraph", text: text ? text + " " + target : target, indent: currentIndent });
      return;
    }
    blocks.push({ id: nextId(), type, text, indent: currentIndent, ...extra });
  };
  let currentIndent = 0;
  const columnStack: { base: number; widthsGiven: boolean; head: Block }[] = [];

  while (i < lines.length) {
    const raw = lines[i];
    // Inside a column the written indent starts at 0; the stored depth is the column's + 1.
    currentIndent = Math.floor((/^ */.exec(raw)?.[0].length ?? 0) / 2) + (columnStack.length ? columnStack[columnStack.length - 1].base + 2 : 0);
    const line = raw.trim();

    const source = synced?.sources.get(i);
    if (source) {
      const pad = /^ */.exec(raw)![0];
      const children = markdownToBlocks(originalLines.slice(i + 1, source.end).map(line => line.startsWith(pad) ? line.slice(pad.length) : line).join("\n"), options);
      push("synced", "", { id: source.id, meta: { synced: { v: 1, source: null } } });
      for (const child of children) blocks.push({ ...child, indent: (child.indent || 0) + currentIndent + 1 });
      i = source.end + 1;
      continue;
    }
    const reference = synced?.references.get(i);
    if (reference) {
      push("synced", "", { meta: { synced: reference } });
      i += 2;
      continue;
    }

    const comment = metaLines.get(i);
    if (comment && blocks.length) {
      const last = blocks[blocks.length - 1];
      const { actions, ...rest } = comment;
      last.meta = { ...(last.meta || {}), ...rest, ...(actions && last.type === "button" ? { actions } : {}) };
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (/^```/.test(line.trim()) || (options.meta && /^~~~/.test(line))) {
      const ticks = /^(?:`+|~+)/.exec(line.trim())![0];
      const info = line.trim().slice(ticks.length).trim();
      const langMatch = /^(\S*)\s*(.*)$/.exec(info)!;
      const visual = VISUAL_FENCES[langMatch[1]];
      const lang = visual ? langMatch[1] : info;
      const close = new RegExp("^" + ticks[0] + "{" + ticks.length + ",}\\s*$");
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(visual || ticks.length > 3 || ticks[0] === "~" ? close.test(lines[i].trim()) : /^```/.test(lines[i].trim()))) {
        body.push(lines[i].startsWith("  ".repeat(currentIndent)) ? lines[i].slice(currentIndent * 2) : lines[i]);
        i += 1;
      }
      i += 1;
      if (visual) {
        const meta = visualMeta(langMatch[2], visual);
        push(visual, body.join("\n"), meta ? { meta } : {});
      } else push("code", body.join("\n"), lang ? { meta: { lang } } : {});
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      push("divider", "");
      i += 1;
      continue;
    }

    // 파이프 표는 데이터베이스 블록이 되고, 첫 행이 열 이름이다.
    // 구분 행에 = 가 들어가면 데이터베이스가 아니라 그냥 표(간단 표)가 된다.
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const header = splitTableRow(line);
      const simple = isSimpleTableDivider(lines[i + 1]);
      const rows: Record<string, string>[] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = splitTableRow(lines[i]);
        const row: Record<string, string> = {};
        header.forEach((name, index) => {
          row[name] = cells[index] ?? "";
        });
        rows.push(row);
        i += 1;
      }
      if (simple) {
        const body = rows.map((row) => header.map((name) => row[name] ?? ""));
        push("table", header.join(" | "), { meta: { columns: header, rows: body, header: true } });
      } else {
        push("database", header.join(" | "), { meta: { columns: header, rows } });
      }
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // #### is heading 4 (notion-parity C16); ##### and ###### have no own level and become heading 4.
      const level = Math.min(heading[1].length, 4);
      const type = ("heading" + level) as BlockType;
      push(type, heading[2].trim());
      i += 1;
      continue;
    }

    // 토글: - [toggle] 제목  (아래에 들여쓴 줄이 있으면 그 줄들이 자식이 된다)
    const toggle = /^(\s*)[-*]\s+\[toggle\]\s*(.*)$/.exec(line);
    if (toggle) {
      const indent = currentIndent;
      push("toggle", toggle[2].trim(), { indent });
      i += 1;
      continue;
    }

    // 미디어·레이아웃 한 줄 블록: - [video] 주소, - [button] 라벨 | 주소, - [progress] 70 라벨, - [toc]
    const bracket = /^(\s*)[-*]\s+\[(video|audio|file|embed|bookmark|button|progress|toc|breadcrumb|db_ref)\]\s*(.*)$/.exec(line);
    if (bracket) {
      const kind = bracket[2] as BlockType;
      const rest = bracket[3].trim();
      if (kind === "db_ref") {
        push("db_ref", "", { meta: { database: rest } });
      } else if (kind === "video" || kind === "audio" || kind === "embed" || kind === "bookmark") {
        push(kind, "", { meta: { url: rest } });
      } else if (kind === "file") {
        const cut = rest.indexOf(" ");
        const url = cut >= 0 ? rest.slice(0, cut) : rest;
        const name = cut >= 0 ? rest.slice(cut + 1).trim() : "";
        push("file", name, { meta: { url, name } });
      } else if (kind === "button") {
        const cut = rest.indexOf("|");
        push("button", (cut >= 0 ? rest.slice(0, cut) : rest).trim(), { meta: { url: cut >= 0 ? rest.slice(cut + 1).trim() : "" } });
      } else if (kind === "progress") {
        const m = /^(\d+)\s*%?\s*(.*)$/.exec(rest);
        push("progress", m ? m[2] : rest, { meta: { value: m ? Math.min(100, Math.max(0, Number(m[1]))) : 0, color: "blue" } });
      } else {
        push(kind, "");
      }
      i += 1;
      continue;
    }

    // 이미지 한 줄: ![캡션](주소 "60 t=0:05 g=v1 agent")  — 따옴표 안 숫자는 폭(%), t= 는 영상 속 시각, g= 는 한 줄로
    // 묶을 이미지 무리, agent 는 에이전트가 붙인 이미지 표시다(#33).
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/.exec(line);
    if (image) {
      const meta: Record<string, unknown> = { src: image[2], width: 100 };
      for (const token of (image[3] ?? "").split(/\s+/)) {
        if (/^\d+$/.test(token)) meta.width = Math.min(100, Math.max(10, Number(token)));
        else if (/^t=\d{1,2}(?::\d{2}){1,2}$/.test(token)) meta.time = token.slice(2);
        else if (/^g=[\w-]{1,24}$/.test(token)) meta.group = token.slice(2);
        else if (token === "agent") meta.agent = true;
      }
      push("image", image[1], { meta });
      i += 1;
      continue;
    }

    // 수식 겉치장: $$ 와 $$ 사이
    if (/^\$\$\s*$/.test(line.trim())) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\$\$\s*$/.test(lines[i].trim())) {
        body.push(lines[i].startsWith("  ".repeat(currentIndent)) ? lines[i].slice(currentIndent * 2) : lines[i]);
        i += 1;
      }
      i += 1;
      push("equation", body.join("\n").trim());
      continue;
    }

    // 열 나누기 겉치장: :::cols 와 ::: 사이, --- 로 열을 나눈다 (최대 3열)
    if (/^:::\s*cols?\d*\s*$/i.test(line.trim())) {
      const cols: { text: string }[] = [];
      let current: string[] = [];
      i += 1;
      while (i < lines.length && !/^:::\s*$/.test(lines[i].trim())) {
        if (/^-{3,}$/.test(lines[i].trim())) {
          cols.push({ text: current.join("\n").trim() });
          current = [];
          i += 1;
          continue;
        }
        current.push(lines[i]);
        i += 1;
      }
      i += 1;
      cols.push({ text: current.join("\n").trim() });
      // 3열을 넘으면 남은 묶음을 버리지 않고 마지막 열로 합친다.
      while (cols.length > 3) {
        const extra = cols.pop()!;
        cols[cols.length - 1].text = (cols[cols.length - 1].text + "\n" + extra.text).trim();
      }
      while (cols.length < 2) cols.push({ text: "" });
      // Old :::cols markdown still reads as columns, now as columns + column + paragraph blocks (notion-parity C13).
      const legacy = { id: nextId(), type: "columns" as BlockType, text: "", indent: currentIndent, meta: { columns: cols } };
      const converted = (globalThis as any).ColumnsModel ? (globalThis as any).ColumnsModel.columnsFromLegacy([legacy]) : [legacy];
      for (const block of converted) blocks.push(block.type === "columns" || block.type === "column" ? { ...block, id: nextId() } : { ...block, id: nextId(), meta: undefined } as Block);
      continue;
    }

    // Column marker lines (notion-parity C13), only in an acard_meta document and only as a whole line:
    // <!--acard columns {"widths":[..]}--> ... <!--acard column--> ... <!--acard /columns-->. The blocks between two
    // markers are ordinary markdown written without the column's own indent; an unclosed set stays text.
    if (options.meta && !escaped.has(i) && COLUMNS_OPEN.test(raw) && columnsClosed(lines, i, escaped)) {
      const open = COLUMNS_OPEN.exec(raw)!;
      let widths: number[] | null = null;
      try { const parsed = open[2] ? JSON.parse(open[2]) : null; if (parsed && Array.isArray(parsed.widths) && parsed.widths.every((w: unknown) => typeof w === "number" && w > 0)) widths = parsed.widths; } catch {}
      const base = currentIndent;
      push("columns", "", widths ? { meta: { widths } } : {});
      columnStack.push({ base, widthsGiven: !!widths, head: blocks[blocks.length - 1] });
      i += 1;
      continue;
    }
    if (options.meta && !escaped.has(i) && columnStack.length && COLUMN_LINE.test(raw)) {
      const top = columnStack[columnStack.length - 1];
      blocks.push({ id: nextId(), type: "column", text: "", indent: top.base + 1 });
      i += 1;
      continue;
    }
    if (options.meta && !escaped.has(i) && columnStack.length && COLUMNS_CLOSE.test(raw)) {
      const top = columnStack.pop()!;
      const count = blocks.filter((b, k) => k > blocks.indexOf(top.head) && b.type === "column" && b.indent === top.base + 1).length;
      if (!top.widthsGiven && count) top.head.meta = { widths: Array.from({ length: count }, () => Math.round(10000 / count) / 10000) };
      i += 1;
      continue;
    }

    // 주소만 있는 줄은 북마크 블록이 된다 (노션에서 주소를 붙여넣으면 카드가 되는 것과 같다)
    if (/^https?:\/\/\S+$/.test(line.trim())) {
      push("bookmark", "", { meta: { url: line.trim() } });
      i += 1;
      continue;
    }

    // 할 일: - [ ] / - [x]
    const todo = /^(\s*)[-*]\s+\[( |x|X)\]\s*(.*)$/.exec(line);
    if (todo) {
      const indent = currentIndent;
      push("to_do", todo[3].trim(), { indent, checked: todo[2].toLowerCase() === "x" });
      i += 1;
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = currentIndent;
      push("bulleted", bullet[2].trim(), { indent });
      i += 1;
      continue;
    }
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const indent = currentIndent;
      push("numbered", numbered[2].trim(), { indent });
      i += 1;
      continue;
    }

    // 콜아웃: > [!note] 내용  (다음 줄부터 이어지는 인용은 같은 콜아웃)
    const callout = /^>\s*\[!(\w+)\]\s*(.*)$/i.exec(line);
    if (callout) {
      const parts = [callout[2].trim()];
      i += 1;
      while (i < lines.length && /^>\s?/.test(lines[i].trimStart()) && lines[i].trim() !== ">") {
        parts.push(lines[i].trimStart().replace(/^>\s?/, "").trimEnd());
        i += 1;
      }
      push("callout", parts.join("\n").trim(), { meta: { tone: callout[1].toLowerCase() } });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trimStart())) {
        parts.push(lines[i].trimStart().replace(/^>\s?/, "").trimEnd());
        i += 1;
      }
      push("quote", parts.join("\n").trim());
      continue;
    }

    const parts: string[] = [line.trim()];
    i += 1;
    while (i < lines.length) {
      const peek = lines[i];
      if (
        Math.floor((/^ */.exec(peek)?.[0].length ?? 0) / 2) !== currentIndent ||
        peek.trim() === "" ||
        /^(#{1,6})\s+/.test(peek.trim()) ||
        /^(\s*)[-*+]\s+/.test(peek) ||
        /^(\s*)\d+[.)]\s+/.test(peek) ||
        /^>\s?/.test(peek) ||
        /^```/.test(peek.trim()) ||
        (options.meta && /^~~~/.test(peek.trim())) ||
        synced?.sources.has(i) || synced?.references.has(i) ||
        isTableRow(peek) ||
        /^https?:\/\/\S+$/.test(peek.trim()) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(peek.trim()) ||
        metaLines.has(i)
      ) {
        break;
      }
      parts.push(peek.trim());
      i += 1;
    }
    push("paragraph", parts.join(" ").trim());
  }

  return blocks;
}

function tableCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "&#124;").replace(/\n/g, " ");
}

// Rich runs keep only the marks the reader's inline() renders back: bold, code and links.
function richMarkdown(block: Block): string {
  const runs = block.meta?.richText;
  if (!Array.isArray(runs) || block.type === "code") return block.text;
  return runs.map(richRun).join("");
}

function richRun(run: any): string {
  let text = String(run?.text ?? "");
  if (!text.trim()) return text;
  if (run.code) text = "`" + text + "`";
  if (run.bold) text = "**" + text + "**";
  const href = run.mention?.type === "page" ? "/" + run.mention.slug + "/" : run.href;
  if (typeof href === "string" && /^(https?:\/\/|\/)/.test(href)) text = "[" + text + "](" + href + ")";
  return text;
}

// Two-space indentation preserves child hierarchy without replacing existing flat callers.
// Every block type has a markdown form that markdownToBlocks reads back as the same type.
// Numbered items are written 1. 2. 3. per list (a list restarts after any other block at its indent), so an agent
// that edits the markdown by text sees the same numbers the reader shows.
export function blocksToMarkdown(blocks: Block[], options: MarkdownOptions = {}): string {
  const counters: number[] = [];
  const model = (globalThis as any).ColumnsModel;
  if (model) blocks = model.columnsFromLegacy(blocks);
  // Column children are written without the 2 levels each enclosing columns adds (notion-parity C13).
  const lift: number[] = model ? model.columnsLevels(blocks).map((n: number) => n * 2) : blocks.map(() => 0);
  const closers: { indent: number; text: string }[] = [];
  const out: string[] = [];
  let skipUntil = -1;
  blocks.forEach((block, index) => {
    if (index < skipUntil) return;
    while (closers.length && (block.indent || 0) <= closers[closers.length - 1].indent) out.push(closers.pop()!.text);
    if (block.type === "synced") {
      const meta = syncedMeta(block.meta?.synced);
      const depth = block.indent || 0;
      let end = index + 1;
      while (end < blocks.length && (blocks[end].indent || 0) > depth) end += 1;
      if (!meta || block.text || !SYNCED_ID.test(block.id) || (meta.source && end !== index + 1) ||
          blocks.slice(index + 1, end).some(child => child.type === "synced")) throw new Error("Invalid synced block structure: " + block.id);
      const pad = "  ".repeat(Math.max(0, depth - lift[index]));
      if (meta.source) {
        out.push(pad + syncedLink(meta.source) + (options.meta ? "\n" + pad + "<!--acard " + JSON.stringify({ synced: meta }) + "-->" : ""));
      } else {
        const content = blocksToMarkdown(blocks.slice(index + 1, end).map(child => ({ ...child, indent: (child.indent || 0) - depth - 1 })), options);
        if (options.meta) out.push(pad + "<!--acard synced " + JSON.stringify({ v: 1, id: block.id }) + "-->");
        if (content) out.push(content.split("\n").map(line => line ? pad + line : "").join("\n"));
        if (options.meta) out.push(pad + "<!--acard /synced-->");
      }
      skipUntil = end;
      return;
    }
    if (!options.meta && block.type === "columns" && model) {
      // Without the flag, columns that hold only one-line paragraphs go back to :::cols (reads back the same).
      const plain = plainColumns(blocks, index);
      if (plain) { out.push("  ".repeat(Math.max(0, (block.indent || 0) - lift[index])) + plain.text); skipUntil = plain.end; return; }
    }
    const text = blockMarkdown(block, index);
    if (text !== null) out.push(text);
  });
  while (closers.length) out.push(closers.pop()!.text);
  return out.join("\n\n");

  function plainColumns(list: Block[], index: number): { text: string; end: number } | null {
    const head = list[index], d = head.indent || 0;
    let end = index + 1;
    while (end < list.length && (list[end].indent || 0) > d) end += 1;
    const cols: string[][] = [];
    for (let k = index + 1; k < end; k += 1) {
      const b = list[k];
      if (b.type === "column" && (b.indent || 0) === d + 1) { cols.push([]); continue; }
      if (!cols.length || b.type !== "paragraph" || (b.indent || 0) !== d + 2 || !b.text || b.text.includes("\n") || /^\s|\s$/.test(b.text) || /^(:::|-{3,}$)/.test(b.text) || (b.meta && Object.keys(b.meta).some((key) => key !== "richText"))) return null;
      cols[cols.length - 1].push(richMarkdown(b));
    }
    if (cols.length < 2 || cols.length > 3) return null;
    const widths = head.meta?.widths;
    if (Array.isArray(widths) && widths.some((w: number) => Math.abs(w - 1 / cols.length) > 0.001)) return null;
    return { text: [":::cols", ...cols.map((lines, n) => (n ? "---\n" : "") + lines.join("\n")), ":::"].join("\n"), end };
  }

  function blockMarkdown(block: Block, index: number): string | null {
    const pad = "  ".repeat(Math.max(0, (block.indent || 0) - lift[index]));
    if ((block.type === "columns" && !Array.isArray(block.meta?.columns)) || block.type === "column") {
      // Without the acard_meta flag there is no marker syntax: the columns' blocks are written one after another.
      if (!options.meta) return null;
      if (block.type === "columns") {
        const widths = Array.isArray(block.meta?.widths) ? block.meta!.widths : null;
        closers.push({ indent: block.indent || 0, text: pad + "<!--acard /columns-->" });
        return pad + "<!--acard columns" + (widths ? " " + JSON.stringify({ widths }) : "") + "-->";
      }
      return pad + "<!--acard column-->";
    }
    return plainBlockMarkdown(block, pad);
  }

  function plainBlockMarkdown(block: Block, pad: string): string {
    const meta = (block.meta || {}) as Record<string, any>;
    const level = Math.max(0, block.indent || 0);
    counters.length = Math.min(counters.length, level + 1);
    if (block.type === "numbered") counters[level] = (counters[level] || 0) + 1;
    else counters.length = Math.min(counters.length, level);
    let text = richMarkdown(block);
    switch (block.type) {
      case "heading1": text = "# " + text; break;
      case "heading2": text = "## " + text; break;
      case "heading3": text = "### " + text; break;
      case "heading4": text = "#### " + text; break;
      case "bulleted": text = "- " + text; break;
      case "numbered": text = counters[level] + ". " + text; break;
      case "to_do": text = "- [" + (block.checked ? "x" : " ") + "] " + text; break;
      case "toggle": text = "- [toggle] " + text; break;
      case "callout": text = "> [!" + String(block.meta?.tone || "note") + "] " + text.replace(/\n/g, "\n> "); break;
      case "quote": text = text.split("\n").map(line => "> " + line).join("\n"); break;
      case "code": text = "```" + String(block.meta?.lang || "") + "\n" + text + "\n```"; break;
      case "diagram": case "chart": case "visual": case "html": case "part": case "component": {
        const picked: Record<string, unknown> = {};
        for (const key of fenceMetaKeys(block.type)) if (meta[key] !== undefined && meta[key] !== "" && meta[key] !== null) picked[key] = meta[key];
        const fence = "`".repeat(Math.max(3, ...[...block.text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1].length + 1)));
        text = fence + VISUAL_LANGS[block.type] + (Object.keys(picked).length ? " " + JSON.stringify(picked) : "") + "\n" + block.text + "\n" + fence;
        break;
      }
      case "divider": text = "---"; break;
      case "database": {
        const columns = Array.isArray(block.meta?.columns) ? block.meta.columns.map(String) : [];
        const rows = Array.isArray(block.meta?.rows) ? block.meta.rows : [];
        const rowText = (cells: unknown[]) => "| " + cells.map(tableCell).join(" | ") + " |";
        text = [rowText(columns), rowText(columns.map(() => "---")), ...rows.map(row => rowText(columns.map(column => String(row[column] ?? "")) ))].join("\n");
        break;
      }
      case "table": {
        const columns = Array.isArray(meta.columns) ? meta.columns.map(String) : [];
        const rows = Array.isArray(meta.rows) ? meta.rows : [];
        const rowText = (cells: unknown[]) => "| " + cells.map(tableCell).join(" | ") + " |";
        text = [rowText(columns), rowText(columns.map(() => "===")), ...rows.map((row: unknown[]) => rowText(columns.map((_c: string, index: number) => Array.isArray(row) ? row[index] : "")))].join("\n");
        break;
      }
      case "image": {
        const tokens = [
          meta.width && Number(meta.width) !== 100 ? String(Number(meta.width)) : "",
          typeof meta.time === "string" && /^\d{1,2}(?::\d{2}){1,2}$/.test(meta.time) ? "t=" + meta.time : "",
          typeof meta.group === "string" && /^[\w-]{1,24}$/.test(meta.group) ? "g=" + meta.group : "",
          meta.agent === true ? "agent" : "",
        ].filter(Boolean);
        text = "![" + block.text.replace(/[\]\n]/g, " ") + "](" + String(meta.src || "") + (tokens.length ? ' "' + tokens.join(" ") + '"' : "") + ")";
        break;
      }
      case "video": case "audio": case "embed": text = "- [" + block.type + "] " + String(meta.url || ""); break;
      case "bookmark": text = /^https?:\/\/\S+$/.test(String(meta.url || "")) ? String(meta.url) : "- [bookmark] " + String(meta.url || ""); break;
      case "file": text = "- [file] " + String(meta.url || "") + (block.text || meta.name ? " " + (block.text || meta.name) : ""); break;
      case "button": text = "- [button] " + block.text + (meta.url ? " | " + meta.url : ""); break;
      case "progress": text = "- [progress] " + Math.min(100, Math.max(0, Number(meta.value) || 0)) + (block.text ? " " + block.text : ""); break;
      case "toc": case "breadcrumb": text = "- [" + block.type + "]"; break;
      case "db_ref": text = "- [db_ref] " + String(meta.database || ""); break;
      case "equation": text = "$$\n" + block.text + "\n$$"; break;
      case "columns": {
        // A page too full to convert keeps its old text-only columns: write them as :::cols, which reads back as columns.
        const cols = Array.isArray(meta.columns) ? meta.columns : [];
        text = [":::cols", ...cols.map((col: { text?: string }, index: number) => (index ? "---\n" : "") + String(col?.text ?? "")), ":::"].join("\n");
        break;
      }
      case "paragraph": break;
    }
    if (!options.meta) return text.split("\n").map(line => pad + line).join("\n");
    const lines = text.split("\n").map(line => pad + line.replace(/^(\s*)(\\*<!--acard)/, "$1\\$2"));
    const comment = blockMetaComment(block);
    if (comment) lines.push(pad + "<!--acard " + JSON.stringify(comment) + "-->");
    return lines.join("\n");
  }
}

// 블록 안에서 나가는 링크를 뽑는다 (백링크용). [[슬러그]] 와 [글](/슬러그/) 둘 다 인정한다.
export function blockLinks(blocks: Block[]): string[] {
  const found = new Set<string>();
  const text = blocks.map((block) => block.text).join("\n");
  for (const match of text.matchAll(/\[\[([^[\]\n|#]+)[^[\]\n]*\]\]/g)) {
    const name = match[1].trim();
    if (name && !/\s/.test(name)) found.add(name);
  }
  for (const match of text.matchAll(/\]\(\/([^)\s#?]+)\/?\)/g)) {
    const slug = match[1].replace(/\/$/, "");
    if (slug && !slug.includes("/")) found.add(slug);
  }
  return [...found];
}

export function blocksHash(blocks: Block[]): string {
  const text = JSON.stringify(blocks);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}
