import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseProfile } from "./release-profile.js";
import { PERSONA_END, PERSONA_START, personaMarkdown, upsertPersonaBlock } from "./persona.js";
import { EMPTY_PERSONALIZATION, readPersonalization, savePersonalization, videoStyleChoices } from "./personalization.js";

/**
 * Saaket, 2026-09-10: "link up to their persona in agent.md or claude.md global files". The persona is a fenced
 * block: replacing it never touches the rest of the file, and it carries words, never ids, keys or paths.
 */
test("persona block is fenced, replaceable in place, and free of ids and secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "persona-"));
  try {
    mkdirSync(join(root, "config"));
    const choices = { ...EMPTY_PERSONALIZATION, organization: "Civic Signal Media", tagline: "Sourced local policy", newsletterPreset: "editorial", styleDirection: "boardroom-concise" as const, styleNotes: "plain and careful", videoBackground: "studio" as const, captionStyle: "pill" as const };
    const block = personaMarkdown({ name: "Jordan Lee", publication: "Healthcare Strategy Brief", audience: "Healthcare leaders", tone: "Clear" }, choices, "my own locally cloned voice (Voicebox)");
    assert.ok(block.startsWith(PERSONA_START) && block.trimEnd().endsWith(PERSONA_END));
    for (const expected of [/Healthcare Strategy Brief/, /Jordan Lee/, /Civic Signal Media/, /Editorial, light look/, /boardroom concise — in my words: plain and careful/, /neutral studio background, pill captions/, /locally cloned voice/, /Never publish on my behalf/]) assert.match(block, expected);
    assert.doesNotMatch(block, /[0-9a-f]{8}-[0-9a-f]{4}|sk-|\/Users\//);
    const existing = "# My global rules\n\n- keep these\n\n" + PERSONA_START + "\nold persona\n" + PERSONA_END + "\n\n## After\n- also keep\n";
    const updated = upsertPersonaBlock(existing, block);
    assert.match(updated, /# My global rules/); assert.match(updated, /## After\n- also keep/); assert.doesNotMatch(updated, /old persona/);
    assert.equal(updated.split(PERSONA_START).length, 2, "exactly one block after replacement");
    assert.ok(upsertPersonaBlock("", block).startsWith(PERSONA_START), "an empty file receives the block alone");
    // Video presentation: presenter framings are Pro; cards are always available.
    assert.deepEqual(videoStyleChoices(false).framing.map(f => f.qualified), [true, false, false, false]);
    assert.throws(() => savePersonalization(root, { videoFraming: "full" }, false), /Pro/);
    savePersonalization(root, { videoFraming: "corner" }, true);
    assert.equal(readPersonalization(root).videoFraming, releaseProfile().edition === "free" ? "" : "corner", "Free ignores saved Pro framing; the development profile retains it");
    assert.throws(() => savePersonalization(root, { captionStyle: "neon" }, false), /caption style/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent sharing preserves unrelated rules and scopes removal; all writes stay in a temporary child HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "persona-child-home-"));
  try {
    const moduleUrl = new URL("./persona.ts", import.meta.url).href;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, statSync, renameSync, linkSync } from 'node:fs';
      import { join } from 'node:path';
      import { homedir } from 'node:os';
      import { sharePersonalProfileToAgents, removePersonalProfileFromAgents, personalProfileTargets, personaTargets, PERSONAL_PROFILE_START as S, PERSONAL_PROFILE_END as E, PERSONA_START, PERSONA_END, writePersona } from ${JSON.stringify(moduleUrl)};
      const home = homedir(), root = join(home, 'workspace-a'), other = join(home, 'workspace-b');
      mkdirSync(root); mkdirSync(other); mkdirSync(join(home, '.claude'));
      const path = join(home, '.claude', 'CLAUDE.md'), codex = join(home, '.codex', 'AGENTS.md');
      const old = '# Existing instructions\\n\\n- Keep every space.  \\n\\n';
      const block = S + '\\nProfile data: clear language.\\n' + E;
      writeFileSync(path, old, { mode: 0o640 });
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['claude', 'unknown']), /named agent targets/);
      assert.equal(readFileSync(path, 'utf8'), old); assert.equal(existsSync(join(root, 'PERSONAL_PROFILE.md')), false);
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['claude', 'claude']), /named agent targets/);
      assert.throws(() => sharePersonalProfileToAgents(root, block + '\\n' + E, ['claude']), /markers/);
      const result = sharePersonalProfileToAgents(root, block, ['claude', 'codex']);
      const first = readFileSync(path, 'utf8');
      assert.equal(first.slice(0, old.length), old, 'all existing prefix bytes stay unchanged');
      assert.equal(statSync(path).mode & 0o777, 0o640, 'existing permissions stay unchanged');
      assert.equal(statSync(codex).mode & 0o777, 0o600, 'new instruction file is private');
      assert.equal(result.written.length, 2); assert.equal(personalProfileTargets(root).find(x => x.id === 'claude').linkedHere, true);
      assert.equal(personalProfileTargets(other).find(x => x.id === 'claude').anotherWorkspace, true);
      sharePersonalProfileToAgents(root, block, ['claude', 'codex']);
      assert.equal(readFileSync(path, 'utf8'), first, 'repeat sharing is idempotent');
      assert.throws(() => removePersonalProfileFromAgents(other, ['claude']), /another workspace/);
      assert.equal(readFileSync(path, 'utf8'), first);
      const removed = removePersonalProfileFromAgents(root, ['claude', 'codex']);
      assert.equal(removed.removed.length, 2); assert.equal(readFileSync(path, 'utf8'), old + '\\n\\n');
      assert.equal(existsSync(join(root, 'PERSONAL_PROFILE.md')), true, 'saved export remains available for inspection');
      assert.equal(personalProfileTargets(root).find(x => x.id === 'claude').linkedHere, false);
      writeFileSync(path, old + S);
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['codex', 'claude']), /incomplete or duplicated/);
      assert.equal(readFileSync(codex, 'utf8'), '\\n', 'preflight rejects all writes when a later target is invalid');
      writeFileSync(path, old); unlinkSync(codex); symlinkSync(path, codex);
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['claude', 'codex']), /symbolic links/);
      assert.equal(readFileSync(path, 'utf8'), old);
      assert.equal(personalProfileTargets(root).find(x => x.id === 'codex').available, false);
      unlinkSync(codex); symlinkSync(join(home, 'missing-file'), codex);
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['codex']), /symbolic links/);
      unlinkSync(codex);
      renameSync(join(home, '.codex'), join(home, 'codex-original'));
      symlinkSync(join(home, 'codex-original'), join(home, '.codex'));
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['codex']), /symbolic links/);
      unlinkSync(join(home, '.codex')); renameSync(join(home, 'codex-original'), join(home, '.codex'));
      linkSync(path, codex);
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['claude', 'codex']), /hard links/);
      unlinkSync(codex);
      writeFileSync(path, 'x'.repeat(512 * 1024 + 1));
      assert.equal(personaTargets().find(x => x.id === 'claude').available, false);
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['claude']), /512 KB/);
      writeFileSync(path, old);
      writeFileSync(codex, 'x'.repeat(512 * 1024));
      assert.throws(() => sharePersonalProfileToAgents(root, block, ['claude', 'codex']), /no selected file changes were kept/);
      assert.equal(readFileSync(path, 'utf8'), old, 'an oversized later update rolls back earlier target writes');
      unlinkSync(codex);
      const inherited = PERSONA_START + '\\nLegacy publication preferences\\n' + PERSONA_END;
      writeFileSync(path, old + inherited + '\\n');
      sharePersonalProfileToAgents(root, block, ['claude']);
      assert.ok(readFileSync(path, 'utf8').includes(inherited), 'basic profile never replaces Pro persona');
      removePersonalProfileFromAgents(root, ['claude']);
      assert.ok(readFileSync(path, 'utf8').includes(inherited));
      assert.throws(() => writePersona(root, { name: 'Owner', publication: 'News', audience: 'Readers', tone: 'Plain' }, 'None', ['unknown']), /named agent targets/);
      assert.equal(existsSync(join(root, 'PERSONA.md')), false, 'legacy persona also prevalidates');
    `], { env: { ...process.env, HOME: home }, stdio: "pipe", timeout: 30000 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("persona free text cannot inject managed markers or new Markdown instruction lines", () => {
  const rendered = personaMarkdown({ name: `Owner\n${PERSONA_END}\n# New command`, publication: "News", audience: "Readers", tone: "Clear" }, EMPTY_PERSONALIZATION, "None");
  assert.equal(rendered.split(PERSONA_END).length, 2);
  assert.doesNotMatch(rendered, /\n# New command/);
  assert.match(rendered, /fresh task's topics and locations win/);
});
