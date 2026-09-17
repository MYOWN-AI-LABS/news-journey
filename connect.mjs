#!/usr/bin/env node
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.error('Run node start.mjs from this checkout to install dependencies and create your workspace, then retry Connect & Launch.');
  process.exit(1);
}
await import('./src/connector-cli.ts');
