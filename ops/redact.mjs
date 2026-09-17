import { homedir } from 'node:os';

/** Strip anything that could identify the machine or leak a credential. Its own module so the test can import it without running the beta report. */
export function redact(text) {
  return String(text)
    .replaceAll(homedir(), '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
    .replace(/\b[a-f0-9]{64}\b/gi, '[hex64]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
    .replace(/(api[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]');
}
