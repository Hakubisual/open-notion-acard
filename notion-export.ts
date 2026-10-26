// 저장된 블록을 마크다운 / 독립 HTML / 워크스페이스 ZIP으로 되돌린다.
// 워커 안에서 돌아야 하므로 Node API도 npm 패키지도 쓰지 않는다.
import "./assets/columns-model.js";
import { renderBlocks } from "./block-html.js";
import type { Block } from "./markdown-blocks.ts";

export type NotionExportPage = { slug: string; title: string; blocks: Block[]; folder?: string; tags?: string[] };

function notionExportCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function notionExportBlock(block: Block): string[] {
  const pad = "  ".repeat(block.indent || 0);
  const meta = block.meta || {};
  const text = block.text || "";
  switch (block.type) {
    case "synced":
      return ["Synced content unavailable", ""];
    case "heading1":
      return ["# " + text, ""];
    case "heading2":
      return ["## " + text, ""];
    case "heading3":
      return ["### " + text, ""];
    case "heading4":
      return ["#### " + text, ""];
    case "bulleted":
      return [pad + "- " + text];
    case "numbered":
      return [pad + "1. " + text];
    case "to_do":
      return [pad + (block.checked ? "- [x] " : "- [ ] ") + text];
    case "toggle":
      return [pad + "- [toggle] " + text];
    case "callout": {
      const tone = typeof meta.tone === "string" && meta.tone ? meta.tone : "note";
      const [first, ...rest] = text.split("\n");
      return ["> [!" + tone + "] " + first, ...rest.map((line) => "> " + line), ""];
    }
    case "quote":
      return [...text.split("\n").map((line) => "> " + line), ""];
    case "code": {
      const lang = typeof meta.lang === "string" ? meta.lang : "";
      return ["```" + lang, ...text.split("\n"), "```", ""];
    }
    case "divider":
      return ["---", ""];
    case "database": {
      const columns = Array.isArray(meta.columns) ? (meta.columns as unknown[]).map(String) : [];
      const rows = Array.isArray(meta.rows) ? (meta.rows as Record<string, unknown>[]) : [];
      const out = [
        "| " + columns.map(notionExportCell).join(" | ") + " |",
        "| " + columns.map(() => "---").join(" | ") + " |",
      ];
      for (const row of rows) {
        out.push("| " + columns.map((name) => notionExportCell(row?.[name])).join(" | ") + " |");
      }
      out.push("");
      return out;
    }
    default:
      return [text, ""];
  }
}

// Notion's markdown import has no columns, so they are laid out one after another (on purpose lossy, notion-parity C13):
// the columns and column rows write nothing and their blocks lose the 2 levels each enclosing columns adds.
export function notionBlocksToMarkdown(title: string, blocks: Block[]): string {
  const lines: string[] = ["# " + title, ""];
  const model = (globalThis as any).ColumnsModel;
  const flat = model ? model.columnsFromLegacy(blocks) as Block[] : blocks;
  const levels: number[] = model ? model.columnsLevels(flat) : flat.map(() => 0);
  flat.forEach((block, index) => {
    if (block.type === "columns" && !Array.isArray(block.meta?.columns) || block.type === "column") return;
    lines.push(...notionExportBlock(levels[index] ? { ...block, indent: Math.max(0, (block.indent || 0) - levels[index] * 2) } : block));
  });
  while (lines.length > 2 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

function notionExportEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NOTION_EXPORT_CSS = [
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;line-height:1.7;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1f2328;background:#fff}",
  "h1{font-size:2rem;line-height:1.3}",
  "pre{background:#f6f8fa;padding:.75rem 1rem;overflow:auto;border-radius:6px}",
  "code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
  "blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:4px solid #d0d7de;color:#57606a}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{border:1px solid #d0d7de;padding:.4rem .6rem;text-align:left}",
  "hr{border:0;border-top:1px solid #d0d7de}",
  "@media print{body{max-width:none;margin:0;color:#000}pre{white-space:pre-wrap}a{color:inherit;text-decoration:none}}",
].join("\n");

export function pageToHtml(page: { title: string; blocks: Block[] }): string {
  const title = notionExportEscape(page.title);
  return (
    '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + title + "</title>\n<style>\n" + NOTION_EXPORT_CSS + "\n</style>\n</head>\n<body>\n" +
    "<article>\n<h1>" + title + "</h1>\n" + renderBlocks(page.blocks, { page: { readOnly: true } }) + "\n</article>\n</body>\n</html>\n"
  );
}

let notionExportCrcTable: Uint32Array | null = null;

function notionExportCrc32(data: Uint8Array): number {
  if (!notionExportCrcTable) {
    notionExportCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      notionExportCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = notionExportCrcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function workspaceToZip(pages: NotionExportPage[]): Uint8Array {
  const encoder = new TextEncoder();
  const fileOf = (page: NotionExportPage) => (page.folder ? page.folder + "/" : "") + page.slug + ".md";
  const frontMatter = (page: NotionExportPage) =>
    page.tags && page.tags.length ? "---\ntags: [" + page.tags.map((tag) => JSON.stringify(tag)).join(", ") + "]\n---\n\n" : "";
  const index =
    "# 목차\n\n" + pages.map((page) => "- [" + page.title + "](./" + fileOf(page) + ")").join("\n") + "\n";
  const files = [{ name: "index.md", data: encoder.encode(index) }].concat(
    pages.map((page) => ({
      name: fileOf(page),
      data: encoder.encode(frontMatter(page) + notionBlocksToMarkdown(page.title, page.blocks)),
    })),
  );

  // 고정 시각 2026-01-01 00:00:00 (결과가 항상 같도록)
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const dosTime = 0;
  const flags = 0x0800;

  const entries = files.map((file) => ({
    nameBytes: encoder.encode(file.name),
    data: file.data,
    crc: notionExportCrc32(file.data),
    offset: 0,
  }));

  let total = 22;
  for (const e of entries) total += 30 + e.nameBytes.length + e.data.length + 46 + e.nameBytes.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const e of entries) {
    e.offset = pos;
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, flags, true);
    view.setUint16(pos + 8, 0, true);
    view.setUint16(pos + 10, dosTime, true);
    view.setUint16(pos + 12, dosDate, true);
    view.setUint32(pos + 14, e.crc, true);
    view.setUint32(pos + 18, e.data.length, true);
    view.setUint32(pos + 22, e.data.length, true);
    view.setUint16(pos + 26, e.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    pos += 30;
    out.set(e.nameBytes, pos);
    pos += e.nameBytes.length;
    out.set(e.data, pos);
    pos += e.data.length;
  }

  const cdStart = pos;
  for (const e of entries) {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, flags, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, dosTime, true);
    view.setUint16(pos + 14, dosDate, true);
    view.setUint32(pos + 16, e.crc, true);
    view.setUint32(pos + 20, e.data.length, true);
    view.setUint32(pos + 24, e.data.length, true);
    view.setUint16(pos + 28, e.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, e.offset, true);
    pos += 46;
    out.set(e.nameBytes, pos);
    pos += e.nameBytes.length;
  }

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, pos - cdStart, true);
  view.setUint32(pos + 16, cdStart, true);
  view.setUint16(pos + 20, 0, true);
  return out;
}
