(function () {
  var editor = window.AcardEditor;
  if (!editor) return;
  var slug = editor.slug, lazy = editor.lazy;
  function net(url, options) { var provider = window.AcardEditorProvider; return provider && typeof provider.fetch === "function" ? provider.fetch(url, options) : fetch(url, options); }
  function openLightbox(src, alt) {
    var overlay = document.createElement("div");
    overlay.className = "lightbox on";
    var img = document.createElement("img");
    img.src = src;
    img.alt = alt || "";
    overlay.appendChild(img);
    overlay.addEventListener("click", function () { overlay.remove(); });
    document.addEventListener("keydown", function onKey(ev) {
      if (ev.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
    });
    document.body.appendChild(overlay);
  }

  function downscaleImage(file, maxSide) {
    if (!/^image\//.test(file.type) || file.type === "image/svg+xml") return Promise.resolve(file);
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale === 1 && file.size < 1536 * 1024) { resolve(file); return; }
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          resolve(blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file);
        }, "image/jpeg", 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  // Videos and files over the 4 MB form limit go through the big-upload chunk (streamed, up to 50 MB, progress and 취소).
  function uploadFile(file) {
    if (/^video\//.test(file.type) || file.size > 4 * 1024 * 1024) return lazy("big-upload").then(function (big) { return big.upload(file, slug); });
    var form = new FormData();
    form.append("file", file, file.name);
    form.append("page", slug);
    return net("/api/upload", { method: "POST", body: form }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || String(res.status));
        return body;
      });
    });
  }

  function uploadInto(block, file, created) {
    var render = editor.render, setSave = editor.setSave, scheduleSave = editor.scheduleSave;
    block._busy = true;
    render();
    setSave("올리는 중…", true);
    var ready = /^image\//.test(file.type) ? downscaleImage(file, 1600) : Promise.resolve(file);
    return ready.then(function (f) { return created.then(function () { return uploadFile(f); }); }).then(function (res) {
      block._busy = false;
      block.meta = Object.assign({}, block.meta, { src: res.url, url: res.url, name: res.name, size: res.size });
      delete block.meta.iw; delete block.meta.ih; delete block.meta.poster;
      if (res.width > 0 && res.height > 0) { block.meta.iw = res.width; block.meta.ih = res.height; }
      if (res.poster) block.meta.poster = res.poster;
      render();
      setSave(res.note || "저장됨", false);
      scheduleSave();
    }).catch(function (err) {
      block._busy = false;
      render();
      setSave(err.cancelled ? err.message : "올리기 실패: " + err.message, !err.cancelled);
    });
  }
  editor.provide("image-tools", { open: openLightbox, shrink: downscaleImage, upload: uploadFile, uploadInto: uploadInto });
})();
