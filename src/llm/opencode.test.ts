import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { opencodeText } from "./opencode.js";
import { portableCommand } from "../platform.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-adapter-test-"));
  const cli = join(dir, "opencode-fixture.js"), audit = join(dir, "audit.json"), pidFile = join(dir, "worker.pid");
  const oldPath = process.env.PATH;
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 const env=process.env,config=JSON.parse(env.OPENCODE_CONFIG_CONTENT),args=process.argv.slice(2);
 const files=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(p,e.name)):[path.join(p,e.name)]);
 const attachments=args.flatMap((arg,i)=>arg==='--file'?[{path:args[i+1],hex:fs.readFileSync(args[i+1]).toString('hex'),mode:fs.statSync(args[i+1]).mode&511}]:[]);
 fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({prompt,args,env,config,cwd:process.cwd(),files:files(path.dirname(process.cwd())),attachments}));
 const part={sessionID:'session-1',messageID:'message-1'},emit=(type,data={})=>console.log(JSON.stringify({type,sessionID:'session-1',part:{...part,...data}}));
 const worker=()=>{const child=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();};
 if(prompt==='TIMEOUT'){worker();setInterval(()=>{},1000);return;}
 if(prompt==='DESCENDANT'){worker();}
 if(prompt==='STDOUT'){process.stdout.write('x'.repeat(3*1024*1024));return;}
 if(prompt==='STDERR'){process.stderr.write('x'.repeat(100000));return;}
 if(prompt==='CHATTER'){console.log('Falling back to the default agent');return;}
 if(prompt==='ERROR'){console.log(JSON.stringify({type:'error',error:{data:{message:'fixture session failure'}}}));return;}
 if(prompt==='TOOL'){worker();emit('tool_use',{type:'tool',tool:'bash'});setInterval(()=>{},1000);return;}
 if(prompt==='NOTEXT'){emit('step_finish',{reason:'stop'});return;}
 emit('step_start',{type:'step-start'});
 emit('text',{type:'text',id:'text-1',text:'{"written":true}',time:prompt==='PARTIAL'?{start:1}:{start:1,end:2}});
 if(prompt==='MISMATCH'){console.log(JSON.stringify({type:'step_finish',sessionID:'other',part:{...part,reason:'stop'}}));return;}
 if(prompt==='UNKNOWN'){emit('permission_request',{});return;}
 if(prompt==='NOFINAL')return;
 emit('step_finish',{type:'step-finish',reason:prompt==='LENGTH'?'length':'stop',tokens:{input:12,output:4,total:16},cost:0});
 if(prompt==='AFTERFINAL')emit('text',{id:'text-2',text:'extra',time:{end:3}});
 if(prompt==='NONZERO'){console.error('fixture command failure');process.exitCode=7;}
});
`);
  chmodSync(cli, 0o700);
  writeFileSync(join(dir, "opencode-fixture.cmd"), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%/opencode-fixture.js" %*\r\n`);
  assert.deepEqual(portableCommand("opencode-fixture", ["argument with spaces"], "win32", dir), { command: process.execPath, args: [realpathSync(cli), "argument with spaces"] });
  if (process.platform === "win32") process.env.PATH = dir + delimiter + (oldPath || "");
  return {
    dir, audit, pidFile,
    runtime: { command: process.platform === "win32" ? "opencode-fixture" : cli, model: "ollama/qwen2.5:7b", timeoutMs: 5000 },
    read: () => JSON.parse(readFileSync(audit, "utf8")),
    cleanup: () => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); },
  };
}

async function assertWorkerGone(pidFile: string) {
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // Clean up the test fixture even if the assertion discovers an adapter regression.
  try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  assert.fail(`OpenCode descendant ${pid} survived the request`);
}

test("OpenCode pins the exact local model and isolates text, configuration and credentials", async () => {
  const f = fixture();
  const secrets = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "OPENCODE_CONFIG", "OPENCODE_TEST_HOME", "OPENCODE_SERVER_PASSWORD", "NODE_OPTIONS", "BUN_OPTIONS"];
  const prior = Object.fromEntries(secrets.map(key => [key, process.env[key]]));
  for (const key of secrets) process.env[key] = "must-not-cross";
  try {
    const prompt = "Return text with literal $() and `backticks`. Sports only. 😀";
    const output = await opencodeText(prompt, f.runtime);
    assert.deepEqual(output, { text: '{"written":true}', model: "ollama/qwen2.5:7b", usage: { tokens: { input: 12, output: 4, total: 16 }, cost: 0 } });
    const a = f.read();
    assert.equal(a.prompt, prompt);
    assert.deepEqual(a.args, ["run", "--pure", "--agent", "writer", "--model", f.runtime.model, "--format", "json", "--title", "Content writer", "--dir", a.cwd]);
    assert.ok(!a.args.includes(prompt));
    assert.equal(a.env.PWD, a.cwd);
    assert.notEqual(a.env.HOME, process.env.HOME);
    for (const key of secrets) assert.equal(a.env[key], undefined, key);
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR", "TMPDIR"]) assert.ok(a.env[key].startsWith(a.cwd.slice(0, -"project".length)), key);
    for (const key of ["OPENCODE_PURE", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_LSP_DOWNLOAD"]) assert.equal(a.env[key], "true", key);
    assert.equal(a.config.model, f.runtime.model); assert.equal(a.config.small_model, f.runtime.model);
    assert.deepEqual(a.config.enabled_providers, ["ollama"]);
    assert.equal(a.config.share, "disabled"); assert.equal(a.config.snapshot, false); assert.equal(a.config.autoupdate, false);
    assert.deepEqual(a.config.permission, { "*": "deny" }); assert.deepEqual(a.config.tools, { "*": false });
    assert.deepEqual(a.config.agent.writer.permission, { "*": "deny" }); assert.deepEqual(a.config.agent.writer.tools, { "*": false });
    assert.equal(a.config.agent.writer.model, f.runtime.model); assert.equal(a.config.agent.writer.steps, 2, 'first turn must not receive OpenCode maximum-steps assistant prefill');
    assert.equal(a.config.agent.writer.reasoningEffort, 'none');
    assert.deepEqual(a.config.plugin, []); assert.deepEqual(a.config.mcp, {}); assert.deepEqual(a.config.instructions, []); assert.deepEqual(a.config.skills, { paths: [], urls: [] });
    assert.equal(a.config.lsp, false); assert.equal(a.config.formatter, false);
    assert.equal(a.config.provider.ollama.npm, "@ai-sdk/openai-compatible");
    assert.equal(a.config.provider.ollama.options.baseURL, "http://127.0.0.1:11434/v1");
    assert.deepEqual(Object.keys(a.config.provider.ollama.models), ["qwen2.5:7b"]);
    assert.equal(a.config.provider.ollama.models["qwen2.5:7b"].limit.context, 16384);
    assert.equal(a.config.provider.ollama.models["qwen2.5:7b"].limit.output, 4096, 'thinking control does not increase the output ceiling');
    assert.deepEqual(a.files, []); assert.equal(existsSync(a.cwd), false);
  } finally {
    for (const key of secrets) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    f.cleanup();
  }
});

test("OpenCode native free selection uses its CLI provider and copies only public catalog metadata", async () => {
  const f = fixture(), priorCache = process.env.XDG_CACHE_HOME;
  const cache = join(f.dir, "user-cache"), native = join(cache, "opencode");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "models.json"), JSON.stringify({ opencode: { models: { "example-free": { cost: { input: 0, output: 0 } } } } }));
  writeFileSync(join(native, "auth.json"), '{"secret":"must-not-cross"}');
  writeFileSync(join(native, "opencode.json"), '{"plugin":["must-not-load"]}');
  process.env.XDG_CACHE_HOME = cache;
  try {
    const result = await opencodeText("native", { ...f.runtime, model: "opencode/example-free" });
    assert.equal(result.model, "opencode/example-free");
    const a = f.read();
    assert.deepEqual(a.config.enabled_providers, ["opencode"]);
    assert.equal(a.config.agent.writer.reasoningEffort, undefined, 'native free models keep their own reasoning defaults');
    assert.equal(a.config.provider, undefined);
    assert.deepEqual(a.files, [join(a.env.XDG_CACHE_HOME, "opencode", "models.json")]);
    assert.equal(existsSync(a.cwd), false);
  } finally {
    if (priorCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = priorCache;
    f.cleanup();
  }
});

test("OpenCode sends bounded real image attachments to the same verified local model and removes private copies", async () => {
  const f = fixture(), priorFetch = globalThis.fetch;
  const bytes = [Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('ffd8ffe00000', 'hex'), Buffer.from('RIFF0000WEBP')];
  const originals = bytes.map((value, i) => { const path = join(f.dir, `private-${i}.not-an-extension`); writeFileSync(path, value); return path; });
  let checks = 0;
  globalThis.fetch = (async (url, init) => {
    checks++;
    assert.equal(String(url), 'http://127.0.0.1:11434/api/show');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'vision:4b' });
    return new Response(JSON.stringify({ capabilities: ['completion', 'vision'] }));
  }) as typeof fetch;
  try {
    const result = await opencodeText('Inspect only the attached frames.', { ...f.runtime, model: 'ollama/vision:4b' }, originals);
    assert.equal(result.model, 'ollama/vision:4b'); assert.equal(checks, 1);
    const a = f.read(), model = a.config.provider.ollama.models['vision:4b'];
    assert.equal(model.attachment, true); assert.deepEqual(model.modalities, { input: ['text', 'image'], output: ['text'] });
    assert.deepEqual(a.config.enabled_providers, ['ollama']);
    assert.equal(a.config.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1');
    assert.deepEqual(a.config.permission, { '*': 'deny' }); assert.deepEqual(a.config.agent.writer.tools, { '*': false });
    assert.deepEqual(a.attachments.map((x: any) => x.hex), bytes.map(value => value.toString('hex')));
    a.attachments.forEach((x: any, i: number) => {
      assert.ok(x.path.startsWith(a.cwd + '/image-')); assert.equal(a.args.includes(originals[i]), false);
      if (process.platform !== 'win32') assert.equal(x.mode, 0o600);
      assert.equal(existsSync(x.path), false); assert.deepEqual(readFileSync(originals[i]), bytes[i]);
    });
    assert.equal(existsSync(a.cwd), false);
    await assert.rejects(opencodeText('ERROR', { ...f.runtime, model: 'ollama/vision:4b' }, originals), /fixture session failure/);
    assert.equal(existsSync(f.read().cwd), false, 'failed image calls also remove their copies');
  } finally { globalThis.fetch = priorFetch; f.cleanup(); }
});

test("OpenCode rejects unsafe images, text-only models and remote aliases before CLI execution", async () => {
  const f = fixture(), priorFetch = globalThis.fetch;
  const image = join(f.dir, 'image.png'), invalid = join(f.dir, 'invalid.png'), big = join(f.dir, 'big.png');
  writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex')); writeFileSync(invalid, 'Not an image'); writeFileSync(big, Buffer.alloc(8_000_001));
  globalThis.fetch = (async () => new Response(JSON.stringify({ capabilities: ['completion'] }))) as typeof fetch;
  try {
    await assert.rejects(opencodeText('inspect', f.runtime, [image]), /does not advertise local vision/);
    await assert.rejects(opencodeText('inspect', { ...f.runtime, model: 'opencode/example-free' }, [image]), /accepts text only/);
    await assert.rejects(opencodeText('inspect', f.runtime, Array(7).fill(image)), /at most six/);
    await assert.rejects(opencodeText('inspect', f.runtime, [invalid]), /PNG, JPEG, or WebP/);
    await assert.rejects(opencodeText('inspect', f.runtime, [big]), /at most 8 MB/);
    await assert.rejects(opencodeText('inspect', f.runtime, [f.dir]), /regular image/);
    if (process.platform !== 'win32') {
      const link = join(f.dir, 'symlink.png'); symlinkSync(image, link);
      await assert.rejects(opencodeText('inspect', f.runtime, [link]), /ELOOP/);
    }
    globalThis.fetch = (async () => new Response(JSON.stringify({ capabilities: ['vision'], remote_host: 'https://remote.invalid' }))) as typeof fetch;
    await assert.rejects(opencodeText('inspect', f.runtime, [image]), /does not advertise local vision/);
    assert.equal(existsSync(f.audit), false);
  } finally { globalThis.fetch = priorFetch; f.cleanup(); }
});

test("OpenCode refuses ambiguous models, authenticated routes and invalid bounds before launching", async () => {
  const f = fixture();
  try {
    for (const model of [undefined, "", "qwen2.5:7b", "openai/gpt-x", "ollama/", "ollama/model name", "opencode/paid-model", "ollama/example:cloud", "ollama/example-cloud"]) {
      await assert.rejects(opencodeText("text", { ...f.runtime, model }), /exact|unsupported/);
    }
    for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) await assert.rejects(opencodeText("text", { ...f.runtime, timeoutMs }), /timeout/);
    for (const prompt of ["  ", "a".repeat(1_048_577)]) await assert.rejects(opencodeText(prompt, f.runtime), /prompt/);
    assert.equal(existsSync(f.audit), false);
  } finally { f.cleanup(); }
});

test("OpenCode rejects errors, unexpected events, partial results and output overflow", async () => {
  const f = fixture();
  try {
    for (const [prompt, error] of [
      ["NONZERO", /exit 7.*fixture command failure/], ["ERROR", /fixture session failure/],
      ["CHATTER", /invalid JSON/], ["NOFINAL", /no complete final text/], ["NOTEXT", /no complete final text/],
      ["PARTIAL", /incomplete text/], ["LENGTH", /did not finish.*length/], ["MISMATCH", /mismatched session/],
      ["UNKNOWN", /unexpected event/], ["AFTERFINAL", /events after its final/],
      ["STDOUT", /output limit/], ["STDERR", /diagnostic output limit/],
    ] as const) {
      await assert.rejects(opencodeText(prompt, f.runtime), error);
      assert.equal(existsSync(f.read().cwd), false, prompt);
    }
    await assert.rejects(opencodeText("text", { ...f.runtime, command: join(f.dir, "does-not-exist") }), /could not start/);
  } finally { f.cleanup(); }
});

test("OpenCode kills descendants on timeout, forbidden tools and normal launcher completion", async () => {
  const f = fixture();
  try {
    await assert.rejects(opencodeText("TIMEOUT", { ...f.runtime, timeoutMs: 500 }), /timed out after 0.5s/);
    await assertWorkerGone(f.pidFile);
    assert.equal(existsSync(f.read().cwd), false);
    await assert.rejects(opencodeText("TOOL", f.runtime), /attempted tool use/);
    await assertWorkerGone(f.pidFile);
    assert.equal((await opencodeText("DESCENDANT", f.runtime)).text, '{"written":true}');
    await assertWorkerGone(f.pidFile);
  } finally { f.cleanup(); }
});
