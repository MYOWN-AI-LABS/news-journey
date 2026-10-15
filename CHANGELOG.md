# Changelog

## 0.3.0-beta.7 (unreleased; tag after merge)

### Security
- Dependencies: `npm audit fix` (0 known vulnerabilities, down from 1 critical, 4 high and 3 moderate); `@modelcontextprotocol/sdk` raised to ^1.32.1.
- Diagram SVG is sanitized with DOMPurify before rendering (`src/pipeline/sanitize-svg.ts`, with tests).
- The live dashboard escapes every interpolated value.
- `site/vercel.json` sends security headers: HSTS, nosniff, SAMEORIGIN framing, Referrer-Policy, Permissions-Policy and CSP.

### Model providers and failover
- Claude CLI: the generic 300 s default is raised to 900 s, matching Grok and Antigravity. An explicit value or `AI_CONTENT_MODEL_TIMEOUT_SECONDS` still wins.
- Local role router (Ollama/OpenCode): tasks can only narrow the parent's deadline and physical-attempt allowance, never extend them.
- Prepared role and vision dispatch tag each model call with its package and stage, which stay correct across retries, rescue and concurrent tasks. The tags are written only to the local `model-calls.jsonl` ledger and never sent in prompts.

### Reliability
- An interrupted subprocess (SIGTERM, SIGINT or SIGKILL, or a media timeout) is recognised as an interruption, not a content failure, and the user sees "stopped unexpectedly. Your completed work is saved." Full stderr goes to the log.
