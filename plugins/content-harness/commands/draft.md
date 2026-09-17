---
description: Prepare the current sourced draft and inspect its exact returned job
argument-hint: [edition]
---

Call `harness_setup` and `harness_status` first. Confirm the saved brief/topics and edition match the user's current request. Never treat any package from today as the current result merely because its date matches. If Describe has changed or the match is uncertain, have the owner use Create my preview for the current brief instead of drafting against old saved topics.

When setup matches and generation was requested, call `harness_draft` with the requested configured edition (or the saved default) and a fresh stable `requestId`. For identical retry inputs, retain the original ID. Read the returned `job` using `harness_status` with its `job` field; never pass `requestId` to status. Inspect an exact returned package using `packageId`. If the job is active, keep checking that job without starting another.

Report the exact package, status and next local review step. Story or visual selection is a pause for the owner's choice. A failed stage must include the actual validator message. An earlier package is earlier work, not the new request. Publication is disabled in this evaluation.
