import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  mergeConfig,
  computeDelayMs,
  matchRetryable,
  shouldHandleProvider,
  buildAutoContinueText,
} from "../src/internal.js";

test("matchRetryable: matches HTTP/2 INTERNAL_ERROR received from peer", () => {
  const msg = "stream error: stream ID 705; INTERNAL_ERROR; received from peer";
  const label = matchRetryable(msg, DEFAULT_CONFIG);
  assert.equal(label, "HTTP/2 stream internal error");
});

test("matchRetryable: does not match AbortError/user aborts", () => {
  const msg = "AbortError: The operation was aborted";
  const label = matchRetryable(msg, DEFAULT_CONFIG);
  assert.equal(label, undefined);
});

test("computeDelayMs: exponential backoff capped", () => {
  assert.equal(computeDelayMs(1, DEFAULT_CONFIG), 2000);
  assert.equal(computeDelayMs(2, DEFAULT_CONFIG), 4000);
  assert.equal(computeDelayMs(3, DEFAULT_CONFIG), 8000);
  assert.equal(computeDelayMs(10, DEFAULT_CONFIG), 30000); // capped
});

test("normalizeConfig: clamps/normalizes inputs", () => {
  const cfg = normalizeConfig({
    enabled: "false",
    maxAttempts: "5",
    baseDelayMs: "100",
    maxDelayMs: 250,
    includeProviders: ["cli", "  ", 123],
    excludeProviders: ["openai"],
    marker: " [x] ",
    includeLastUserExcerpt: "true",
    lastUserExcerptChars: "-1", // should be ignored because < 0
    match: {
      strings: ["INTERNAL_ERROR; received from peer"],
      regexes: [{ pattern: "foo", flags: "i", label: "Foo" }],
    },
  });

  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxAttempts, 5);
  assert.equal(cfg.baseDelayMs, 100);
  assert.equal(cfg.maxDelayMs, 250);
  assert.deepEqual(cfg.includeProviders, ["cli"]);
  assert.deepEqual(cfg.excludeProviders, ["openai"]);
  assert.equal(cfg.marker, "[x]");
  assert.equal(cfg.includeLastUserExcerpt, true);
  assert.equal(cfg.lastUserExcerptChars, DEFAULT_CONFIG.lastUserExcerptChars);
  assert.deepEqual(cfg.match.strings, ["INTERNAL_ERROR; received from peer"]);
});

test("mergeConfig: provider override layers on top of base", () => {
  const base = normalizeConfig({ maxAttempts: 10, excludeProviders: ["a"] });
  const merged = mergeConfig(base, { maxAttempts: 3, excludeProviders: ["b"] });
  assert.equal(merged.maxAttempts, 3);
  assert.deepEqual(merged.excludeProviders, ["b"]);
});

test("shouldHandleProvider: respects include/exclude", () => {
  const cfg = normalizeConfig({ includeProviders: ["cli"], excludeProviders: ["cli"] });
  assert.equal(shouldHandleProvider("cli", cfg), false);

  const cfg2 = normalizeConfig({ includeProviders: ["cli"] });
  assert.equal(shouldHandleProvider("cli", cfg2), true);
  assert.equal(shouldHandleProvider("openai", cfg2), false);
});

test("buildAutoContinueText: includes marker and optional excerpt", () => {
  const text = buildAutoContinueText({
    marker: "[better-opencode-retries]",
    attempt: 1,
    maxAttempts: 20,
    label: "HTTP/2 stream internal error",
    lastUserText: "Hello world",
    includeLastUserExcerpt: true,
    lastUserExcerptChars: 400,
  });
  assert.ok(text.startsWith("[better-opencode-retries]"));
  assert.ok(text.includes("HTTP/2 stream internal error"));
  assert.ok(text.includes("Hello world"));
});

