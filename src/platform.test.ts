import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isAppleSilicon, portableCommand, resolveFreeTtsEngine } from "./platform.js";

test("Windows native Claude and npm entry points keep shell metacharacters literal", () => {
  const root=mkdtempSync(join(tmpdir(),"Executive & résumé "));
  try {
    writeFileSync(join(root,"claude.exe"),"");
    const args=["a path & echo injected",'a "quoted" value',"%PATH%"];
    assert.deepEqual(portableCommand("claude",args,"win32",root),{command:join(root,"claude.exe"),args});
    mkdirSync(join(root,"node_modules/npm/bin"),{recursive:true});
    writeFileSync(join(root,"node_modules/npm/bin/npx-cli.js"),"");
    const npm=portableCommand("npx",args,"win32",root);
    assert.equal(npm.command,process.execPath);
    assert.deepEqual(npm.args.slice(1),args);
    assert.match(npm.args[0],/npx-cli\.js$/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("native executables and non-Windows commands remain direct", () => {
  assert.deepEqual(portableCommand("uv", ["--version"], "win32"), { command: "uv", args: ["--version"] });
  assert.deepEqual(portableCommand("npx", ["remotion"], "darwin"), { command: "npx", args: ["remotion"] });
});

test("Apple-local media support is restricted to arm64 macOS", () => {
  assert.equal(isAppleSilicon("darwin", "arm64"), true);
  assert.equal(isAppleSilicon("darwin", "x64"), false);
  assert.equal(isAppleSilicon("win32", "arm64"), false);
});

test("a selected local TTS engine never becomes a network provider on another platform", () => {
  assert.equal(resolveFreeTtsEngine("kokoro", "darwin", "arm64"), "kokoro");
  assert.equal(resolveFreeTtsEngine("kokoro", "win32", "x64"), "kokoro");
  assert.equal(resolveFreeTtsEngine("kokoro", "darwin", "x64"), "kokoro");
  assert.equal(resolveFreeTtsEngine("kokoro", "linux", "x64"), "kokoro");
});

test("an explicit edge configuration is never overridden", () => {
  assert.equal(resolveFreeTtsEngine("edge", "darwin", "arm64"), "edge");
  assert.equal(resolveFreeTtsEngine("edge", "win32", "x64"), "edge");
});

test('Windows npm agent shims use Node directly and preserve literal user arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent shim '));
  try {
    mkdirSync(join(root, 'node_modules/agent'), { recursive: true });
    writeFileSync(join(root, 'node_modules/agent/cli.js'), '');
    writeFileSync(join(root, 'copilot.cmd'), '@"%dp0%\\node.exe" "%dp0%\\node_modules\\agent\\cli.js" %*');
    const args = ['a & echo unsafe', '%SECRET%', '$(whoami)'];
    const result = portableCommand('copilot', args, 'win32', root);
    assert.equal(result.command, process.execPath); assert.deepEqual(result.args.slice(1), args);
    writeFileSync(join(root, 'other.cmd'), 'echo arbitrary');
    assert.throws(() => portableCommand('other', [], 'win32', root), /Cannot safely launch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
