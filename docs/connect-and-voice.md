# Connect your agent and choose a writer

The Free harness includes its connector code, Claude Code/Codex plugin, skill and four commands. Install the harness dependencies with `node start.mjs`, create your workspace, and describe your publication before connecting an agent. No model weights, agent applications, credentials or GPU service ship in this package.

Your **agent** helps operate the harness through named MCP tools. Your **writer** produces the content using the model saved in the workspace. They can be different: Hermes can operate a workspace whose writer is Ollama, for example. A working connector does not establish that its model can write an accurate newsletter.

## Connect from the local browser

Open **Advanced settings → Connect agents**, select your agent and configure it. Complete that application's normal trust/login steps, then ask it to call `harness_status`. The card distinguishes detected, configured, tool verified and connected. **Verify** calls the real MCP server with the harness test client; it does not certify the external agent's account or model.

Developers can use the same connection from the extracted directory, replacing `my-publication` with their existing workspace ID:

```sh
node connect.mjs hermes --workspace my-publication --configure-only
node connect.mjs hermes --workspace my-publication --verify
node connect.mjs hermes --workspace my-publication --status
node connect.mjs hermes --workspace my-publication --restore
```

Replace `hermes` with a supported ID below. `--configure-only` writes the connector entry without launching the agent; `--verify` starts a bounded MCP test. Without either flag, the launcher configures and starts the selected local agent. Restore revokes this connection and removes only its unchanged harness-owned configuration. It preserves other models, connectors and credentials; edited harness entries require manual review.

| Agent ID | Shipped connection |
| --- | --- |
| `claude`, `codex` | Local native plugin; use the launcher from this extracted directory |
| `opencode` | `~/.config/opencode/opencode.json`, under `mcp`; a local command array |
| `hermes` | `~/.hermes/config.yaml`, under `mcp_servers`; command and arguments |
| `openclaw` | `~/.openclaw/openclaw.json`, under `mcp.servers`; command and arguments |
| `cursor` | `~/.cursor/mcp.json`, under `mcpServers` |
| `vscode` | This harness directory's `.vscode/mcp.json`, under `servers` |
| `gemini` | `~/.gemini/settings.json`, under `mcpServers` |
| `zcode` | `~/.zcode/cli/config.json`, under `mcp.servers` |
| `droid` | `~/.factory/mcp.json`, under `mcpServers` |
| `copilot` | `~/.copilot/mcp-config.json`, under `mcpServers` |
| `grok` | Grok Build CLI; `~/.grok/config.toml`, under `mcp_servers` |
| `pi` | Local extension registering the same bounded harness tools |
| `grok-bot` | Separate remote MCP/OAuth connection; customer account flow remains unverified |

These are standard locations; custom application configuration roots may need the application's own setup process. OpenClaw comments are preserved in the backup, while the updated file is valid JSON. Configuration shapes agree with the current [OpenCode](https://opencode.ai/docs/mcp-servers/), [Hermes](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference) and [OpenClaw](https://docs.openclaw.ai/cli/mcp) documentation. Actual native-client tool calls must still be tested in the customer's installed version.

## Ollama, OpenCode and GPU choices

Select the writer in Describe or Advanced settings. Ollama needs an exact installed model name. OpenCode writing supports an exact `ollama/<installed-model>` route or an OpenCode native `opencode/<name>-free` cloud route. The latter sends source text to its provider and has provider limits. Neither path automatically downloads a model. Hosted rescue is off by default; enabling it allows the displayed, limited Claude/Codex calls.

Use **Find a local writer** in Describe. Your unsent brief is kept in this browser tab for the authenticated workspace and member, including during reloads.

1. Open **Set up the optional fit checker → Set up fit checker** if the analyzer is missing. This explicitly downloads about 7 MB of tool files from the pinned [official llmfit 1.1.15 release](https://github.com/AlexsJones/llmfit/releases/tag/v1.1.15), checks the published and pinned checksums, and installs only the tool in this harness. It changes no global settings and downloads no model weights. Automatic setup supports macOS and Linux on ARM64 or x64. Native Windows installation is unsupported in this version.
2. Choose a context estimate, then **Scan this computer**. The default 8K estimate is for smaller writing tasks; the separate 32K coding recommendation is not a writing prerequisite. Scanning lists models already installed in Ollama. Catalog fit, speed, runtime and quantization are estimates, not a task-quality result. Scanning and ordinary page refreshes never download tools or models or start inference.
3. Choose the exact **Ollama** or **OpenCode with Ollama** route, then **Check this connection**. This reads model metadata, including the digest, runtime versions and actual installed quantization. A selected memory plan uses that quantization and context; the current available memory is checked again before a model task starts. OpenCode uses the model's installed context and explicitly disables reasoning for the local Ollama writing task; this effective setting is included in its test identity. If that context is unknown, use a known configured model or direct Ollama at the selected context; an advertised catalog context does not change Ollama's actual setting.
4. Select a task and press **Run task test**. This runs two small synthetic tasks, with at most four local model requests and a two-minute parent budget. The result covers keeping verified claim IDs in source order or choosing captured source references. It does not qualify original prose, factual criticism, visuals or a complete publication. Each result belongs to the exact checked model, runtime, context and task contract; testing another model does not overwrite it. No cloud help is used.
5. Press **Use this writer** to save that exact local writer with hosted rescue off, then return to your brief. Review the completed output before accepting the full workflow. A connection or reference-selection pass does not establish factual accuracy.

Developers can install the same pinned advisor tool explicitly from the extracted harness directory:

```sh
node ops/setup-llmfit.mjs
```

`npm run models:recommend -- --json` remains a separate developer hardware shortlist. Its explicit `--use-uvx` option may download a helper, but it does not install the advisor's verified project tool. `npm run model:check -- --workspace my-publication` makes a small real writing call; `npm run models:qualify -- --workspace my-publication` runs the editorial check twice. Those commands use the selected provider and may incur its charges. A structural result or one diagnostic attempt cannot establish current factual quality; inspect the facts, lengths, visuals and narration.

Hermes and OpenClaw choose their own model and GPU infrastructure. Running them on a GPU does not move the harness writer or renderer automatically. A customer-hosted inference endpoint can use the harness's compatible API writer, with the exact model and endpoint set in the local browser. Verify where inference runs and test that provider's API; an MCP connection alone does not test GPU placement, speed or model support. Keep the control interface on loopback.

## Grok CLI and Grok Bot

**Grok writer** uses the [Grok Build CLI](https://docs.x.ai/build/cli/reference) and its saved login. Install it and sign in with `grok login`. Leave the model name blank to use the current `grok models` recommendation; an explicit model stays pinned. New workspaces use the CLI even without a saved command. News Journey does not require an xAI API key or fall back to HTTP for this writer. Model discovery does not generate content; checking/generating still requires available account usage.

**Grok Bot** is a [persistent cloud agent](https://docs.x.ai/grok-bot/overview). The harness includes an optional remote MCP server, not a Grok Bot account. Its local browser setup requires an existing customer-owned named Cloudflare tunnel, stable HTTPS hostname and matching credentials file. Start the connection explicitly and complete the account's available connector flow. OAuth grants bind one member/workspace, expire after one hour and require fresh consent; the remote client never receives the local member token. Disconnect revokes grants and stops the managed tunnel. The local computer and tunnel must remain running for this connection. Do not expose the control UI or owner token. Grok Bot account integration is unverified until that account successfully calls `harness_status`.

## What has been verified

On the September 14 extracted Free candidate, four focused checks passed: ten configuration formats with narrow restore, real stdio status calls and revocation, redacted tool results, and repository-plugin self-binding over stdio. These are local harness tests using a protocol client and fixture data. Native Hermes, OpenClaw, Grok Build, Grok Bot and customer GPU/provider integrations are not certified by them. The repository-marketplace installation path has not been tested end to end for this Free package; use the local launcher first.

The Free tools prepare sourced drafts, expose status and support the individual LinkedIn workbench. Pro personalization, managed analytics/outreach, workflow packs and conversational assistance remain unavailable. The evaluation cannot publish, even after review. Original harness code remains [MIT](../LICENSE); agent subscriptions, API calls and optional infrastructure are separate. See [the Free/Pro boundary](free-vs-pro.md) and [security policy](../SECURITY.md).
