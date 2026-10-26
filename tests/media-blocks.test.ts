import { describe, expect, test } from "bun:test";
import { markdownToBlocks } from "../markdown-blocks.ts";
import { renderBlocks } from "../block-html.js";

describe("unsafe media URLs (#87)", () => {
  const unsafe = ["javascript:alert(1)", "  JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "\u0000javascript:alert(1)", "data:text/html,<img src=x onerror=alert(1)>", "vbscript:msgbox(1)", "//evil.example/x", "/\\evil.example/x"];
  for (const type of ["bookmark", "file", "image", "embed", "button", "video", "audio"]) {
    test(type + " renders unsafe URLs as text without href or src", () => {
      for (const url of unsafe) {
        const html = renderBlocks([{ id: "unsafe", type, text: "label", meta: { url, src: url } }]);
        expect(html).not.toMatch(/<[a-z][^>]*\s(?:href|src)=/);
        expect(html).not.toContain("<img");
        // An image draws a 'cannot load' placeholder instead of its raw address (issue 176).
        expect(html).toContain(type === "button" ? "label" : type === "image" ? "이미지를 불러올 수 없어요" : url.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
      }
    });
  }
  test("Markdown normalizes unsafe media targets to plain paragraphs", () => {
    for (const type of ["bookmark", "file", "embed", "button", "video", "audio"]) {
      const [block] = markdownToBlocks("- [" + type + "] " + (type === "button" ? "label | " : "") + "javascript:alert(1)");
      expect(block.type).toBe("paragraph");
      expect(block.meta).toBeUndefined();
      expect(renderBlocks([block])).not.toMatch(/<[a-z][^>]*\s(?:href|src)=/);
      expect(block.text).toContain("javascript:alert(1)");
    }
    expect(renderBlocks(markdownToBlocks("![label](data:text/html,bad)"))).not.toContain("<img");
  });
  test("safe targets remain linked and escaped once", () => {
    for (const url of ["https://example.com/?a=1&b=2", "http://example.com/", "mailto:owner@example.com", "/notes/", "#section", "/media/photo"]) {
      expect(renderBlocks([{ type: "bookmark", text: "", meta: { url } }])).toContain('href="' + url.replaceAll("&", "&amp;") + '"');
    }
  });
});

describe("markdownToBlocks: 미디어·레이아웃 블록", () => {
  test("이미지 한 줄은 캡션과 폭을 기억한다", () => {
    const blocks = markdownToBlocks('![서울 야경](/media/abc "60")\n\n![없는 폭](https://x.test/i.png)');
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].text).toBe("서울 야경");
    expect(blocks[0].meta).toEqual({ src: "/media/abc", width: 60 });
    expect(blocks[1].meta.width).toBe(100);
  });

  test("한 줄 미디어 블록들", () => {
    const blocks = markdownToBlocks([
      "- [video] https://youtu.be/dQw4w9WgXcQ",
      "- [audio] /media/s1",
      "- [file] /media/f1 업무계획서.pdf",
      "- [embed] https://codepen.io/x",
      "- [bookmark] https://example.com",
      "- [toc]",
      "- [breadcrumb]",
    ].join("\n"));
    expect(blocks.map((b) => b.type)).toEqual(["video", "audio", "file", "embed", "bookmark", "toc", "breadcrumb"]);
    expect(blocks[0].meta.url).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(blocks[2].text).toBe("업무계획서.pdf");
    expect(blocks[2].meta).toEqual({ url: "/media/f1", name: "업무계획서.pdf" });
  });

  test("버튼은 라벨과 주소를 나누고 진행률은 값을 0~100 으로 묶는다", () => {
    const blocks = markdownToBlocks("- [button] 시작하기 | https://example.com\n\n- [progress] 170 과한 값");
    expect(blocks[0].type).toBe("button");
    expect(blocks[0].text).toBe("시작하기");
    expect(blocks[0].meta.url).toBe("https://example.com");
    expect(blocks[1].meta.value).toBe(100);
  });

  test("주소만 있는 줄은 북마크가 되고 문단은 거기서 끊긴다", () => {
    const blocks = markdownToBlocks("앞 문장\nhttps://example.com/a\n뒷 문장");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "bookmark", "paragraph"]);
    expect(blocks[1].meta.url).toBe("https://example.com/a");
  });

  test("$$ 겉치장은 수식 블록이 된다", () => {
    const blocks = markdownToBlocks("$$\nE = mc^2\n$$");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("equation");
    expect(blocks[0].text).toBe("E = mc^2");
  });

  test(":::cols 는 --- 로 열을 나누고 2~3열로 묶는다", () => {
    // notion-parity C13: the columns hold blocks - each line is a paragraph in its column.
    const blocks = markdownToBlocks(":::cols\n첫째\n---\n둘째\n---\n셋째\n---\n넷째\n:::");
    expect(blocks.map((b) => b.type + ":" + (b.indent || 0) + (b.text ? ":" + b.text : ""))).toEqual([
      "columns:0", "column:1", "paragraph:2:첫째", "column:1", "paragraph:2:둘째", "column:1", "paragraph:2:셋째", "paragraph:2:넷째",
    ]);
    expect(blocks[0].meta).toEqual({ widths: [0.3333, 0.3333, 0.3333] });
  });

  test("=== 구분 표는 간단 표, --- 구분 표는 데이터베이스다", () => {
    const simple = markdownToBlocks("| 열1 | 열2 |\n| === | === |\n| a | b |");
    expect(simple[0].type).toBe("table");
    expect(simple[0].meta).toEqual({ columns: ["열1", "열2"], rows: [["a", "b"]], header: true });
    const db = markdownToBlocks("| 열1 | 열2 |\n| --- | --- |\n| a | b |");
    expect(db[0].type).toBe("database");
  });
});

describe("renderBlocks: 미디어·레이아웃 블록", () => {
  const parse = (md: string) => renderBlocks(markdownToBlocks(md));

  test("이미지는 폭과 캡션과 크게 보기 링크를 그린다", () => {
    const html = parse('![서울](/media/abc "60")');
    expect(html).toContain('style="width:60%"');
    expect(html).toContain('<a class="imgview" href="/media/abc">');
    expect(html).toContain("<figcaption>서울</figcaption>");
  });

  test("유튜브 주소는 nocookie iframe 이 되고 파일 주소는 video 태그가 된다", () => {
    const html = parse("- [video] https://youtu.be/dQw4w9WgXcQ\n\n- [video] /media/clip.mp4");
    expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(html).toContain('<video controls preload="metadata" src="/media/clip.mp4">');
  });

  test("a video file block with an uploaded first frame shows it as the poster; any other poster value is left out", () => {
    expect(renderBlocks([{ id: "v", type: "video", text: "", meta: { url: "/media/0123456789abcdef", poster: "/media/fedcba9876543210" } }] as any)).toContain('<video controls preload="metadata" poster="/media/fedcba9876543210" src="/media/0123456789abcdef">');
    expect(renderBlocks([{ id: "v", type: "video", text: "", meta: { url: "/media/0123456789abcdef", poster: "javascript:x" } }] as any)).toContain('<video controls preload="metadata" src="/media/0123456789abcdef">');
  });

  test("임베드: 아는 플레이어는 그대로, 그 밖의 https 위젯은 샌드박스 프레임 (notion-parity C11)", () => {
    const ok = parse("- [embed] https://codepen.io/x");
    expect(ok).toContain('<div class="media16 embed"><iframe src="https://codepen.io/x" loading="lazy" allowfullscreen referrerpolicy="no-referrer"></iframe></div>');
    expect(ok).not.toContain("sandbox");
    const SANDBOX = 'sandbox="allow-scripts allow-same-origin allow-popups allow-forms"';
    for (const url of ["https://s.tradingview.com/widgetembed/?symbol=NASDAQ%3AAAPL", "https://x.github.io/clock/", "https://evil.example/x"]) {
      const html = renderBlocks([{ id: "e", type: "embed", text: "", meta: { url } }] as any);
      expect(html).toContain(SANDBOX);
      expect(html).not.toContain("allow-top-navigation");
      expect(html).not.toContain("allowfullscreen");
    }
  });

  test("임베드는 https 가 아니거나 Acard 자신·IP·내부 주소면 거부한다", () => {
    for (const url of ["http://a.com", "javascript:alert(1)", "data:text/html,<b>x</b>", "https://notes.example.com/x", "https://www.notes.example.com/x", "https://notes-example.pages.dev/", "https://abc.notes-example.pages.dev/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://intranet/", "http://youtube.com/embed/x", "not a url"]) {
      const html = renderBlocks([{ id: "e", type: "embed", text: "", meta: { url } }] as any);
      expect([url, html.includes("<iframe")]).toEqual([url, false]);
      expect(html).toContain("여기에 넣을 수 없는 주소예요");
    }
  });

  test("임베드 높이는 120~2000px 로 묶고, 없으면 지금처럼 16:9", () => {
    const at = (height: unknown) => renderBlocks([{ id: "e", type: "embed", text: "", meta: { url: "https://x.github.io/w", height } }] as any);
    expect(at(480)).toContain('<div class="media16 embed" style="padding-top:0;height:480px">');
    expect(at(99999)).toContain("height:2000px");
    expect(at(5)).toContain("height:120px");
    expect(at("480px; background:url(x)")).toContain('<div class="media16 embed">');
    expect(at(undefined)).toContain('<div class="media16 embed"><iframe');
  });

  test("북마크와 파일 카드를 그린다", () => {
    const html = parse("https://example.com\n\n- [file] /media/f1 계획서.pdf");
    expect(html).toContain('<a class="bookmark" href="https://example.com"');
    expect(html).toContain('class="filecard"');
    expect(html).toContain("계획서.pdf");
  });

  test("열 나누기와 간단 표를 그린다", () => {
    const html = parse(":::cols\n가\n---\n나\n:::\n\n| 열1 | 열2 |\n| === | === |\n| 1 | 2 |");
    expect(html).toContain('<div class="cols cols2" style="--cols:0.5fr 0.5fr"><div class="col">');
    expect(html).toContain("<p>가</p>");
    expect(html).toContain('<div class="stable" tabindex="0" role="region"');
    expect(html).toContain('</svg>열1</span></th>');
    expect(html).toContain("<td>1</td>");
  });

  test("목차 블록은 제목보다 앞에 있어도 같은 id 로 걸린다", () => {
    const html = parse("- [toc]\n\n## 첫 절\n\n### 더하기");
    expect(html).toContain('<nav class="tocblock"><details open><summary><h3>목차</h3> <span class="tcount">2</span></summary><ul><li class="lvl3"><a href="#첫-절">첫 절</a></li><li class="lvl4"><a href="#더하기">더하기</a></li>');
    expect(html).toContain('<h3 id="첫-절">');
  });

  test("제목이 12개를 넘는 목차는 하위 제목을 접는다", () => {
    const steps = Array.from({ length: 12 }, (_, i) => "### 단계 " + (i + 1)).join("\n\n");
    const html = parse("- [toc]\n\n## 개요\n\n## 단계별 상세\n\n" + steps + "\n\n## 배운 점");
    expect(html).toContain('<li class="lvl3"><a href="#개요">개요</a></li>');
    expect(html).toContain('<li class="lvl3 tocgrp"><details><summary><a href="#단계별-상세">단계별 상세</a> <span class="tcount">12</span></summary><ul><li class="lvl4"><a href="#단계-1">단계 1</a></li>');
    expect(html).toContain('</ul></details></li><li class="lvl3"><a href="#배운-점">배운 점</a></li>');
  });

  test("이동 경로는 부모 체인을 그린다", () => {
    const pages = [
      { slug: "index", title: "홈", parent: null },
      { slug: "projects", title: "프로젝트", parent: "index" },
      { slug: "akanesasu", title: "아카네사스", parent: "projects" },
    ];
    const html = renderBlocks(markdownToBlocks("- [breadcrumb]"), { page: pages[2], pages });
    expect(html).toContain('<nav class="crumbs"><a href="/home/">홈</a><span class="sep"');
    expect(html.indexOf("프로젝트")).toBeLessThan(html.indexOf("아카네사스"));
  });

  test("버튼과 진행률 막대를 그린다", () => {
    const html = parse("- [button] 시작하기 | https://example.com\n\n- [progress] 70 완료율");
    expect(html).toContain('<a class="btn" href="https://example.com">시작하기</a>');
    expect(html).toContain('aria-valuenow="70"');
    expect(html).toContain('style="width:70%"');
  });

  test("수식은 이스케이프되고 모르는 커맨드는 남는다", () => {
    const html = parse("$$\n\\frac{a}{b} <script>alert(1)</script>\n$$");
    expect(html).not.toContain("<script>");
    expect(html).toContain('class="mfrac"');
    expect(html).toContain("&lt;script&gt;");
  });

  test("주소가 없는 미디어 블록은 아무것도 그리지 않는다", () => {
    expect(parse("- [video]\n\n- [bookmark]\n\n- [button] 라벨")).toBe("");
  });
});
