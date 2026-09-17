import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activeRoot } from '../src/workspaces.js';
import { loadConfig } from '../src/util.js';
import type { ModelConfig } from '../src/llm/model.js';
import type { ModelIdentity } from '../src/llm/model-identity.js';
import type { LocalRoleRoute, ParentWorkScope } from '../src/llm/role-router.js';
import { GENERAL_CRITIC_CONTRACT, generalCriticControlPlan, qualifyGeneralCritic } from '../src/llm/critic-qualification.js';

const args = process.argv.slice(2);
if (args.length === 0 || args.length === 1 && args[0] === '--describe') {
  // Read-only: no identity metadata requests, model loading, parent creation or inference.
  console.log(JSON.stringify({ protocol: 2, contractHash: GENERAL_CRITIC_CONTRACT, controls: generalCriticControlPlan(),
    execution: 'node --import tsx ops/qualify-general-critic.mts --execute approved-plan.json',
    planFields: ['root (the active workspace)', 'parent.parentId (critic-check- prefix)', 'parent.parentIdentity (frozen plan hash)',
      'parent.limits (explicit existing physical/time/tool allowance)', 'route (exact Ollama or OpenCode selection)', 'identity (measured local runtime identity)'],
    minimumRemainingPhysicalCalls: 4, createsReplacementParent: false, hostedRescue: false,
    limitation: 'Four-sentence/four-claim full-mode general source-support controls only. Specialist schemas and complete local editorial acceptance remain unqualified.' }, null, 2));
} else {
  if (args.length !== 2 || args[0] !== '--execute') throw new Error('Use --describe, or --execute approved-plan.json');
  const plan = JSON.parse(readFileSync(resolve(args[1]!), 'utf8')) as { root: string; parent: Omit<ParentWorkScope, 'root' | 'now'>; route: LocalRoleRoute; identity: ModelIdentity };
  if (!plan || Object.keys(plan).sort().join(',') !== 'identity,parent,root,route' || resolve(plan.root) !== resolve(activeRoot())) throw new Error('The explicit plan must name the active workspace and only root, parent, route and measured identity');
  if (!plan.parent || Object.keys(plan.parent).sort().join(',') !== 'limits,parentId,parentIdentity') throw new Error('The explicit parent needs only parentId, parentIdentity and original limits');
  const result = await qualifyGeneralCritic({ root: activeRoot(), parent: { ...plan.parent, root: activeRoot() }, route: plan.route,
    identity: plan.identity, primary: { ...loadConfig<ModelConfig>('model'), rescue: { enabled: false } } });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
