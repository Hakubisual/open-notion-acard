// Landing "예시 페이지": each card's stage cycles through real blocks captured from that example's public page
// (scripts/qa/landing-example-frames.ts). Frames load only when the card nears the viewport; hover, focus or an
// off-screen card pauses the cycle, a chip or a tap on the stage picks a frame. Reduced motion: no autoplay or typing.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window);
const STEP = 3400;

const type = (el) => {
  const text = el.textContent;
  const chars = [...text];
  el.style.minHeight = el.offsetHeight + "px";
  el.setAttribute("aria-label", text);
  el.textContent = "";
  el.classList.add("typing");
  let i = 0;
  const step = () => {
    i += 1;
    el.textContent = chars.slice(0, i).join("");
    if (i < chars.length) setTimeout(step, 34);
    else { el.classList.remove("typing"); el.removeAttribute("aria-label"); el.style.minHeight = ""; }
  };
  step();
};

const setup = (card) => {
  const stage = card.querySelector(".ex-stage");
  const first = stage.querySelector("picture");
  const chips = [...card.querySelectorAll(".ex-chip")];
  const bars = [...card.querySelectorAll(".ex-bar i")];
  const names = chips.map((c) => c.dataset.frame);
  const pics = [first];
  let at = 0, timer = 0, seen = false, hold = false;
  chips.forEach((c, i) => c.setAttribute("aria-pressed", String(!i)));
  const load = () => {
    if (pics.length > 1) return;
    const img = first.querySelector("img");
    for (const name of names.slice(1)) {
      const pic = first.cloneNode(true);
      pic.classList.remove("on");
      pic.removeAttribute("data-ex-shot");
      const swap = (v) => v.replace("-" + names[0] + "-", "-" + name + "-");
      for (const s of pic.querySelectorAll("source")) s.srcset = swap(s.getAttribute("srcset"));
      const im = pic.querySelector("img");
      im.src = swap(img.getAttribute("src"));
      im.alt = chips[pics.length].textContent;
      im.removeAttribute("data-i18n-attr");
      pics.push(pic);
      stage.appendChild(pic);
    }
    first.querySelector("img").alt = chips[0].textContent;
  };
  const show = (n) => {
    at = (n + pics.length) % pics.length;
    pics.forEach((p, i) => p.classList.toggle("on", i === at));
    chips.forEach((c, i) => c.setAttribute("aria-pressed", String(i === at)));
    bars.forEach((b, i) => { b.className = i < at ? "done" : i === at ? "now" : ""; });
    card.classList.remove("run");
    if (!still) { void card.offsetWidth; card.classList.add("run"); }
  };
  const tick = () => {
    clearTimeout(timer);
    if (still || !seen || hold || document.hidden) return;
    timer = setTimeout(() => { show(at + 1); tick(); }, STEP);
  };
  const pause = (on) => { hold = on; card.classList.toggle("hold", on); tick(); };
  chips.forEach((c, i) => c.addEventListener("click", () => { load(); show(i); tick(); }));
  stage.addEventListener("click", () => { load(); show(at + 1); tick(); });
  card.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") pause(true); });
  card.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") pause(false); });
  card.addEventListener("focusin", () => pause(true));
  card.addEventListener("focusout", (e) => { if (!card.contains(e.relatedTarget)) pause(false); });
  document.addEventListener("visibilitychange", tick);
  return (inView) => {
    if (inView === seen) return;
    if (inView) load();
    seen = inView;
    card.classList.toggle("live", inView);
    if (inView && !card.classList.contains("run")) show(at);
    tick();
  };
};

const cards = [...document.querySelectorAll(".ex-card")];
const md = document.querySelector(".ex-md");
if (still || !cards.length) {
  for (const card of cards) setup(card);
} else {
  const views = new Map(cards.map((c) => [c, setup(c)]));
  const near = new IntersectionObserver((entries) => { for (const e of entries) views.get(e.target)(e.isIntersecting); }, { rootMargin: "120px 0px" });
  const typed = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      typed.unobserve(e.target);
      if (e.target === md) { md.classList.add("play"); continue; }
      e.target.closest(".ex-card").classList.add("in");
      type(e.target);
    }
  }, { threshold: 0.6 });
  for (const card of cards) {
    near.observe(card);
    const title = card.querySelector("[data-type]");
    const box = title.getBoundingClientRect();
    if (box.top < innerHeight && box.bottom > 0) card.classList.add("in");
    else { card.classList.add("wait"); typed.observe(title); }
  }
  if (md) { md.classList.add("ready"); typed.observe(md); }
}
