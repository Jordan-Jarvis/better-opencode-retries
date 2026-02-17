/**
 * Internal helpers for better-opencode-retries.
 *
 * NOTE: Do not export non-plugin values from `src/index.js` because OpenCode's
 * plugin loader will try to invoke every export as a plugin function.
 */

const DEFAULT_RETRYABLE_PATTERNS = [
  // Common HTTP/2 reset coming from the peer (often reported by Rust h2/hyper)
  {
    re: /stream error:\s*stream id\s*\d+\s*;\s*internal_error\s*;\s*received from peer/i,
    label: "HTTP/2 stream internal error",
  },
  { re: /\b(ERR_HTTP2_STREAM_ERROR|ERR_HTTP2_SESSION_ERROR)\b/i, label: "HTTP/2 stream error" },
  { re: /\bNGHTTP2_(INTERNAL_ERROR|REFUSED_STREAM|CANCEL)\b/i, label: "HTTP/2 stream reset" },

  // Undici / fetch / socket-ish messages
  { re: /\bUND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)\b/i, label: "Network/stream error" },
  { re: /\bECONNRESET\b/i, label: "Connection reset" },
  { re: /connection reset by peer/i, label: "Connection reset by peer" },
  { re: /\bECONNREFUSED\b/i, label: "Connection refused" },
  { re: /\bEPIPE\b/i, label: "Broken pipe" },
  { re: /\bETIMEDOUT\b/i, label: "Timed out" },
  { re: /\bENOTFOUND\b|\bEAI_AGAIN\b/i, label: "DNS lookup failed" },
  { re: /socket hang up/i, label: "Socket hang up" },
  { re: /premature close/i, label: "Stream closed prematurely" },
  { re: /unexpected (end|eof)|ERR_STREAM_PREMATURE_CLOSE/i, label: "Unexpected end of stream" },
  { re: /\bfetch failed\b/i, label: "Fetch failed" },
  { re: /\bnetwork error\b/i, label: "Network error" },
  { re: /stream (interrupted|aborted|closed)/i, label: "Stream interrupted" },
  { re: /\bterminated\b/i, label: "Connection terminated" },
];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,

  /**
   * Only auto-retry for these provider IDs. If empty/undefined, all providers are allowed.
   * Example: ["cli"]
   */
  includeProviders: undefined,

  /**
   * Never auto-retry for these provider IDs.
   */
  excludeProviders: [],

  /**
   * Maximum number of auto-continue attempts per session before giving up.
   */
  maxAttempts: 20,

  /**
   * Base delay in ms for exponential backoff.
   */
  baseDelayMs: 2000,

  /**
   * Maximum delay in ms for exponential backoff.
   */
  maxDelayMs: 30000,

  /**
   * Reset attempt counter after quiet period (ms).
   */
  resetAfterMs: 2 * 60 * 1000,

  /**
   * Prefix marker used for auto-retry messages (also used to ignore our own prompts).
   */
  marker: "[better-opencode-retries]",

  /**
   * Include an excerpt of the last *real* user prompt in the auto-continue prompt.
   */
  includeLastUserExcerpt: true,

  /**
   * Max characters of last user prompt excerpt.
   */
  lastUserExcerptChars: 400,

  /**
   * Match configuration.
   */
  match: {
    /**
     * If true, default retryable matchers are disabled (only custom matchers apply).
     */
    disableDefaults: false,

    /**
     * Additional case-insensitive substring matches.
     * Example: ["INTERNAL_ERROR; received from peer"]
     */
    strings: [],

    /**
     * Additional regex patterns. Each entry can be:
     * - a string pattern (compiled with "i" flag), or
     * - { pattern: string, flags?: string, label?: string }
     */
    regexes: [],
  },

  /**
   * Log extra details to opencode logs.
   */
  debug: false,
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  return out;
}

/**
 * Parse/normalize raw user config. Unknown keys are ignored.
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const cfg = {
    ...DEFAULT_CONFIG,
    excludeProviders: [...DEFAULT_CONFIG.excludeProviders],
    match: {
      ...DEFAULT_CONFIG.match,
      strings: [...DEFAULT_CONFIG.match.strings],
      regexes: [...DEFAULT_CONFIG.match.regexes],
    },
  };

  if (!isPlainObject(raw)) return cfg;

  const enabled = toBool(raw.enabled);
  if (enabled !== undefined) cfg.enabled = enabled;

  const includeProviders = toStringArray(raw.includeProviders);
  if (includeProviders !== undefined) cfg.includeProviders = includeProviders.length ? includeProviders : undefined;

  const excludeProviders = toStringArray(raw.excludeProviders);
  if (excludeProviders !== undefined) cfg.excludeProviders = excludeProviders;

  const maxAttempts = toInt(raw.maxAttempts);
  if (maxAttempts !== undefined && maxAttempts >= 0) cfg.maxAttempts = maxAttempts;

  const baseDelayMs = toInt(raw.baseDelayMs);
  if (baseDelayMs !== undefined && baseDelayMs > 0) cfg.baseDelayMs = baseDelayMs;

  const maxDelayMs = toInt(raw.maxDelayMs);
  if (maxDelayMs !== undefined && maxDelayMs > 0) cfg.maxDelayMs = maxDelayMs;

  const resetAfterMs = toInt(raw.resetAfterMs);
  if (resetAfterMs !== undefined && resetAfterMs >= 0) cfg.resetAfterMs = resetAfterMs;

  if (typeof raw.marker === "string" && raw.marker.trim()) cfg.marker = raw.marker.trim();

  const includeLastUserExcerpt = toBool(raw.includeLastUserExcerpt);
  if (includeLastUserExcerpt !== undefined) cfg.includeLastUserExcerpt = includeLastUserExcerpt;

  const lastUserExcerptChars = toInt(raw.lastUserExcerptChars);
  if (lastUserExcerptChars !== undefined && lastUserExcerptChars >= 0) cfg.lastUserExcerptChars = lastUserExcerptChars;

  const debug = toBool(raw.debug);
  if (debug !== undefined) cfg.debug = debug;

  if (isPlainObject(raw.match)) {
    const disableDefaults = toBool(raw.match.disableDefaults);
    if (disableDefaults !== undefined) cfg.match.disableDefaults = disableDefaults;

    const strings = toStringArray(raw.match.strings);
    if (strings !== undefined) cfg.match.strings = strings;

    if (Array.isArray(raw.match.regexes)) {
      cfg.match.regexes = raw.match.regexes
        .map((entry) => {
          if (typeof entry === "string" && entry.trim()) return entry.trim();
          if (isPlainObject(entry) && typeof entry.pattern === "string" && entry.pattern.trim()) {
            return {
              pattern: entry.pattern.trim(),
              flags: typeof entry.flags === "string" ? entry.flags : undefined,
              label: typeof entry.label === "string" ? entry.label : undefined,
            };
          }
          return undefined;
        })
        .filter(Boolean);
    }
  }

  return cfg;
}

export function mergeConfig(base, override) {
  // Normalize both, then layer override on top by re-normalizing merged object.
  // This keeps validation/clamping logic in one place.
  const b = normalizeConfig(base);
  if (!override) return b;
  return normalizeConfig({
    ...b,
    ...override,
    match: {
      ...b.match,
      ...(isPlainObject(override.match) ? override.match : {}),
    },
  });
}

export function computeDelayMs(attempt, cfg) {
  const n = typeof attempt === "number" && attempt > 0 ? attempt : 1;
  const base = cfg?.baseDelayMs ?? DEFAULT_CONFIG.baseDelayMs;
  const max = cfg?.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs;
  const exp = base * 2 ** (n - 1);
  return Math.min(exp, max);
}

export function extractErrorMessage(err) {
  // err is typically a NamedError object: { name, data: { message }, ... }
  if (!err) return "";
  const dataMsg = typeof err?.data?.message === "string" ? err.data.message : "";
  if (dataMsg) return dataMsg;
  const msg = typeof err?.message === "string" ? err.message : "";
  if (msg) return msg;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function looksUserAborted(msg) {
  const s = String(msg ?? "").toLowerCase();
  return s.includes("aborterror") || (s.includes("aborted") && !s.includes("provider"));
}

export function compileMatchers(cfg) {
  const match = cfg?.match ?? DEFAULT_CONFIG.match;
  const matchers = [];

  const patterns = match.disableDefaults ? [] : DEFAULT_RETRYABLE_PATTERNS;
  for (const p of patterns) {
    matchers.push({ type: "regex", re: p.re, label: p.label });
  }

  for (const needle of match.strings ?? []) {
    const n = String(needle).trim();
    if (!n) continue;
    matchers.push({ type: "substring", needleLower: n.toLowerCase(), label: `Matched "${n}"` });
  }

  for (const entry of match.regexes ?? []) {
    try {
      if (typeof entry === "string") {
        matchers.push({ type: "regex", re: new RegExp(entry, "i"), label: `Matched /${entry}/i` });
        continue;
      }
      if (isPlainObject(entry) && typeof entry.pattern === "string") {
        const flags = typeof entry.flags === "string" && entry.flags.length ? entry.flags : "i";
        const re = new RegExp(entry.pattern, flags);
        matchers.push({ type: "regex", re, label: entry.label || `Matched /${entry.pattern}/${flags}` });
      }
    } catch {
      // ignore invalid regex
    }
  }

  return matchers;
}

export function matchRetryable(message, cfg) {
  const msg = String(message ?? "");
  if (!msg) return undefined;
  if (looksUserAborted(msg)) return undefined;

  const matchers = compileMatchers(cfg);
  const lower = msg.toLowerCase();

  for (const m of matchers) {
    if (m.type === "substring") {
      if (lower.includes(m.needleLower)) return m.label;
      continue;
    }
    if (m.type === "regex") {
      if (m.re.test(msg)) return m.label;
    }
  }

  return undefined;
}

export function shouldHandleProvider(providerId, cfg) {
  if (!cfg?.enabled) return false;
  const id = String(providerId ?? "");
  if (!id) return false;

  const exclude = cfg.excludeProviders ?? [];
  if (exclude.includes(id)) return false;

  const include = cfg.includeProviders;
  if (Array.isArray(include) && include.length > 0) {
    return include.includes(id);
  }

  return true;
}

export function buildAutoContinueText(input) {
  const {
    marker,
    attempt,
    maxAttempts,
    label,
    lastUserText,
    includeLastUserExcerpt,
    lastUserExcerptChars,
  } = input;

  const excerpt =
    includeLastUserExcerpt && lastUserText
      ? lastUserText.slice(0, Math.max(0, lastUserExcerptChars ?? 0))
      : "";

  return [
    `${marker} [auto-retry ${attempt}/${maxAttempts}] The previous response was interrupted by a transient error (${label}).`,
    "Continue from where you left off.",
    "Do not repeat content that was already sent; resume at the next token.",
    excerpt ? `\nContext (last user prompt excerpt):\n${excerpt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

