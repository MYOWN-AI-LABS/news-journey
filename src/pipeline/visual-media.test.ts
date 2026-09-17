import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneReviewBrief } from './visual-media.js';

test('phone review asks a plain photograph for legibility, and a labelled scene for labels and motion', () => {
  const photo = phoneReviewBrief({ kind: 'source', image: { file: 'og-0.png' } } as any);
  assert.match(photo, /plain source photograph/); assert.doesNotMatch(photo, /moving explanation across/);
  assert.match(photo, /rights review needed[\s\S]*never reject for its wording/); assert.match(photo, /shows the stated subject/);
  const clip = phoneReviewBrief({ kind: 'source', image: { file: 'og-0.png' }, clip: { file: 'clip.mp4' } } as any);
  assert.match(clip, /explanatory labels/); assert.match(clip, /moving explanation/);
  assert.match(phoneReviewBrief({ kind: 'diagram' } as any), /moving explanation/);
  assert.match(phoneReviewBrief({ kind: 'three' } as any), /schematic 3D/);
});
