# Try the Free harness

**The harness today is a review-mode product by default:** every edition stops at a private preview, and publishing is a separate explicit step. The Journey's Automated mode can approve and publish passing previews later, after the first editions you approve yourself.

1. Install Node.js 22.13 or newer with npm. Extract into a new folder.
2. Run `node start.mjs`. Keep the terminal open while using the browser workspace.
3. Describe one real publication, check the selected writer, then choose **Create my preview**. Automatic source discovery is the default; add trusted websites only if you prefer your own sources or discovery needs help.
4. Continue with Free neutral defaults. Personalization and managed services are planned Pro features.
5. Create a private preview. Inspect facts, source links, newsletter length, each visual and the full narration. With a writer that cannot look at images, the story's source photo is attached unreviewed with its rights note, or add your own image at **Choose the visual for each story**; the harness fits it to the video frame and the newsletter column.
6. Reload and reopen the same package. Create a second edition and record any assistance required.

**Your data** stays under `workspaces/<workspace>/` (brief, private `.env`, receipts under `state/`, outputs under `workdir/`); delete that folder to remove a publication and its history. The launcher credential file is `~/.content-harness/identity.json` (or the path in `HARNESS_IDENTITY_FILE`).

Do not copy another person's workspace, browser profile, `.env`, voice sample or entitlement.
No local driver binary or model weight ships. Optional local services require explicit installation and your
own settings. Provider usage can cost money. The software license does not pay for provider usage.

For checks without model calls: `npm test`, `npm run test:unit`, `npm run typecheck`, then `npm run dry-run`.
Publishing is a separate, explicit step after you review the preview; nothing is posted until you choose to.

For OpenCode, Ollama, Hermes, OpenClaw, Grok API, Grok Bot and your own GPU host, follow the [connector and voice guide](docs/connect-and-voice.md). It separates shipped adapters from integrations that still need a live account test.

To use Claude Code or Codex with this workspace, follow the [plugin installation guide](plugins/content-harness/README.md). It includes the public GitHub marketplace commands, workspace binding and a status call to verify the connection.
