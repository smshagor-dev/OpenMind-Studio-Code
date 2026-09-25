/** Scheme of the URIs `asWebviewUri` returns (the app turns them into inline data; nothing is fetched by the page). */
export const RESOURCE_SCHEME = "openmind-webview-resource:";

export interface PrepareOptions {
  enableScripts: boolean;
  /** Secret the page's own script must present when it posts to the app. */
  token: string;
  /** `setState` value of an earlier run (a JSON text), handed back by `getState`. */
  state: string | null;
  /** The bytes of a local resource as a `data:` URL, or a rejection saying why not. */
  readResource: (uri: string) => Promise<string>;
}

export interface Prepared {
  html: string;
  /** What was left out and why, one line each (shown to the user and logged). */
  blocked: string[];
}

const SAFE_IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

type Kind = "empty" | "fragment" | "resource" | "image-data" | "remote" | "unsafe" | "relative";

function classify(raw: string): Kind {
  const value = raw.trim();
  if (value === "") return "empty";
  if (value.startsWith("#")) return "fragment";
  if (value.toLowerCase().startsWith(RESOURCE_SCHEME)) return "resource";
  if (SAFE_IMAGE_DATA.test(value)) return "image-data";
  if (/^(?:https?:|wss?:|ftp:)/i.test(value) || value.startsWith("//")) return "remote";
  if (SCHEME.test(value)) return "unsafe";
  return "relative";
}

/**
 * The Content-Security-Policy every webview gets, before its own: nothing loads from the network or the
 * disk, images/fonts/styles only inline or as data, no frames, plugins, forms or base URLs, and scripts only
 * inline and only when the extension asked for them. (The page's own CSP can only narrow this.)
 */
export function contentSecurityPolicy(enableScripts: boolean): string {
  return [
    "default-src 'none'",
    "img-src data:",
    "media-src data:",
    "font-src data:",
    "style-src 'unsafe-inline' data:",
    `script-src ${enableScripts ? "'unsafe-inline'" : "'none'"}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** `acquireVsCodeApi()` for the page: posts only to the app's frame, with the token, as JSON text. */
export function bridgeScript(token: string, state: string | null): string {
  const t = JSON.stringify(token);
  const s = state === null ? "undefined" : state.replace(/</g, "\\u003c");
  return `(function(){var token=${t},state=${s},acquired=false;window.acquireVsCodeApi=function(){if(acquired)throw new Error('An instance of the VS Code API has already been acquired');acquired=true;var send=function(type,key,value){parent.postMessage({omWebview:token,type:type,[key]:value},'*')};return Object.freeze({postMessage:function(message){var text;try{text=JSON.stringify(message)}catch(e){throw new Error('The message must be JSON-serializable')}if(text===undefined)throw new Error('The message must be JSON-serializable data');send('message','message',text)},getState:function(){return state},setState:function(next){state=next;send('state','state',JSON.stringify(next)===undefined?'null':JSON.stringify(next));return next}})}})();`;
}

const REMOVED_ELEMENTS =
  "base,iframe,frame,frameset,object,embed,applet,portal,meta[http-equiv='refresh' i]";
/** Attributes that carry a URL and that a page may only use for something we handle below. */
const URL_ATTRIBUTES = [
  "src",
  "poster",
  "data",
  "action",
  "formaction",
  "background",
  "ping",
  "xlink:href",
];

class Collector {
  readonly blocked: string[] = [];
  add(line: string): void {
    if (!this.blocked.includes(line)) this.blocked.push(line);
  }
}

async function rewriteCss(css: string, options: PrepareOptions, found: Collector): Promise<string> {
  let out = css.replace(/@import[^;]*;?/gi, () => {
    found.add("A stylesheet @import was blocked (only local files from asWebviewUri load).");
    return "";
  });
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  const jobs: { whole: string; replacement: Promise<string> }[] = [];
  for (const match of out.matchAll(pattern)) {
    const url = match[1] ?? match[2] ?? match[3] ?? "";
    jobs.push({ whole: match[0], replacement: cssUrl(url, options, found) });
  }
  for (const job of jobs) out = out.replace(job.whole, await job.replacement);
  return out;
}

async function cssUrl(url: string, options: PrepareOptions, found: Collector): Promise<string> {
  const kind = classify(url);
  if (kind === "resource") {
    try {
      return `url("${await options.readResource(url.trim())}")`;
    } catch (error) {
      found.add(`Local resource not loaded: ${reason(error)}`);
    }
  } else if (kind === "image-data") {
    return `url("${url.trim()}")`;
  } else if (kind === "remote") {
    found.add(`Remote content blocked: ${shorten(url)}`);
  } else if (kind !== "empty") {
    found.add(`Blocked URL in a style: ${shorten(url)}`);
  }
  return 'url("data:,")';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shorten(text: string): string {
  const one = text.trim().replace(/\s+/g, " ");
  return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

async function resourceOrDrop(
  element: Element,
  attribute: string,
  options: PrepareOptions,
  found: Collector,
  allowImageData: boolean,
): Promise<void> {
  const value = element.getAttribute(attribute) ?? "";
  const kind = classify(value);
  if (kind === "empty") return;
  if (kind === "resource") {
    try {
      element.setAttribute(attribute, await options.readResource(value.trim()));
      return;
    } catch (error) {
      found.add(`Local resource not loaded: ${reason(error)}`);
    }
  } else if (kind === "image-data" && allowImageData) {
    return;
  } else if (kind === "remote") {
    found.add(`Remote content blocked: ${shorten(value)}`);
  } else if (kind === "relative") {
    found.add(
      `Blocked ${shorten(value)}: a relative path can't be loaded, use webview.asWebviewUri.`,
    );
  } else {
    found.add(`Blocked ${element.tagName.toLowerCase()} ${attribute}: ${shorten(value)}`);
  }
  element.removeAttribute(attribute);
}

/**
 * Turns an extension's webview HTML into the document the sandboxed frame shows. Nothing here trusts the page:
 * frames/plugins/base/refresh are removed, scripts and event handlers only stay when `enableScripts` is set,
 * every URL is either a local resource inlined as data (through `readResource`, which checks the roots), a safe
 * inline image, a `#fragment` link or an ordinary link that can't navigate (the frame has no popups), and
 * anything remote is dropped and reported. A CSP and, for scripts, the `acquireVsCodeApi` bridge come first.
 * The result is meant for `<iframe sandbox srcdoc>` (never `allow-same-origin`), so even a mistake here can't
 * reach the app, its storage or the disk.
 */
export async function prepareWebviewHtml(html: string, options: PrepareOptions): Promise<Prepared> {
  const found = new Collector();
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const element of doc.querySelectorAll(REMOVED_ELEMENTS)) {
    found.add(`<${element.tagName.toLowerCase()}> isn't allowed in a webview and was removed.`);
    element.remove();
  }
  if (!options.enableScripts) {
    for (const element of doc.querySelectorAll("script")) element.remove();
  }
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) && !options.enableScripts)
        element.removeAttribute(attribute.name);
    }
  }

  // Scripts with a source, and stylesheets, become inline (the page can't fetch anything itself).
  for (const script of [...doc.querySelectorAll("script[src]")]) {
    const src = script.getAttribute("src") ?? "";
    if (classify(src) === "resource") {
      try {
        const text = decodeDataText(await options.readResource(src.trim()));
        script.removeAttribute("src");
        script.textContent = text.replace(/<\/script/gi, "<\\/script");
        continue;
      } catch (error) {
        found.add(`Local resource not loaded: ${reason(error)}`);
      }
    } else {
      found.add(`Script blocked: ${shorten(src)} (only local files from asWebviewUri load).`);
    }
    script.remove();
  }
  for (const link of [...doc.querySelectorAll("link")]) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    const href = link.getAttribute("href") ?? "";
    if (rel.split(/\s+/).includes("stylesheet") && classify(href) === "resource") {
      try {
        const style = doc.createElement("style");
        style.textContent = await rewriteCss(
          decodeDataText(await options.readResource(href.trim())),
          options,
          found,
        );
        link.replaceWith(style);
        continue;
      } catch (error) {
        found.add(`Local resource not loaded: ${reason(error)}`);
      }
    } else if (classify(href) === "remote") {
      found.add(`Remote content blocked: ${shorten(href)}`);
    } else {
      found.add(
        `<link ${rel || "href"}> was removed (only local stylesheets from asWebviewUri load).`,
      );
    }
    link.remove();
  }

  for (const style of doc.querySelectorAll("style")) {
    style.textContent = await rewriteCss(style.textContent, options, found);
  }
  for (const element of doc.querySelectorAll("[style]")) {
    element.setAttribute(
      "style",
      await rewriteCss(element.getAttribute("style") ?? "", options, found),
    );
  }

  for (const element of doc.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    if ((tag === "a" || tag === "area") && element.hasAttribute("href")) {
      const href = element.getAttribute("href") ?? "";
      const kind = classify(href);
      if (kind === "unsafe" || kind === "resource") {
        found.add(`Blocked link: ${shorten(href)}`);
        element.removeAttribute("href");
      } else if (kind !== "fragment") {
        // Kept as text, but it can't open anything: the frame has no popups or navigation.
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    } else if (element.hasAttribute("href") && tag !== "link") {
      element.removeAttribute("href");
    }
    if (element.hasAttribute("srcset")) {
      found.add("srcset isn't supported in a webview and was removed.");
      element.removeAttribute("srcset");
    }
    const imageTag = tag === "img" || tag === "source" || tag === "picture";
    for (const attribute of URL_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue;
      if (attribute === "action" || attribute === "formaction" || attribute === "ping") {
        found.add(`${attribute} isn't allowed in a webview and was removed.`);
        element.removeAttribute(attribute);
        continue;
      }
      await resourceOrDrop(element, attribute, options, found, imageTag);
    }
  }

  const head = doc.head;
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", contentSecurityPolicy(options.enableScripts));
  const first = head.firstChild;
  head.insertBefore(meta, first);
  if (options.enableScripts) {
    const bridge = doc.createElement("script");
    bridge.textContent = bridgeScript(options.token, options.state);
    head.insertBefore(bridge, meta.nextSibling);
  }
  return { html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, blocked: found.blocked };
}

/** The text of a `data:` URL made by the app (base64 or plain). */
function decodeDataText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!head.endsWith(";base64")) return decodeURIComponent(body);
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
