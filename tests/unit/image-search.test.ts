import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampImageCount,
  getGoogleImageSearchJs,
  GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT,
  GOOGLE_IMAGE_SEARCH_MAX_COUNT,
} from "../../src/extractors.ts";

// The Google Images extractor is generated per call because the result count is
// embedded in it. These tests cover the pure part (clamping) and the generated
// JS contract: it must parse, carry the count, and keep depending on the DOM
// landmarks the extraction relies on (data-lpage tiles, the preview image
// jsname, the cached-thumbnail fallback).

test("clampImageCount: defaults, clamps and floors", () => {
  assert.equal(clampImageCount(undefined), GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT);
  assert.equal(clampImageCount(null), GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT);
  assert.equal(clampImageCount("nonsense"), GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT);
  assert.equal(clampImageCount(NaN), GOOGLE_IMAGE_SEARCH_DEFAULT_COUNT);
  assert.equal(clampImageCount(0), 1);
  assert.equal(clampImageCount(-5), 1);
  assert.equal(clampImageCount(4), 4);
  assert.equal(clampImageCount(4.9), 4);
  assert.equal(clampImageCount(999), GOOGLE_IMAGE_SEARCH_MAX_COUNT);
  assert.equal(clampImageCount("6"), 6);
});

test("getGoogleImageSearchJs parses as valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(getGoogleImageSearchJs(8)), "generated extractor should parse");
});

test("getGoogleImageSearchJs embeds the count, clamped", () => {
  assert.ok(getGoogleImageSearchJs(3).includes("const MAX = 3;"), "should embed the requested count");
  assert.ok(
    getGoogleImageSearchJs(999).includes(`const MAX = ${GOOGLE_IMAGE_SEARCH_MAX_COUNT};`),
    "out-of-range counts should be clamped",
  );
  assert.ok(
    getGoogleImageSearchJs(0).includes("const MAX = 1;"),
    "counts below 1 should clamp to 1",
  );
});

test("the extractor keeps its DOM contract", () => {
  const js = getGoogleImageSearchJs(8);
  // Result tiles: source page URL + title + Google thumbnail.
  assert.ok(js.includes("[data-lpage]"), "modern tiles carry the source page in data-lpage");
  assert.ok(js.includes(".isv-r"), "older layout fallback");
  // Preview panel: the big image whose src swaps to the original.
  assert.ok(js.includes('img[jsname="kn3ccd"], img.sFlh5c'), "preview image selector");
  // Original-vs-cached distinction.
  assert.ok(js.includes("google-cached"), "cached thumbnails must be marked for the agent");
  assert.ok(js.includes("gstatic"), "cached-preview detection");
  // Both URLs must be emitted for every result.
  assert.ok(js.includes('"   image: "'), "image URL line");
  assert.ok(js.includes('"   page: "'), "source page URL line");
});

test("the extractor bounds its own runtime (stays under the CDP timeout)", () => {
  const js = getGoogleImageSearchJs(12);
  assert.ok(/deadline = Date\.now\(\) \+ \d+/.test(js), "should have a wall-clock deadline");
  assert.ok(js.includes("Date.now() < deadline"), "should stop clicking past the deadline");
});
