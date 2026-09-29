import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_CONSENT_JS,
  GOOGLE_SEARCH_JS,
  EXTRACT_PAGE_JS,
  X_EXTRACT_JS,
  REDDIT_EXTRACT_JS,
  AMAZON_PRODUCT_JS,
  AMAZON_SEARCH_JS,
  SCHOLAR_EXTRACT_JS,
  DEFUDDLE_DRIVER_JS,
} from "../../src/extractors.ts";

// Every extractor is a JS string built from a TypeScript template literal.
// If the escaping is wrong (e.g. a single \n becomes a real newline inside a
// "..." string literal), the page throws a SyntaxError when CDP evaluates it.
// This test catches that without a browser: new Function(js) parses but does
// not execute, so missing `document` / `window` refs are fine - only syntax
// errors fail.

const extractors: Record<string, string> = {
  GOOGLE_CONSENT_JS,
  GOOGLE_SEARCH_JS,
  EXTRACT_PAGE_JS,
  X_EXTRACT_JS,
  REDDIT_EXTRACT_JS,
  AMAZON_PRODUCT_JS,
  AMAZON_SEARCH_JS,
  SCHOLAR_EXTRACT_JS,
  DEFUDDLE_DRIVER_JS,
};

for (const [name, js] of Object.entries(extractors)) {
  test(`${name} is valid JavaScript (no template-literal escaping errors)`, () => {
    assert.doesNotThrow(
      () => new Function(js),
      `${name} failed to parse - check \\n / \\" escaping in the template literal`,
    );
  });
}

test("every extractor is non-empty", () => {
  for (const [name, js] of Object.entries(extractors)) {
    assert.ok(js.length > 50, `${name} is suspiciously short (${js.length} chars)`);
  }
});
