(function(d,w){function c(h){if(!d.querySelector('[href="'+h+'"]')){var l=d.createElement("link");l.rel="stylesheet";l.href=h;d.head.append(l)}}w.acardFont=function(f){f=="serif"?c("/fonts/serif.css"):/^(?!default$|report$)[a-z]+$/.test(f)&&c("/fonts/lib/"+f+".css")};c("/fonts/fonts.css")})(document,window);
(function () {
  "use strict";
  window.mountEditorPages = function (context) {
    var api = context.api, slug = context.slug, state = context.state;
    var base = "/page/" + encodeURIComponent(slug);
    var settings = {};
    var bar = document.getElementById("page-tools") || document.createElement("div");
    if (!bar.parentNode) { bar.className = "page-tools"; document.querySelector(".docbar").before(bar); }
    var more = document.getElementById("more-menu");
    var cover = document.createElement("img");
    cover.className = "page-cover"; cover.alt = "페이지 표지"; cover.hidden = true;
    bar.before(cover);
    var panel = document.createElement("dialog");
    panel.className = "editor-panel";
    document.body.appendChild(panel);
    function fail(error) { context.setSave("실패: " + error.message, true); }
    function button(host, label, fn) {
      var b = document.createElement("button"); b.type = "button"; b.className = host === more ? "menuitem" : /삭제|휴지통으로/.test(label) ? "mini danger" : "mini"; b.textContent = label;
      b.addEventListener("click", function () {
        if (host === more) { more.hidden = true; document.getElementById("more").setAttribute("aria-expanded", "false"); }
        Promise.resolve().then(fn).catch(fail);
      }); host.appendChild(b); return b;
    }
    function open(title) {
      panel.replaceChildren();
      var heading = document.createElement("h2"); heading.textContent = title; panel.appendChild(heading);
      button(panel, "닫기", function () { panel.close(); });
      if (!panel.open) panel.showModal();
    }
    function applySettings() {
      document.querySelector("#doc").dataset.font = settings.font || "default";
      if (window.acardFont) window.acardFont(settings.font);
      document.querySelector("#doc").classList.toggle("full-width", settings.width === "full");
      document.querySelector("#doc").classList.toggle("width-normal", settings.width === "normal");
      document.querySelector("#doc").classList.toggle("small-text", settings.small === true);
      document.querySelector("#doc").dataset.aiDefault = settings.ai || "edit";
      if (settings.ai && settings.ai !== "edit") window.AcardEditor.lazy("ai-marks-ui").catch(function () {});
      widthButtons.forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.width === (settings.width || "default") ? "true" : "false"); });
      cover.hidden = !settings.cover;
      if (settings.cover) cover.src = settings.cover; else cover.removeAttribute("src");
      iconButton.textContent = settings.icon || "아이콘 추가";
      if ([settings.icon, settings.cover].some(function (v) { return /^(\/media\/|g\d$)/.test(v); })) look(function (ui) { ui.paint(cover, iconButton, settings); });
      favoriteButton.textContent = settings.favorite ? "즐겨찾기 해제" : "즐겨찾기";
    }
    function patch(value) {
      return api(base + "/settings", { method: "PUT", body: JSON.stringify(value) }).then(function (data) { settings = data.settings; applySettings(); return context.loadTree(); });
    }
    function inputPanel(title, value, submit) {
      open(title);
      var label = document.createElement("label"); label.textContent = title;
      var input = document.createElement("input"); input.value = value || ""; label.appendChild(input); panel.appendChild(label);
      button(panel, "저장", function () { return Promise.resolve(submit(input.value)).then(function () { panel.close(); }); });
      input.focus();
    }
    function confirmPanel(title, action) {
      open(title);
      button(panel, "계속", function () { return Promise.resolve(action()).then(function () { panel.close(); }); });
    }
    var widthButtons = [].slice.call(document.querySelectorAll("#more-menu [data-width]"));
    widthButtons.forEach(function (b) { b.addEventListener("click", function () { patch({ width: b.dataset.width }).catch(fail); }); });
    function look(fn) { return window.AcardEditor.lazy("page-look").then(fn); }
    function pick(kind) { return function () { return look(function (ui) { ui.open(kind, kind == "icon" ? iconButton : coverButton, settings[kind], slug, function (v) { patch(kind == "icon" ? { icon: v } : { cover: v }).catch(fail); }); }); }; }
    var iconButton = button(bar, "아이콘 추가", pick("icon"));
    var coverButton = button(bar, "표지", pick("cover"));
    var favoriteButton = button(more, "즐겨찾기", function () { return patch({ favorite: !settings.favorite }); });
    button(bar, "페이지 설정", function () {
      open("페이지 설정");
      [["너비", "width", [["default", "좁게"], ["normal", "보통"], ["full", "넓게"]]]].forEach(function (field) {
        var label = document.createElement("label"); label.textContent = field[0];
        var select = document.createElement("select");
        field[2].forEach(function (pair) { var option = document.createElement("option"); option.value = pair[0]; option.textContent = pair[1]; select.appendChild(option); });
        select.value = settings[field[1]] || "default";
        select.addEventListener("change", function () { var value = {}; value[field[1]] = select.value; patch(value).catch(fail); });
        label.appendChild(select); panel.appendChild(label);
      });
      var fonts = document.createElement("div"); fonts.className = "font-pick"; fonts.setAttribute("role", "group"); fonts.setAttribute("aria-label", "글꼴"); fonts.textContent = "글꼴 목록을 불러오는 중…"; panel.appendChild(fonts);
      window.AcardEditor.lazy("font-picker").then(function (picker) { picker.mount(fonts, settings.font || "default", function (id) { return patch({ font: id }); }); }).catch(function (error) { fonts.textContent = "글꼴 목록을 불러오지 못했어요."; fail(error); });
      // 작은 글씨 and the AI default for the page (acard-human-edit) mount after the font list.
      var look = document.createElement("div"); panel.appendChild(look);
      window.AcardEditor.lazy("page-settings").then(function (ui) { ui.mount(look, settings, patch); }, function () {});
      button(panel, "페이지 복제", function () { return context.save().then(function () { return api(base + "/duplicate", { method: "POST", body: "{}" }); }).then(function (data) { location.href = "/edit/" + encodeURIComponent(data.slug) + "/"; }); });
      button(panel, "휴지통으로 이동", function () { confirmPanel(state.title + " 휴지통으로 이동", function () { return context.save().then(function () { return api(base + "/trash", { method: "POST" }); }).then(function () { location.href = "/edit/index/"; }); }); });
      button(panel, "템플릿으로 저장", function () { inputPanel("템플릿 이름", state.title, function (name) { return context.save().then(function () { return api("/editor/templates", { method: "POST", body: JSON.stringify({ slug: slug, name: name }) }); }).then(function () { context.setSave("템플릿 저장됨", false); }); }); });
    });
    button(more, "페이지 기록", function () {
      return context.save().then(function () { return api(base + "/history"); }).then(function (data) {
        open("페이지 기록");
        if (!data.versions.length) { var empty = document.createElement("p"); empty.textContent = "저장된 이전 버전이 없어요."; panel.appendChild(empty); }
        data.versions.forEach(function (version) { button(panel, new Date(version.created).toLocaleString() + " · " + version.title + " 복원", function () {
          confirmPanel("이 버전으로 복원 (현재 내용은 기록에 보관)", function () { return api(base + "/history/" + encodeURIComponent(version.id) + "/restore", { method: "POST" }).then(function () { location.reload(); }); });
        }); });
      });
    });
    button(more, "템플릿 사용", function () { if (window.AcardEditor.openTemplatePicker) return window.AcardEditor.openTemplatePicker(); return api("/editor/templates").then(function (data) {
      open("템플릿 사용");
      if (!data.templates.length) { var empty = document.createElement("p"); empty.textContent = "페이지 설정에서 템플릿을 저장해 주세요."; panel.appendChild(empty); }
      data.templates.forEach(function (template) { button(panel, template.name, function () {
        confirmPanel("템플릿 적용 (현재 내용은 기록에 보관)", function () { return context.save().then(function () { return api(base + "/from-template", { method: "POST", body: JSON.stringify({ templateId: template.id }) }); }).then(function () { location.reload(); }); });
      }); });
    }); });
    button(document.querySelector(".navhead").parentNode, "휴지통", function () { return api("/editor/trash").then(function (data) {
      open("휴지통");
      if (!data.pages.length) { var empty = document.createElement("p"); empty.textContent = "휴지통이 비었어요."; panel.appendChild(empty); }
      data.pages.forEach(function (page) {
        var row = document.createElement("div"); var title = document.createElement("p"); title.textContent = page.title; row.appendChild(title); panel.appendChild(row);
        button(row, "복원", function () { return api("/page/" + encodeURIComponent(page.slug) + "/restore", { method: "POST" }).then(function () { row.remove(); return context.loadTree(); }); });
        button(row, "영구 삭제", function () { confirmPanel(page.title + " 영구 삭제 (되돌릴 수 없음)", function () { return api("/page/" + encodeURIComponent(page.slug) + "/permanent", { method: "DELETE" }); }); });
      });
    }); });
    context.comments = function (blockId) {
      return context.save().then(function () { return api(base + "/comments"); }).then(function (data) {
        open(blockId ? "블록 댓글" : "댓글");
        data.comments.filter(function (c) { return !blockId || c.blockId === blockId; }).forEach(function (comment) {
          var row = document.createElement("div"), text = document.createElement("p");
          text.textContent = (comment.resolved ? "[해결됨] " : "") + comment.text; row.appendChild(text); panel.appendChild(row);
          button(row, "수정", function () { inputPanel("댓글 수정", comment.text, function (value) { return api(base + "/comments/" + comment.id, { method: "PATCH", body: JSON.stringify({ text: value }) }); }); });
          button(row, comment.resolved ? "다시 열기" : "해결", function () { return api(base + "/comments/" + comment.id, { method: "PATCH", body: JSON.stringify({ resolved: !comment.resolved }) }).then(function () { return context.comments(blockId); }); });
          button(row, "삭제", function () { return api(base + "/comments/" + comment.id, { method: "DELETE" }).then(function () { row.remove(); }); });
        });
        var label = document.createElement("label"); label.textContent = "새 댓글";
        var input = document.createElement("textarea"); label.appendChild(input); panel.appendChild(label);
        button(panel, "댓글 추가", function () { if (!input.value.trim()) return; return api(base + "/comments", { method: "POST", body: JSON.stringify({ blockId: blockId, text: input.value }) }).then(function () { return context.comments(blockId); }); });
      }).catch(fail);
    };
    if (location.hash === "#comments") context.comments(null);
    return api(base + "/settings").then(function (data) { settings = data.settings; applySettings(); }).catch(fail);
  };
})();
