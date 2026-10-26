(function () {
  "use strict";
  var identity = (document.querySelector('meta[name="acard-id"]') || {}).content;
  if (!document.body.classList.contains("reader") || !identity || identity.indexOf("g-") === 0 || document.body.dataset.readonly === "1") return;
  var key = "acard-reader-toc", visible = true;
  try { visible = localStorage.getItem(key) !== "hidden"; } catch (e) {}

  function mount() {
    var main = document.getElementById("main"), article = main && main.querySelector("#article");
    var actions = article && article.querySelector(".page-actions");
    if (!article || !actions) return;
    // A cached navigation snapshot can already contain our markup, but not its listeners.
    var previous = article.querySelector(".reader-toc"), open = !previous || previous.querySelector("details").open;
    if (previous) previous.remove();
    var previousButton = actions.querySelector(".reader-toc-toggle");
    if (previousButton) previousButton.remove();
    main.classList.remove("reader-has-toc");
    // Static owner pages used to put a second, server-built TOC below the document.
    main.querySelectorAll(":scope > .toc").forEach(function (toc) { toc.remove(); });
    var headings = Array.from(article.querySelectorAll(".blocks h2[id],.blocks h3[id],.blocks h4[id],.blocks h5[id]"))
      .filter(function (heading) { return heading.textContent.trim() && !heading.closest(".tocblock"); });
    if (headings.length < 2) return;

    var toc = document.createElement("aside"), details = document.createElement("details");
    toc.className = "reader-toc";
    toc.id = "reader-toc";
    toc.setAttribute("aria-label", "목차");
    details.open = open;
    var summary = document.createElement("summary");
    summary.textContent = "목차";
    details.appendChild(summary);
    var list = document.createElement("ol");
    headings.forEach(function (heading) {
      var item = document.createElement("li"), link = document.createElement("a"), label = document.createElement("span");
      item.className = "l" + heading.tagName.slice(1);
      link.href = "#" + encodeURIComponent(heading.id);
      label.className = "reader-toc-label";
      label.textContent = heading.textContent.trim();
      link.appendChild(label);
      // Hash navigation stays native; reveal headings nested in closed toggles first.
      link.addEventListener("click", function (event) {
        if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        for (var parent = heading.parentElement; parent && parent !== article; parent = parent.parentElement) {
          if (parent.tagName === "DETAILS") parent.open = true;
        }
      });
      item.appendChild(link);
      list.appendChild(item);
    });
    details.appendChild(list);
    toc.appendChild(details);
    // Keep the page header and all block containers intact for their existing features.
    var body = article.querySelector(".blocks");
    while (body.parentElement !== article) body = body.parentElement;
    article.insertBefore(toc, body);

    var button = document.createElement("button");
    button.type = "button";
    button.className = "reader-toc-toggle";
    button.textContent = "목차";
    button.setAttribute("aria-controls", toc.id);
    function paint() {
      toc.hidden = !visible;
      button.setAttribute("aria-expanded", String(visible));
      main.classList.toggle("reader-has-toc", visible);
    }
    button.addEventListener("click", function () {
      visible = !visible;
      if (visible) details.open = true;
      try { localStorage.setItem(key, visible ? "visible" : "hidden"); } catch (e) {}
      paint();
    });
    actions.insertBefore(button, actions.firstChild);
    paint();
  }
  window.AcardReader.on("ready", mount);
  document.addEventListener("acard:navigated", mount);
  document.addEventListener("acard:page-fresh", mount);
})();
