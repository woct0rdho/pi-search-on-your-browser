/**
 * JavaScript extractors + URL classifiers for visit_page / google_search.
 *
 * Each extractor is a self-contained JS string (run via CDP
 * `Runtime.evaluate` in the page's main execution context). They're kept as
 * strings — not real TypeScript — because they execute in the browser, not
 * Node, and can't be type-checked or linted here. The tests in
 * `tests/unit/extractors-parse.test.ts` validate they at least parse as valid
 * JavaScript via `new Function()`.
 *
 * Split from `chrome.ts` so the CDP plumbing (which changes rarely) is
 * isolated from the site-specific extractors (which change whenever a site
 * redesigns its DOM). This module has zero dependency on the CDP layer —
 * it's pure data + pure functions.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Google consent + search ───────────────────────────────────────────────

// Backtick constant for building JS strings that contain backticks
const BT = "`";

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
// browser (HTTP 302 Location) by src/google-links.ts — never dropped.
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

// ── Generic page extractor (fallback / default) ───────────────────────────

export const EXTRACT_PAGE_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  'const esc=s=>clean(s).replace(/\\\\/g,"\\\\\\\\").replace(/\\[/g,"\\\\[").replace(/\\]/g,"\\\\]").replace(/\\n/g," ");' +
  'const visible=el=>{const r=el.getBoundingClientRect();const st=getComputedStyle(el);return r.width>0&&r.height>0&&st.display!=="none"&&st.visibility!=="hidden"&&st.opacity!=="0";};' +
  "const inline=n=>{if(!n)return'';if(n.nodeType===3)return n.nodeValue;if(n.nodeType!==1)return'';const el=n;" +
  'if(el.tagName==="SCRIPT"||el.tagName==="STYLE"||el.tagName==="NOSCRIPT")return"";' +
  'if(el.tagName==="A"){const t=esc(el.innerText||el.textContent);const h=el.href||"";return t&&h?"["+t+"]("+h+")":t;}' +
  'if(el.tagName==="CODE")return"' + BT + '"+clean(el.innerText||el.textContent).replace(/`/g,"\\\\\\\\' + BT + '")+"' + BT + '";' +
  "return[...el.childNodes].map(inline).join('');};" +
  'const lines=["# "+(clean(document.title)||location.href),"","URL: "+location.href,"","## Content"];' +
  'const blocks=[...document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th")];' +
  "const seen=new Set();" +
  "for(const el of blocks){" +
  'if(!visible(el))continue;let s="";const tag=el.tagName;' +
  'if(/^H[1-6]$/.test(tag)){s="#".repeat(Number(tag[1]))+" "+inline(el);}' +
  'else if(tag==="LI"){s="- "+inline(el);}' +
  'else if(tag==="PRE"){s="' + BT + BT + BT + '\\n"+(el.innerText||el.textContent||"").trimEnd()+"\\n' + BT + BT + BT + '";}' +
  'else if(tag==="BLOCKQUOTE"){s="> "+clean(el.innerText||el.textContent);}' +
  "else{s=inline(el);}" +
  "s=s.trim();if(!s||seen.has(s))continue;seen.add(s);" +
  'lines.push("",s);if(lines.join("\\n").length>90000){lines.push("","[Content truncated by browser extractor.]");break;}}' +
  'lines.push("","## Visible links");let n=0;const linkSeen=new Set();' +
  'for(const a of document.querySelectorAll("a[href]")){' +
  "if(!visible(a))continue;const t=esc(a.innerText||a.textContent);if(t.length<3)continue;" +
  "let u;try{u=new URL(a.href)}catch{continue;}" +
  "if(!/^https?:$/.test(u.protocol)||linkSeen.has(u.href))continue;linkSeen.add(u.href);" +
  'lines.push("- ["+t.slice(0,160)+"]("+u.href+")");if(++n>=80)break;}' +
  'return lines.join("\\n");' +
  "})()";

// ── Defuddle (clean article extraction) ─────────────────────────────────
// A vendored, self-contained UMD bundle of Defuddle (MIT, by Steph Ango /
// @kepano) — the same library the Obsidian Web Clipper uses. When injected
// into a page, it exposes `window.Defuddle`, which extracts the page's main
// article content (reader-mode style: drops nav, sidebars, ads, footers) and
// converts it to clean Markdown via the bundled Turndown engine.
//
// This is far cleaner than EXTRACT_PAGE_JS (the naive block-walker fallback)
// for articles, docs, and blog posts: no navigation noise, no "visible links"
// dump, no 90 KB truncation cliff — just the article content as Markdown.
//
// See src/vendor/README.md for build provenance and license attribution.
const DEFUDDLE_BUNDLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "vendor",
  "defuddle-browser.js",
);
let defuddleBundleCache: string | null = null;
export function getDefuddleBundle(): string {
  if (defuddleBundleCache === null) {
    defuddleBundleCache = readFileSync(DEFUDDLE_BUNDLE_PATH, "utf8");
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
    if (meta.length) { lines.push(""); lines.push(meta.join(" · ")); }
    lines.push("");
    lines.push(content);
    return lines.join("\\n");
  } catch (e) {
    return "__DEFUDDLE_ERROR__: " + (e && e.message || String(e));
  }
})()`;

// ── X (Twitter) extractor ────────────────────────────────────────────────
// Search results, profiles, and individual tweets all render tweets as
// <article data-testid="tweet">. Written as a template literal for readability
// (no backticks needed inside), unlike the Google/generic extractors above.
//
// X virtualizes its timeline: only a window of tweets is mounted in the DOM at
// any time, and scrolling past evicts earlier ones. So this extractor is async
// and self-scrolling — it collects the currently-mounted tweets, scrolls to
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
      lines.push("_X returned an error (\\"Something went wrong. Try reloading.\\"). This is usually a transient rate-limit — wait a minute and retry, or open the URL in the visible Chrome window and reload._");
    } else if (/log in|iniciar sesi|connexion/i.test(bodyText)) {
      lines.push("_No tweets found — the page is showing a login wall. Log in to X in the visible Chrome window (profile at ~/.pi-search-browser/) and retry._");
    } else {
      lines.push("_No tweets found. The search may have yielded no results, or the page failed to render._");
    }
    return lines.join("\\n");
  }
  for (const t of tweets) {
    const link = t.permalink ? "https://x.com" + t.permalink : "";
    lines.push("### @" + t.handle + (t.name ? " — " + t.name : ""));
    const meta = [];
    if (t.time) meta.push(t.time);
    if (link) meta.push(link);
    if (meta.length) lines.push(meta.join(" · "));
    lines.push("");
    lines.push(t.text || "(no text)");
    lines.push("");
    const eng = [];
    if (t.reply) eng.push(t.reply);
    if (t.retweet) eng.push(t.retweet);
    if (t.like) eng.push(t.like);
    if (eng.length) lines.push("_" + eng.join(" · ") + "_");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\\n");
})()`;

// ── Reddit extractor ─────────────────────────────────────────────────────
// Post + comment pages render the post as <shreddit-post> and each comment as
// <shreddit-comment>, which carries author/depth/score/created as attributes.
// The generic extractor misses these (no <p>/<li> structure) and flattens
// comments into an unattributed wall of text. Reddit lazy-loads comments on
// scroll, so this is async + self-scrolling and dedupes by `thingid`, like the
// X extractor. Only post/comment pages (path has /comments/) are routed here;
// subreddit listings and user pages use the generic extractor.
export const REDDIT_EXTRACT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const cleanMulti = s => (s||"").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Post ──
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

  // ── Comments (incremental scroll, dedup by thingid) ──
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

  // ── Build markdown ──
  const lines = [];
  lines.push("# " + (title || "Reddit post"));
  lines.push("");
  lines.push("URL: " + location.href);
  const pm = [];
  if (subreddit) pm.push("r/" + subreddit);
  if (author) pm.push("u/" + author);
  if (postScore) pm.push(postScore + " points");
  if (pm.length) { lines.push(""); lines.push(pm.join(" · ")); }
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

// ── Amazon extractor ─────────────────────────────────────────────────────
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

  // Feature bullets — deduped (Amazon sometimes repeats them)
  const bset = new Set(); const bullets = [];
  for (const el of document.querySelectorAll("#feature-bullets ul li span.a-list-item")) {
    const t = clean(el.innerText); if (!t || bset.has(t)) continue; bset.add(t); bullets.push(t);
  }
  // Tech specs — prefer the table, fall back to detail bullets
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

  // Reviews are lazy-loaded near the bottom — best-effort scroll to find a few
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
    lines.push("- **" + (r.title || "(no title)") + (r.sponsored ? " [Sponsored]" : "") + "**" + (parts.length ? " — " + parts.join(" | ") : ""));
    lines.push("  " + r.url);
  }
  return lines.join("\\n");
})()`;

// ── Google Scholar extractor ──────────────────────────────────────────────
// Scholar search pages (scholar.google.com/scholar?q=...) render results as
// .gs_r blocks, each with .gs_ri (info) containing .gs_rt (title+link), .gs_a
// (authors/year/venue), .gs_rs (snippet), and .gs_fl (footer links: Cited by,
// Related, Versions). The generic extractor flattens these into H3 headers and
// loses the authors, snippets, citation counts, and PDF links — the data that
// matters for academic search. Scholar paginates (10 results/page) rather than
// infinite-scrolling, so this is synchronous like GOOGLE_SEARCH_JS (no async
// scroll loop). The dedicated Chrome profile carries any locale setting, so
// the citation footer text varies ("Cited by 1108" / "Cité 1108 fois" /
// "Citado por 1108" / "Zitiert von 1108") — matched with a locale-agnostic
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
    if (r.meta) lines.push("   " + r.meta + (r.cited ? " · Cited by " + r.cited : ""));
    else if (r.cited) lines.push("   Cited by " + r.cited);
    if (r.snip) lines.push("   " + r.snip);
    const links = [];
    if (r.href) links.push("[Article](" + r.href + ")");
    if (r.pdf) links.push("[PDF](" + r.pdf + ")");
    if (links.length) lines.push("   " + links.join(" · "));
    lines.push("");
  }
  return lines.join("\\n");
})()`;

// ── URL classifiers ───────────────────────────────────────────────────────
// Used by visitPage() to route URLs to the right specialized extractor.
// Specialized extractors produce far cleaner, more structured markdown than
// the generic block-walker; the classifiers ensure each is only used on the
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
    // Only post/comment pages — listings and user pages use the generic extractor.
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
    // scholar.google.com (any TLD) — search and citation pages both use /scholar
    return host === "scholar.google.com" || host.endsWith(".scholar.google.com");
  } catch {
    return false;
  }
}
