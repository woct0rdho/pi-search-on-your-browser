import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_IMAGE_BYTES,
  readImageFile,
  resolveImagePath,
  sniffImageMime,
} from "../../src/chrome.ts";
import {
  getReverseImageSearchJs,
  isReverseImageMode,
  REVERSE_IMAGE_MODES,
  type ReverseImageMode,
} from "../../src/extractors.ts";

// A valid 1x1 PNG - enough for the signature check and a real upload fixture.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-revimg-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Path resolution (read-tool style)

test("resolveImagePath: absolute paths pass through, relative ones use cwd", () => {
  const abs = resolve(tmpdir(), "shot.png");
  assert.equal(resolveImagePath(abs), abs);
  assert.equal(resolveImagePath("shots/a.png"), resolve(process.cwd(), "shots/a.png"));
  assert.equal(resolveImagePath("  ./b.png  "), resolve(process.cwd(), "b.png"));
});

test("resolveImagePath: expands ~ to the home directory", () => {
  assert.equal(resolveImagePath("~"), homedir());
  assert.equal(resolveImagePath("~/pics/a.png"), join(homedir(), "pics/a.png"));
});

test("resolveImagePath: rejects an empty path", () => {
  assert.throws(() => resolveImagePath(""), /path is required/i);
  assert.throws(() => resolveImagePath("   "), /path is required/i);
});

// Format sniffing

test("sniffImageMime: recognizes the formats Google Lens accepts", () => {
  assert.equal(sniffImageMime(PNG_1X1), "image/png");
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("GIF89a....", "latin1")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("GIF87a....", "latin1")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("BM\x36\x00\x00\x00", "latin1")), "image/bmp");
});

test("sniffImageMime: rejects everything else", () => {
  assert.equal(sniffImageMime(Buffer.from("<!DOCTYPE html>", "latin1")), undefined);
  assert.equal(sniffImageMime(Buffer.from("plain text", "latin1")), undefined);
  assert.equal(sniffImageMime(Buffer.alloc(0)), undefined);
  assert.equal(sniffImageMime(Buffer.from("RIFF\x10\x00\x00\x00WAVEfmt ", "latin1")), undefined);
});

// File validation

test("readImageFile: returns absolute path, name, mime and size", () => {
  withTempDir((dir) => {
    const file = join(dir, "logo.png");
    writeFileSync(file, PNG_1X1);
    const image = readImageFile(file);
    assert.equal(image.path, file);
    assert.equal(image.name, "logo.png");
    assert.equal(image.mime, "image/png");
    assert.equal(image.size, PNG_1X1.length);
  });
});

test("readImageFile: resolves a relative path against the cwd", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "rel.png"), PNG_1X1);
    const image = readImageFile(join(dir, "rel.png"));
    assert.ok(image.path.endsWith("rel.png"));
  });
});

test("readImageFile: explains missing, empty, non-file and non-image inputs", () => {
  withTempDir((dir) => {
    assert.throws(() => readImageFile(join(dir, "nope.png")), /Image not found/i);

    const empty = join(dir, "empty.png");
    writeFileSync(empty, Buffer.alloc(0));
    assert.throws(() => readImageFile(empty), /empty/i);

    const text = join(dir, "notes.txt");
    writeFileSync(text, "hello");
    assert.throws(() => readImageFile(text), /Unsupported image format/i);

    assert.throws(() => readImageFile(dir), /Not a regular file|Image not found/i);
  });
});

test("MAX_IMAGE_BYTES matches Google Lens's 20 MB upload limit", () => {
  assert.equal(MAX_IMAGE_BYTES, 20 * 1024 * 1024);
});

// Modes

test("mode helpers accept exactly the two modes", () => {
  assert.deepEqual(REVERSE_IMAGE_MODES, ["exact", "visual"]);
  assert.ok(isReverseImageMode("exact"));
  assert.ok(isReverseImageMode("visual"));
  for (const bad of ["Exact", "all", "", undefined, null, 1]) {
    assert.equal(isReverseImageMode(bad), false);
  }
});

// Generated extractor

test("getReverseImageSearchJs parses for both modes and differs per mode", () => {
  for (const mode of REVERSE_IMAGE_MODES) {
    assert.doesNotThrow(() => new Function(getReverseImageSearchJs(mode)), `${mode} should parse`);
  }
  const exact = getReverseImageSearchJs("exact");
  const visual = getReverseImageSearchJs("visual");
  assert.ok(exact.includes("exact matches"));
  assert.ok(visual.includes("visual matches"));
  assert.notEqual(exact, visual);
});

test("the extractor keeps its DOM contract and caps the result count", () => {
  const js: string = getReverseImageSearchJs("exact" as ReverseImageMode);
  // Lens cards, ordinary web results (exact view), and the older image grid.
  assert.ok(js.includes("a.LBcIee"), "Lens card selector");
  assert.ok(js.includes('a[href*="/goto?url="]'), "result links are /goto redirects");
  assert.ok(js.includes("h3"), "web-result titles");
  assert.ok(js.includes("const LIMIT = 12"), "results should be capped");
  // Both URLs the agent needs: the page (markdown link) and the matched image.
  assert.ok(js.includes('lines.push("   image: "'), "image URL line");
  assert.ok(js.includes("](\" + r.page + \")\""), "page URL as a markdown link");
  // The page links stay absolute so the Google-redirect resolver can rewrite them.
  assert.ok(js.includes("new URL(u, location.href).href"), "links must be absolutized");
});

test("the extractor reports an empty page clearly", () => {
  const js = getReverseImageSearchJs("visual");
  assert.ok(js.includes("no results found"), "should explain an empty result set");
  assert.ok(js.includes("bot-check"), "should mention the bot-check possibility");
});
