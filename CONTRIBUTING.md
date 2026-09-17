# Testing and contributing

This MIT source package is the Free edition of the harness. You can help by reproducing a problem, improving documentation or proposing a small, scoped patch. Pro access is separate from open-source participation.

## Start from a fresh copy

Use Node.js 22.13 or newer with npm. Extract the release or check out its exact revision into a new directory, then run:

```sh
npm ci
npm test
npm run test:unit
npm run typecheck
npm run dry-run
```

These are the Free package's existing checks. Dependency installation uses package infrastructure. The synthetic checks do not qualify a model, native client, operating system, voice or finished video. Real generation requires your own configured provider and any necessary local dependencies; keep model costs and limits explicit. See [QUICKSTART.md](QUICKSTART.md).

## Report a reproducible problem

Open an issue at https://github.com/MYOWN-AI-LABS/ai-content-engine/issues. Include the release/commit, operating system, Node version, exact model and client/runtime when relevant, requested output settings, minimal steps, expected behavior and a redacted error. Distinguish a failing test, model response, generated draft and inspected final artifact. Use fictional or public source data for reproductions.

Never include credentials, session cookies, private prompts, personal source documents, voice samples, browser state or unredacted logs in a public bug report. Report vulnerabilities through the private route in [SECURITY.md](SECURITY.md), not a public issue. No response-time guarantee is implied.

## Propose a focused change

Keep a patch limited to one concrete problem. Explain the resulting behavior and include a relevant regression when changing behavior. Run the checks above and report exactly what passed, failed or was not tested. Preserve source attribution, qualifications, selected output lengths, topic identity, approved-artifact hashes and shared call/time limits. A smaller model must not receive weaker factual gates or an undisclosed hosted fallback.

Script, newsletter and visual development have independent reviews. A successful branch must survive another branch's failure. Visual concepts still need alignment to accepted narration; rendered artwork, captions, voice and the final video require their own applicable inspection. Passing JSON or unit checks does not establish factual or media quality. Do not replace a failed gate with an unchecked fallback to make a test pass.

Keep private state, generated media, model weights and credentials out of the change. Retain the MIT license and [third-party notices](THIRD_PARTY_NOTICES.md). Open a pull request with a concise description, reproduction and validation evidence. An issue or contribution does not grant publishing permission or Pro admission.
