import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { contained } from './workspaces.js';

/** Hash-only pin: operator secrets never enter a watchdog receipt. Include nested editions. */
export function watchdogConfigurationHash(root: string): string {
  const files: string[] = [];
  const walk = (folder: string, depth = 0) => {
    if (depth > 8 || files.length > 1000) throw new Error('Configuration inventory exceeds watchdog bounds');
    const path = contained(root, folder); if (!existsSync(path)) return;
    for (const row of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${folder}/${row.name}`;
      if (row.isDirectory()) walk(name, depth + 1);
      else if (row.name.endsWith('.json') && name !== 'config/watchdog.json') { contained(root, name); files.push(name); }
    }
  };
  walk('config');
  files.push('.env', 'CONTENT.md', 'state/journey-brief.json', 'state/personalization.json', 'state/personal-profile.json');
  return createHash('sha256').update(JSON.stringify(files.map(name => [name, existsSync(contained(root, name)) ? readFileSync(contained(root, name), 'utf8') : null]))).digest('hex');
}
