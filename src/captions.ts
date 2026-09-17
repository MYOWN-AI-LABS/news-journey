import type { WordStamp } from "./types.js";

/** Four words at most, bounded by the sentence containing the active word. */
export function captionGroup(words: WordStamp[], index: number): { start: number; words: WordStamp[] } {
  const endsSentence = (i: number) => /[.!?]["'’”)\]]*$/.test(words[i].w);
  let sentenceStart = index;
  while (sentenceStart > 0 && !endsSentence(sentenceStart - 1)) sentenceStart--;
  const start = sentenceStart + Math.floor((index - sentenceStart) / 4) * 4;
  let end = start;
  do { end++; } while (end < words.length && end < start + 4 && !endsSentence(end - 1));
  return { start, words: words.slice(start, end) };
}
