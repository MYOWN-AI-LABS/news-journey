# News Journey plugins for Claude Code and Codex

Use the Free MIT AI Content Engine Harness from your coding agent. The plugin reads your publication settings and sources, prepares drafts with your selected writer, and reports the exact job or preview for your review. It cannot approve, publish or send. Publishing remains an owner action in the Journey; Pro services remain unavailable.

## Prepare your local workspace

Install Node.js 22.13 or newer, clone the public repository, and run the launcher:

```sh
git clone https://github.com/MYOWN-AI-LABS/news-journey.git
cd news-journey
node start.mjs
```

Complete setup in the browser and note your workspace ID. Keep its credentials, selected writer and voice on your computer. Installation does not qualify a model or generate an edition.

## Install from the GitHub marketplace

In a second terminal, open your `news-journey` checkout and set these variables before launching the agent. These examples use macOS/Linux shell syntax; replace `my-publication` with the existing workspace ID:

```sh
export CONTENT_HARNESS_ROOT="$PWD"
export HARNESS_WORKSPACE="my-publication"
```

Claude Code:

```sh
claude plugin marketplace add MYOWN-AI-LABS/news-journey
claude plugin install content-harness@content-harness
claude
```

Codex CLI:

```sh
codex plugin marketplace add MYOWN-AI-LABS/news-journey
codex plugin add content-harness@content-harness
codex
```

Complete the host's own login and trust prompts. In a new session, ask: **“Call harness_status and report my workspace ID.”** Confirm it matches the workspace you selected. A successful installation alone does not prove that connection.

The checkout path is required because marketplace clients cache the plugin separately from the complete harness. `HARNESS_WORKSPACE` defaults to `default` only if that workspace already exists. `HARNESS_IDENTITY_FILE` is optional for operators who moved their local identity file; never paste its contents into chat.

## Use the launcher instead

For a connection bound to one workspace, including Codex desktop use without terminal environment variables:

```sh
node connect.mjs claude --workspace my-publication
node connect.mjs codex --workspace my-publication
```

The launcher copies the plugin into private workspace state and binds its MCP command to that workspace. For Codex, open a new app session after installation. `--configure-only` configures without launching, `--verify` checks the protocol, `--status` reads connection evidence, and `--restore` revokes the connection and removes only unchanged harness-owned entries.

## What is included

- A shared `content-harness` skill and four Claude commands: `/content-harness:setup`, `draft`, `status` and `review`.
- Local MCP tools for setup, sources, draft preparation, exact job/package status and individual LinkedIn drafts.
- Existing writer and narration choices; no credentials, cloud service, model weights or paid plan bundled.

The repository is the distribution marketplace. A listing in Anthropic's community catalog or OpenAI's central directory is a separate review process; these installation commands do not depend on either listing.

See [agent and voice setup](../../docs/connect-and-voice.md). Licensed under [MIT](../../LICENSE).
