# Agent, plugin and connector compatibility

An agent can operate the harness through its workspace-scoped connector while the harness uses a separately configured writer. Connecting an agent does not change the writer, grant a paid model subscription, or qualify an edition for publication. Writer transports are described in [model providers](model-providers.md).

## Connect an agent

From the harness checkout:

```sh
node connect.mjs <agent> --workspace <id>
node connect.mjs <agent> --workspace <id> --status
node connect.mjs <agent> --workspace <id> --verify
```

Use an agent ID from the table below. The launcher installs or configures the harness-owned integration for that workspace. Read the resulting setup instructions and complete any host-side enablement. A detected binary, written configuration or connector self-check is not proof that the external host made a tool call. Connection status uses an actual host tool-call receipt to distinguish that state.

| Agent ID | Harness integration |
| --- | --- |
| `codex` | Local plugin |
| `claude` | Local Claude Code plugin |
| `cursor` | MCP entry in `.cursor/mcp.json` |
| `vscode` | Project MCP entry in `.vscode/mcp.json` |
| `gemini` | MCP entry in `.gemini/settings.json` |
| `opencode` | MCP entry in `.config/opencode/opencode.json` |
| `zcode` | MCP entry in `.zcode/cli/config.json` |
| `hermes` | MCP entry in `.hermes/config.yaml` |
| `openclaw` | MCP entry in `.openclaw/openclaw.json` |
| `droid` | MCP entry in `.factory/mcp.json` |
| `copilot` | MCP entry in `.copilot/mcp-config.json` |
| `grok` | Grok Build MCP entry in `.grok/config.toml` |
| `pi` | Local extension |
| `grok-bot` | Remote HTTPS MCP connector with OAuth and account-side tool-call proof |

These entries describe implemented configuration adapters. Installed host versions, model access and live host behavior still need verification in the user's environment. The local plugin source, commands and skill are under `plugins/content-harness/`; they are part of the shared harness. Proprietary workflow packs are separately licensed materials and are not required for the connector, launcher or normal workflows.

To disconnect and restore the harness-owned configuration entry:

```sh
node connect.mjs <agent> --workspace <id> --restore
```

The launcher preserves a backup and checks ownership before restoring configuration. Do not overwrite unrelated agent settings to resolve a conflict. Revoking or superseding a connection removes its authority; access is also constrained by current workspace membership.

## Host and writer boundaries

- Claude Code and Codex have both connector integrations and direct CLI writer adapters. Each role still has its own task and authentication context.
- OpenCode has an MCP host integration and a direct writer adapter. The writer currently accepts validated Ollama and anonymous OpenCode free-model routes, not every provider that the host itself supports.
- Antigravity (Google's agentic IDE and its `agy` CLI) is an MCP host through `~/.gemini/config/mcp_config.json`. The native `gemini` writer setting uses the Gemini HTTP API key, not the Antigravity login.
- Grok Build has both an MCP host integration and a CLI writer path. The xAI API writer requires API credentials separately. Grok Bot connects through the remote connector flow; installing a desktop app or signing into a browser is not that connection.
- Hermes and OpenClaw are MCP hosts. Their own GPU or local-model setup does not automatically become the harness writer. A model server they operate can be selected separately if it exposes a supported harness transport.
- Ollama and Bedrock are writer providers, not connector host IDs. CompactifAI/Multiverse uses the configured OpenAI-compatible writer route.

## Workspace and action controls

Use the existing workspace and its saved brief, sources and model settings. Connector access does not permit importing another workspace's private configuration, credentials or source history. The connector exposes the same harness operations and saved-state controls used by the local Journey; it does not bypass source checks, review decisions, usage limits or destination approvals.

Start with status and setup, inspect the configured sources and writer, and create the requested draft or preview. Follow the active task's publishing authorization and the harness's action confirmation requirements. A ready preview and an enabled connector are not permission to send messages or publish externally.

For shell-capable hosts, the repository's `AGENTS.md`, `CLAUDE.md` and `skills/ai-content-engine/SKILL.md` provide the operational contract. Read them before changing settings or invoking workflows. For Bedrock credentials in Journey workers, use the workspace-specific environment rules in the provider guide rather than assuming shell variables are inherited.
