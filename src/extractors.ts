// JavaScript extractors + URL classifiers for visit_page / google_search.
//
// Each extractor is a self-contained JS string (run via CDP
// `Runtime.evaluate` in the page's main execution context). They're kept as
// strings - not real TypeScript - because they execute in the browser, not
// Node, and can't be type-checked or linted here. The tests in
// `tests/unit/extractors-parse.test.ts` validate they at least parse as valid
// JavaScript via `new Function()`.
//
// Split from `chrome.ts` so the CDP plumbing (which changes rarely) is
// isolated from the site-specific extractors (which change whenever a site
// redesigns its DOM). This module has zero dependency on the CDP layer -
// it's pure data + pure functions.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Google consent + search

// NOTE: deliberately does NOT match <a> tags. Clicking an anchor navigates
// away from the target page. Cookie-consent "accept" buttons are always
// <button>/<input>/[role=button], never <a>. Patterns are anchored (^...$)
// so e.g. /^agree$/i does not match "Service Level Agreement" in a footer.
export const GOOGLE_CONSENT_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  "const pats=[/^accept all$/i,/^accept$/i,/^i agree$/i,/^agree$/i,/^allow all$/i,/^got it$/i,/^accetta tutto$/i,/^tout accepter$/i,/^aceptar todo$/i,/^alle akzeptieren$/i];" +
  'const els=[...document.querySelectorAll("button,[role=button],input[type=submit]")];' +
  "for(const el of els){const t=clean(el.innerText||el.value||el.textContent);" +
  "if(!t)continue;if(pats.some(p=>p.test(t))){el.click();return'clicked '+t;}}" +
  'return"";' +
  "})()";

// Google search results. Classic redirect wrappers (`/url?q=` / `/url?url=`) are
// unwrapped locally when the target is a plain URL. The newer
// `/goto?url=<opaque token>` wrapper is a Tink-encrypted protobuf that cannot be
// decoded offline, so those links are kept as-is and resolved afterwards in the
// browser (HTTP 302 Location) by src/google-links.ts - never dropped.
export const GOOGLE_SEARCH_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  'const esc=s=>clean(s).replace(/\\\\/g,"\\\\\\\\").replace(/\\[/g,"\\\\[").replace(/\\]/g,"\\\\]").replace(/\\n/g," ");' +
  'const visible=el=>{const r=el.getBoundingClientRect();const st=getComputedStyle(el);return r.width>0&&r.height>0&&st.display!=="none"&&st.visibility!=="hidden"&&st.opacity!=="0";};' +
  "const bad=h=>/(^|\\.)google\\./.test(h)||/(^|\\.)gstatic\\./.test(h)||/(^|\\.)googleusercontent\\./.test(h);" +
  "const wrap=u=>/(^|\\.)google\\./.test(u.hostname)&&/^\\/(url|goto)\\/?$/.test(u.pathname);" +
  'const lines=["# Google search results","","URL: "+location.href,"","## Visible links"];' +
  "const seen=new Set();" +
  'for(const a of document.querySelectorAll("a[href]")){' +
  "if(!visible(a))continue;let href=a.href||'';" +
  'try{const u=new URL(href);if(wrap(u)){const t=u.searchParams.get("q")||u.searchParams.get("url");if(t&&/^https?:\\/\\//i.test(t))href=t;}}catch{}' +
  "let u;try{u=new URL(href)}catch{continue;}" +
  "if(!/^https?:$/.test(u.protocol))continue;" +
  "if(bad(u.hostname)&&!wrap(u))continue;" +
  "const text=esc(a.innerText||a.textContent);if(text.length<3)continue;" +
  "if(seen.has(u.href))continue;seen.add(u.href);" +
  'lines.push("- ["+text.slice(0,180)+"]("+u.href+")");if(seen.size>=30)break;}' +
  'lines.push("","## Text snippet",clean(document.body.innerText).slice(0,1200));' +
  'return lines.join("\\n");' +
  "})()";

// Google Images (`udm=2`). Each result tile carries the source page URL in
// `data-lpage`, the page title in the thumbnail's `alt`, and a Google-hosted
// thumbnail in `src`. The original image URL is not in the grid: it only
// appears in the preview panel after a tile is clicked, where Google first
// shows the cached thumbnail and then swaps in the original (measured: 0.5-4s.
// On hosts that block hotlinking - e.g. Facebook - it stays cached). So the
// driver clicks through the tiles and reports the original when it arrives,
// falling back to the cached thumbnail otherwise. Tiles that don't get their
// turn before the deadline are reported from the grid data alone, which keeps
// the whole extractor inside the 30s Runtime.evaluate budget.
export const GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT = 8;
export const GOOGLE_IMAGE_SEARCH_MAX_COUNT = 12;

// Clamp a caller-supplied result count into [1, MAX]. Non-numbers use the default.
export function clampImageCount(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT;
  return Math.min(GOOGLE_IMAGE_SEARCH_MAX_COUNT, Math.max(1, Math.floor(n)));
}

export function getGoogleImageSearchJs(count: number): string {
  const max = clampImageCount(count);
  return `(async () => {
  const MAX = ${max};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // The runtime evaluate budget is 30s. Return comfortably inside it. Tiles the
  // deadline cuts off are still reported, from the grid data (cached thumb).
  const deadline = Date.now() + 20000;
  const clean = s => (s || "").replace(/\\s+/g, " ").trim();
  const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const googleish = u => {
    const h = hostOf(u);
    return /(^|\\.)google\\./.test(h) || /(^|\\.)gstatic\\.com$/.test(h) || /(^|\\.)googleusercontent\\.com$/.test(h);
  };
  const unwrap = raw => {
    let href = raw || "";
    try { href = new URL(href, location.href).href; } catch { return ""; }
    try {
      const u = new URL(href);
      if (/(^|\\.)google\\./.test(u.hostname) && /^\\/(url|imgres)\\/?$/.test(u.pathname)) {
        const t = u.searchParams.get("q") || u.searchParams.get("url") || u.searchParams.get("imgurl");
        if (t && /^https?:\\/\\//i.test(t)) return t;
      }
    } catch {}
    return href;
  };

  // Modern tiles carry the source page in data-lpage. The pre-2023 layout uses
  // .isv-r with a /url?q= anchor and data-src on the thumbnail.
  let tiles = [...document.querySelectorAll("[data-lpage]")];
  if (!tiles.length) tiles = [...document.querySelectorAll(".isv-r")];
  const items = [];
  for (const el of tiles) {
    const img = el.querySelector("img");
    if (!img) continue;
    const thumb = img.getAttribute("data-src") || img.getAttribute("src") || "";
    if (!/^https?:/i.test(thumb)) continue;
    const a = el.querySelector("a[href]");
    const page = unwrap(el.getAttribute("data-lpage") || (a ? a.getAttribute("href") : ""));
    if (!page || googleish(page)) continue;
    const aria = el.querySelector("a[aria-label]");
    const title = clean(img.alt || (aria ? aria.getAttribute("aria-label") : ""));
    items.push({ el: el, img: img, thumb: thumb, page: page, title: title });
    if (items.length >= MAX) break;
  }

  // Let the grid finish loading before clicking: the preview originals are
  // large and would otherwise compete with the thumbnails for bandwidth.
  for (let i = 0; i < 20 && document.readyState !== "complete"; i++) await sleep(150);
  await sleep(700);

  // One preview panel serves every tile, sequentially: give each tile a slice
  // of the time budget - fewer results means more patience per image. Originals
  // that do load typically appear within ~1s. Hosts that block hotlinking never
  // swap, so waiting longer only costs time.
  const perItem = Math.max(1200, Math.min(5000, Math.floor(10000 / items.length)));

  const results = [];
  for (const item of items) {
    let image = item.thumb, w = 0, h = 0, original = false;
    if (Date.now() < deadline) {
      try {
        item.el.scrollIntoView({ block: "center" });
        await sleep(200);
        // The panel may still be showing the previous tile's image. Ignore it.
        const panelBefore = document.querySelector('img[jsname="kn3ccd"], img.sFlh5c');
        const before = panelBefore ? panelBefore.getAttribute("src") || "" : "";
        item.img.click();
        // Google first shows its cached thumbnail, then swaps in the original
        // when that has loaded (usually <1s. Some hosts block hotlinking and
        // never swap - e.g. Facebook - so the window is bounded).
        const until = Math.min(deadline, Date.now() + perItem);
        while (Date.now() < until) {
          await sleep(150);
          const big = document.querySelector('img[jsname="kn3ccd"], img.sFlh5c');
          if (!big) continue;
          const src = big.getAttribute("src") || "";
          if (!/^https?:/i.test(src)) continue;
          if (src === before && !googleish(before)) continue;
          if (big.naturalWidth) { w = big.naturalWidth; h = big.naturalHeight; }
          image = src;
          if (!googleish(src) && (big.naturalWidth || 0) > 60) { original = true; break; }
        }
      } catch (e) {}
    }
    results.push({ title: item.title, page: item.page, image: image, w: w, h: h, original: original });
  }

  const lines = ["# Google image search results", "", "URL: " + location.href, ""];
  results.forEach((r, i) => {
    lines.push((i + 1) + ". " + (r.title || hostOf(r.page) || "(untitled image)"));
    lines.push("   image: " + r.image + (r.original ? "" : " (google-cached)"));
    lines.push("   page: " + r.page);
    if (r.w && r.h) lines.push("   size: " + r.w + "x" + r.h);
  });
  if (!results.length) {
    lines.push("(no image results found - the page may be showing a consent or captcha screen)");
    lines.push("");
    lines.push(clean(document.body.innerText).slice(0, 500));
  }
  return lines.join("\\n");
})()`;
}

// Generic page extractor (fallback / default)
//
// A reader for the wild web rather than for article layouts: blogs, forums
// (5ch keeps its posts in <dd>), wikis, galleries, listing/product pages, old
// table-based sites. Sections, in order:
//
//   ## Content       the main text, with hyperlinks and images inline
//   ## Images        every content image (URL + alt + size), including ones
//                    that carry no text of their own (galleries)
//   ## Navigation    declared (rel=next/prev/up/contents) and detected
//                    (text/aria heuristics, pagination) links, so the agent
//                    can reach the next page, the index, or the original
//   ## Visible links the remaining visible links, for exploration
//
// It is null-safe (document.body is null on Chrome error pages and briefly
// mid-reload) and the text section is capped independently of the trailing
// sections, so navigation/images survive a huge article.
export const EXTRACT_PAGE_JS = `(() => {
  const doc = document;
  const root = doc.body || doc.documentElement;
  if (!root) return "__NAV_ERROR__: " + location.href;
  const clean = s => (s || "").replace(/\\s+/g, " ").trim();
  const esc = s => clean(s).replace(/\\\\/g, "\\\\\\\\").replace(/\\[/g, "\\\\[").replace(/\\]/g, "\\\\]");
  const fence = String.fromCharCode(96).repeat(3);
  const abs = u => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (e) { return ""; } };
  const visible = el => {
    try {
      const r = el.getBoundingClientRect(), st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
    } catch (e) { return false; }
  };
  // images
  const SKIP_IMG = /sprite|\\/icons?\\/|icon\\.|logo\\.|avatar|spacer|blank\\.(gif|png)|pixel\\.(gif|png)|1x1|loading\\.(gif|png)|transparent\\.(gif|png)|emoji|rating|badge|banner/i;
  const imgSrc = img => {
    const cands = [img.currentSrc, img.getAttribute("src"), img.getAttribute("data-src"), img.getAttribute("data-original"), img.getAttribute("data-lazy-src"), img.getAttribute("data-echo"), img.getAttribute("data-url")];
    for (const v of cands) if (v && !/^data:/i.test(v)) { const a = abs(v); if (a) return a; }
    const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    if (srcset) {
      const best = srcset.split(",").map(s => s.trim().split(/\\s+/)).sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0))[0];
      if (best && best[0] && !/^data:/i.test(best[0])) return abs(best[0]);
    }
    return "";
  };
  const seenImg = new Set();
  const images = [];
  const note = img => {
    const src = imgSrc(img);
    if (!src) return null;
    const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
    const cls = String(img.className || "") + " " + String(img.id || "");
    if (SKIP_IMG.test(src) || SKIP_IMG.test(cls) || (img.getAttribute("width") || "") === "1") return null;
    if (w && h && w < 64 && h < 64) return null;
    const alt = clean(img.alt || img.getAttribute("title") || "");
    if (!seenImg.has(src)) { seenImg.add(src); images.push({ src: src, alt: alt, w: w, h: h }); }
    return { src: src, alt: alt };
  };
  // inline text (links + images)
  const SKIP_INLINE = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|BUTTON|SELECT|OPTION|TEXTAREA|INPUT)$/;
  const inline = n => {
    if (!n) return "";
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return "";
    const el = n;
    if (SKIP_INLINE.test(el.tagName)) return "";
    if (el.tagName === "IMG") { const i = note(el); return i ? "![" + esc(i.alt) + "](" + i.src + ")" : ""; }
    if (el.tagName === "BR") return " ";
    const inner = () => [...el.childNodes].map(inline).join("");
    if (el.tagName === "A") {
      const t = esc(el.innerText || el.textContent);
      const h = abs(el.getAttribute("href"));
      const imgs = (inner().match(/!\\[[^\\]]*\\]\\([^)]+\\)/g) || []).join(" ");
      if (t && h) return "[" + t + "](" + h + ")" + (imgs ? " " + imgs : "");
      return t || imgs;
    }
    return inner();
  };
  // main text: walk blocks, emit leaf blocks with their inline content
  const BLOCK = new Set("ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIALOG DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL".split(" "));
  const blockish = el => {
    if (BLOCK.has(el.tagName)) return true;
    try { return /^(block|flex|grid|table|list-item|flow-root)/.test(getComputedStyle(el).display); } catch (e) { return false; }
  };
  const CHROME_TAG = /^(NAV|ASIDE|FOOTER|HEADER|DIALOG)$/;
  const CHROME_ROLE = /^(navigation|banner|contentinfo|search|dialog|complementary)$/;
  const chromeEl = el => CHROME_TAG.test(el.tagName) || CHROME_ROLE.test(el.getAttribute("role") || "");
  const out = [];
  const seenBlock = new Set();
  let outLen = 0;
  const MAX = 120000;
  const push = s => {
    s = (s || "").trim();
    if (!s || seenBlock.has(s)) return;
    seenBlock.add(s);
    out.push(s);
    outLen += s.length + 1;
  };
  const walk = el => {
    if (!el || el.nodeType !== 1 || !el.tagName || outLen > MAX) return;
    if (chromeEl(el)) return;
    const tag = el.tagName;
    if (SKIP_INLINE.test(tag) || tag === "VIDEO" || tag === "AUDIO") return;
    let hasBlock = false;
    for (const c of el.children) if (blockish(c)) { hasBlock = true; break; }
    if (!hasBlock) {
      if (!visible(el)) return;
      if (tag === "PRE") { const t = (el.innerText || el.textContent || "").replace(/\\s+$/, ""); if (t) push(fence + "\\n" + t + "\\n" + fence); return; }
      const text = clean(inline(el));
      if (!text) return;
      if (/^H[1-6]$/.test(tag)) push("#".repeat(Number(tag[1])) + " " + text);
      else if (tag === "LI") push("- " + text);
      else if (tag === "BLOCKQUOTE") push("> " + text);
      else push(text);
      return;
    }
    for (const c of el.children) walk(c);
  };
  const container = doc.querySelector("main, article, [role=main], #content, #main, .entry-content, .post-content, .article-body, .article-content, .content-body") || root;
  walk(container);
  if (out.length < 3 && container !== root) walk(root);
  // galleries/lightboxes: images that never appeared in the text
  for (const img of doc.querySelectorAll("img")) {
    if (images.length >= 60) break;
    if (img.closest("nav, header, footer, aside")) continue;
    note(img);
  }
  // navigation links
  const navRe = /(^|[^a-z])(next|previous|prev|back|index|contents?|up|first|last|older|newer|more)([^a-z]|$)|次へ|次ページ|次のページ|前へ|前ページ|前のページ|戻る|もどる|一覧|記事一覧|目次|インデックス|トップ|ホーム|続きを読む|次の記事|前の記事|»|«|→|←/i;
  const nav = [];
  const navSeen = new Set();
  const addNav = (url, text, rel) => {
    if (!url || navSeen.has(url) || nav.length >= 20) return;
    navSeen.add(url);
    nav.push("- " + (text ? esc(text) : (rel || url)) + (rel ? " [" + rel + "]" : "") + ": " + url);
  };
  for (const l of doc.querySelectorAll("link[rel][href], a[rel][href]")) {
    const rel = (l.getAttribute("rel") || "").toLowerCase();
    if (!/(^|\\s)(next|prev|previous|up|contents|first|last|index|canonical)(\\s|$)/.test(rel)) continue;
    addNav(abs(l.getAttribute("href")), clean(l.textContent || l.innerText || ""), rel);
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    if (!visible(a)) continue;
    const label = clean(a.innerText || a.textContent || "") || clean(a.getAttribute("aria-label") || "") || clean(a.getAttribute("title") || "");
    if (!label && !a.querySelector("img")) continue;
    const rel = (a.getAttribute("rel") || "").toLowerCase();
    const href = a.getAttribute("href") || "";
    // Ad and tracking URLs carry a p= parameter too, so only a numeric page
    // number counts as pagination. Code snippets in an article body are long,
    // escaped-markup labels that would otherwise read as navigation.
    const pager = (() => {
      const path = href.split(/[?#]/)[0];
      const seg = path.slice(path.lastIndexOf("/") + 1);
      const pathPage = path.includes("/page/") && seg.length > 0 && !isNaN(Number(seg));
      const query = (() => {
        const at = href.indexOf("?");
        if (at < 0) return false;
        for (const pair of href.slice(at + 1).split(/[&;]/)) {
          const eq = pair.indexOf("=");
          if (eq < 0) continue;
          const key = pair.slice(0, eq).toLowerCase();
          const value = pair.slice(eq + 1);
          if ((key === "page" || key === "paged" || key === "pg" || key === "p") &&
              value.length > 0 && !isNaN(Number(value))) return true;
        }
        return false;
      })();
      return (pathPage || query) && label.length <= 24;
    })();
    if (label.startsWith("<") || rel.includes("sponsored")) continue;
    if (navRe.test(label) || rel.includes("next") || rel.includes("prev") || pager) {
      addNav(abs(href), label.slice(0, 40), rel);
    }
  }
  // trailing sections
  const imgLines = images.slice(0, 60).map(i => "- " + (i.alt ? esc(i.alt) + " " : "") + (i.w && i.h ? "(" + i.w + "x" + i.h + ") " : "") + i.src);
  const links = [];
  const linkSeen = new Set();
  for (const a of doc.querySelectorAll("a[href]")) {
    if (!visible(a)) continue;
    const t = esc(a.innerText || a.textContent);
    const u = abs(a.getAttribute("href"));
    if (!u || t.length < 2 || linkSeen.has(u)) continue;
    linkSeen.add(u);
    links.push("- [" + t.slice(0, 160) + "](" + u + ")");
    if (links.length >= 120) break;
  }
  const parts = ["# " + (clean(doc.title) || location.href), "", "URL: " + location.href, "", "## Content", out.join("\\n")];
  if (imgLines.length) parts.push("", "## Images (" + images.length + ")", imgLines.join("\\n"));
  if (nav.length) parts.push("", "## Navigation", nav.join("\\n"));
  if (links.length) parts.push("", "## Visible links", links.join("\\n"));
  return parts.join("\\n");
})()`;

// Defuddle (clean article extraction)
// Defuddle (MIT, by Steph Ango / @kepano - the library behind the Obsidian
// Web Clipper) is a regular npm dependency now. Its browser entry
// (`defuddle/full` -> `dist/index.full.js`) is a self-contained UMD bundle
// that exposes `window.Defuddle` when injected into a page.
//
// The full entry is required, not the default one: only it bundles the
// Turndown-based HTML -> Markdown converter, so `{ markdown: true }` actually
// produces Markdown (the slim entry silently ignores the option and returns
// HTML) - plus MathML/Temml rendering for math-heavy pages.
//
// It is injected with the driver below in a single Runtime.evaluate call, and
// is far cleaner than EXTRACT_PAGE_JS (the naive block-walker fallback) for
// articles, docs, and blog posts: no navigation noise, no "visible links"
// dump, no 90 KB truncation cliff - just the article content as Markdown.

const requireFromHere = createRequire(import.meta.url);

// Absolute path of the installed Defuddle browser bundle (the package's UMD
// entry, resolved through its `exports` map). Exported for tests.
export function defuddleBundlePath(): string {
  try {
    return requireFromHere.resolve("defuddle/full");
  } catch {
    throw new Error(
      "The 'defuddle' package is not installed - run `pnpm install` (or `npm install`). " +
        "Clean extraction needs it; without it, visit_page({ clean: true }) falls back to the generic extractor.",
    );
  }
}

let defuddleBundleCache: string | null = null;

// The UMD bundle text, read once and cached.
export function getDefuddleBundle(): string {
  if (defuddleBundleCache === null) {
    // Shadow `module`, `exports` and `define` so the UMD always takes its
    // browser-global branch ("set window.Defuddle") even on a page that
    // happens to define any of them.
    defuddleBundleCache =
      "(function(module, exports, define){" +
      readFileSync(defuddleBundlePath(), "utf8") +
      "\n})(undefined, undefined, undefined)";
  }
  return defuddleBundleCache;
}

// Driver: runs AFTER the bundle is injected (window.Defuddle exists).
// Uses { markdown: true } so Defuddle replaces result.content with Markdown.
// On failure or empty extraction, returns a short error so the caller can
// fall back to the generic extractor.
export const DEFUDDLE_DRIVER_JS = `(() => {
  if (typeof Defuddle === "undefined") return "__DEFUDDLE_ERROR__: bundle did not load";
  try {
    const d = new Defuddle(document, { url: location.href, markdown: true });
    const r = d.parse();
    const content = (r.content || "").trim();
    if (!content) return "__DEFUDDLE_ERROR__: no content extracted";
    const lines = [];
    lines.push("# " + (r.title || document.title || location.href));
    lines.push("");
    lines.push("URL: " + location.href);
    const meta = [];
    if (r.author) meta.push("by " + r.author);
    if (r.published) meta.push(r.published);
    if (r.wordCount) meta.push(r.wordCount + " words");
    if (r.site) meta.push(r.site);
    if (meta.length) { lines.push(""); lines.push(meta.join(" - ")); }
    lines.push("");
    lines.push(content);
    return lines.join("\\n");
  } catch (e) {
    return "__DEFUDDLE_ERROR__: " + (e && e.message || String(e));
  }
})()`;

// X (Twitter) extractor
// Search results, profiles, and individual tweets all render tweets as
// <article data-testid="tweet">. Written as a template literal for readability
// (no backticks needed inside), unlike the Google/generic extractors above.
//
// X virtualizes its timeline: only a window of tweets is mounted in the DOM at
// any time, and scrolling past evicts earlier ones. So this extractor is async
// and self-scrolling - it collects the currently-mounted tweets, scrolls to
// load more, and repeats, deduping by permalink. Tweets that get unmounted as
// we scroll past them are already captured in `seen`.
export const X_EXTRACT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const parseEng = s => {
    if (!s) return "";
    // aria-label looks like "48 Replies. Reply" / "1.2K Likes. Like" -> "48 replies"
    const idx = s.lastIndexOf(". ");
    const stats = (idx >= 0 ? s.slice(0, idx) : s).trim().toLowerCase();
    return /\\d/.test(stats) ? stats : "";
  };
  const titleFor = () => {
    try {
      const u = new URL(location.href);
      const p = u.pathname;
      if (p === "/search") return "X search: " + (u.searchParams.get("q") || "(no query)");
      const m = p.match(/^\\/([^/]+)\\/status\\/\\d+/);
      if (m) return "Tweet by @" + m[1];
      if (/^\\/[^/]+$/.test(p)) return "X profile: @" + p.slice(1);
    } catch {}
    return clean(document.title) || "X (Twitter)";
  };
  const collectTweet = art => {
    const text = clean(art.querySelector('[data-testid="tweetText"]')?.innerText || "");
    const userEl = art.querySelector('[data-testid="User-Name"]');
    let handle = "", name = "";
    if (userEl) {
      const links = [...userEl.querySelectorAll('a[href]')];
      const handleLink = links.find(a => /^\\/[^/]+$/.test(a.getAttribute("href")));
      if (handleLink) handle = handleLink.getAttribute("href").slice(1);
      name = clean(links[0]?.innerText || "");
    }
    const time = art.querySelector("time");
    let permalink = "";
    for (const a of art.querySelectorAll('a[href]')) {
      if (/\\/status\\/\\d+/.test(a.getAttribute("href"))) { permalink = a.getAttribute("href"); break; }
    }
    const reply = parseEng(art.querySelector('[data-testid="reply"]')?.getAttribute("aria-label") || "");
    const retweet = parseEng(art.querySelector('[data-testid="retweet"]')?.getAttribute("aria-label") || "");
    const like = parseEng(art.querySelector('[data-testid="like"]')?.getAttribute("aria-label") || "");
    return { handle, name, time: time?.getAttribute("datetime") || "", permalink, text, reply, retweet, like };
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const seen = new Map();
  let stale = 0;
  for (let i = 0; i < 12; i++) {
    let added = 0;
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const t = collectTweet(art);
      const key = t.permalink || (t.handle + "|" + t.text.slice(0, 40));
      if (!seen.has(key)) { seen.set(key, t); added++; }
    }
    if (seen.size >= 40) break;
    if (added === 0) { stale++; if (stale >= 2) break; } else { stale = 0; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.5));
    await sleep(700);
  }
  window.scrollTo(0, 0);
  const tweets = [...seen.values()];
  const lines = ["# " + titleFor(), "", "URL: " + location.href, "", "## Tweets (" + tweets.length + ")", ""];
  if (tweets.length === 0) {
    const bodyText = (document.body.innerText || "").slice(0, 2000);
    if (/something went wrong|try reloading|algo sali/i.test(bodyText)) {
      lines.push("_X returned an error (\\"Something went wrong. Try reloading.\\"). This is usually a transient rate-limit - wait a minute and retry, or open the URL in the visible Chrome window and reload._");
    } else if (/log in|iniciar sesi|connexion/i.test(bodyText)) {
      lines.push("_No tweets found - the page is showing a login wall. Log in to X in the visible Chrome window (profile at ~/.pi-search-browser/) and retry._");
    } else {
      lines.push("_No tweets found. The search may have yielded no results, or the page failed to render._");
    }
    return lines.join("\\n");
  }
  for (const t of tweets) {
    const link = t.permalink ? "https://x.com" + t.permalink : "";
    lines.push("### @" + t.handle + (t.name ? " - " + t.name : ""));
    const meta = [];
    if (t.time) meta.push(t.time);
    if (link) meta.push(link);
    if (meta.length) lines.push(meta.join(" - "));
    lines.push("");
    lines.push(t.text || "(no text)");
    lines.push("");
    const eng = [];
    if (t.reply) eng.push(t.reply);
    if (t.retweet) eng.push(t.retweet);
    if (t.like) eng.push(t.like);
    if (eng.length) lines.push("_" + eng.join(" - ") + "_");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\\n");
})()`;

// Reddit extractor
// Post + comment pages render the post as <shreddit-post> and each comment as
// <shreddit-comment>, which carries author/depth/score/created as attributes.
// The generic extractor misses these (no <p>/<li> structure) and flattens
// comments into an unattributed wall of text. Reddit lazy-loads comments on
// scroll, so this is async + self-scrolling and dedupes by `thingid`, like the
// X extractor. Only post/comment pages (path has /comments/) are routed here.
// Subreddit listings and user pages use the generic extractor.
export const REDDIT_EXTRACT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const cleanMulti = s => (s||"").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Post
  const post = document.querySelector('shreddit-post, [data-testid="post-container"]');
  const titleEl = post ? post.querySelector('[slot="title"], h1, [data-testid="post-title"]') : null;
  const title = clean(titleEl ? titleEl.innerText : document.title);
  const author = (post && post.getAttribute('author')) || "";
  let subreddit = "";
  const sm = location.pathname.match(/^\\/r\\/([^/]+)/);
  if (sm) subreddit = sm[1];
  const postScore = (post && post.getAttribute('score')) || "";
  const postBodyEl = post ? post.querySelector('[slot="text-body"], .md, [data-testid="post-text"]') : null;
  const postBody = cleanMulti(postBodyEl ? postBodyEl.innerText : "");

  // Comments (incremental scroll, dedup by thingid)
  const seen = new Map();
  let stale = 0;
  for (let i = 0; i < 10; i++) {
    let added = 0;
    for (const c of document.querySelectorAll('shreddit-comment, [id^="comment-tree-comment-node"]')) {
      const id = c.getAttribute('thingid') || c.id;
      if (!id || seen.has(id)) continue;
      const cAuthor = c.getAttribute('author') || "";
      const depth = parseInt(c.getAttribute('depth') || '0', 10);
      const cScore = c.getAttribute('score') || "";
      const created = c.getAttribute('created') || (c.querySelector('time') ? c.querySelector('time').getAttribute('datetime') : "");
      const isOp = c.hasAttribute('is-op');
      const bodyEl = c.querySelector('[slot="comment"], .md');
      const cBody = cleanMulti(bodyEl ? bodyEl.innerText : "");
      seen.set(id, { author: cAuthor, depth, score: cScore, created, isOp, body: cBody });
      added++;
    }
    if (seen.size >= 80) break;
    if (added === 0) { stale++; if (stale >= 2) break; } else { stale = 0; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.2));
    await sleep(650);
  }
  window.scrollTo(0, 0);

  // Build markdown
  const lines = [];
  lines.push("# " + (title || "Reddit post"));
  lines.push("");
  lines.push("URL: " + location.href);
  const pm = [];
  if (subreddit) pm.push("r/" + subreddit);
  if (author) pm.push("u/" + author);
  if (postScore) pm.push(postScore + " points");
  if (pm.length) { lines.push(""); lines.push(pm.join(" - ")); }
  if (postBody) { lines.push(""); lines.push(postBody); }
  lines.push("");
  lines.push("## Comments (" + seen.size + ")");
  lines.push("");
  for (const c of seen.values()) {
    const indent = "  ".repeat(Math.min(c.depth, 8));
    const who = "u/" + c.author + (c.isOp ? " (OP)" : "");
    const csm = [];
    if (c.score) csm.push(c.score + " pts");
    lines.push(indent + "- **" + who + "**" + (csm.length ? " _" + csm.join(", ") + "_" : ""));
    if (c.body) {
      const ind = indent + "  ";
      lines.push(c.body.split("\\n").map(l => ind + l).join("\\n"));
    }
    lines.push("");
  }
  if (seen.size === 0) {
    lines.push("_No comments found or extracted. The page may require login, or comments may not have loaded._");
  }
  return lines.join("\\n");
})()`;

// Amazon extractor
// Amazon product pages are extremely noisy: the generic extractor pulls
// ~110KB of nav, keyboard-shortcut help, and category links before reaching
// the actual product data (and truncates at 90KB, often losing specs). This
// dedicated extractor pulls structured fields (title, price, availability,
// brand, rating, bullets, tech specs, ASIN) into ~2-3KB of clean markdown.
// Reviews are lazy-loaded near the bottom, so this is async and self-scrolls
// a few times to try to capture a few top reviews (best-effort).
export const AMAZON_PRODUCT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const txt = sel => { const el = document.querySelector(sel); return el ? clean(el.innerText) : null; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const title = txt("#productTitle") || txt("#titleSection");
  const price = txt("#corePrice_feature_div .a-offscreen") || txt(".a-price .a-offscreen");
  const listPrice = txt("#corePrice_feature_div .a-text-price .a-offscreen") || txt(".a-price.a-text-price .a-offscreen");
  const availability = txt("#availability span") || txt("#availability");
  let brand = txt("#bylineInfo") || "";
  brand = brand.replace(/^Brand:\\s*/i, "").replace(/\\s*Visit the .* Store$/i, "").trim();
  const rating = txt('span[data-hook="rating-out-of-text"]') || txt(".a-icon-star .a-icon-alt");
  let reviewCount = txt("#acrCustomerReviewText") || "";
  reviewCount = reviewCount.replace(/[()]/g, "").trim();
  const asinM = location.pathname.match(/\\/dp\\/([A-Z0-9]{10})/);
  const asin = asinM ? asinM[1] : null;

  // Feature bullets - deduped (Amazon sometimes repeats them)
  const bset = new Set(); const bullets = [];
  for (const el of document.querySelectorAll("#feature-bullets ul li span.a-list-item")) {
    const t = clean(el.innerText); if (!t || bset.has(t)) continue; bset.add(t); bullets.push(t);
  }
  // Tech specs - prefer the table, fall back to detail bullets
  const specs = []; const sset = new Set();
  for (const tr of document.querySelectorAll("#productDetails_techSpec_section_1 tr, #techSpecTable tr")) {
    const th = tr.querySelector("th"); const td = tr.querySelector("td");
    if (th && td) { const s = clean(th.innerText) + " :: " + clean(td.innerText); if (!sset.has(s)) { sset.add(s); specs.push(s); } }
  }
  if (specs.length === 0) {
    for (const li of document.querySelectorAll("#detailBulletsWrapper_feature_div li")) {
      const s = clean(li.innerText); if (!sset.has(s)) { sset.add(s); specs.push(s); }
    }
  }
  const description = txt("#productDescription");

  // Reviews are lazy-loaded near the bottom - best-effort scroll to find a few
  let reviews = [];
  for (let i = 0; i < 4; i++) {
    const els = [...document.querySelectorAll('[data-hook="review-body"] span')];
    if (els.length > 0) { reviews = els.slice(0, 5).map(el => clean(el.innerText).slice(0, 400)); break; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.5));
    await sleep(700);
  }
  window.scrollTo(0, 0);

  // CAPTCHA / bot-check guard: if no title and no ASIN, the page is likely a
  // "Enter the characters you see below" interstitial.
  if (!title && !asin) {
    const cap = ["# Amazon (no product data found)", "", "URL: " + location.href, "", "_The page may be a CAPTCHA / bot-check interstitial, or the product is no longer available._"];
    return cap.join("\\n");
  }

  const lines = [];
  lines.push("# " + (title || "Amazon product"));
  lines.push("");
  lines.push("URL: " + location.href);
  if (asin) lines.push("ASIN: " + asin);
  lines.push("");
  const meta = [];
  if (price) meta.push("Price: " + price);
  if (listPrice) meta.push("List price: " + listPrice);
  if (availability) meta.push("Availability: " + availability);
  if (brand) meta.push("Brand: " + brand);
  if (rating) meta.push("Rating: " + rating + (reviewCount ? " (" + reviewCount + " reviews)" : ""));
  for (const m of meta) lines.push("- " + m);
  if (bullets.length) {
    lines.push("");
    lines.push("## About this item");
    for (const b of bullets) lines.push("- " + b);
  }
  if (specs.length) {
    lines.push("");
    lines.push("## Technical specifications");
    for (const s of specs) lines.push("- " + s);
  }
  if (description) {
    lines.push("");
    lines.push("## Description");
    lines.push(description);
  }
  if (reviews.length) {
    lines.push("");
    lines.push("## Top reviews");
    for (const r of reviews) lines.push("> " + r.replace(/\\n/g, " "));
  }
  return lines.join("\\n");
})()`;

// Amazon search results (/s?k=...). Each result is a card with
// data-component-type="s-search-result" and data-asin. Results are paginated
// via infinite scroll, so this is async + self-scrolling and dedupes by ASIN,
// like the X/Reddit extractors.
export const AMAZON_SEARCH_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden"; };

  const seen = new Map();
  let stale = 0;
  for (let i = 0; i < 10; i++) {
    let added = 0;
    for (const c of document.querySelectorAll('[data-component-type="s-search-result"]')) {
      if (!visible(c)) continue;
      const asin = c.getAttribute("data-asin");
      if (!asin || seen.has(asin)) continue;
      const h2 = c.querySelector("h2");
      const title = h2 ? clean(h2.innerText) : null;
      const priceEl = c.querySelector(".a-price .a-offscreen");
      const price = priceEl ? clean(priceEl.innerText) : null;
      let rating = null;
      for (const ia of c.querySelectorAll(".a-icon-alt")) {
        const t = clean(ia.innerText); if (/out of 5/i.test(t)) { rating = t; break; }
      }
      const sponsored = !!c.querySelector(".puis-label-popover-default, [aria-label*='Sponsored' i]");
      if (!title && !price) continue;
      seen.set(asin, { title: title ? title.slice(0, 220) : null, price, rating, sponsored, url: "https://" + location.host + "/dp/" + asin });
      added++;
    }
    if (seen.size >= 40) break;
    if (added === 0) { stale++; if (stale >= 2) break; } else { stale = 0; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.5));
    await sleep(700);
  }
  window.scrollTo(0, 0);

  const query = new URLSearchParams(location.search).get("k") || clean(document.title).replace(/\\s*[|:]\\s*Amazon.*$/i, "");
  const lines = ["# Amazon search: " + (query || "(no query)"), "", "URL: " + location.href, "", "## Results (" + seen.size + ")", ""];
  if (seen.size === 0) {
    lines.push("_No results found or extracted. The page may be a CAPTCHA / bot-check interstitial._");
    return lines.join("\\n");
  }
  for (const r of seen.values()) {
    const parts = [];
    if (r.price) parts.push(r.price);
    if (r.rating) parts.push(r.rating);
    lines.push("- **" + (r.title || "(no title)") + (r.sponsored ? " [Sponsored]" : "") + "**" + (parts.length ? " - " + parts.join(" | ") : ""));
    lines.push("  " + r.url);
  }
  return lines.join("\\n");
})()`;

// Google Scholar extractor
// Scholar search pages (scholar.google.com/scholar?q=...) render results as
// .gs_r blocks, each with .gs_ri (info) containing .gs_rt (title+link), .gs_a
// (authors/year/venue), .gs_rs (snippet), and .gs_fl (footer links: Cited by,
// Related, Versions). The generic extractor flattens these into H3 headers and
// loses the authors, snippets, citation counts, and PDF links - the data that
// matters for academic search. Scholar paginates (10 results/page) rather than
// infinite-scrolling, so this is synchronous like GOOGLE_SEARCH_JS (no async
// scroll loop). The dedicated Chrome profile carries any locale setting, so
// the citation footer text varies ("Cited by 1108" / "Cité 1108 fois" /
// "Citado por 1108" / "Zitiert von 1108") - matched with a locale-agnostic
// regex.
export const SCHOLAR_EXTRACT_JS = `(() => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const esc = s => clean(s).replace(/\\\\/g, "\\\\\\\\").replace(/\\[/g, "\\\\[").replace(/\\]/g, "\\\\]");
  const q = new URLSearchParams(location.search).get("q") || clean(document.title).replace(/\\s*-\\s*Google Scholar\\s*$/i, "");
  const results = [];
  const seen = new Set();
  for (const c of document.querySelectorAll(".gs_r")) {
    const ri = c.querySelector(".gs_ri");
    if (!ri) continue;
    const titleEl = ri.querySelector(".gs_rt");
    const titleA = titleEl ? titleEl.querySelector("a") : null;
    const title = titleEl ? clean(titleEl.innerText).replace(/^\\[PDF\\]\\s*/i, "").replace(/^\\[HTML\\]\\s*/i, "").replace(/^\\[CITATION\\]\\s*/i, "") : null;
    const href = titleA ? titleA.href : null;
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const meta = ri.querySelector(".gs_a") ? clean(ri.querySelector(".gs_a").innerText) : "";
    const snip = ri.querySelector(".gs_rs") ? clean(ri.querySelector(".gs_rs").innerText) : "";
    // Footer links: [Save, Cite, Cited by N, Related, Versions]
    const fl = ri.querySelector(".gs_fl");
    let cited = null;
    if (fl) {
      for (const a of fl.querySelectorAll("a")) {
        const t = clean(a.innerText);
        const m = t.match(/(\\d[\\d,]*)/);
        if (m && /cited|cit\\u00e9|citado|zitiert/i.test(t)) { cited = m[1].replace(/,/g, ""); break; }
      }
    }
    // PDF link (sidebar)
    const pdfEl = c.querySelector(".gs_or_ggsm a, .gs_ggsd a");
    const pdf = pdfEl ? pdfEl.href : null;
    results.push({ title, href, meta, snip, cited, pdf });
  }
  // CAPTCHA / bot-check guard
  if (results.length === 0 && /captcha|unusual traffic|automated queries/i.test(document.body.innerText)) {
    return "# Google Scholar (blocked)\\n\\nURL: " + location.href + "\\n\\n_Scholar returned a CAPTCHA / bot-check page. Try again later or solve it in the visible Chrome window._";
  }
  const lines = ["# Google Scholar: " + (q || "(no query)"), "", "URL: " + location.href, "", "## Results (" + results.length + ")", ""];
  if (results.length === 0) {
    lines.push("_No results found or extracted._");
    return lines.join("\\n");
  }
  let i = 0;
  for (const r of results) {
    i++;
    lines.push(i + ". **" + r.title + "**");
    if (r.meta) lines.push("   " + r.meta + (r.cited ? " - Cited by " + r.cited : ""));
    else if (r.cited) lines.push("   Cited by " + r.cited);
    if (r.snip) lines.push("   " + r.snip);
    const links = [];
    if (r.href) links.push("[Article](" + r.href + ")");
    if (r.pdf) links.push("[PDF](" + r.pdf + ")");
    if (links.length) lines.push("   " + links.join(" - "));
    lines.push("");
  }
  return lines.join("\\n");
})()`;

// URL classifiers
// Used by visitPage() to route URLs to the right specialized extractor.
// Specialized extractors produce far cleaner, more structured markdown than
// the generic block-walker. The classifiers ensure each is only used on the
// URL shape it was designed for.

export function isXUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") ||
      host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

export function isRedditPostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isReddit = host === "reddit.com" || host.endsWith(".reddit.com");
    // Only post/comment pages - listings and user pages use the generic extractor.
    return isReddit && u.pathname.includes("/comments/");
  } catch {
    return false;
  }
}

export function isAmazonProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\./.test(u.hostname.toLowerCase())) return false;
    // /dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN
    return /\/(dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}/.test(u.pathname);
  } catch {
    return false;
  }
}

export function isAmazonSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\./.test(u.hostname.toLowerCase())) return false;
    // Amazon search: /s?k=... (also /s/ on some locales)
    return (u.pathname === "/s" || u.pathname.startsWith("/s/")) && u.searchParams.has("k");
  } catch {
    return false;
  }
}

export function isScholarSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // scholar.google.com (any TLD) - search and citation pages both use /scholar
    return host === "scholar.google.com" || host.endsWith(".scholar.google.com");
  } catch {
    return false;
  }
}

// Page-state probes: is this page a wall instead of content?
//
// A page can answer 200 and still not carry the content: Fastly's "Client
// Challenge" (pypi.org), Cloudflare's "Just a moment...", a reCAPTCHA gate
// (jbovlaste.lojban.org), a login form, or a JavaScript shell that still says
// "Loading...". These probes feed classifyWall(), which is a pure function so
// the rules stay testable without a browser.

export interface WallState {
  href: string;
  title: string;
  // Visible text length.
  len: number;
  // First 240 characters of visible text.
  head: string;
  captcha: boolean;
  // A password field that is actually laid out (a hidden login modal in a
  // page's header must not look like a login wall).
  password: boolean;
  scripts: number;
  // Number of <img> elements: an image-only page has no text but is content. *
  images: number;
}

export type WallKind = "challenge" | "captcha" | "login" | "shell";

// Title of bot-check interstitials, anchored: a real page titled "Access
// Denied: ..." must not look like a JavaScript challenge.
const WALL_TITLE_RE =
  /^(just a moment|client challenge|attention required|access denied|checking your browser|verifying your browser|please wait|请稍候|人机验证|安全验证|环境异常|アクセスが制限)/i;

// Body text that only appears on bot-check interstitials.
const WALL_BODY_RE =
  /client challenge|checking your browser|verifying your browser|checking if the site connection is secure|enable javascript and cookies|ddos protection|verify (?:you are|you're) (?:a )?human|are you a robot|human verification|请稍候|人机验证|安全验证|环境异常|しばらくお待ちください|アクセスが制限/i;

// "Still loading" placeholders of JavaScript app shells.
const WALL_LOADING_RE =
  /loading(\.\.\.|…)|please wait|読み込み中|読み込んでいます|加载中|正在加载|initiali[sz]ing(\.\.\.|…)|wird geladen/i;

// Login-wall wording.
const WALL_LOGIN_RE = /\b(log ?in|sign ?in|login|password|authenticate)\b|ログイン|パスワード|登录|密码|密碼/i;

// Wording of a CAPTCHA gate. A page that merely embeds a Turnstile widget in
// its own form (nowsecure.nl, contact pages) does not say any of this.
const WALL_CAPTCHA_TEXT_RE =
  /captcha|verify|verification|robot|human|security check|confirm you|log ?in|sign ?in|password|登录|验证|ログイン|認証/i;

// Decide whether a page state is a wall and which kind. Deliberately
// conservative: every rule needs a short page, so a long article that merely
// mentions "Access Denied" or embeds a reCAPTCHA in a sidebar stays content.
// `password` means a *laid-out* password field (the probe checks it), because
// plenty of pages carry a hidden login modal in their header.
export function classifyWall(state: WallState): WallKind | null {
  if (state.captcha && state.len < 800 && WALL_CAPTCHA_TEXT_RE.test(`${state.title} ${state.head}`)) {
    return "captcha";
  }
  if (state.len < 500 && (WALL_TITLE_RE.test(state.title.trim()) || WALL_BODY_RE.test(state.head))) {
    return "challenge";
  }
  if (state.len <= 240 && WALL_LOADING_RE.test(state.head)) return "shell";
  // No text at all and no images, but scripts: a shell that has not rendered.
  // An image-only page (a gallery) is content, not a shell.
  if (state.len < 40 && state.scripts > 0 && state.images === 0) return "shell";
  if (state.password && state.len < 800 && WALL_LOGIN_RE.test(state.head)) return "login";
  return null;
}

// One-shot page state probe used by classifyWall(). The `pi-wall` marker
// lets the unit-test fake recognise the probe.
export const WALL_PROBE_JS = `(() => {
  /* pi-wall */
  try {
    const body = document.body;
    const text = (body && body.innerText ? body.innerText : "").replace(/\\s+/g, " ").trim();
    const has = s => { try { return Boolean(document.querySelector(s)); } catch (e) { return false; } };
    const pw = document.querySelector("input[type=password]");
    const pwVisible = Boolean(pw && (pw.getClientRects().length > 0 || pw.offsetParent !== null));
    return JSON.stringify({
      href: location.href,
      title: (document.title || "").trim(),
      len: text.length,
      head: text.slice(0, 240),
      captcha: has(".g-recaptcha,[data-sitekey],.cf-turnstile,.h-captcha,iframe[src*='recaptcha'],iframe[src*='hcaptcha']"),
      password: pwVisible,
      scripts: document.scripts.length,
      images: document.images.length
    });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;

// Visible iframe/frame geometry, for locating a bot-check widget (Turnstile,
// reCAPTCHA, ...) that must be clicked. Only the light DOM is reachable from
// here - Cloudflare nests its iframe in a closed shadow root, which the DOM
// domain walk in findChallengeWidget() handles instead.
export const WIDGET_RECTS_JS = `(() => {
  /* pi-widget */
  const out = [];
  try {
    for (const f of document.querySelectorAll("iframe, frame")) {
      const r = f.getBoundingClientRect();
      const s = getComputedStyle(f);
      if (r.width < 20 || r.height < 10 || s.visibility === "hidden" || s.display === "none") continue;
      out.push({
        src: (f.getAttribute("src") || "") + " " + (f.getAttribute("title") || ""),
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height
      });
    }
  } catch (e) {
    // Return what was collected.
  }
  return JSON.stringify(out);
})()`;

// Read a URL that Chrome turned into a download. Runs on a page of the same
// origin (about:blank has an opaque origin, so fetch() from there is
// cross-origin and CORS-blocked). fetch() itself ignores
// `Content-Disposition: attachment` and returns the bytes, with the browser's
// cookies, TLS and proxy. Base64 bodies (Gitiles `?format=TEXT`, many APIs)
// are decoded when they are valid UTF-8 text.
export function downloadFetchJs(target: string): string {
  return `(async () => {
  /* pi-download */
  const cap = 400000;
  try {
    const r = await fetch(${JSON.stringify(target)});
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const total = bytes.length;
    const slice = bytes.subarray(0, cap);
    const text = new TextDecoder("utf-8").decode(slice);
    let bad = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
    }
    let decoded = "";
    const compact = text.replace(/\\s+/g, "");
    if (compact.length > 40 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      try {
        const bin = atob(compact);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(u8);
      } catch (e) {
        decoded = "";
      }
    }
    return JSON.stringify({ status: r.status, ct: r.headers.get("content-type") || "", total, truncated: total > cap, bad, text, decoded });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`;
}
