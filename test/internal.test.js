import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  mergeConfig,
  computeDelayMs,
  matchRetryable,
  matchRetryableStructured,
  shouldHandleProvider,
} from "../src/internal.js";

test("matchRetryable: matches HTTP/2 INTERNAL_ERROR received from peer", () => {
  const msg = "stream error: stream ID 705; INTERNAL_ERROR; received from peer";
  const label = matchRetryable(msg, DEFAULT_CONFIG);
  assert.equal(label, "HTTP/2 stream internal error");
});

test("matchRetryable: matches connection reset by peer", () => {
  const msg = "read tcp 172.19.0.2:51808->104.18.32.47:443: read: connection reset by peer";
  const label = matchRetryable(msg, DEFAULT_CONFIG);
  assert.equal(label, "Connection reset by peer");
});

test("matchRetryableStructured: retries on any error when status not excluded", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { retryOnAnyError: true });
  const err = { name: "SomeError", data: { message: "bad gateway", status: 502 } };
  const label = matchRetryableStructured(err, cfg);
  assert.equal(label, "HTTP status 502");
});

test("matchRetryableStructured: does not retry excluded HTTP status", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { retryOnAnyError: true });
  const err = { name: "AuthError", data: { message: "unauthorized", status: 401 } };
  const label = matchRetryableStructured(err, cfg);
  assert.equal(label, undefined);
});

test("matchRetryableStructured: retries HTTP 422 by default", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { retryOnAnyError: true });
  const err = { name: "UnprocessableEntity", data: { message: "unprocessable", status: 422 } };
  const label = matchRetryableStructured(err, cfg);
  assert.equal(label, "HTTP status 422");
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

