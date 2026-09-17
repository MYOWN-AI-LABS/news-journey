# Story visualization

The harness chooses a visual from each story's evidence before narration: an authored SVG for a process or comparison, real captured footage for a product/UI demonstration, or Three.js geometry for a supported spatial explanation. Users do not write React or select a decorative effect for every story.

## Use it

Run `node start.mjs` to set your publication, audience, topics, sources and model. Then run `node start.mjs --draft`. Open the readiness page's local archive link and review the newsletter and video. `npm run review` lists packages; `npm run preview -- <id>` opens a video.

The source demo path uses actual screenshots or clips, with source links and SHA-256 receipts. The model reviews captured frames before selecting an excerpt. A story about layered video composition can use the actual product demonstration. A supported compute-assembly explanation can use distinct board, memory, processor and cooling geometry. Three.js scenes are labelled as schematics; no product specifications are invented.

## Shared artifacts and checks

- `story-diagram.ts` validates authored SVG and measures contrast and phone text. The portrait canvas uses 2–4 steps and large labels. One visual repair receives a second judgment. A failed or unfinished review blocks release before narration (`visualReleaseProblem()`, called by `produce`); verdicts and before/after frames stay in `diagram-phone-review.json`, never in the customer newsletter.
- `visual-choice.ts` offers each story up to three source-bound candidates (News image, News snapshot, Explanation, plus Your image), recommends by beat, and binds the customer's choice to the candidate hash; in the executive path a missing choice pauses the package as `awaiting_visual_choice` before narration, and `produce --resume <id>` continues it. A chosen visual that fails media review returns to choice instead of falling back silently.
- `visual-director.ts` selects a story-specific plan. `visual-media.ts` produces and decodes its MP4, GIF and poster and binds the frame review to those bytes. The captured original is unchanged.
- `StoryVisualArt.tsx` draws actual Three.js geometry or verified source pixels. `StoryVisual.tsx` gives the video separate headline, visual, caption and qualification space. Legacy `Diagram3D` remains a standalone preview.
- `visual-timing.ts` aligns scene boundaries and exact cue phrases to the current transcript. A mismatched transcript requires fresh voice. Voice regeneration invalidates compressed audio. Reading timing is never presented as narration timing.
- The newsletter mounts the same selected scene; LinkedIn HTML embeds the same GIF bytes. Cache rerenders persist the refreshed scene so a later video-link refresh retains it. Story narration supports seek/replay and pauses offscreen. Reduced motion uses a meaningful complete view.
- With newsletter images enabled, every main story needs real selected artwork. Journey reuses the completed `ensureEditionDiagrams` receipt and applies Daily Signal's `assertIssueCarriesVisuals` before rendering figures and before saving write/rerender output. Empty diagram fallbacks, missing stories and custom shells that omit the figures are refused. Repair the upstream visual stage; accepted text and existing output files remain intact. Explicitly disabling newsletter images keeps the text-only option. Formatting does not generate artwork or add a factual review.
- GitHub stars are a dated observation unless real history exists. The harness no longer invents a growth curve. Historical charts have a zero baseline and fixed scale; authored metric geometry still needs source/value review.

## Model and network requirements

**Text-only writers and your own image.** A writer that cannot take image input (Ollama and OpenCode local models, CompactifAI's Quasar and GLM, Antigravity's `agy`) cannot run the phone-size check, so the News image and Explanation candidates are marked "cannot be checked" and the News snapshot is recommended. The person can add their own image for the story instead (`own-image`, rights `user-owned`); `storeOwnImage` decodes it in the bundled Chromium, applies EXIF orientation, fits it inside 1080×1920 without upscaling, refuses images narrower than 480 px, re-encodes it in its own format and records the fitted size beside the file (`assets/<ref>-own.<ext>.json`). The video frame and the 680-px newsletter column both use that one fitted copy.

Use a vision-capable model for source relevance and frame judgment. The six-provider router stays in place. Claude receives actual image bytes through its streaming input/output protocol with tools and hooks disabled for image review; compatible endpoints receive image content. A text-only model or unavailable quota retains the diagram fallback and records an unavailable review. These states are not a passed visual assessment.

Source capture uses bounded public HTTPS GET requests, pinned DNS, no redirects, and no browser service workers or WebSockets. Private/local addresses and paths outside the workspace are rejected. No new dependency was added; React, Remotion, Three.js, Playwright and bundled FFmpeg already exist here.

Successful model calls record provider, model, runtime, usage and reported cost in private `state/model-calls.jsonl`. Incremental subscription expense remains unknown; no full-edition savings percentage is claimed. Failed requests and non-model media work are not a complete cost ledger.

## Preview and verification

```sh
npm run studio
# Open StoryVisual for the neutral Three.js preview.
npx remotion still video/index.ts StoryVisual scene.png --frame=24 --gl=angle
npm test
npm run typecheck
```

Local controlled validation covered a narrated Three.js assembly and an official Remotion demo, actual decoded MP4/GIF/poster derivatives, exact GIF reuse in LinkedIn HTML, phone screenshots, and newsletter narration seek/replay/offscreen/reduced-motion behavior. Evidence is in `docs/visual-intelligence-validation-2026-09-07.json`. Generated media and voice data remain outside the release repository.

A fresh model-generated end-to-end edition remains unverified when the configured model has no available quota. Local LinkedIn HTML checks do not prove LinkedIn kept the uploaded GIFs: the existing live publisher does not yet call the artifact-based image verifier. No external publication was exercised by this validation. Generated daily presenters and measured full-edition cost comparisons remain outside this update.
