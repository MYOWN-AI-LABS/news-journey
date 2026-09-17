# Security policy

This software runs on your own computer. It is not an internet-facing generation service. Keep its control server on loopback; do not remove Host, Origin or credential checks to expose it remotely.

Report security problems privately to **saaket@myownailabs.com**. Include the release identifier, affected boundary and reproduction using synthetic data. Do not send passwords, API keys, session cookies, private source documents, voice samples or unredacted logs. Do not open a public issue containing exploit details or credentials.

Only the current release receives fixes. The maintainer will assess the report, reproduce it in an isolated workspace and prepare a correction before disclosure. No response-time guarantee is offered.

Source pages, model replies and imported files are untrusted. Publishing goes only to the channels you connect, after your review. A model connection check or passing unit tests do not establish factual accuracy or secure hosted deployment.

Before distributing a new archive, review its actual extracted inventory, scan files and reachable Git history for secrets, check dependencies, run the release checks and repeat the relevant isolation tests. Do not include workspaces, credentials, logs, model weights or private Git history.

Original harness source is MIT licensed. Third-party components retain their own terms; see THIRD_PARTY_NOTICES.md.
