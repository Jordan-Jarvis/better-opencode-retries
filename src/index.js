import {
  DEFAULT_CONFIG,
  mergeConfig,
  computeDelayMs,
  extractErrorMessage,
  matchRetryable,
  matchRetryableStructured,
  extractErrorInfo,
  shouldHandleProvider,
} from "./internal.js";

const PATCH_FLAG = Symbol.for("better-opencode-retries.plugin.loaded.v1");
const SERVICE = "better-opencode-retries";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * OpenCode plugin that auto-recovers from transient stream/network errors by
 * sending an automatic "continue" prompt after an exponential backoff.
 *
 * Configuration (recommended):
 * Put config under provider options key `betterOpencodeRetries` and the plugin
 * will read it and then *strip it* so it doesn't get forwarded to the AI SDK.
 *
 * Example:
 * {
 *   "provider": {
 *     "cli": {
 *       "options": {
 *         "baseURL": "http://127.0.0.1:8317/v1",
 *         "betterOpencodeRetries": { "maxAttempts": 20 }
 *       }
 *     }
 *   }
 * }
 */
export const BetterOpencodeRetries = async (ctx = {}) => {
  if (globalThis[PATCH_FLAG]) return {};
  globalThis[PATCH_FLAG] = true;

  const retryState = new Map(); // sessionID -> { attempts, lastAt, pending }
  const providerConfig = new Map(); // providerID -> config

  const log = async (level, message, extra = undefined) => {
    try {
      await ctx?.client?.app?.log?.({
        body: {
          service: SERVICE,
          level,
          message,
          extra,
        },
      });
    } catch {}
  };

  // Global defaults from env (optional).
  const envCfgRaw =
    process.env.BETTER_OPENCODE_RETRIES_CONFIG ??
    process.env.BETTER_OPENCODE_RETRIES ??
    process.env.BETTER_OPENCODE_RETRIES_OPENCODE_JSON; // legacy-ish alias
  const globalCfg = mergeConfig(DEFAULT_CONFIG, envCfgRaw ? safeJsonParse(envCfgRaw) : undefined);

  const getConfigForProvider = (providerId) => {
    const cfg = providerConfig.get(providerId) ?? globalCfg;
    return cfg;
  };

  const scheduleRetry = async ({ sessionID, providerID, label, message }) => {
    const cfg = getConfigForProvider(providerID);
    if (!shouldHandleProvider(providerID, cfg)) return;

    const now = Date.now();
    const prev = retryState.get(sessionID) ?? { attempts: 0, lastAt: 0, pending: false };

    // Reset attempts after a quiet period.
    if (now - prev.lastAt > cfg.resetAfterMs) prev.attempts = 0;

    // Don't stack multiple scheduled continues.
    if (prev.pending) return;

    const attempt = prev.attempts + 1;
    if (attempt > cfg.maxAttempts) {
      retryState.set(sessionID, { attempts: attempt, lastAt: now, pending: false });
      await log("error", "giving up on auto-retry (max attempts reached)", {
        sessionID,
        providerID,
        attempt,
        maxAttempts: cfg.maxAttempts,
        label,
        message,
      });
      return;
    }

    const delayMs = computeDelayMs(attempt, cfg);
    retryState.set(sessionID, { attempts: attempt, lastAt: now, pending: true });

    if (cfg.debug) {
      await log("warn", "scheduling auto-retry after error", {
        sessionID,
        providerID,
        attempt,
        delayMs,
        label,
      });
    }

    setTimeout(() => {
      void (async () => {
        try {
          await ctx?.client?.session?.prompt?.({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: "." }],
            },
          });

          if (cfg.debug) {
            await log("info", "auto-retry prompt sent", { sessionID, providerID, attempt, label });
          }
        } catch (err) {
          await log("error", "auto-retry prompt failed", {
            sessionID,
            providerID,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          const cur = retryState.get(sessionID);
          if (cur) retryState.set(sessionID, { ...cur, pending: false });
        }
      })();
    }, delayMs);
  };

  await log("info", "loaded", {
    hasEnvConfig: Boolean(envCfgRaw),
    defaultMaxAttempts: globalCfg.maxAttempts,
  });

  return {
    // Capture provider-scoped config from OpenCode config object.
    config: async (opencodeConfig) => {
      try {
        providerConfig.clear();

        const providers = opencodeConfig?.provider ?? {};
        for (const [providerID, provider] of Object.entries(providers)) {
          const options = provider?.options;
          if (!options || typeof options !== "object") continue;

          const raw =
            // preferred
            options.betterOpencodeRetries ??
            // legacy/snake_case
            options.better_opencode_retries;

          if (raw === undefined) continue;

          // Merge global defaults + provider override, normalize/clamp.
          const merged = mergeConfig(globalCfg, raw);
          providerConfig.set(providerID, merged);

          // Strip config from provider options so it won't be forwarded to the AI SDK.
          try {
            delete options.betterOpencodeRetries;
            delete options.better_opencode_retries;
          } catch {}
        }

        if (globalCfg.debug) {
          await log("info", "config loaded", {
            providerOverrides: Array.from(providerConfig.keys()),
          });
        }
      } catch (e) {
        await log("warn", "failed to load plugin config", { error: String(e) });
      }
    },

    // React to transient stream/network errors and recover.
    event: async ({ event }) => {
      try {
        if (!event) return;

        // Prefer message.updated because assistant errors include providerID/modelID,
        // which lets us pick the correct provider config without relying on last-user state.
        if (event.type === "message.updated") {
          const info = event.properties?.info;
          const sessionID = info?.sessionID;
          if (!sessionID || !info) return;

          if (info.role === "assistant") {
            const errObj = info.error;
            const providerID = typeof info.providerID === "string" ? info.providerID : undefined;
            if (!errObj || !providerID) return;

            const msg = extractErrorMessage(errObj);
            const cfg = getConfigForProvider(providerID);
            if (!shouldHandleProvider(providerID, cfg)) return;

            const label = cfg.retryOnAnyError ? matchRetryableStructured(errObj, cfg) : matchRetryable(msg, cfg);
            if (!label) return;

            if (cfg.debug) {
              const e = extractErrorInfo(errObj);
              await log("warn", "detected retryable error (message.updated)", {
                sessionID,
                providerID,
                label,
                message: msg,
                error: e,
              });
            }

            await scheduleRetry({ sessionID, providerID, label, message: msg });
          }

          return;
        }

        // Keep behavior minimal: we only auto-retry when we can attribute the error
        // to an assistant message (which includes provider/model context).
        return;
      } catch {}
    },
  };
};

export default BetterOpencodeRetries;

