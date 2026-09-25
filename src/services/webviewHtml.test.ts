import { describe, expect, it, vi } from "vitest";

import {
  bridgeScript,
  contentSecurityPolicy,
  prepareWebviewHtml,
  RESOURCE_SCHEME,
} from "./webviewHtml";

const PNG = "data:image/png;base64,AAAA";
const CSS = `data:text/css;base64,${btoa("body{color:red;background:url(openmind-webview-resource://panel/AAAA)} @import url(https://x.test/a.css);")}`;
const JS = `data:text/javascript;base64,${btoa("window.fromFile = 1;")}`;

function options(
  enableScripts = false,
  extra: Partial<Parameters<typeof prepareWebviewHtml>[1]> = {},
) {
  return {
    enableScripts,
    token: "tok",
    state: null,
    readResource: vi.fn((uri: string) =>
      uri.endsWith("css")
        ? Promise.resolve(CSS)
        : uri.endsWith("js")
          ? Promise.resolve(JS)
          : Promise.resolve(PNG),
    ),
    ...extra,
  };
}

async function prepare(html: string, enableScripts = false, extra = {}) {
  const opts = options(enableScripts, extra);
  const prepared = await prepareWebviewHtml(html, opts);
  const doc = new DOMParser().parseFromString(prepared.html, "text/html");
  return { ...prepared, doc, opts };
}

describe("prepareWebviewHtml: scripts", () => {
  it("removes scripts and event handlers unless scripts are enabled, and says script-src 'none'", async () => {
    const r = await prepare(
      '<p onclick="x()">a</p><script>window.ran=1</script><button onmouseover="y()">b</button>',
    );
    expect(r.doc.querySelectorAll("script")).toHaveLength(0);
    expect(r.doc.querySelector("p")?.hasAttribute("onclick")).toBe(false);
    expect(r.doc.querySelector("button")?.hasAttribute("onmouseover")).toBe(false);
    const csp = r.doc
      .querySelector("meta[http-equiv='Content-Security-Policy']")
      ?.getAttribute("content");
    expect(csp).toBe(contentSecurityPolicy(false));
    expect(csp).toContain("script-src 'none'");
    expect(r.html).not.toContain("acquireVsCodeApi");
  });

  it("keeps the page's scripts when enabled, puts the CSP first and adds the bridge", async () => {
    const r = await prepare("<p>a</p><script>window.ran=1</script>", true);
    const head = [...r.doc.head.children];
    expect(head[0]?.tagName).toBe("META");
    expect(head[0]?.getAttribute("content")).toContain("script-src 'unsafe-inline'");
    expect(head[1]?.textContent).toContain("acquireVsCodeApi");
    expect(head[1]?.textContent).toContain('"tok"');
    expect(r.doc.body.querySelector("script")?.textContent).toBe("window.ran=1");
    // The policy never opens the network or the disk, even with scripts.
    const csp = contentSecurityPolicy(true);
    for (const part of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("the bridge script hands back the earlier state safely", () => {
    const script = bridgeScript("t", '{"a":"</script>"}');
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
  });
});

describe("prepareWebviewHtml: what may not be there", () => {
  it("removes frames, plugins, base and meta refresh", async () => {
    const r = await prepare(
      '<base href="https://x.test/"><iframe src="https://x.test"></iframe><object data="a"></object><embed src="a"><meta http-equiv="refresh" content="0;url=https://x.test"><p>ok</p>',
    );
    for (const selector of ["base", "iframe", "object", "embed", "meta[http-equiv='refresh']"]) {
      expect(r.doc.querySelector(selector)).toBeNull();
    }
    expect(r.doc.body.textContent).toContain("ok");
    expect(r.blocked.length).toBeGreaterThanOrEqual(4);
  });

  it("blocks remote images, scripts, stylesheets, file:, javascript: and non-image data: and reports each", async () => {
    const r = await prepare(
      '<link rel="stylesheet" href="https://x.test/a.css"><script src="https://x.test/a.js"></script>' +
        '<img id="remote" src="https://x.test/a.png"><img id="proto" src="//x.test/a.png"><img id="file" src="file:///C:/Windows/win.ini">' +
        '<a id="js" href="javascript:alert(1)">x</a><img id="vb" src="vbscript:x"><img id="dataHtml" src="data:text/html;base64,AAAA">' +
        '<img id="rel" src="pic.png"><video poster="https://x.test/p.png"></video><img srcset="https://x.test/a.png 2x" id="set">',
      true,
    );
    for (const id of ["remote", "proto", "file", "vb", "dataHtml", "rel"]) {
      expect(r.doc.getElementById(id)?.hasAttribute("src")).toBe(false);
    }
    expect(r.doc.getElementById("js")?.hasAttribute("href")).toBe(false);
    expect(r.doc.getElementById("set")?.hasAttribute("srcset")).toBe(false);
    expect(r.doc.querySelector("video")?.hasAttribute("poster")).toBe(false);
    expect(r.doc.querySelector("link")).toBeNull();
    expect(r.doc.body.querySelector("script[src]")).toBeNull();
    const text = r.blocked.join("\n");
    expect(text).toContain("Remote content blocked: https://x.test/a.css");
    expect(text).toContain("Remote content blocked: https://x.test/a.png");
    expect(text).toContain("Script blocked: https://x.test/a.js");
    expect(text).toContain("use webview.asWebviewUri");
    expect(r.opts.readResource).not.toHaveBeenCalled();
  });

  it("allows an inline png/jpeg/gif/webp/svg data image on img only", async () => {
    const r = await prepare(
      '<img id="ok" src="data:image/png;base64,AAAA"><script id="bad" src="data:text/javascript,alert(1)"></script>',
      true,
    );
    expect(r.doc.getElementById("ok")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(r.doc.getElementById("bad")).toBeNull();
  });

  it("removes form actions, and links that would navigate become inert", async () => {
    const r = await prepare(
      '<form action="https://x.test" id="f"><input formaction="https://x.test" id="i"></form><a id="web" href="https://x.test">go</a><a id="anchor" href="#top">top</a>',
    );
    expect(r.doc.getElementById("f")?.hasAttribute("action")).toBe(false);
    expect(r.doc.getElementById("i")?.hasAttribute("formaction")).toBe(false);
    expect(r.doc.getElementById("web")?.getAttribute("target")).toBe("_blank");
    expect(r.doc.getElementById("web")?.getAttribute("rel")).toContain("noopener");
    expect(r.doc.getElementById("anchor")?.hasAttribute("target")).toBe(false);
  });

  it("blocks remote content in styles: @import and url(), keeping data images", async () => {
    const r = await prepare(
      '<style>@import url("https://x.test/a.css"); .a{background:url(https://x.test/a.png)} .b{background:url(data:image/png;base64,AAAA)}</style><p style="background:url(//x.test/p.png)">x</p>',
    );
    const css = r.doc.querySelector("style")?.textContent ?? "";
    expect(css).not.toContain("x.test");
    expect(css).toContain("data:image/png;base64,AAAA");
    expect(r.doc.querySelector("p")?.getAttribute("style")).not.toContain("x.test");
    expect(r.blocked.some((line) => line.includes("@import"))).toBe(true);
  });
});

describe("prepareWebviewHtml: local resources", () => {
  const uri = (name: string) => `${RESOURCE_SCHEME}//panel/${name}`;

  it("inlines an image, a stylesheet (with its own url()) and a script as data, through readResource only", async () => {
    const r = await prepare(
      `<link rel="stylesheet" href="${uri("css")}"><img id="i" src="${uri("png")}"><script src="${uri("js")}"></script>`,
      true,
    );
    expect(r.doc.getElementById("i")?.getAttribute("src")).toBe(PNG);
    const style = r.doc.querySelector("style")?.textContent ?? "";
    expect(style).toContain("color:red");
    expect(style).toContain(`url("${PNG}")`);
    expect(style).not.toContain("x.test");
    expect(r.doc.querySelector("link")).toBeNull();
    expect(
      [...r.doc.querySelectorAll("script")].some((s) => s.textContent === "window.fromFile = 1;"),
    ).toBe(true);
    expect(r.blocked.some((line) => line.includes("@import"))).toBe(true);
    expect(r.opts.readResource).toHaveBeenCalled();
  });

  it("a resource that can't be read is dropped and the reason shown, never left as an address", async () => {
    const readResource = vi
      .fn()
      .mockRejectedValue(
        new Error("Couldn't use x: it is outside this webview's local resource roots"),
      );
    const r = await prepare(
      `<img id="i" src="${uri("png")}"><link rel="stylesheet" href="${uri("css")}">`,
      false,
      { readResource },
    );
    expect(r.doc.getElementById("i")?.hasAttribute("src")).toBe(false);
    expect(r.html).not.toContain(RESOURCE_SCHEME);
    expect(r.blocked.join("\n")).toContain("outside this webview's local resource roots");
  });
});
