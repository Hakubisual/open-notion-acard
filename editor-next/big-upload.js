// Large file uploads in the editor (acard-upload-100mb): one file up to the server's limit (/api/media-usage uploadLimit,
// 50 MB). Loaded on demand as /lazy/big-upload.js by both editors when a video, or any file over the 4 MB form limit,
// is added. A video is first re-encoded in the browser (/lazy/video-encode.js) when it can be, and its first frame is
// uploaded as the poster. The file itself goes up as one raw request (POST /api/upload?stream=1) so the server can
// stream it into R2; progress and 취소 are shown in a bar at the bottom of the screen.
(function () {
  "use strict";
  var editor = window.AcardEditor;
  if (!editor) return;
  var EN = window.ACARD_LANG === "en";
  var T = EN ? {
    preparing: "Getting the video ready…", encoding: "Shrinking the video", uploading: "Uploading", cancel: "Cancel",
    tooBig: "is over {n}MB. Shorten it or lower its quality, then try again.", tooBigVideo: "is over {n}MB even after shrinking. Shorten it, then try again.",
    cancelled: "Upload cancelled.", network: "The connection dropped while uploading. Please try again.",
    failed: "Upload failed", smaller: "Shrunk {a} → {b}", kept: "Kept the original video ({a})",
    status: { 411: "The file size is unknown. Please try again.", 413: "The file is over {n}MB.", 415: "The file's content does not match its type. Upload the original file.", 507: "There is no storage space left for this file. Delete files you no longer need, then try again." },
  } : {
    preparing: "영상을 준비하는 중…", encoding: "영상 크기 줄이는 중", uploading: "올리는 중", cancel: "취소",
    tooBig: "파일이 {n}MB를 넘어요. 길이를 줄이거나 화질을 낮춘 뒤 다시 올려 주세요.", tooBigVideo: "영상을 줄여도 {n}MB를 넘어요. 길이를 줄인 뒤 다시 올려 주세요.",
    cancelled: "올리기를 취소했어요.", network: "올리는 도중 연결이 끊겼어요. 다시 올려 주세요.",
    failed: "올리기 실패", smaller: "{a} → {b} 로 줄였어요", kept: "원본 영상을 그대로 올렸어요 ({a})",
  };
  var limits = null;
  function getLimits() {
    if (limits) return limits;
    limits = fetch("/api/media-usage").then(function (r) { return r.ok ? r.json() : {}; }).then(function (d) {
      return { upload: Number(d.uploadLimit) || 50 * 1024 * 1024, buffer: Number(d.bufferLimit) || 4 * 1024 * 1024 };
    }, function () { limits = null; return { upload: 50 * 1024 * 1024, buffer: 4 * 1024 * 1024 }; });
    return limits;
  }
  function mb(bytes) { return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + "MB"; }
  function fill(text, values) { return text.replace(/\{(\w)\}/g, function (_m, k) { return values[k]; }); }

  var bar = null, jobs = [];
  function paintBar() {
    if (!jobs.length) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "acard-upbar"; bar.setAttribute("role", "status"); bar.setAttribute("translate", "no");
      bar.innerHTML = '<div class="au-text"><span class="au-name"></span><span class="au-step"></span></div><div class="au-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div><button type="button" class="au-x"></button>';
      bar.querySelector(".au-x").addEventListener("click", function () { jobs.slice().forEach(function (job) { job.cancel(); }); });
      document.body.appendChild(bar);
    }
    var job = jobs[0];
    bar.hidden = false;
    bar.querySelector(".au-name").textContent = job.name + (jobs.length > 1 ? " +" + (jobs.length - 1) : "");
    bar.querySelector(".au-step").textContent = job.step + (job.pct >= 0 ? " " + Math.round(job.pct) + "%" : "");
    var track = bar.querySelector(".au-track");
    track.setAttribute("aria-valuenow", String(Math.max(0, Math.round(job.pct))));
    track.classList.toggle("au-wait", job.pct < 0);
    track.querySelector("i").style.width = Math.max(0, job.pct) + "%";
    bar.querySelector(".au-x").textContent = T.cancel;
  }

  function send(file, page, job, query) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      job.xhr = xhr;
      xhr.open("POST", "/api/upload?stream=1&name=" + encodeURIComponent(file.name || "file") + (page ? "&page=" + encodeURIComponent(page) : "") + (query || ""));
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable && job.onSend) job.onSend(ev.loaded / ev.total); };
      xhr.onload = function () {
        var body = {};
        try { body = JSON.parse(xhr.responseText); } catch (e) { void e; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(EN ? fill(T.status[xhr.status] || T.network, { n: 50 }) : body.error || String(xhr.status)));
      };
      xhr.onerror = function () { reject(new Error(T.network)); };
      xhr.onabort = function () { reject(Object.assign(new Error(T.cancelled), { cancelled: true })); };
      xhr.send(file);
    });
  }

  // The first frame (at 0.1 s, past a black lead-in frame) as a JPEG no wider than 1280 px; null when the browser cannot
  // decode the file.
  function poster(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      var done = function (blob) { URL.revokeObjectURL(url); video.removeAttribute("src"); video.load(); resolve(blob); };
      var timer = setTimeout(function () { done(null); }, 15000);
      video.muted = true; video.playsInline = true; video.preload = "auto";
      video.onerror = function () { clearTimeout(timer); done(null); };
      video.onloadeddata = function () { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); };
      video.onseeked = function () {
        clearTimeout(timer);
        var scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        if (!video.videoWidth) return done(null);
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) { done(blob); }, "image/jpeg", 0.82);
      };
      video.src = url;
    });
  }
  function uploadPoster(blob, name, page) {
    var form = new FormData();
    form.append("file", new File([blob], String(name).replace(/\.[^.]+$/, "") + "-poster.jpg", { type: "image/jpeg" }));
    if (page) form.append("page", page);
    return fetch("/api/upload", { method: "POST", body: form }).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) { return b && b.url ? b.url : null; }, function () { return null; });
  }

  // localStorage "acard-video-encode" = "off" skips the browser re-encode (QA of the fallback path; also a way out if
  // the encoder misbehaves on some machine).
  function encodeOff() { try { return localStorage.getItem("acard-video-encode") === "off"; } catch (e) { return false; } }

  // Resolves { url, name, size, mime, poster?, originalSize?, note } or rejects with an Error whose message is ready to
  // show (cancelled errors carry .cancelled).
  function upload(file, page) {
    var job = { name: file.name || "file", step: T.preparing, pct: -1, cancelled: false, xhr: null, abort: new AbortController() };
    job.cancel = function () { job.cancelled = true; job.abort.abort(); if (job.xhr) job.xhr.abort(); };
    jobs.push(job); paintBar();
    var finish = function () { var at = jobs.indexOf(job); if (at >= 0) jobs.splice(at, 1); paintBar(); };
    var stopIfCancelled = function () { if (job.cancelled) throw Object.assign(new Error(T.cancelled), { cancelled: true }); };
    var isVideo = /^video\//.test(file.type);
    var original = file.size;
    return getLimits().then(function (limit) {
      var picked = Promise.resolve({ file: file, encoded: false });
      if (isVideo && !encodeOff()) {
        picked = editor.lazy("video-encode").then(function (codec) {
          if (!codec.supported()) return { file: file, encoded: false };
          job.step = T.encoding; job.pct = 0; paintBar();
          return codec.encode(file, { signal: job.abort.signal, timeoutMs: Math.max(120000, original / 1024 / 1024 * 8000), onProgress: function (p) { job.pct = p * 100; paintBar(); } })
            .then(function (out) { return out.file.size < original ? { file: out.file, encoded: true } : { file: file, encoded: false }; },
              function (error) { if (error && error.reason === "cancelled") throw Object.assign(new Error(T.cancelled), { cancelled: true }); console.warn("acard video encode skipped", error && error.message); return { file: file, encoded: false }; });
        }, function () { return { file: file, encoded: false }; });
      }
      return picked.then(function (choice) {
        stopIfCancelled();
        if (choice.file.size > limit.upload) throw new Error(job.name + ": " + fill(isVideo ? T.tooBigVideo : T.tooBig, { n: Math.round(limit.upload / 1024 / 1024) }));
        var shot = isVideo ? poster(choice.file).then(function (blob) { return blob && !job.cancelled ? uploadPoster(blob, job.name, page) : null; }) : Promise.resolve(null);
        job.step = T.uploading; job.pct = 0; paintBar();
        job.onSend = function (f) { job.pct = f * 100; paintBar(); };
        // A poster that finished uploading for a cancelled or failed file is deleted again.
        var sent = send(choice.file, page, job);
        sent.catch(function () { shot.then(function (url) { if (url) fetch("/api" + url, { method: "DELETE" }).catch(function () {}); }); });
        return Promise.all([sent, shot]).then(function (got) {
          var res = got[0];
          var note = isVideo ? (choice.encoded ? fill(T.smaller, { a: mb(original), b: mb(res.size) }) : fill(T.kept, { a: mb(res.size) })) : "";
          return Object.assign({}, res, { poster: got[1] || undefined, originalSize: choice.encoded ? original : undefined, note: note });
        });
      });
    }).then(function (res) { finish(); return res; }, function (error) { finish(); throw error; });
  }

  function needed(file) { return getLimits().then(function (limit) { return /^video\//.test(file.type) || file.size > limit.buffer; }); }

  editor.provide("big-upload", { upload: upload, needed: needed, limits: getLimits });
})();
