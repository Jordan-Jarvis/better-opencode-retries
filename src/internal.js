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
   * If true, auto-retry on *any* session.error for handled providers,
   * using structured error fields (status/code/name) to skip obvious
   * non-transient failures.
   *
   * This avoids relying on message regexes, at the cost of potentially
   * retrying more than you want if your exclusions are too permissive.
   */
  retryOnAnyError: false,

  /**
   * When retryOnAnyError=true, do NOT auto-retry if an HTTP-like status code
   * is found and is in this list.
   *
   * Defaults are tuned to avoid infinite loops on auth/invalid-request errors.
   */
  excludeHttpStatus: [400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 412, 413, 414, 415, 416],

  /**
   * When retryOnAnyError=true, do NOT auto-retry if an error code matches one of these
   * strings (case-insensitive). Useful for provider-specific permanent failures.
   */
  excludeErrorCodes: [],

  /**
   * When retryOnAnyError=true, do NOT auto-retry if err.name matches one of these
   * strings (case-insensitive).
   */
  excludeErrorNames: [],

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

function toNumberArray(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const v of value) {
    const n = toInt(v);
    if (n !== undefined) out.push(n);
  }
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
    excludeHttpStatus: [...DEFAULT_CONFIG.excludeHttpStatus],
    excludeErrorCodes: [...DEFAULT_CONFIG.excludeErrorCodes],
    excludeErrorNames: [...DEFAULT_CONFIG.excludeErrorNames],
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

  const debug = toBool(raw.debug);
  if (debug !== undefined) cfg.debug = debug;

  const retryOnAnyError = toBool(raw.retryOnAnyError);
  if (retryOnAnyError !== undefined) cfg.retryOnAnyError = retryOnAnyError;

  const excludeHttpStatus = toNumberArray(raw.excludeHttpStatus);
  if (excludeHttpStatus !== undefined) cfg.excludeHttpStatus = excludeHttpStatus;

  const excludeErrorCodes = toStringArray(raw.excludeErrorCodes);
  if (excludeErrorCodes !== undefined) cfg.excludeErrorCodes = excludeErrorCodes;

  const excludeErrorNames = toStringArray(raw.excludeErrorNames);
  if (excludeErrorNames !== undefined) cfg.excludeErrorNames = excludeErrorNames;

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

function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function firstInt(...values) {
  for (const v of values) {
    const n = toInt(v);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * Best-effort extraction of structured error fields.
 * The shape varies depending on which layer threw it (provider SDK / fetch / OpenCode).
 */
export function extractErrorInfo(err) {
  const message = extractErrorMessage(err);
  const name = firstString(err?.name, err?.data?.name, err?.data?.error?.name);
  const code = firstString(
    err?.code,
    err?.data?.code,
    err?.data?.error?.code,
    err?.cause?.code,
    err?.cause?.data?.code
  );
  const status = firstInt(
    err?.status,
    err?.statusCode,
    err?.data?.status,
    err?.data?.statusCode,
    err?.data?.error?.status,
    err?.data?.error?.statusCode,
    err?.cause?.status,
    err?.cause?.statusCode
  );
  const type = firstString(err?.type, err?.data?.type, err?.data?.error?.type);
  return { message, name, code, status, type, raw: err };
}

export function looksUserAborted(msg) {
  const s = String(msg ?? "").toLowerCase();
  return s.includes("aborterror") || (s.includes("aborted") && !s.includes("provider"));
}

function includesOneOfCaseInsensitive(value, needles) {
  if (!value) return false;
  const v = String(value).toLowerCase();
  for (const n of needles ?? []) {
    const s = String(n).trim().toLowerCase();
    if (!s) continue;
    if (v === s) return true;
  }
  return false;
}

/**
 * Structured (non-regex) retry decision.
 * Returns a label string if retryable, otherwise undefined.
 */
export function matchRetryableStructured(err, cfg) {
  const info = extractErrorInfo(err);
  const msg = info.message;
  if (!msg) return undefined;
  if (looksUserAborted(msg) || includesOneOfCaseInsensitive(info.name, ["AbortError"])) return undefined;

  // Skip explicitly excluded name/code.
  if (includesOneOfCaseInsensitive(info.code, cfg?.excludeErrorCodes)) return undefined;
  if (includesOneOfCaseInsensitive(info.name, cfg?.excludeErrorNames)) return undefined;

  // Skip excluded HTTP-like status codes (when present).
  const status = info.status;
  if (typeof status === "number" && Number.isFinite(status)) {
    const excluded = Array.isArray(cfg?.excludeHttpStatus) ? cfg.excludeHttpStatus : DEFAULT_CONFIG.excludeHttpStatus;
    if (excluded.includes(status)) return undefined;
    return `HTTP status ${status}`;
  }

  // If we have a string error code, classify it.
  if (info.code) return `Error code ${info.code}`;

  // Fall back to "Any error" (still non-regex; uses the fact that a session.error happened).
  return "Any error";
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

