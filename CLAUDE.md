# Free harness contributor instructions

## Plugin distribution

The public marketplace is `MYOWN-AI-LABS/news-journey`; install instructions live in `plugins/content-harness/README.md`. Codex's inline MCP manifest explicitly forwards `CONTENT_HARNESS_ROOT`, `HARNESS_WORKSPACE` and optional `HARNESS_IDENTITY_FILE`: native MCP children otherwise lose the checkout/workspace settings. Preserve those fields and the skill's valid YAML frontmatter. The per-workspace launcher replaces the copied Codex manifest's MCP entry with the same absolute, workspace/connection/generation-bound command written to `.mcp.json`; never leave the unbound marketplace template active alongside it. No credentials belong in either manifest. Verify native marketplace installation and actual tool use separately from protocol checks and content quality. GitHub distribution does not imply an Anthropic/OpenAI directory listing.

Runtime memory is implemented under `src/memory/`; read [the operator guide](docs/publication-memory.md). Local storage is scoped SQLite; PostgreSQL is an injected adapter requiring separate hosted integration. Never use URL/entity overlap, draft files or profile/title discovery as proof of published event identity. Keep complete source revisions/conditions, immutable working context, bounded recalled lessons and the original parent budget. Corrections remain proposed until explicit review, expire, and cannot rewrite tools or publication policy. Memory deletion covers database records only; artifacts and backups have separate retention controls.

This is the Free MIT distribution. Read README.md.
Run `node start.mjs` from this directory. It installs declared JavaScript dependencies and opens a loopback
browser workspace. Stop the foreground process with Ctrl+C and run the same command to restart.

`config/distribution.json` belongs to this code package; never copy it from a workspace. It carries `edition: free`
and an `evaluation` flag: `true` is the private-beta build (publication locked, evaluation banner shown), `false` is the
public build (publishing available after review). Keep Pro operations unavailable in either. Never enable a
destination, attach an account, start a paid request or publish as part of setup.
Provider credentials and all generated publication artifacts belong to an ignored customer workspace.

The default writer must be selected by the operator. Do not guess API keys, voice identities, browser profiles
or local executables. Rescue to a hosted writer is off by default. Optional integrations are not bundled runtimes.
Review actual generated artifacts; passing schemas and fixture tests do not prove factual or visual quality.
Never substitute another narrator or publish on a generation failure. Preserve exact source and artifact IDs.

Fresh beta workspaces must have blank editorial state and new credentials. The local owner may use
`node --import tsx ops/prepare-beta-workspace.mjs <new> <previous>` to retain only the selected writer and
built-in/local narrator. Never copy an old brief, publisher, source configuration, branding or job receipt.
Match restored progress and implicit previews to the submitted brief; a changed Describe input must pass
through quick-preview before Advanced generation can use it.

Use Node.js 22.13 or newer for the declared package and isolated pipeline tests. Run `npm test`, `npm run typecheck` and `npm run dry-run` after relevant edits. Tests exercise the Free
distribution; private development-only Pro and founder-guide tests are not the public acceptance suite.
Inspect the actual browser on desktop and phone widths after UI changes. No external accounts are required
for the synthetic checks. Native Windows and other hardware need separate live verification.

Keep LICENSE and third-party notices. The repository is MIT; separately licensed dependencies and future
Pro services do not change that grant. No private beta records, premium packs, installed drivers or weights
may enter a redistributed archive. Do not expose old development history as a public release.

Completed previews open the newsletter and video together. Visual and story continuation uses the checked selections. Local Voicebox profiles expose their speech engine (Qwen or LuxTTS for new clones); reuse the original recording and engine when reproducing an established voice, and listen before approving. Narration receipts record the profile, engine, generation IDs, processing and output hash.

Sentence captions stay within each sentence. Local Voicebox joins use a 0.65-second sentence pause before speed adjustment, and recorded speech windows keep aligned word onsets out of the inserted silence. Original wording and the selected voice are preserved.

## Local writers and optional cloud help

Describe can create a preview using saved defaults; source, writer and narrator settings are optional. Ollama runs an installed model on your computer. The OpenCode writing route supports an exact installed Ollama model or a native OpenCode free-model route; the latter runs in the cloud and remains subject to provider limits. The isolated writing adapter has no tools or inherited project instructions. Configure the exact OpenCode model under Advanced settings.

New workspaces keep Claude/Codex fallback off. If you enable it, the default limit is two actual hosted calls per workspace per day (America/New_York), including retries, corrections and failures. The local writer is tried again for each new task. The operator setting `rescue.maxCallsPerDay` accepts zero to ten. Explicitly selecting Claude or Codex uses that writer directly. A local editorial check and a source-to-story-review pass do not certify every local model or finished media quality.

Source fetching requires public HTTPS and rejects redirects, private addresses and oversized responses. Claude editorial writing disables tools and inherited customizations; explicit web research has a separate restricted capability. A Claude CLI without the required safe-mode flags fails closed. These controls do not make the local control server suitable for internet exposure.

## Bounded newsletter preparation

Full editions prepare enough supported material for every selected topic before writing. The writer handles one topic at a time; code assigns and checks word ranges, source IDs and final ordering. The selected Deep target stays 900–1300 words. Newsletter text completes before media production. Exact package, model and settings identities preserve checkpoints and cumulative call limits; changing the request cannot refill its original allowance.

The isolated OpenCode route explicitly disables reasoning for local Ollama writing so its output allowance is available for the answer. This setting is part of the tested runtime identity; it does not change native OpenCode cloud routes. A fit estimate or narrow claim-ID test is not qualification for writing or factual critique.


## Topic research and current limits

The selected writer can plan topic searches; the harness performs bounded HTTPS searches and reads, preserves the original topic and primary source, and retains complete extracted source text with hashes. Article qualifications stay with the source; partial responses and clipped text cannot become evidence. A source selection is still fallible and does not certify the finished newsletter.

Each new full package shares one allowance of 96 model attempts, 24 tool uses and 1800 seconds across research, preparation and writing unless explicit role settings choose different supported limits. Retries and JSON corrections count; a child agent cannot replenish the parent. Every selected topic must pass the requested length and source checks before a newsletter is accepted. Deep remains 900–1300 words. Current small-model factual review is not qualified; the earlier controlled1050-word 4B output does not establish broad editorial quality or a current-protocol pass.

Grok API, Grok Build and Grok Bot are separate integrations. A signed-in Bot conversation is not an API credential or a verified harness connector. Supply your own account access and verify the actual tool handshake; credentials and tunnels are not bundled. The paid hosted worker, authentication and tenant-isolation rollout remains planned.

Source preparation now uses a separate complete-source review after sentence selection. That reviewer can add missed topical facts, removes non-editorial text and retains necessary qualifications before words count toward an edition. Code records which source sentence IDs were kept, added or dropped. The word allocator can give a shorter topic less space and a richer topic more, while keeping every topic and the original total. Primary sources are gathered before bounded supporting-source reads or expansions. These controls remain subject to live model acceptance; they do not establish factual quality on their own.

Source-selection tasks identify structurally ineligible source sentences in advance and give precise correction feedback. The complete source remains available as context, and a claim is omitted when its necessary qualification cannot be retained safely.

Keep source publication metadata separate from numbered claims and preserve it in capture, evidence, writer and critic identities. Unknown publication dates remain null; do not use capture time or move a source's relative date onto the edition date. Attribute promotional claims and report documented instructions in complete third-person sentences. Technical-condition lookup is a review aid, never automatic approval or proof of complete dependency coverage.

The evidence allocator preserves the original required minimum and maximum. Source capacity bounds required minimums; optional upper headroom permits grammatical paraphrase, not new facts or repetition. Script repair feedback must name every invalid bounded card field at once without clipping content or dropping qualifiers. Local model selection must retain the checked reasoning mode; an explicit default must remove an old override.


## Free personalization disclosure

The exported journey keeps neutral defaults and Continue with Free visible. `freeEditorialOptions` holds the optional vocabulary controls; `freeProOptions` holds existing Pro forms behind a closed native disclosure. Keep all original field IDs, entitlement locks and defaults. Vocabulary remains Free and its save handler uses its existing IDs. Pro navigation opens the disclosure; expanding it must never activate Pro or save preferences. The source journey is not rewritten by this export transformation.

Run `npm run test:personalize:browser` on the extracted package for keyboard and collapse-height checks at 320, 390 and 1440 pixels. This uses a disposable local workspace, performs no generation or publishing, and does not establish real-model quality.

## Editorial safeguards to preserve

Factual reviews independently read assertion strength, exclusions and temporal framing, account for qualifiers within used claims and external source restrictions, then complete general review. Prompts preserve all text as lossless spans; models select IDs and code derives exact citations. Validate those IDs and reconstructed quotes again before cache reuse. Publication metadata dates the source, not an event; unknown dates cannot support edition-relative assertions. Plan actual task counts dynamically and retain the original allowance. Classifier judgments remain fallible and grant no publishing authority.

Basic personal preferences and correction reminders are optional in Free and Pro. Start at **Personalize → About you & remembered corrections**, or skip directly to a preview. [How preferences, agent sharing and deletion work](docs/personal-preferences.md). Background and raw notes never determine news topics or enter source evidence. Brand design remains a separate Pro feature.

Narration, newsletter text and source visual concepts develop independently from one prepared package. A failed branch preserves completed work in the others. Final visual alignment waits for accepted narration and retains the source and artwork checks. Local model execution remains queued to fit the host; all branches share the original allowance. Fixture tests do not establish model or finished-output quality. Source-account text cards preserve complete source concepts as reviewed context and bind a separate compatibility receipt to accepted narration. They do not claim to render concept artwork or pass pixel review; explicit artwork requests remain held.

Prepared editions can assign explicit local research and writing roles while keeping the selected primary for unspecified roles. Draft repairs use the writer; source and prose review use the critic. These tasks share one saved allowance and exact source/settings identity. Local execution requires current model, context and memory checks; no unqualified local critic or implicit hosted fallback is selected. Source extraction preserves paragraph boundaries, and exact sentence alignment helps the reviewer locate claims without granting factual approval. Full model quality and hosted deployment still require their separate acceptance checks.

Direct script and producer paths both obtain prepared source context. Saved video/edition scope controls implicit resume; a video-only job cannot become a newsletter by omitting its original command options. Single-source topics keep their kind and one real reviewed evidence packet across all scenes. Only the completed writer's factual gates may issue the script receipt. Producers and visuals verify its current hashes and protocol; do not mint a receipt from structural validation or accept legacy media as reviewed evidence.
