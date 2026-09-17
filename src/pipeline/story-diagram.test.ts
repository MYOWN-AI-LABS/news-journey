import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { critiqueAtPhoneScale, diagramValidationProblem, ensureEditionDiagrams, persistedVisualReleaseProblem, visualReleaseProblem, type AuthoredDiagram } from "./story-diagram.js";
import { ensureVisualCandidates, lockVisualChoices, readVisualCandidates, VisualChoiceRequired } from './visual-choice.js';
import { diagramSourceReceipt } from './diagram-source-support.js';
import { createSourceSupportContext } from './source-support.js';
import type { Topic } from '../types.js';
import { preparedScriptReceipt } from './writing-context.js';
import { roleHash } from '../llm/role-router.js';
import { savePersonalization } from '../personalization.js';
import { activeRoot } from '../workspaces.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const fixtureTopic = { stories: [1, 2].map(n => ({ n, primaryUrl: 'https://example.org/transit', verifiedClaims: ['The city announced a proposed transit pilot.'] })) } as Topic;
const noVisualCalls = { call: (_stage: 'visual') => async <T>(): Promise<T> => { throw new Error('No unused visual model request'); }, writerKey: 'isolated-fixture', topic: fixtureTopic, day: '2026-09-09' };
const sourceFixtureCalls = { ...noVisualCalls, call: (_stage: 'visual') => async <T>(prompt: string): Promise<T> => {
  if (!prompt.startsWith('AUTHORED FIELD SOURCE REVIEW')) throw new Error('No unused visual model request');
  const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
  return { fields: fields.map((field: { id: string }) => ({ id: field.id, supported: true, claimIds: [1], reason: 'Injected source-review receipt for cache mechanics.' })) } as T;
} };
const fixtureEvidence = (presentation: unknown) => ({ claims: fixtureTopic.stories![0]!.verifiedClaims!, sourceContext: createSourceSupportContext(noVisualCalls.day, 'https://example.org/transit', []), writerKey: noVisualCalls.writerKey, presentation });

/** A fixture workspace with the installed template config and the Sep 14–16 review port switched on: these tests
 * assert the port's diagram source review and receipts. (They used to pass only because the developer's gitignored
 * workspaces/default predated the `journeyReview: "script"` template default — CI and a fresh worktree have none.) */
async function withReviewPort<T>(run: () => Promise<T>, personalization?: Record<string, unknown>): Promise<T> {
  const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
  mkdirSync(join(codeRoot, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(codeRoot, 'workspaces/test-diagram-review-port-'));
  const slug = workspace.split(/[\\/]/).at(-1);
  const token = 'd'.repeat(64);
  const previous = process.env.HARNESS_WORKSPACE;
  cpSync(join(codeRoot, 'config'), join(workspace, 'config'), { recursive: true });
  const pipeline = JSON.parse(readFileSync(join(workspace, 'config/pipeline.json'), 'utf8'));
  writeFileSync(join(workspace, 'config/pipeline.json'), JSON.stringify({ ...pipeline, journeyReview: 'daily-signal-port' }));
  writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
  writeFileSync(join(workspace, 'members.json'), JSON.stringify([{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]));
  process.env.HARNESS_WORKSPACE = slug;
  if (personalization) savePersonalization(activeRoot(), personalization, false);
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete process.env.HARNESS_WORKSPACE; else process.env.HARNESS_WORKSPACE = previous;
    rmSync(workspace, { recursive: true, force: true });
  });
}
/** Isolate Journey snapshot cost-skip tests from the default newsletterImages=true Daily Signal path. */
async function withTextOnlyNewsletterImages<T>(run: () => Promise<T>): Promise<T> {
  return withReviewPort(run, { newsletterImages: false });
}


function authored(n: number): AuthoredDiagram {
  return {
    svg: `<svg class="tm-story-svg tm-svg-authored" data-visual-primitive="authored-${n}" viewBox="0 0 720 340" role="img" aria-labelledby="tm-visual-${n}"><title id="tm-visual-${n}">A factual mechanism</title><rect class="tm-sc-node" x="20" y="60" width="100" height="70"/><rect class="tm-sc-node" x="180" y="60" width="100" height="70"/><circle class="tm-sc-core-dot" cx="70" cy="95" r="8"/><circle class="tm-sc-core-dot" cx="230" cy="95" r="8"/><line class="tm-native-route" x1="120" y1="95" x2="180" y2="95"/><path class="tm-native-trace" d="M120 110 L180 110"/></svg>`,
    label: "MECHANISM",
    reading: "Read from left to right.",
    legend: [{ kind: "source", label: "input" }, { kind: "result", label: "output" }],
  };
}

test('valid locked headline choices skip unused artwork on resume; changed context cannot reuse them', async () => {
  await withTextOnlyNewsletterImages(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locked-headline-resume-'));
  try {
    const body = [{ onScreen: { title: 'Transit pilot announced' }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Bus service', impact: 'Results not measured', status: 'Announced' } }];
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ primaryUrl: 'https://example.org/transit', verifiedClaims: ['The city announced a transit pilot.'] }));
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ body }));
    const invalid = [{ ...authored(1), svg: '<svg>unused fallback</svg>' }];
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(invalid));
    const candidates = ensureVisualCandidates(dir, body, invalid, false);
    lockVisualChoices(dir, candidates, { '0': 'snapshot' }, 'user');
    let authoredCalls = 0;
    const author = async () => { authoredCalls++; throw new Error('Unexpected unused artwork request'); };
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Snapshot resume must not call a model or network service'); };
    try {
      const out = await ensureEditionDiagrams(dir, body, false, author, noVisualCalls);
      assert.equal(out[0].svg, ''); assert.equal(out[0].visual?.kind, 'diagram');
      assert.deepEqual(out[0].visual?.cues, []); assert.equal(authoredCalls, 0);
      assert.equal(networkCalls, 0, 'a caught model error must not conceal an unused request');
      const receipt = JSON.parse(readFileSync(join(dir, 'newsletter-visuals.json'), 'utf8'));
      assert.equal(receipt.scriptHash, roleHash({ body }));
      assert.equal(receipt.contentHash, roleHash(out));
      assert.deepEqual(receipt.diagrams, JSON.parse(JSON.stringify(out)), 'Newsletter presentation retains the actual completed selection');
      body[0].motion.status = 'Pilot scope changed';
      await assert.rejects(ensureEditionDiagrams(dir, body, false, author, noVisualCalls), /Unexpected unused artwork request/);
      assert.equal(authoredCalls, 1, 'a changed candidate must invalidate the skip path');
    } finally { globalThis.fetch = originalFetch; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


test('a locked headline card never authors unused artwork, even with newsletter images on (decision A)', async () => {
  const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
  const workspace = mkdtempSync(join(codeRoot, 'workspaces/test-diagram-newsletter-images-'));
  const slug = workspace.split(/[\\/]/).at(-1)!;
  const previous = process.env.HARNESS_WORKSPACE;
  mkdirSync(join(workspace, 'config'), { recursive: true });
  writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
  process.env.HARNESS_WORKSPACE = slug;
  savePersonalization(activeRoot(), { newsletterImages: true }, false);
  const dir = mkdtempSync(join(tmpdir(), 'locked-headline-newsletter-images-'));
  try {
    const body = [{ onScreen: { title: 'Transit pilot announced' }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Bus service', impact: 'Results not measured', status: 'Announced' } }];
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ primaryUrl: 'https://example.org/transit', verifiedClaims: ['The city announced a transit pilot.'] }));
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ body }));
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...authored(1), svg: '<svg>unused fallback</svg>' }]));
    const candidates = ensureVisualCandidates(dir, body, [{ ...authored(1), svg: '<svg>unused fallback</svg>' }], false);
    lockVisualChoices(dir, candidates, { '0': 'snapshot' }, 'user');
    let authoredCalls = 0;
    const author = async (_story: unknown, n: number) => { authoredCalls++; return authored(n); };
    const out = await ensureEditionDiagrams(dir, body, false, author, sourceFixtureCalls);
    assert.equal(authoredCalls, 0, 'nothing is drawn that nobody chose; the newsletter refuses a text card as imagery instead');
    assert.equal(out[0].svg, '', 'the locked headline card carries no SVG');
  } finally {
    if (previous === undefined) delete process.env.HARNESS_WORKSPACE; else process.env.HARNESS_WORKSPACE = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('mixed locked visuals retain current explanations and reject stale reviews on resume', () => withReviewPort(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locked-mixed-resume-'));
  const body = [1, 2].map(n => ({ onScreen: { title: `Story ${n}` }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Bus service', impact: 'Results not measured', status: 'Announced' } }));
  const author = async () => { throw new Error('Unexpected unused artwork request'); };
  const originalFetch = globalThis.fetch;
  try {
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ primaryUrl: 'https://example.org/transit' }));
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ body }));
    const second = { ...authored(2), sourceReview: diagramSourceReceipt(authored(2), fixtureEvidence(body[1])) };
    const diagrams = await critiqueAtPhoneScale(dir, body, [{ svg: '', label: '', reading: '', legend: [] }, second], author, async () => ({ passed: true, reason: 'Readable mechanism' }) as any, async () => 'unused.png');
    diagrams[0] = { ...authored(1), svg: '<svg>unused fallback</svg>' };
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(diagrams));
    lockVisualChoices(dir, ensureVisualCandidates(dir, body, diagrams, true), { '0': 'snapshot', '1': 'explanation' }, 'user');
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('No unused model request'); };
    const out = await ensureEditionDiagrams(dir, body, true, author, noVisualCalls);
    assert.equal(out[0].svg, ''); assert.equal(out[1].svg, diagrams[1].svg);
    assert.equal(out[1].review?.status, 'passed'); assert.equal(networkCalls, 0);
    body[1].motion.how = 'Changed mechanism'; // Candidate caption/status unchanged, but phone review is stale.
    await assert.rejects(ensureEditionDiagrams(dir, body, true, author, noVisualCalls), /no current source review/);
  } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
}));

test('a retained source choice cannot fall back to an unchecked unused diagram', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locked-image-fallback-'));
  const body = [{ onScreen: { title: 'Transit pilot' }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Bus service', impact: 'Unknown', status: 'Announced' } }];
  try {
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ primaryUrl: 'https://example.org/transit' }));
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ body }));
    writeFileSync(join(dir, 'own.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(join(dir, 'assets.json'), JSON.stringify({ 'og-0-own': 'own.png' }));
    const diagrams = [{ ...authored(1), svg: '<svg>unchecked fallback</svg>' }];
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(diagrams));
    lockVisualChoices(dir, ensureVisualCandidates(dir, body, diagrams, false), { '0': 'own-image' }, 'user');
    await assert.rejects(ensureEditionDiagrams(dir, body, false, async () => { throw new Error('Unused author request'); }, noVisualCalls), /unused explanation has no current passing review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("diagram validation explains the authored primitive contract", () => {
  assert.equal(diagramValidationProblem(authored(1), 1), null);
  assert.match(diagramValidationProblem({ ...authored(1), svg: authored(1).svg.replace("authored-1", "story-schematic") }, 1)!, /authored-1/);
});

test("encoded links and executable SVG elements cannot enter story artwork", () => {
  for(const payload of ["<rect fill='url(//127.0.0.1/x)'/>",'<a href="jav&#x61;script:alert(1)"><text>click</text></a>','<set attributeName="onload" to="alert(1)"/>','<g style="background:url(https://example.com)"></g>']){
    assert.match(diagramValidationProblem({...authored(1),svg:authored(1).svg.replace('</svg>',payload+'</svg>')},1)!,/forbidden|inline style|external paint/);
  }
});

test("phone critic retries once, checks replacement, and never caches an unavailable review as passed",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"visual-review-"));
  const body=[{onScreen:{title:"An illustrative route"},motion:{kind:"flow" as const,who:"Input",what:"Output",how:"A directed connection",impact:"Explain flow",status:"Illustrative"}}];
  let judgments=0,authors=0;
  const inspect=async()=>({passed:++judgments>1,reason:judgments===1?"Clarify route":"Route is readable"});
  const author=async()=>{authors++;return authored(1);};
  const shot=async()=>"unused.png";
  try{
    const first=await critiqueAtPhoneScale(dir,body,[authored(1)],author,inspect as any,shot);
    assert.equal(first[0].review?.status,"passed");assert.equal(judgments,2);assert.equal(authors,1);
    await critiqueAtPhoneScale(dir,body,first,author,inspect as any,shot);assert.equal(judgments,2);
    const unverified=[{...first[0],review:{...first[0].review!,status:"unverified" as const}}];
    await critiqueAtPhoneScale(dir,body,unverified,author,inspect as any,shot);assert.equal(judgments,3);
    let imageChecks=0;
    const textOnly=await critiqueAtPhoneScale(dir,body,[authored(1)],author,async()=>{imageChecks++;throw new Error("must not run");},async()=>{imageChecks++;return "unused.png";},false);
    assert.equal(imageChecks,0);assert.match(textOnly[0].review!.reason,/cannot look at images/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("a cached schematic is regenerated rather than reused forever", () => withReviewPort(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-content-diagram-test-"));
  try {
    mkdirSync(dir, { recursive: true });
    const body = [{
      onScreen: { title: "Specific story" },
      motion: { kind: "flow" as const, who: "source", what: "change", how: "route", impact: "result", status: "reported" },
    }];
    writeFileSync(join(dir, "script.json"), JSON.stringify({ body }));
    const fallback = { ...authored(1), svg: authored(1).svg.replace("authored-1", "story-schematic") };
    writeFileSync(join(dir, "diagrams.json"), JSON.stringify([fallback]));
    const future = new Date(Date.now() + 1_000);
    utimesSync(join(dir, "diagrams.json"), future, future);
    let calls = 0;
    const previousCritic=process.env.AI_CONTENT_DIAGRAM_CRITIC;
    process.env.AI_CONTENT_DIAGRAM_CRITIC="off";
    const result = await ensureEditionDiagrams(dir, body, true, async (_story, n) => { calls += 1; return authored(n); }, sourceFixtureCalls);
    if(previousCritic===undefined)delete process.env.AI_CONTENT_DIAGRAM_CRITIC;else process.env.AI_CONTENT_DIAGRAM_CRITIC=previousCritic;
    assert.equal(calls, 1);
    assert.match(result[0]!.svg, /authored-1/);
    assert.ok(result[0]!.sourceReview, 'fresh artwork is source-reviewed before it is persisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('production snapshot resume rejects a missing current script receipt before any model or network call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-current-source-'));
  const prior = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('No request expected'); };
  try {
    await assert.rejects(ensureEditionDiagrams(dir, [], false, async () => { calls++; throw new Error('No author expected'); }), /no current source-reviewed script receipt/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = prior; rmSync(dir, { recursive: true, force: true }); }
});

test('diagram transport failure preserves image capability and the exact requested-revision error', async () => {
  const prior = process.env.HARNESS_VISUAL_CHOICE;
  process.env.HARNESS_VISUAL_CHOICE = 'require';
  try {
    for (const mode of ['normal-vision', 'normal-text-only', 'revision'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'diagram-transport-'));
      try {
        const body = [{ assetRef: 'og-0', onScreen: { title: 'Transit pilot' }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Route', impact: 'Unmeasured', status: 'Planned' } }];
        const topic = { ...fixtureTopic, stories: [{ ...fixtureTopic.stories![0], assetRef: 'og-0' }] } as Topic, script = { body };
        writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic));
        writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
        writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(preparedScriptReceipt(topic, noVisualCalls.writerKey, script)));
        writeFileSync(join(dir, 'captured.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        writeFileSync(join(dir, 'assets.json'), JSON.stringify({ 'og-0': 'captured.png' }));
        const context = { ...noVisualCalls, topic, ...(mode === 'revision' ? {
          journal: { kind: 'approved-media-only' }, assertUnchanged() {}, visualRevision: { identity: 'a'.repeat(64), choices: { '0': 'explanation' as const } },
        } : {}) };
        const failure = new Error('Writer process could not initialize: Operation not permitted');
        let calls = 0;
        await assert.rejects(ensureEditionDiagrams(dir, body, mode !== 'normal-text-only', async () => { calls++; throw failure; }, context),
          error => mode === 'revision' ? error === failure : error instanceof VisualChoiceRequired);
        const candidates = readVisualCandidates(dir)!.stories[0].candidates;
        // The source photo attaches for any writer, so it is available in every mode; a text-only writer just does not review it.
        assert.equal(candidates.find(c => c.id === 'image')!.available, true, 'the source photo attaches for a text-only writer too');
        const explanation = candidates.find(c => c.id === 'explanation')!;
        // A transport failure is not a rejection: an image-capable writer's explanation stays requestable (its failure receipt is retained);
        // only a text-only writer cannot request one.
        if (mode === 'normal-text-only') assert.equal(explanation.available, false, 'a text-only writer cannot author or review a diagram');
        else { assert.equal(explanation.available, true); assert.equal(explanation.pending, true, 'a deferred or transport-failed diagram stays requestable'); }
        assert.match(candidates.find(c => c.id === 'image')!.why, mode === 'normal-text-only' ? /source's own reporting photo/ : /Rights are not established/);
        const records = readdirSync(dir).filter(name => name.startsWith('diagram-generation-failed-'));
        if (mode === 'revision') {
          // Only the revision explicitly asked for the explanation, so it is authored once and its failure recorded.
          assert.equal(calls, 1, 'The failed call is not retried');
          assert.equal(records.length, 1);
          assert.equal(JSON.parse(readFileSync(join(dir, records[0]), 'utf8')).error, failure.message);
          assert.equal(existsSync(join(dir, 'diagrams.json')), false);
        } else {
          // A usable photograph is the recommendation: no diagram is authored for vision or text-only.
          assert.equal(calls, 0, 'artwork is deferred while a usable photograph is recommended');
          assert.equal(records.length, 0);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  } finally { if (prior === undefined) delete process.env.HARNESS_VISUAL_CHOICE; else process.env.HARNESS_VISUAL_CHOICE = prior; }
});

test('rejected source artwork exposes an explicit headline choice and keeps its failure without persisting accepted SVG', async () => {
  await withTextOnlyNewsletterImages(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagram-source-choice-'));
  const prior = process.env.HARNESS_VISUAL_CHOICE; process.env.HARNESS_VISUAL_CHOICE = 'require';
  const body = [{ onScreen: { title: 'A proposed transit pilot' }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Route', impact: 'Unmeasured', status: 'Planned' } }];
  let authors = 0, reviews = 0;
  const author = async () => { authors++; return authored(1); };
  const context = { ...noVisualCalls, call: (_stage: 'visual') => async <T>(prompt: string): Promise<T> => {
    reviews++; const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
    return { fields: fields.map((field: { id: string }) => ({ id: field.id, supported: false, claimIds: [1], reason: 'This candidate claims an unsupported outcome.' })) } as T;
  } };
  try {
    writeFileSync(join(dir, 'topic.json'), JSON.stringify({ ...fixtureTopic, stories: [fixtureTopic.stories![0]] }));
    writeFileSync(join(dir, 'script.json'), JSON.stringify({ body }));
    await assert.rejects(ensureEditionDiagrams(dir, body, false, author, context), VisualChoiceRequired);
    assert.equal(authors, 1); assert.equal(reviews, 1); assert.equal(existsSync(join(dir, 'diagrams.json')), false);
    const failures = readdirSync(dir).filter(path => path.startsWith('diagram-source-rejected-')); assert.equal(failures.length, 1);
    const candidates = readVisualCandidates(dir)!;
    assert.ok(candidates.stories[0]!.candidates.find(row => row.id === 'snapshot')!.available);
    assert.equal(candidates.stories[0]!.candidates.find(row => row.id === 'explanation')!.available, false);
    lockVisualChoices(dir, candidates, { '0': 'snapshot' }, 'user');
    const out = await ensureEditionDiagrams(dir, body, false, author, context);
    assert.equal(out[0]!.svg, ''); assert.equal(authors, 1); assert.equal(reviews, 1);
    assert.deepEqual(readdirSync(dir).filter(path => path.startsWith('diagram-source-rejected-')), failures);
  } finally { if (prior === undefined) delete process.env.HARNESS_VISUAL_CHOICE; else process.env.HARNESS_VISUAL_CHOICE = prior; rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * Regression: the 2026-08-21 editions shipped 49 unreadable labels because the model authored its
 * own LIGHT palette. A presentation attribute loses to any stylesheet rule, so the labels were
 * repainted near-white by .tm-svg-label while the untagged background rect survived — near-white on
 * near-white, 1.0:1. These are the exact shapes that defect took.
 */
test("authored colour is rejected so the stylesheet stays the only source of colour", () => {
  const base = authored(1);

  // every <text> carrying its own dark fill — the literal 2026-08-21 defect
  const inlineText = base.svg.replace(
    "</svg>",
    `<text class="tm-svg-label" x="70" y="95" fill="#2d3142">CLOUD AGENT</text></svg>`,
  );
  assert.match(diagramValidationProblem({ ...base, svg: inlineText }, 1)!, /must not author colour/);

  // an authored stroke colour is equally forbidden
  const inlineStroke = base.svg.replace(
    '<line class="tm-native-route" x1="120" y1="95" x2="180" y2="95"/>',
    '<line class="tm-native-route" x1="120" y1="95" x2="180" y2="95" stroke="#bfc0c0"/>',
  );
  assert.match(diagramValidationProblem({ ...base, svg: inlineStroke }, 1)!, /must not author colour/);

  // the opaque full-bleed rect that covered the dark stage
  const backdrop = base.svg.replace(
    "<title",
    '<rect x="0" y="0" width="720" height="340" fill="#f5f5f5"/><title',
  );
  assert.match(diagramValidationProblem({ ...base, svg: backdrop }, 1)!, /full-bleed background rect/);

  // fill="none" is a GEOMETRY declaration, not a colour, and must still pass — stroke-only paths
  // depend on it. An SVG <path> with no fill:none paints SOLID BLACK.
  const noneFill = base.svg.replace(
    '<path class="tm-native-trace" d="M120 110 L180 110"/>',
    '<path class="tm-native-trace" d="M120 110 L180 110" fill="none"/>',
  );
  assert.equal(diagramValidationProblem({ ...base, svg: noneFill }, 1), null);

  // attributes that merely START with fill/stroke are dimensions, not colour, and must not trip it
  const dimensions = base.svg.replace(
    '<path class="tm-native-trace" d="M120 110 L180 110"/>',
    '<path class="tm-native-trace" d="M120 110 L180 110" stroke-width="2" stroke-dasharray="4 4" fill-opacity="0.44"/>',
  );
  assert.equal(diagramValidationProblem({ ...base, svg: dimensions }, 1), null);
});

test("a diagram with no tm-native-trace connector is rejected — every edition animates", () => {
  const still = { ...authored(1), svg: authored(1).svg.replace(/tm-native-trace/g, "tm-native-route") };
  assert.match(diagramValidationProblem(still, 1)!, /no animated connector/);
  assert.equal(diagramValidationProblem(authored(1), 1), null);
});

/**
 * Regression for the 2026-09-09 Daily Political Beat package: story 1's phone review recorded
 * `failed` (review c6649a…46b — qualifiers dropped, 320px labels unreadable) and the package still
 * reached `pending_review`. The critic only ever wrote its verdict; this gate is what acts on it.
 */
test("a failed or unfinished phone review blocks release; only the operator's explicit opt-out passes an unverified diagram", () => {
  const failed: AuthoredDiagram = { ...authored(1), review: {
    status: "failed", sha256: "c6649a61c00f1e532e6c8985d0bcb45bb2f0a3a89be3817755b34222ecedc46b",
    reason: "Both compositions avoid headline/caption overlap, but essential qualifiers are dropped: “asbestos found near Ground Zero for months,” “days after the attacks,” “including the EPA,” and “thousands” are not shown. The 320px version is also overly compressed, making several mechanism labels and icons difficult to read.",
    before: "diagram-1-before-320.png",
  } };
  const passed: AuthoredDiagram = { ...authored(2), review: { status: "passed", sha256: "0e87ce60", reason: "Readable." } };
  const unverified: AuthoredDiagram = { ...authored(3), review: { status: "unverified", sha256: "c10bf847", reason: "Vision request timed out." } };

  assert.equal(visualReleaseProblem([passed, passed]), null);
  assert.equal(visualReleaseProblem([authored(1)]), null, "a story without a review has no visual to judge");
  const problem = visualReleaseProblem([passed, failed])!;
  assert.match(problem, /^Story 2 visual did not pass its phone check: /);
  assert.match(problem, /including the EPA/);
  assert.match(problem, /cannot be reviewed or published/);
  assert.match(problem, /Create a new draft to author fresh artwork/);

  const previousCritic = process.env.AI_CONTENT_DIAGRAM_CRITIC;
  try {
    delete process.env.AI_CONTENT_DIAGRAM_CRITIC;
    assert.match(visualReleaseProblem([unverified])!, /^Story 1 visual could not be checked: Vision request timed out/);
    assert.match(visualReleaseProblem([unverified])!, /Retry once the visual check can complete/);
    const both = visualReleaseProblem([failed, passed, unverified])!;
    assert.match(both, /Story 1 visual did not pass/); assert.match(both, /Story 3 visual could not be checked/, "every failing story is reported, not only the first");
    process.env.AI_CONTENT_DIAGRAM_CRITIC = "off";
    assert.equal(visualReleaseProblem([unverified]), null, "the operator's explicit opt-out is honoured");
    assert.match(visualReleaseProblem([failed])!, /did not pass/, "a recorded failure is never waived");
  } finally {
    if (previousCritic === undefined) delete process.env.AI_CONTENT_DIAGRAM_CRITIC; else process.env.AI_CONTENT_DIAGRAM_CRITIC = previousCritic;
  }

  const clip = { ...failed, visual: { kind: "clip", media: { review: { passed: true } } } as unknown as AuthoredDiagram["visual"] };
  assert.equal(visualReleaseProblem([clip]), null, "a story shown as reviewed media is judged by that media's review, not the unused diagram");
});

test("approval requires current source and phone receipts; only a locked choice skips unused artwork", () => withReviewPort(async () => {
  const root = mkdtempSync(join(tmpdir(), "visual-persisted-")), dir = join(root, '20260909-fixture'); mkdirSync(dir);
  try {
    const body = ['First pilot', 'Second pilot'].map(title => ({ onScreen: { title }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Bus service', impact: 'Not measured', status: 'Announced' } })), script = { body };
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(fixtureTopic)); writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
    writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(preparedScriptReceipt(fixtureTopic, noVisualCalls.writerKey, script)));
    const current = await critiqueAtPhoneScale(dir, body, body.map((segment, i) => ({ ...authored(i + 1), sourceReview: diagramSourceReceipt(authored(i + 1), fixtureEvidence(segment)) })),
      async () => { throw new Error('Passing fixture never requests new artwork'); }, async () => ({ passed: true, reason: 'Injected phone inspection of the exact current composition.' }) as any, async () => 'unused.png');
    const passed = current[1]!;
    for (const review of [undefined, { ...current[0]!.review!, sha256: '0e87ce60' }]) {
      writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...current[0]!, review }, passed]));
      assert.match(persistedVisualReleaseProblem(dir)!, /Story 1 has no current phone review/, 'missing or arbitrary passed verdicts cannot stand in for the exact composition');
    }
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(current));
    assert.equal(persistedVisualReleaseProblem(dir), null, 'the production critic hash is accepted for unchanged source-reviewed artwork');
    const changedGeometry = { ...current[0]!, svg: current[0]!.svg.replace('cx="70"', 'cx="71"') };
    changedGeometry.sourceReview = diagramSourceReceipt(changedGeometry, fixtureEvidence(body[0]));
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([changedGeometry, passed]));
    assert.match(persistedVisualReleaseProblem(dir)!, /no current phone review/, 'a new source receipt cannot carry an old pixel review across a geometry change');
    const previousCritic = process.env.AI_CONTENT_DIAGRAM_CRITIC;
    try {
      const unverified = { ...current[0]!, review: { ...current[0]!.review!, status: 'unverified' as const, reason: 'Phone inspection was unavailable.' } };
      writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([unverified, passed]));
      delete process.env.AI_CONTENT_DIAGRAM_CRITIC;
      assert.match(persistedVisualReleaseProblem(dir)!, /could not be checked/);
      process.env.AI_CONTENT_DIAGRAM_CRITIC = 'off';
      assert.equal(persistedVisualReleaseProblem(dir), null, 'explicit opt-out permits only a current hash-bound unfinished review');
      writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...unverified, review: { ...unverified.review, sha256: 'old' } }, passed]));
      assert.match(persistedVisualReleaseProblem(dir)!, /no current phone review/, 'opt-out does not make stale composition identity current');
    } finally { if (previousCritic === undefined) delete process.env.AI_CONTENT_DIAGRAM_CRITIC; else process.env.AI_CONTENT_DIAGRAM_CRITIC = previousCritic; }
    const rejected = { ...current[0]!, review: { ...current[0]!.review!, status: 'failed' as const, reason: 'qualifiers dropped' } };
    writeFileSync(join(dir, "diagrams.json"), JSON.stringify([rejected, passed]));
    assert.match(persistedVisualReleaseProblem(dir)!, /^Story 1 visual did not pass/, "no visual plan saved: the diagrams are what ships");
    writeFileSync(join(dir, "visual-results.json"), JSON.stringify([{ kind: "clip" }, { kind: "diagram" }]));
    assert.match(persistedVisualReleaseProblem(dir)!, /Story 1 visual did not pass/, 'a stale display kind is not an explicit current choice');
    writeFileSync(join(dir, "diagrams.json"), JSON.stringify([{ ...rejected, visual: { kind: 'source' } }, passed]));
    assert.match(persistedVisualReleaseProblem(dir)!, /Story 1 visual did not pass/, 'embedded stale display metadata cannot waive the phone gate either');
    lockVisualChoices(dir, ensureVisualCandidates(dir, body, [rejected, passed] as AuthoredDiagram[], true), { '0': 'snapshot', '1': 'explanation' }, 'user');
    assert.equal(persistedVisualReleaseProblem(dir), null, 'the current hash-locked headline choice makes only its own SVG unused');
    rmSync(join(dir, 'visual-choices.json'));
    writeFileSync(join(dir, "visual-results.json"), JSON.stringify([{ kind: "diagram" }, { kind: "diagram" }]));
    assert.match(persistedVisualReleaseProblem(dir)!, /Story 1 visual did not pass/);
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ ...rejected, reading: 'An unsupported replacement.' }, passed]));
    assert.match(persistedVisualReleaseProblem(dir)!, /no current artwork source review/);
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify([{ svg: '', label: '', reading: '', legend: [] }]));
    writeFileSync(join(dir, 'visual-results.json'), JSON.stringify([{ kind: 'diagram' }]));
    writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify({ version: 1, topicHash: 'legacy', writerKey: noVisualCalls.writerKey, scriptHash: 'legacy' }));
    assert.match(persistedVisualReleaseProblem(dir)!, /saved video script is not bound/, 'snapshot-only approval still requires the current script source contract');
    rmSync(join(dir, "diagrams.json"));
    rmSync(join(dir, 'visual-results.json'));
    assert.equal(persistedVisualReleaseProblem(dir), null, "no diagrams at all means nothing to judge");
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('all scenes of a prepared single topic bind to its one source; roundup scenes do not borrow it', () => withReviewPort(async () => {
  const root = mkdtempSync(join(tmpdir(), 'single-scene-source-')), dir = join(root, '20260909-fixture'); mkdirSync(dir);
  try {
    const topic = { kind: 'news', stories: [fixtureTopic.stories![0]] } as Topic;
    const body = [1, 2, 3, 4].map(n => ({ onScreen: { title: `Pilot scene ${n}` }, motion: { kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Bus service', impact: 'Not measured', status: 'Announced' } })), script = { body };
    const diagrams = await critiqueAtPhoneScale(dir, body, body.map((segment, i) => ({ ...authored(i + 1), sourceReview: diagramSourceReceipt(authored(i + 1), fixtureEvidence(segment)) })),
      async () => { throw new Error('Passing fixture never requests new artwork'); }, async () => ({ passed: true, reason: 'Injected current phone inspection.' }) as any, async () => 'unused.png');
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(topic)); writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
    writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(preparedScriptReceipt(topic, noVisualCalls.writerKey, script)));
    writeFileSync(join(dir, 'diagrams.json'), JSON.stringify(diagrams));
    assert.equal(persistedVisualReleaseProblem(dir), null, 'every scene uses the same exact prepared source without needing a second story');
    const roundup = { ...topic, kind: 'roundup' } as Topic;
    writeFileSync(join(dir, 'topic.json'), JSON.stringify(roundup));
    writeFileSync(join(dir, 'companion-writing-receipt.json'), JSON.stringify(preparedScriptReceipt(roundup, noVisualCalls.writerKey, script)));
    assert.match(persistedVisualReleaseProblem(dir)!, /selected topic and its pinned claims/, 'a missing roundup source is not replaced by its first story');
  } finally { rmSync(root, { recursive: true, force: true }); }
}));
