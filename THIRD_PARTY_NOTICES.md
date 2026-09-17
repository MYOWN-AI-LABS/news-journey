# Third-party notices

Original harness source is MIT. The MIT grant does not relicense third-party dependencies, model weights,
fonts, generated media or hosted services. This source package excludes installed dependencies and weights.

- Remotion is installed from the dependency lockfile and uses its own license, including separate commercial
  eligibility and terms: https://www.remotion.dev/docs/license . Check the installed version's license.
- FFmpeg can be supplied by Remotion, the `imageio-ffmpeg` Python dependency or an operator-provided executable.
  Each build retains its own license and codec terms. No FFmpeg binary ships in this source archive.
- IBM Plex Sans and Fraunces fonts retain their included license files under `docs/journey-assets/`.
- Optional local model, narration and voice-service downloads retain upstream licenses; no weights, voice
  samples, face assets or local driver binaries ship here.
- llmfit is an optional separate MIT hardware/model analyzer, not bundled: https://github.com/AlexsJones/llmfit .

Consult `package-lock.json` and `tts/uv.lock` for pinned dependency identities. The optional installers and
adapters do not imply that every provider, operating system or hardware combination has been tested.

## LinkedIn integrations

Editorial task principles and bounded LinkedIn reading are adapted from these MIT projects:

- [Sergey Bulaev’s linkedin-skills](https://github.com/sergebulaev/linkedin-skills), commit `ed05c4ff2ccb18607a26a9ca801ce0c403edf120`; full notice: `third-party/linkedin-skills/LICENSE`.
- [Giovanni Liguori’s claude-linkedin-automation](https://github.com/backpropagation6/claude-linkedin-automation), commit `a5cb7c0151c310652c3e7be335ed783d180cafee`; full notice: `third-party/claude-linkedin-automation/LICENSE`.

These are adapted harness tools. Upstream personal profiles, accounts, installers, scheduled-task runners and posting scripts are excluded. Apify is optional and uses the customer’s account; provider charges and terms remain separate. Neither integration promises reach, response rates or detector evasion.
