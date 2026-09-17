# Content Harness plugin for the Free edition

This package includes the Claude Code/Codex plugin, the `content-harness` skill, four commands and a local MCP server. Use it from the extracted harness directory.

Run `node start.mjs` once to install dependencies and create a workspace. Choose the writer and narration in the browser. Then, from this directory, run one of:

```sh
node connect.mjs claude --workspace my-publication
node connect.mjs codex --workspace my-publication
```

Replace `my-publication` with your workspace ID. The launcher creates a private, member-bound plugin connection. Complete the application's login/trust prompts, then ask it to call `harness_status`. Add `--configure-only` to configure without launching, `--verify` for a real protocol-client check, `--status` to inspect connection evidence, or `--restore` to revoke the connection and restore unchanged harness entries.

The repository plugin entry also supports local self-binding. It finds the harness through `CONTENT_HARNESS_ROOT`, or the checkout containing the plugin, and selects `HARNESS_WORKSPACE` (default `default`). It needs that existing workspace and its local owner identity; it does not ship credentials. A copied plugin outside the harness needs the explicit harness root. Repository-marketplace installation is not yet verified end to end for this Free package.

The agent receives `/content-harness:setup`, `/content-harness:draft`, `/content-harness:status` and `/content-harness:review`. Free tools read setup and sources, prepare a draft with the selected writer, inspect exact jobs/packages and prepare individual LinkedIn drafts. The agent cannot approve, publish or send; publishing stays a person's action in the Journey. Pro tools may appear in the shared tool catalog, but Pro services and premium packs are unavailable; do not describe them as active.

On the September 14 extracted Free candidate, the plugin entry completed real stdio status calls, repeated binding and revocation checks using the harness's protocol test client. That proves the shipped server path, not every native application's integration or model quality.

See [agent, writer and GPU setup](../../docs/connect-and-voice.md) for Ollama, OpenCode, Hermes, OpenClaw, Grok API, Grok Build and Grok Bot. Original source is [MIT](../../LICENSE).
