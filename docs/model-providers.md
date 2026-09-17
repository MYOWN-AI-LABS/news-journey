# Model providers

Choose the writer in the Journey or edit the selected workspace's `config/model.json`. A workspace normally lives under `workspaces/<id>/`; root configuration is the template for new workspaces. Keep credentials in the selected workspace's private `.env` or the provider's supported credential store, never in committed configuration.

## Writer routes

| Provider setting | Transport and authentication | Configuration |
| --- | --- | --- |
| `claude` | Installed Claude CLI and its saved login | `providers.claude.command` and optional model |
| `codex` | Installed Codex CLI and its saved login | `providers.codex.command` and optional model; an omitted model is resolved from the saved Codex configuration |
| `opencode` | Installed OpenCode CLI, isolated writer session | Explicit `ollama/<model>` or supported `opencode/<model>-free` route; see below |
| `grok` with `command` | Installed Grok Build CLI and its saved login | `providers.grok.command`, optional model |
| `grok` without `command` | xAI HTTP API | Explicit model; `XAI_API_KEY`; default base URL `https://api.x.ai/v1` |
| `antigravity` | Google Antigravity's signed-in `agy` CLI (Gemini models), print mode, text only | `providers.antigravity.model` from `agy models`, default `gemini-3.8-flash-high` when unset; optional `command`, `reasoningEffort`; no API key; 900 s per call by default |
| `gemini` | Gemini OpenAI-compatible HTTP API | Explicit model; `GEMINI_API_KEY`; default base URL `https://generativelanguage.googleapis.com/v1beta/openai` |
| `zai` | Z.AI HTTP API | Explicit model; `ZAI_API_KEY`; default base URL `https://api.z.ai/api/paas/v4` |
| `ollama` | Ollama chat endpoint | Installed model name; default base URL `http://127.0.0.1:11434/v1`; optional `contextTokens` |
| `openai-compatible` | Configured OpenAI-compatible chat endpoint | `providers.openaiCompatible.baseUrl` and model; `OPENAI_COMPATIBLE_API_KEY` when required |
| `bedrock` | Native AWS Bedrock Converse API | Explicit model ID or inference-profile ARN, AWS region and standard AWS credential chain |

The generic route can connect to a compatible local server or hosted service, including CompactifAI/Multiverse at `https://api.compactif.ai/v1`. Select a model actually available to your account. Compatibility with the HTTP contract does not imply support for images, tools, search or every model feature.

OpenCode currently accepts the harness's validated Ollama and anonymous OpenCode free-model routes. The free route uses an isolated anonymous provider configuration; it does not inherit a paid provider login. OpenCode rejects Ollama cloud aliases; its Ollama route requires an installed local model. For any other configured route, distinguish remote inference from a model running on the local machine. Arbitrary OpenCode provider names are rejected instead of silently selecting another account or transport.

For an installed Ollama model that advertises vision, OpenCode can receive up to six bounded PNG/JPEG/WebP images through private CLI attachments. The adapter checks the selected model's local metadata and sends the same model both text and image bytes; it does not grant browsing tools or switch providers. The hosted free route remains text-only in this adapter. Configure the actual Ollama model context as well as the harness settings: OpenCode's context metadata does not enlarge Ollama's runtime context. Image transport support still requires a real end-to-end quality test for the chosen model.

Grok Build CLI and Grok API are separate routes. A saved CLI login does not establish API access or credits. Grok Bot is a remote connector host, not a native writer transport. Gemini CLI, Hermes and OpenClaw can operate the harness through its connector; that does not select their host model as the harness writer. See [agent compatibility](agent-compatibility.md).

## Bedrock

Example configuration fragment; replace the model placeholder with an authorized model ID or inference-profile ARN:

```json
{
  "provider": "bedrock",
  "providers": {
    "bedrock": {
      "model": "YOUR_MODEL_ID_OR_INFERENCE_PROFILE_ARN",
      "region": "us-east-1",
      "maxTokens": 4096,
      "supportsImages": false
    }
  }
}
```

The AWS SDK signs requests and uses its standard credential chain. The harness does not accept a generic Model URL or generic model API key for Bedrock. `AWS_REGION`, then `AWS_DEFAULT_REGION`, override the saved region. The configured output limit remains a ceiling for bounded calls. Enable `supportsImages` only when the selected Bedrock model accepts images; text-only is the default.

Direct CLI commands can use their shell's AWS environment. Journey workers intentionally load the selected workspace's `.env` and do not inherit arbitrary cloud variables from the server shell. For a named local profile, put `AWS_PROFILE=your-profile` in that workspace's private `.env`; set its region there or in `providers.bedrock.region`. The default shared AWS profile remains available through the retained home directory. Provision hosted worker credentials through a separately scoped service configuration rather than forwarding all host credentials.

## Check a selection

Run commands in the intended workspace context; include `--workspace <id>` when targeting a named workspace:

```sh
npm run model:check -- --workspace <id>
npm run models:recommend -- --workspace <id>
npm run models:qualify -- --workspace <id>
```

`model:check` is a small connection/response check. It does not establish source collection, factual accuracy, complete newsletter generation, narration or rendered-video acceptance. Qualification reports describe the exact checks they executed; inspect their scope and failures before relying on the model for a different task.

The model advisor uses an installed `llmfit` when available and otherwise a conservative local-resource estimate. An explicit `--use-uvx` option can download and run the helper. Recommendations do not install models or prove their writing quality. `models:ollama-profile` is an explicit profile-creation operation; inspect its options and resulting context settings before using the new alias.

Keep model and runtime choices stable within a saved edition. Context and output limits, original parent budgets and bounded repair apply to the selected route. New standard production uses operation timeouts instead of a whole-workflow clock; explicit local-role deadlines and historical fixed deadlines remain in force. Schema or formatting errors retain the task and validation feedback; they do not authorize an unlimited retry loop. Writer calls have their own capability boundary: an HTTP model or CLI connection alone does not grant live web search, filesystem tools or external publishing.

Source collection remains a separate configured pipeline. Use trusted feeds and source connectors for the intended topics. A model's general product description or training knowledge is not evidence that the particular configured writer can search the web.

## Continuing accepted media

An expired historical run can receive an explicit, one-time media authorization after its complete script and script-derived newsletter are accepted. The production continuation API records that authorization separately, binds it to the exact workspace, author, content and settings, and leaves the original budget file untouched. Its total model calls and tools are limited to the original unused allowance; failed attempts still count. It uses per-operation timeouts, not another whole-workflow deadline.

Resume that exact package to reuse its saved issue, assets and visual choices, finish selected narration/rendering and check final media against the approved script. Ordinary continuation reuses accepted writing and visuals, and only final media alignment calls the selected model. A separately authorized visual revision can develop and review the exact requested presentation under the same remaining allowance; it cannot rewrite the script or newsletter. It currently supports the script-first Journey without a separate role-model policy. Changed content/settings, review holds, delivery activity or exhausted counts stop continuation. It cannot publish or restart completed media. The optional watchdog does not grant this authorization or expand any allowance.
