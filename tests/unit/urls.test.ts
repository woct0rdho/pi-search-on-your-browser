import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isXUrl,
  isRedditPostUrl,
  isAmazonProductUrl,
  isAmazonSearchUrl,
  isScholarSearchUrl,
} from "../../src/extractors.ts";

// isXUrl

test("isXUrl: matches x.com and twitter.com with any path", () => {
  for (const url of [
    "https://x.com/search?q=boletus&f=live",
    "https://x.com/xezpeleta",
    "https://x.com/xezpeleta/status/123456",
    "https://twitter.com/search?q=test",
    "https://twitter.com/elonmusk",
    "https://mobile.twitter.com/user", // subdomain
  ]) {
    assert.equal(isXUrl(url), true, `expected true: ${url}`);
  }
});

test("isXUrl: rejects non-X hosts and look-alike domains", () => {
  for (const url of [
    "https://google.com/search?q=x.com",
    "https://x.com.evil.com/", // not a real x.com subdomain
    "https://notx.com/",
    "https://twitter.com.evil.com/",
    "https://example.com/",
    "not a url",
    "",
  ]) {
    assert.equal(isXUrl(url), false, `expected false: ${url}`);
  }
});

// isRedditPostUrl

test("isRedditPostUrl: matches post/comment pages (path contains /comments/)", () => {
  for (const url of [
    "https://reddit.com/r/foo/comments/abc123/title_here/",
    "https://www.reddit.com/r/foo/comments/abc123/",
    "https://old.reddit.com/r/x/comments/123456/some_title/",
    "https://reddit.com/r/foo/comments/abc123/title/?context=3",
  ]) {
    assert.equal(isRedditPostUrl(url), true, `expected true: ${url}`);
  }
});

test("isRedditPostUrl: rejects listings, user pages, and non-reddit", () => {
  for (const url of [
    "https://reddit.com/r/foo/", // listing
    "https://reddit.com/user/spez", // user page
    "https://www.reddit.com/r/foo", // no trailing slash, listing
    "https://reddit.com/", // home
    "https://notreddit.com/r/foo/comments/abc/", // wrong host
    "https://example.com/",
    "",
  ]) {
    assert.equal(isRedditPostUrl(url), false, `expected false: ${url}`);
  }
});

// isAmazonProductUrl

test("isAmazonProductUrl: matches /dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN across TLDs", () => {
  for (const url of [
    "https://www.amazon.com/dp/B0CHX1W1XY",
    "https://www.amazon.es/dp/B0CHX1W1XY",
    "https://amazon.co.uk/dp/B0CHX1W1XY",
    "https://www.amazon.de/gp/product/B0CHX1W1XY",
    "https://www.amazon.com/gp/aw/d/B0CHX1W1XY",
    "https://www.amazon.com/dp/B0CHX1W1XY/ref=sr_1_1", // with ref suffix
  ]) {
    assert.equal(isAmazonProductUrl(url), true, `expected true: ${url}`);
  }
});

test("isAmazonProductUrl: rejects search URLs, non-amazon, and malformed ASINs", () => {
  for (const url of [
    "https://www.amazon.com/s?k=boletus", // search, not product
    "https://www.amazon.com/", // home
    "https://example.com/dp/B0CHX1W1XY", // not amazon
    "https://www.amazon.com/dp/b0chx1w1xy", // lowercase ASIN (ASINs are uppercase)
    "https://www.amazon.com/dp/SHORT", // too short (< 10 chars)
    "",
  ]) {
    assert.equal(isAmazonProductUrl(url), false, `expected false: ${url}`);
  }
});

// isAmazonSearchUrl

test("isAmazonSearchUrl: matches /s?k=... across TLDs", () => {
  for (const url of [
    "https://www.amazon.com/s?k=boletus",
    "https://www.amazon.es/s?k=setas",
    "https://amazon.co.uk/s?k=mushroom",
    "https://www.amazon.com/s/?k=test", // trailing slash variant
    "https://www.amazon.com/s?k=boletus&ref=nb_sb_noss", // with extra params
  ]) {
    assert.equal(isAmazonSearchUrl(url), true, `expected true: ${url}`);
  }
});

test("isAmazonSearchUrl: rejects product URLs, missing k param, non-amazon", () => {
  for (const url of [
    "https://www.amazon.com/dp/B0CHX1W1XY", // product, not search
    "https://www.amazon.com/s", // no k param
    "https://www.amazon.com/?k=test", // k on wrong path
    "https://example.com/s?k=test", // not amazon
    "",
  ]) {
    assert.equal(isAmazonSearchUrl(url), false, `expected false: ${url}`);
  }
});

// isScholarSearchUrl

test("isScholarSearchUrl: matches scholar.google.com with any path", () => {
  for (const url of [
    "https://scholar.google.com/scholar?q=transformers",
    "https://scholar.google.com/citations?user=abc123",
    "https://scholar.google.com/scholar?q=test&start=10",
    "https://scholar.google.com/", // bare host
  ]) {
    assert.equal(isScholarSearchUrl(url), true, `expected true: ${url}`);
  }
});

test("isScholarSearchUrl: rejects regular Google and non-google", () => {
  for (const url of [
    "https://google.com/search?q=scholar",
    "https://www.google.com/scholar?q=test", // google.com, not scholar.google.com
    "https://example.com/",
    "",
  ]) {
    assert.equal(isScholarSearchUrl(url), false, `expected false: ${url}`);
  }
});
