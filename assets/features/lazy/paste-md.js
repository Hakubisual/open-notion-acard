// Markdown paste (issue 134): text copied from Obsidian, an AI chat or a Notion page becomes real blocks. build.ts
// bundles this entry with the import modules into lazy/paste-md.js; editor-next loads it on the first paste that looks
// like markdown and calls pasteBlocks(text, titles).
import { markdownToBlocks } from "../../../markdown-blocks.ts";
import { impInlineRuns } from "../../../import-inline.ts";
import { impSanitizeBlocks } from "../../../import-sanitize.ts";

const TONES = { note: "note", info: "note", todo: "note", abstract: "info", summary: "info", tldr: "info", example: "info", tip: "tip", hint: "tip", important: "tip", success: "success", check: "success", done: "success", question: "question", help: "question", faq: "question", warning: "warning", caution: "warning", attention: "warning", failure: "danger", fail: "danger", missing: "danger", danger: "danger", error: "danger", bug: "danger", quote: "quote", cite: "quote" };
const TEXT = new Set(["paragraph", "heading1", "heading2", "heading3", "heading4", "bulleted", "numbered", "to_do", "toggle", "quote", "callout"]);

function pasteBlocks(text, titles) {
  let body = String(text || "").replace(/\r\n?/g, "\n");
  const front = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(body);
  if (front) body = body.slice(front[0].length);
  body = body.replace(/%%[\s\S]*?%%/g, "");
  body = body.replace(/^>\s*>\s*(?=\[!)/gm, "\n> ");
  body = body.replace(/^(>\s*)+\[!(\w+)\]([+-]?)[ \t]*(.*)$/gm, (_all, _q, type, _fold, title) => "> [!" + (TONES[type.toLowerCase()] || "note") + "] " + title);
  const bySlug = new Map();
  for (const t of titles || []) bySlug.set(String(t.title || "").toLowerCase(), String(t.slug));
  const link = (target) => {
    const slug = bySlug.get(String(target).replace(/\.md$/i, "").split("/").pop().toLowerCase());
    return slug ? { mention: slug } : null;
  };
  const blocks = markdownToBlocks(body);
  for (const b of blocks) {
    if (!TEXT.has(b.type)) continue;
    const runs = impInlineRuns(b.text, { link, href: (href) => (/^(https?:|mailto:|\/(?!\/)|#)/i.test(href) ? href : null) });
    if (!runs) continue;
    b.text = runs.text;
    b.meta = { ...(b.meta || {}), richText: runs.richText };
  }
  return impSanitizeBlocks(blocks).blocks;
}

// URL paste uses the human-edit menu and existing rich text / media blocks. Nothing is written until a choice is made.
function offerImage(at, url, showNotice) {
  const editor = window.AcardEditor;
  showNotice("붙여넣은 주소를 이미지로 넣을까요?", { label: "이미지로 넣기", run: function () {
    editor.setSave("이미지를 가져오는 중…", true);
    editor.api("/media/import", { method: "POST", body: JSON.stringify({ url: url, page: editor.slug }) }).then(function (res) {
      const block = editor.state.blocks.find(function (b) { return b.id === at.block.id; });
      if (block && typeof block.text === "string" && block.text.indexOf(url) >= 0) { block.text = block.text.split(url).join("").trim(); if (block.meta && block.meta.richText) delete block.meta.richText; }
      editor.insertBlocksAfter(at.block.id, [{ type: "image", text: "", meta: { src: res.url, width: 100 } }]);
      editor.scheduleSave();
      editor.setSave("이미지를 넣었어요", false);
    }).catch(function (error) { editor.setSave("이미지를 가져오지 못했어요: " + error.message, true); });
  } });
}

let urlMenu;
async function offerUrl(value, blockId, offset, before) {
  const editor = window.AcardEditor, model = window.EditorModel;
  const url = new URL(value);
  if (!editor.coreEditing || !/^https?:$/.test(url.protocol)) return;
  const point = { kind: "text", blockId, offset };
  const selection = { anchor: point, focus: point, selectedBlockIds: [] };
  let changed = JSON.stringify(editor.state.blocks) !== before;
  const offChange = editor.on("change", () => { changed = true; close(); });
  const offRemote = editor.on("remoteAdopted", () => { changed = true; close(); });
  let menu = null, context = null;
  function close() { if (context && menu && menu.current?.scope === "paste") menu.close(false); offChange(); offRemote(); }
  function valid() { return !changed && JSON.stringify(editor.state.blocks) === before; }
  try {
    const loaded = await Promise.all([editor.lazy("context-menu"), editor.lazy("block-commands"), editor.lazy("editor-selection")]);
    if (!valid()) return close();
    menu = loaded[0];
    if (urlMenu !== menu) {
      urlMenu = menu;
      [["link", "링크로 붙여넣기"], ["mention", "페이지 멘션"], ["preview", "미리보기"], ["embed", "임베드"], ["image", "이미지로 넣기"]].forEach(([id, label]) => {
        menu.register({ id: "paste-url-" + id, label, scope: "paste", group: "insert", icon: "link", when: ctx => ctx.choices.includes(id), run: ctx => ctx.choose(id) });
      });
    }
    const path = /^\/(?:edit\/)?([^/]+)\/?$/.exec(url.pathname);
    const page = url.origin === location.origin && path && !url.hash && editor.state.pages.find(p => p.slug === decodeURIComponent(path[1]));
    const choices = ["link"];
    if (page) choices.push("mention");
    choices.push("preview");
    // Match the existing editor embed surface: HTTPS only, not Acard's own hosts or IP addresses.
    if (url.protocol === "https:" && url.origin !== location.origin && !/(^|\.)(acard\.dev|pages\.dev|localhost)\.?$/.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(":") && url.hostname.includes(".")) choices.push("embed");
    choices.push("image");
    editor.restoreSelection(selection);
    const range = getSelection().getRangeAt(0), rect = range.getBoundingClientRect();
    const host = document.getElementById("block-" + selection.anchor.blockId);
    const fallback = host.getBoundingClientRect();
    context = { choices, x: rect.left || fallback.left, y: (rect.bottom || fallback.top) + 4, onClose: () => { offChange(); offRemote(); }, choose: async kind => {
      if (!valid()) return;
      // Re-subscribe while an image or preview request is in flight, including change -> undo sequences.
      const off = editor.on("change", () => { changed = true; }), remote = editor.on("remoteAdopted", () => { changed = true; });
      try {
        let block;
        if (kind === "preview") {
          const preview = await editor.api("/link-preview?url=" + encodeURIComponent(value));
          block = { type: "bookmark", text: "", meta: { url: value, title: preview.title || "", description: preview.description || "", image: preview.image || "", site: preview.site || "" } };
        } else if (kind === "image") {
          const image = await editor.api("/media/import", { method: "POST", body: JSON.stringify({ url: value, page: editor.slug }) });
          block = { type: "image", text: "", meta: { src: image.url, width: 100 } };
        } else if (kind === "embed") block = { type: "embed", text: "", meta: { url: value } };
        if (!valid()) { editor.setSave("내용이 바뀌었어요. 동작을 다시 눌러 주세요.", true); return; }
        off(); remote();
        if (block) return editor.commands.insertBlocks([block], selection);
        const target = editor.state.blocks.find(b => b.id === selection.anchor.blockId);
        const run = kind === "mention" ? { text: page.title, mention: { type: "page", slug: page.slug } } : { text: value, href: value };
        editor.transact("paste URL", tx => {
          let offset = 0, inserted = false;
          const rich = [];
          model.richText(target.meta && target.meta.richText, target.text).forEach(part => {
            const cut = selection.anchor.offset - offset;
            if (!inserted && cut >= 0 && cut <= part.text.length) {
              if (cut) rich.push({ ...part, text: part.text.slice(0, cut) });
              rich.push(run); inserted = true;
              if (cut < part.text.length) rich.push({ ...part, text: part.text.slice(cut) });
            } else rich.push(part);
            offset += part.text.length;
          });
          if (!inserted) rich.push(run);
          target.text = rich.map(r => r.text).join(""); target.meta = { ...target.meta, richText: rich };
          const point = { ...selection.anchor, offset: selection.anchor.offset + run.text.length };
          tx.setSelection({ anchor: point, focus: point, selectedBlockIds: [] });
        }, { beforeSelection: selection });
      } finally { off(); remote(); }
    } };
    menu.openPaste(context);
  } catch (error) { close(); throw error; }
}

  // --- Files: every dropped or pasted file becomes its own block where it was dropped ---
  var MAX = 4 * 1024 * 1024;
  function shrink(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (img) {
      var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      if (scale === 1 && file.size <= MAX) return file;
      var canvas = document.createElement("canvas"); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return new Promise(function (ok) { canvas.toBlob(function (blob) { ok(blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file); }, "image/jpeg", 0.88); });
    }).catch(function () { return file; });
  }
  function kindOf(file) {
    if (/^image\//.test(file.type)) return "image";
    if (/^video\//.test(file.type)) return "video";
    if (/^audio\//.test(file.type)) return "audio";
    if (file.type === "application/pdf" || file.type === "text/plain") return "file";
    return null;
  }
  function addFiles(files, at, net) {
    var editor = window.AcardEditor, model = window.EditorModel, state = function () { return editor.state; };
    var errors = [], accepted = [];
    files.forEach(function (file) {
      var kind = kindOf(file);
      if (!kind) errors.push(file.name + ": 올릴 수 없는 형식");
      else accepted.push({ file: file, block: { type: kind, text: kind === "file" ? file.name : "", meta: kind === "image" ? { src: "", width: 100 } : { url: "", name: file.name }, _busy: true } });
    });
    if (!accepted.length) { editor.setSave("올리기 실패: " + errors.join(", "), true); return; }
    if (editor.coreEditing) {
      // Uploads are provisional until complete: do not put empty placeholders into document history.
      var anchorId = at ? at.block.id : (state().blocks[state().blocks.length - 1] || {}).id;
      if (!anchorId) return;
      var finished = 0;
      editor.setSave("올리는 중… (0/" + accepted.length + ")", true);
      return Promise.all(accepted.map(function (item) {
        return shrink(item.file).then(function (file) {
          if (item.block.type === "video" || file.size > MAX) return editor.lazy("big-upload").then(function (big) { return big.upload(file, editor.slug); });
          var form = new FormData(); form.append("file", file, file.name);
          return net("/api/upload", { method: "POST", body: form }).then(function (res) {
            return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || String(res.status)); return body; });
          });
        }).then(function (res) {
          delete item.block._busy;
          item.block.meta = Object.assign({}, item.block.meta, { src: res.url, url: res.url, name: res.name, size: res.size }, res.poster ? { poster: res.poster } : {});
          return item.block;
        }, function (error) { errors.push(item.file.name + ": " + error.message); return null; }).finally(function () {
          finished++; editor.setSave("올리는 중… (" + finished + "/" + accepted.length + ")", true);
        });
      })).then(async function (uploaded) {
        var ready = uploaded.filter(Boolean);
        if (ready.length) {
          await Promise.all([editor.lazy("block-commands"), editor.lazy("editor-selection")]);
          var index = state().blocks.findIndex(function (block) { return block.id === anchorId; });
          if (index < 0) {
            await Promise.all(ready.map(function (block) { return editor.api(block.meta.src, { method: "DELETE" }); }));
            editor.setSave("내용이 바뀌었어요. 동작을 다시 눌러 주세요.", true);
            return;
          }
          editor.transact("paste files", function () {
            var anchor = state().blocks[index];
            if (anchor.type === "image" && !(anchor.meta && anchor.meta.src) && ready[0].type === "image") {
              anchor.meta = ready.shift().meta;
            }
            if (ready.length) editor.insertBlocksAfter(anchorId, ready);
          });
        }
        if (errors.length) editor.setSave("올리기 실패: " + errors.join(", "), true);
      });
    }
    var ids;
    var list = state().blocks;
    if (at && at.block.type === "image" && !(at.block.meta && at.block.meta.src) && accepted[0].block.type === "image") {
      Object.assign(at.block, { _busy: true }); accepted[0].block = at.block;
      ids = [at.block.id].concat(accepted.length > 1 ? editor.insertBlocksAfter(at.block.id, accepted.slice(1).map(function (a) { return a.block; })) : []);
      if (accepted.length === 1) editor.render();
    } else if (at) ids = editor.insertBlocksAfter(at.block.id, accepted.map(function (a) { return a.block; }));
    else if (list.length) ids = editor.insertBlocksAfter(list[list.length - 1].id, accepted.map(function (a) { return a.block; }));
    else return;
    var done = 0, failed = errors.slice(), notes = [];
    editor.setSave("올리는 중… (0/" + accepted.length + ")", true);
    accepted.forEach(function (item, i) {
      var block = state().blocks.find(function (b) { return b.id === ids[i]; });
      shrink(item.file).then(function (file) {
        // Videos and anything over the form limit go through the streamed upload (big-upload chunk, 50 MB, progress, 취소).
        if (item.block.type === "video" || file.size > MAX) return editor.lazy("big-upload").then(function (big) { return big.upload(file, editor.slug); });
        var form = new FormData(); form.append("file", file, file.name);
        return net("/api/upload", { method: "POST", body: form }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { if (!res.ok) throw new Error(body.error || String(res.status)); return body; });
        });
      }).then(function (res) {
        block = state().blocks.find(function (b) { return b.id === ids[i]; }) || block;
        block.meta = Object.assign({}, block.meta, { src: res.url, url: res.url, name: res.name, size: res.size }, res.poster ? { poster: res.poster } : {});
        if (res.note) notes.push(res.note);
      }).catch(function (error) {
        // A cancelled or failed file leaves no empty block behind.
        block = state().blocks.find(function (b) { return b.id === ids[i]; }) || block;
        if (!(block.meta && (block.meta.src || block.meta.url))) { var at = state().blocks.indexOf(block); if (at >= 0) state().blocks.splice(at, 1); }
        if (error.cancelled) notes.push(error.message);
        else failed.push(error.message.indexOf(item.file.name) === 0 ? error.message : item.file.name + ": " + error.message);
      }).then(function () {
        block._busy = false; done += 1;
        editor.render();
        if (done < accepted.length) return editor.setSave("올리는 중… (" + done + "/" + accepted.length + ")", true);
        editor.scheduleSave();
        if (failed.length) editor.setSave("올리기 실패: " + failed.join(", "), true);
        else if (notes.length) editor.setSave(notes.join(", "), false);
      });
    });
  }

window.AcardEditor.provide("paste-md", { pasteBlocks, offerUrl, offerImage, addFiles });
