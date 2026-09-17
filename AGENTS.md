# Free harness contributor instructions

This is the Free MIT distribution. Read README.md and CLAUDE.md.
Keep the original request, model identity, cumulative budgets and selected length when resuming; do not treat a connection or claim-ID task as a full writing qualification.
Run `node start.mjs` from this directory. It installs declared JavaScript dependencies and opens a loopback
browser workspace. Stop the foreground process with Ctrl+C and run the same command to restart.

`config/distribution.json` belongs to this code package; never copy it from a workspace. It carries `edition: free`
and an `evaluation` flag: `true` is the private-beta build (publication locked), `false` is the public build
(publishing available after review). Keep Pro operations unavailable in either. Never enable a destination,
attach an account, start a paid request or publish as part of setup.
Provider credentials and all generated publication artifacts belong to an ignored customer workspace.

The default writer must be selected by the operator. Do not guess API keys, voice identities, browser profiles
or local executables. Rescue to a hosted writer is off by default. Optional integrations are not bundled runtimes.
Review actual generated artifacts; passing schemas and fixture tests do not prove factual or visual quality.
Never substitute another narrator or publish on a generation failure. Preserve exact source and artifact IDs.

Run `npm test`, `npm run typecheck` and `npm run dry-run` after relevant edits. Tests exercise the Free
distribution; private development-only Pro and founder-guide tests are not the public acceptance suite.
Inspect the actual browser on desktop and phone widths after UI changes. No external accounts are required
for the synthetic checks. Native Windows and other hardware need separate live verification.

Keep LICENSE and third-party notices. The repository is MIT; separately licensed dependencies and future
Pro services do not change that grant. No private beta records, premium packs, installed drivers or weights
may enter a redistributed archive. Do not expose old development history as a public release.
