# Viewer engagement

The local browser starts with a one-page use case, one agent dropdown and six setup steps. [Follow the simplified journey](simplified-journey.md); the same exact human review boundaries remain.

Once a package has a recorded post, open Engagement. The inbox prioritizes viewer corrections and disagreements, followed by questions and other conversations. Captured reactions indicate interest; they neither create a reply thread nor identify individuals from aggregate likes.

The sequence is **recorded post → collect/capture → deduplicate → triage → draft → approve exact reply → explicitly send or hand off → receipt**. Collection has no built-in schedule; explicit CLI polling is available. Direct messages are not sent unsolicited, and this runner never sends replies automatically. An organization may follow this process with one operator or a team. Its connected provider account determines the publishing identity.

| Channel | Current path |
|---|---|
| X | Collect recent replies directly to your recorded post and send an approved public reply through the API. Requires account read/write entitlement. |
| YouTube | Collect top-level comments on your recorded video and send an approved reply. Use **Authorize YouTube comment access** to request the additional comment scope. |
| LinkedIn, Instagram, Threads, Reddit, TikTok | Paste the exact viewer response and channel permalink. Draft and approve here, then copy the approved reply into the channel and record its permalink. |

Before collection, the harness verifies that the connected account owns the source post or video. Each refresh examines up to 100 recent responses and reports any additional page. X recent-search access and retention depend on the provider entitlement. Historical pagination and nested conversations are not implemented. Posting permission does not grant comment-read or organization access, and the current LinkedIn member connector cannot publish as a Company Page.

## Reply review

Composing your own reply requires no LLM call. To use the selected content model, explicitly confirm **Suggest reply**. The request quotes source/comment material as untrusted data, disables Claude tools/hooks/MCP, and allows at most one corrective retry. Verify its claims before approval; a model suggestion cannot approve or send itself.

Drafting belongs to editors on their assigned desks, approval to reviewers on their assigned desks, and sending to owners/admins. Where a desk requires independent review, even an owner must have another person approve their reply. Editing the saved reply or original comment invalidates approval. Before sending, the API checks the expected hash, current connected account, parent post and original comment.

A send attempt is stored as `sending` before the provider is contacted. Timeouts and missing receipts leave a durable hold, since the provider may already have accepted the reply. Check the channel before operator recovery: this beta offers no automatic retry or reset for the hold. Successful API receipts and manually entered receipts remain `unconfirmed`, without claiming an independent live probe.

## Workspace data and local API

The private files at `state/engagement/<sha256>.json` identify each response by channel, account, post and comment to prevent duplicates. Original post receipts remain separately in `meta.posts`. Every member can read their own workspace's inbox, as with other workspace content. Desks control editing and approval rather than read visibility.

Authenticated `GET /v1/engagement?workspace=<slug>` returns the inbox and capabilities. Named `POST /v1/journey/engagement-{collect,capture,draft,suggest,approve,send,confirm,dismiss}` operations accept `videoId`, `platform` and, where needed, `itemId`, `reply`, `url`, `text` or `expectedHash`. They use the same member tokens, job receipts and idempotency keys as the other browser actions. `expectedHash` is mandatory for approve/send/manual-confirm. No free-form command execution endpoint exists.

## Provider references

The YouTube collector follows [commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list); replies use [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert) with `youtube.force-ssl`. X uses [recent search](https://docs.x.com/x-api/posts/search-recent-posts), [conversation IDs](https://docs.x.com/x-api/fundamentals/conversation-id), and [create post with a reply parent](https://docs.x.com/x-api/posts/create-post). LinkedIn comment access has separate product/scope requirements described in its [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api?view=li-lms-2025-07).

Automated checks mock provider responses and verify duplicate handling, independent review, stale approval, changed accounts/parents and ambiguous outcomes. They do not send live replies or claim live provider readiness.


## Reliable runner and public acknowledgements

Run `node scripts/engagement-followup.mjs <workspace> <video-id> <x,youtube,...> <run-id> <request-id>` with the existing owner/admin `HARNESS_TOKEN` and loopback `HARNESS_API_URL`. The command polls the exact authenticated job until done, fails on errors/interruption or a five-minute timeout, and returns exit 2 when collection is partial or requires manual channels. Inspect the saved run and per-item delivery state; successful collection never proves replies were delivered. Reuse the same request ID to inspect a still-running job. Resume a failed run with the same run ID and a new request ID after resolving its cause; a fresh collection needs a fresh run ID.

`--every-minutes=60` opts into repeated collection of that exact recorded package. It uses interval-specific run/request IDs and stops on partial/failure instead of retrying the same error indefinitely. The app must remain running. No daemon is silently installed, no token is logged, and the runner cannot approve or send. For macOS launchd, invoke the absolute Node executable directly with separate arguments, not a shell command in a protected working directory. Check `launchctl` exit status plus the actual fresh run receipt; an installed plist is not a successful run. External schedulers are not inferred from `automaticSchedule: false`, which describes the harness's built-in scheduler only.

For a manually captured reaction, provide the observed person's `author`, `authorUrl`, `kind: reaction`, and the exact recorded parent-post `url`. The profile and parent post deduplicate the observation. An explicit `acknowledge: true` on draft/suggest creates a public acknowledgement targeted at that original post. It does not create a private-message or connection flow. Never invent identities from aggregate counts. Read the complete actual discussion first, acknowledge briefly and ask one relevant feedback question when useful. For commenters, answer their point within the existing thread. Stop after a decline and do not repeat a prior reply.

Manual delivery now requires `engagement-begin-manual` on the exact approved hash before posting externally. It persists `sending` and returns the reserved text and destination. The Journey button awaits that receipt before copying text or saying posting is ready. After the actual channel submission, `engagement-confirm` requires the unchanged hash and a new reply permalink; it records an unconfirmed receipt. The original post/comment URL cannot serve as the new reply receipt. An interrupted or uncertain manual attempt remains `sending`, blocks editing/resending, and must be reconciled live. Both actions are supported in the connector's existing human confirmation queue. Nothing here weakens workspace roles, two-person review, Free/Pro entitlement or channel capability checks.

When a reply invites someone to inspect an app, demo, article or video, include the verified destination from that publication. Check that the link opens the intended output; do not fabricate a URL or send a feedback request without the example being discussed.
