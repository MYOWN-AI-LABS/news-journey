import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual Journey renderer and its click handler. A failed reservation must never
// copy a reply or tell the operator that it is safe to post.
test('manual posting instructions require a successful durable reservation', async () => {
  const html = readFileSync(new URL('../src/executive-page.html', import.meta.url), 'utf8');
  const renderer = html.slice(html.indexOf('function renderEngagement(){'), html.indexOf('\nfunction fieldOptions()'));
  class Element {
    children = []; textContent = ''; value = '';
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const nodes = new Map(), messages = [], copies = [];
  let fail = true;
  const context = vm.createContext({
    engagement: { total: 1, items: [{ id: 'item', videoId: 'post', platform: 'linkedin', status: 'approved', source: 'manual', kind: 'reaction', reply: 'Thank you. What would help?', hash: 'exact', author: 'Reader', text: 'Liked', url: 'https://www.linkedin.com/feed/update/post' }] },
    document: { createElement: () => new Element() },
    $: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    notice: text => messages.push(text),
    navigator: { clipboard: { writeText: async text => copies.push(text) } },
    run: async () => { if (fail) throw new Error('Publication receipt changed'); return { reply: 'Thank you. What would help?' }; },
    fire: () => { throw new Error('Reservation must not use the swallowing helper'); },
    confirm: () => true,
  });
  vm.runInContext(renderer + ';renderEngagement()', context);
  const button = nodes.get('engagementInbox').children[0].children.find(n => n.textContent === 'Begin manual posting');
  assert.ok(button);
  await button.onclick(); assert.equal(copies.length, 0); assert.match(messages.at(-1), /not ready.*receipt changed/);
  fail = false; await button.onclick(); assert.equal(copies.length, 1); assert.match(messages.at(-1), /Attempt recorded/);
});
