# Vendored third-party libraries

This directory contains prebuilt browser bundles of third-party MIT-licensed
software, used by the `clean` extraction mode of `visit_page`.

## defuddle-browser.js

A self-contained UMD bundle of [Defuddle](https://github.com/kepano/defuddle)
(MIT License, © 2025 Steph Ango / @kepano), which extracts the main article
content from a web page and converts it to clean Markdown - the same library
used by the [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper).

This slim build was produced from the defuddle source with the following
webpack-equivalent configuration:

- Entry: `src/index.full.ts` (exports `Defuddle` + `createMarkdownContent`).
- Math module: the *core* stub (`src/elements/math.core.ts`) instead of the
  *full* one. The full build bundles `temml` (~300 KB) and `mathml-to-latex`
  for server-side MathML->LaTeX conversion; the core stub keeps existing
  MathML/ LaTeX intact without those dependencies, which is sufficient for
  browser extraction (the browser already rendered the math).
- Turndown (MIT, © 2017 Dom Christie) is bundled in - it is the HTML->Markdown
  engine defuddle uses internally.
- `linkedom` (a server-side DOM polyfill) is not included - the bundle runs
  in a real Chrome page where the native DOM is available.

### How it was built

```bash
git clone --depth 1 https://github.com/kepano/defuddle
cd defuddle
# math.core.ts is imported via webpack alias './elements/math'; create a stub
# so esbuild (which can't alias relative paths) can resolve it.
echo 'export * from "./math.core";' > src/elements/math.ts
npm install turndown --no-save
# CJS entry shim so esbuild's IIFE global IS the class (not a namespace),
# replicating webpack's `library.export: 'default'`.
cat > entry-browser.cjs <<'EOF'
const { default: Defuddle, createMarkdownContent } = require("./src/index.full");
Defuddle.createMarkdownContent = createMarkdownContent;
module.exports = Defuddle;
EOF
npx esbuild entry-browser.cjs \
  --bundle --format=iife --global-name=Defuddle --minify \
  --outfile=defuddle-browser.js
```

The resulting `~500 KB` file exposes `window.Defuddle` (the constructor, with
`createMarkdownContent` attached as a static property) and is injected into the
page via a single `Runtime.evaluate` CDP call before the extraction driver runs.

### License

Both Defuddle and Turndown are MIT-licensed. Their license terms are compatible
with this package's MIT license. See:
- https://github.com/kepano/defuddle/blob/main/LICENSE
- https://github.com/mixmark-io/turndown/blob/master/LICENSE
