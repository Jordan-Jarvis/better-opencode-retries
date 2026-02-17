import {
  DEFAULT_CONFIG,
  normalizeConfig,
  mergeConfig,
  computeDelayMs,
  extractErrorMessage,
  matchRetryable,
  shouldHandleProvider,
  buildAutoContinueText,
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

  const lastUser = new Map(); // sessionID -> { agent, model, variant, text }
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

  const getMarkersForProvider = (providerId) => {
    const cfg = providerId ? getConfigForProvider(providerId) : globalCfg;
    const markers = new Set([
      DEFAULT_CONFIG.marker,
      globalCfg.marker,
      cfg?.marker,
      // Back-compat with earlier prototype plugin marker
      "[auto-retry",
    ]);
    return Array.from(markers).filter((m) => typeof m === "string" && m.trim().length > 0);
  };

  const isAutoRetryPrompt = (text, providerId) => {
    if (!text) return false;
    const markers = getMarkersForProvider(providerId);
    return markers.some((m) => text.startsWith(m));
  };

  const getSessionMessages = async (sessionID, limit = 50) => {
    try {
      const res = await ctx?.client?.session?.messages?.({
        path: { id: sessionID },
        query: { limit },
      });
      const data = res && typeof res === "object" && "data" in res ? res.data : res;
      return Array.isArray(data) ? data : undefined;
    } catch {
      return undefined;
    }
  };

  const hydrateLastUserFromServer = async (sessionID) => {
    const messages = await getSessionMessages(sessionID, 50);
    if (!messages) return undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i];
      const info = item?.info;
      if (!info || info.role !== "user") continue;

      const providerId = info?.model?.providerID;
      const parts = Array.isArray(item?.parts) ? item.parts : [];
      const text = parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();

      // Don't let our own auto-retry prompts overwrite last-user state.
      if (isAutoRetryPrompt(text, providerId)) continue;

      const existing = lastUser.get(sessionID);
      lastUser.set(sessionID, {
        agent: info.agent ?? existing?.agent,
        model: info.model ?? existing?.model,
        variant: existing?.variant,
        text: text ?? existing?.text ?? "",
      });

      return lastUser.get(sessionID);
    }

    return undefined;
  };

  const scheduleContinue = async ({ sessionID, providerID, label, message }) => {
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
      await log("warn", "scheduling auto-continue after transient error", {
        sessionID,
        providerID,
        attempt,
        delayMs,
        label,
      });
    }

    const last = lastUser.get(sessionID);
    const marker = cfg.marker || DEFAULT_CONFIG.marker;

    setTimeout(() => {
      void (async () => {
        try {
          const promptText = buildAutoContinueText({
            marker,
            attempt,
            maxAttempts: cfg.maxAttempts,
            label,
            lastUserText: last?.text ?? "",
            includeLastUserExcerpt: cfg.includeLastUserExcerpt,
            lastUserExcerptChars: cfg.lastUserExcerptChars,
          });

          await ctx?.client?.session?.prompt?.({
            path: { id: sessionID },
            body: {
              agent: last?.agent,
              model: last?.model,
              variant: last?.variant,
              parts: [{ type: "text", text: promptText }],
            },
          });

          if (cfg.debug) {
            await log("info", "auto-continue sent", { sessionID, providerID, attempt, label });
          }
        } catch (err) {
          await log("error", "auto-continue failed", {
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

    // Track last user prompt context for better continuation prompts.
    "chat.message": async (input, output) => {
      try {
        if (!input?.sessionID) return;
        const info = output?.message;
        const providerId = info?.model?.providerID;

        const parts = Array.isArray(output?.parts) ? output.parts : [];
        const text = parts
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .trim();

        // Ignore our own auto-retry prompts.
        if (isAutoRetryPrompt(text, providerId)) return;

        lastUser.set(input.sessionID, {
          // Prefer the stored message info because it always includes a resolved model.
          agent: info?.agent ?? input.agent,
          model: info?.model ?? input.model,
          variant: input.variant,
          text: text ?? "",
        });
      } catch {}
    },

    // React to transient stream/network errors and recover.
    event: async ({ event }) => {
      try {
        if (!event || event.type !== "session.error") return;

        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        const msg = extractErrorMessage(event.properties?.error);
        if (!msg) return;

        // Best-effort providerID from last user message.
        let last = lastUser.get(sessionID);
        let providerID = last?.model?.providerID;

        // If we don't have last-user context (or it lacks model info), fetch it from the server.
        if (!providerID) {
          last = (await hydrateLastUserFromServer(sessionID)) ?? last;
          providerID = last?.model?.providerID;
        }
        if (!providerID) return;

        const cfg = getConfigForProvider(providerID);
        if (!shouldHandleProvider(providerID, cfg)) return;

        const label = matchRetryable(msg, cfg);
        if (!label) return;

        if (cfg.debug) {
          await log("warn", "detected retryable error", {
            sessionID,
            providerID,
            label,
            message: msg,
          });
        }

        await scheduleContinue({ sessionID, providerID, label, message: msg });
      } catch {}
    },
  };
};

export default BetterOpencodeRetries;

