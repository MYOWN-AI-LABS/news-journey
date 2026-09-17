import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { workerAction } from './control.js';

test('brand suggestions use the selected writer without saving brand/model settings and enforce Pro and role in workers', async () => {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/brand-suggestion-')), slug = basename(root), owner = 'a'.repeat(64), viewer = 'b'.repeat(64);
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: slug }); atomicJson(join(root, 'desks.json'), {});
  atomicJson(join(root, 'members.json'), [[owner, 'owner'], [viewer, 'viewer']].map(([token, role]) => ({ id: role, role, tokenHash: createHash('sha256').update(token).digest('hex') })));
  let calls = 0, fail = false;
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); calls++; assert.equal(data.model, 'selected-fixture'); assert.equal(data.tools, undefined);
    assert.match(JSON.stringify(data.messages), /Haines City/);
    if (fail) { res.writeHead(400); res.end('fixture model unavailable'); return; }
    const logo = /publication logo icon/.test(JSON.stringify(data.messages));
    const result = logo ? { background: '#FFFFFF', ink: '#102B3F', accent: '#007D87', symbol: 'compass', shapes: [], reason: 'A clear compass for discovering local activities.' } : { text: 'Good places. Better weekends.' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening'); const address = model.address(); assert.ok(address && typeof address !== 'string');
  const savedModel = { provider: 'codex', timeoutSeconds: 5, providers: { openaiCompatible: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'selected-fixture' } } };
  atomicJson(join(root, 'config/model.json'), savedModel); atomicJson(join(root, 'config/personalization.json'), { organization: 'Kept brand', tagline: 'Kept tagline' });
  const modelBefore = readFileSync(join(root, 'config/model.json')), brandBefore = readFileSync(join(root, 'config/personalization.json'));
  const issuer = generateKeyPairSync('ed25519'), priorIssuer = process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY;
  process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY = issuer.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const input = { suggestField: 'tagline', model: 'openai-compatible', description: 'Weekly activities in Haines City, Orlando and Tampa.', organization: 'Local Weekends', tagline: 'My current text' };
  const action = (data: Record<string, unknown>, token = owner) => workerAction(root, token, { action: 'journey', operation: 'personalize', data });
  try {
    await assert.rejects(action(input), /part of Pro/); assert.equal(calls, 0);
    const payload = { version: 1, issuer: 'myownai-labs', subject: slug, plan: 'pro', packs: ['executive-briefing'], issuedAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 };
    atomicJson(join(root, 'state/pro-entitlement.json'), { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), issuer.privateKey).toString('base64') });
    await assert.rejects(action(input, viewer), /Forbidden/); assert.equal(calls, 0);
    for (const suggestField of ['tagline', 'footer']) {
      const result: any = await action({ ...input, suggestField }); assert.equal(result.brandCopy.field, suggestField); assert.equal(result.brandCopy.text, 'Good places. Better weekends.');
    }
    const logo: any = await action({ ...input, suggestField: 'logo', logoMode: 'choose' }); assert.equal(logo.brandCopy.design.symbol, 'compass');
    fail = true; await assert.rejects(action(input), /400|fixture model unavailable/);
    assert.deepEqual(readFileSync(join(root, 'config/model.json')), modelBefore); assert.deepEqual(readFileSync(join(root, 'config/personalization.json')), brandBefore);
  } finally {
    if (priorIssuer === undefined) delete process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY; else process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY = priorIssuer;
    model.closeAllConnections(); await new Promise<void>(r => model.close(() => r())); rmSync(root, { recursive: true, force: true });
  }
});
