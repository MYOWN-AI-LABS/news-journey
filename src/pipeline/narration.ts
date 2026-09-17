import type { Script } from '../types.js';

/** The publisher owns the ident. A writer supplies news prose, never a replacement brand. */
export function publicationIntro(edition: { spokenName?: string }, publication: string): string {
  const name = (edition.spokenName?.trim() || publication).replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
  if (!name || name.length > 120 || /[<>\x00-\x1f]/.test(name)) throw new Error('Choose a plain publication name of at most 120 characters for the spoken introduction.');
  return `This is ${name}.`;
}

export function scriptPrelude(script: Pick<Script, 'hook' | 'intro'>): { kind: 'hook' | 'intro'; text: string }[] {
  return [{ kind: 'hook', text: script.hook }, ...(script.intro ? [{ kind: 'intro' as const, text: script.intro }] : [])];
}

/** One ordering for validation, TTS and scene timing, including older scripts without an ident. */
export function narrationSections(script: Pick<Script, 'hook' | 'intro' | 'body' | 'cta'>): string[] {
  return [...scriptPrelude(script).map(part => part.text), ...script.body.map(segment => segment.voiceover), script.cta];
}

export function spokenScriptText(script: Pick<Script, 'hook' | 'intro' | 'body' | 'cta'>): string {
  return narrationSections(script).join(' ');
}


/** Only code-owned links/disclosure and the computed spoken text may follow editorial review. */
export function reviewedJourneyScript(candidate: Script, sourceUrls: string[]): Script {
  const script = structuredClone(candidate);
  script.fullVoiceoverText = spokenScriptText(script);
  const suffix = '\n\nSources:\n' + sourceUrls.join('\n')
    + '\n\nDisclosure: produced with an automated editorial workflow; review every source before publication.';
  script.publish.description += suffix; script.publish.linkedinPost += suffix;
  return script;
}
