## better-opencode-retries

An **OpenCode plugin** that makes “mid-stream” provider failures less painful.

When OpenCode gets a transient streaming/network error (for example:
`stream error: stream ID 705; INTERNAL_ERROR; received from peer`), OpenCode may stop the session.
This plugin automatically **sends a follow-up “continue from where you left off” prompt** with
exponential backoff, so your workflow keeps going without manual restarts.

### How it works

- Listens for `session.error` events.
- Detects retryable errors using a configurable matcher set (defaults include the common HTTP/2 `INTERNAL_ERROR; received from peer`).
- After a backoff, sends an automatic continuation prompt to the same session using the last known agent/model/variant.

### Install (local file plugin)

1) Clone this repo anywhere on your machine.

2) Add the plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // Update this path to wherever you cloned the repo:
    "file:///ABSOLUTE/PATH/to/better-opencode-retries/src/index.js"
  ]
}
```

Restart OpenCode to load it.

### Configuration

The easiest way to configure the plugin is to put config under **provider options** as
`betterOpencodeRetries`. The plugin reads it and then **strips it** so it won’t be forwarded to the AI SDK.

Example (only apply to your `cli` provider):

```jsonc
{
  "provider": {
    "cli": {
      "options": {
        "baseURL": "http://127.0.0.1:8317/v1",

        "betterOpencodeRetries": {
          "enabled": true,
          "includeProviders": ["cli"],
          "excludeProviders": [],

          "maxAttempts": 20,
          "baseDelayMs": 2000,
          "maxDelayMs": 30000,
          "resetAfterMs": 120000,

          "marker": "[better-opencode-retries]",
          "includeLastUserExcerpt": true,
          "lastUserExcerptChars": 400,

          "match": {
            "disableDefaults": false,

            // Additional substring matches (case-insensitive)
            "strings": [
              "INTERNAL_ERROR; received from peer"
            ],

            // Additional regexes (optional)
            "regexes": [
              { "pattern": "stream error: stream id\\\\s*\\\\d+", "flags": "i", "label": "HTTP/2 stream error" }
            ]
          },

          "debug": false
        }
      }
    }
  }
}
```

### Config via environment variable (optional)

You can also set a global JSON config using:

- `BETTER_OPENCODE_RETRIES_CONFIG` (or `BETTER_OPENCODE_RETRIES`)

Example:

```bash
export BETTER_OPENCODE_RETRIES_CONFIG='{"debug":true,"maxAttempts":50}'
opencode
```

Provider-specific config in `betterOpencodeRetries` will override global settings.

### Verify it loaded

Run:

```bash
opencode debug config --print-logs --log-level INFO
```

You should see a log line like:

- `service=plugin path=file:///.../better-opencode-retries/src/index.js loading plugin`
- `service=better-opencode-retries loaded ...`

### Development

Run tests:

```bash
npm test
```

### Notes / limitations

- This does **not** prevent upstream HTTP/2 resets or provider gateway interruptions.
  It only makes recovery automatic.
- Recovery is implemented by sending a new “continue” user message (prefixed with the configured `marker`).
  That message will be visible in the session history.

