# Local control, delivery and analytics

The local browser starts with a one-page use case, one agent dropdown and six setup steps. [Follow the simplified journey](simplified-journey.md); the same exact human review boundaries remain.

The executive browser app starts with `node start.mjs` and serves `/journey` on an available loopback port. It reuses this API and the `/control` review console. `GET /v1/journey` returns safe settings; `GET /v1/engagement` returns viewer responses. Named `POST /v1/journey/<operation>` actions run in a selected workspace worker and normally return HTTP 202 with a job ID. Poll `GET /v1/journey/jobs/<id>` with the initiating member token. Send a unique `Idempotency-Key` for each deliberate action; an identical repeat returns the existing job and a conflicting payload returns 409. Job records omit submitted form data and credentials. `member-add` returns its one-time token directly. Upload actions accept at most 8 MiB JSON (5 MiB image); other forms accept 32 KiB. See [journey contract](executive-onboarding.md) and [engagement actions](engagement.md).


Implemented 2026-09-07. The production engine stays a single publication. The distributable harness adds isolated workspaces, roles and editorial desks. Both expose the same local control and provider contracts.

## Run

```bash
npm run api:token -- --output /absolute/private/path/control.token
npm run api:serve -- --port 4791
# Open http://127.0.0.1:4791/control and use the credential from that private file.
npm run verify:posts -- --id 20260907-example
npm run metrics:weekly -- --days=7
```

Use a different port (for example 4792) when running the harness alongside production. Never put a bearer credential in a URL, Git, screenshot or report. The server binds only to 127.0.0.1, rejects foreign Host/Origin headers, and sends no permissive CORS headers. `/health` and the console shell are public locally; data and actions require a workspace member token. The console keeps it only in the current tab's session storage. Filesystem access remains the trust boundary: these roles do not sandbox someone who can directly edit the installation's files.

## API contract

Prefix every scoped request with `?workspace=<slug>` in the harness; omit it for legacy mode. The production API rejects workspace selectors. Send `Authorization: Bearer <token>` for all `/v1/*` requests.

| Endpoint | Behavior |
|---|---|
| `GET /v1/state` | Workspace, desks, packages, exact missing destinations, last harvest/newsletter, verification report, analytics snapshots, attribution counts |
| `GET /v1/analytics` | Stored post snapshots; no provider collection is triggered |
| `GET /v1/events?offset=0` | Up to 500 chronological events plus nextOffset; consumers deduplicate event identity |
| `GET /v1/packages/<id>` | SHA-256 binding topic, script, video and the presence/content of companion newsletter artifacts |
| `GET /v1/packages/<id>/artifact/<name>` | Exact topic.json, script.json, final.mp4, newsletter.html or newsletter.linkedin.html; authenticated, contained paths |
| `POST /v1/packages/<id>/approve` | `{ "expectedHash": "<reviewed SHA-256>" }`; requires approval role, desk assignment, any two-person rule, and unchanged artifacts |
| `POST /v1/packages/<id>/hold` | `{ "reason": "why" }`; adds a review hold |
| `POST /v1/packages/<id>/retry` | `{ "platform": "youtube" }`; owner/admin retries only this destination through the existing publication gates |

Every mutation requires a new `Idempotency-Key` (8–128 safe characters). Reusing a completed key with the same actor/payload returns its receipt. Reusing it with different input, or after an incomplete/failed operation, returns 409 and requires state inspection. This is deliberately conservative about ambiguous external results. Mutations run in a child process with a sanitized environment and the selected workspace's credentials. A workspace release lock serializes CLI artifact mutations, approval/rejection and external release. A crashed worker's stale lock is recovered under an exclusive recovery guard; a persistent `.release.lock.recovery` requires inspecting the process before manually removing it.

Approval binds exact artifact hashes. Adding/changing a newsletter invalidates a video-only approval; rejection clears approval. The canonical LinkedIn reverse-link is accepted only when its deterministic derivative reconstructs the reviewed package. Approval never creates a provider receipt, and a retry never overrides a hold.

## Delivery contract

Each entry in `ADAPTERS` has `publish`, `validate`, `verify` and `collectMetrics`. Provider probes are shared by the standalone verifier and the adapter API. X verification requires the provider's exact post-and-author embed, rather than an HTTP 200 shell. LinkedIn public verification can remain inconclusive; it is never counted as proof of failure or success.

`meta.posts` remains the only publication/idempotence record. Verification appends `platform.verified` events and never rewrites `meta.json`. Failures and holds remain visible as missing destinations. An API-only expired credential with an unchanged credential fingerprint suppresses repeated doomed attempts; changed credentials or explicit `--retry-blocked` retries resume them. Providers with an available browser fallback continue trying that fallback. Other failures remain retryable. A partial `--only` success cannot mark the whole package posted.

## Analytics and attribution

`metrics:collect`, `metrics:weekly`, `metrics:report` and `metrics:dashboard` work in both repositories. Collectors retain exact post identities and measurement timestamps. They distinguish collected/partial/unavailable, and keep separate account and post metrics. Missing values are unknown, never fabricated zeroes. Browser collectors run sequentially to avoid profile contention. Public Threads/TikTok counters are accepted only from a matching provider JSON payload; private impressions/reach still require owner analytics access. Reddit currently has no metrics collector.

```bash
node --import tsx src/cli.ts attribution:create --id 20260907-example --platform x --url https://publication.example/issues/2026-09-07.html
```

Attribution binds an immutable content/channel key to an HTTPS URL on `pipeline.siteUrl` or an explicitly configured `pipeline.attribution.allowedOrigins` origin. `GET /r/<id>` records a raw redirect request, then returns 302; HEAD does not count. No IP, cookie, referrer or user-agent is stored. Counts are not unique readers, conversions or impressions. Local redirect support is implemented and tested; making links usable by public readers needs a separately hosted redirect route. Do not post localhost links or replace source citations with tracking links. Existing public posts are not rewritten.

## Signed event webhooks

Create a private `config/webhooks.json` array with `{ "id": "receiver", "url": "https://receiver.example/events", "secretEnv": "CONTENT_WEBHOOK_SECRET" }`, and a random secret of at least 32 characters in that workspace's `.env`. Configuration is opt-in; no external endpoint ships enabled.

The running API dispatches every five seconds. Headers are `x-content-event-id`, `x-content-timestamp`, and `x-content-signature: sha256=<HMAC>`. Verify HMAC-SHA256 over `<timestamp>.<raw request body>`, reject stale timestamps at the receiver, and deduplicate event IDs. Failed attempts persist in `state/webhook-deliveries.json` with capped exponential backoff. Acknowledged events are not resent; a crash after delivery but before recording acknowledgement can deliver the same ID again (at least once). At most 25 deliveries are attempted per tick. Change an endpoint's id if it needs a separate replay history.

## Validation

Run `npm run typecheck` and `npm test`. `src/capability-control.test.ts` covers the role matrix, cross-workspace credentials and traversal, exact approval, API idempotency, webhook failure/retry/signatures, click redirects, unknown metric values, credential-repair retry and fake X embeds. The harness also exercises its real CLI and child approval worker. Local browser verification covers console race/error handling and exact artifacts. External publication is not part of these tests.

## Interrupted delivery

Before an external publish call, the poster writes a private `.delivery-<platform>.json` attempt marker beside the package. It clears this only after persisting the provider receipt, or after a typed pre-submission failure/definite provider refusal. Unknown errors retain the marker. X API-to-browser fallback follows the same rule, preventing a second submission after a lost create response. Process death and ambiguous network/browser errors leave the marker in place. A restart with no `meta.posts` receipt holds that destination, even with `--retry-blocked`; it never infers successful delivery from the marker. Independently verify the destination before an admin uses `delivery:clear-attempt --id <id> --platform <platform> --confirmed-absent --reason <evidence>`. If a post exists, recover its exact receipt instead of clearing the marker and reposting. This conservative local hold is not a distributed exactly-once guarantee.
