import { registerControlCommands } from "./control-cli.js";
import { Command } from "commander";
import { enableDryRun } from "./dry-run.js";

// Stage modules are imported lazily inside handlers so the CLI works even
// while later phases are still being built, and startup stays fast.

const program = new Command();
program.command('edition:preview')
  .description('Collect current stories and create a sourced newsletter and script with independent factual review')
  .requiredOption('--request <file>', 'JSON request with runId, day, brief, topics, feeds, writer and reviewer')
  .action(async opts => {
    const { readFileSync } = await import('node:fs');
    const { runLiveEdition } = await import('./pipeline/live-edition.js');
    const result = await runLiveEdition(JSON.parse(readFileSync(opts.request, 'utf8')));
    console.log(JSON.stringify({ status: result.status, output: result.output, newsletterWords: result.newsletterWords, scriptWords: result.scriptWords, publicationReady: false }));
  });
const { registerMemoryCommands } = await import("./memory/cli.js");
registerMemoryCommands(program);
program.name("ai-content-engine").description("Configured news sources → short video → review-first distribution");

program.command("setup").description("Configure your private publication from a short profile/CONTENT.md brief").action(async () => {
  const { configureExecutive } = await import("./onboarding.js");
  const result = configureExecutive();
  console.log(`${result.changed ? "Configured" : "Already configured"}: ${result.publication}\n${result.root}`);
  const { read } = await import("./workspaces.js");
  const { join } = await import("node:path");
  const file = join(result.root, "config/sources.json");
  if (read<any>(file, {}).publicApis?.setupMode !== "off") {
    const { setupApiSources } = await import("./sources/api-setup.js");
    await setupApiSources(result.root, { automatic: true, refresh: result.changed });
  }
  if (!read<any>(file, {}).enabledSources?.length) throw new Error("No source is connected yet. Run npm run sources:setup to choose an API, or add a trusted RSS feed to your publication brief. See this workspace's state/sources.html for matching APIs.");
});

program.command("sources:setup").description("Find and connect APIs for your publication topics and areas")
  .option("--auto", "connect supported matching sources after live checks")
  .option("--refresh", "refresh the catalog and retry live connections")
  .option("--select <ids>", "connect specific API IDs, separated by commas")
  .action(async opts => {
    const { setupApiSources } = await import("./sources/api-setup.js");
    const result = await setupApiSources(undefined, { automatic: opts.auto, refresh: opts.refresh, select: opts.select?.split(",").map((s: string) => s.trim()) });
    if (result.catalogError || result.results.some(r => r.status === "failed")) process.exitCode = 1;
  });
program.command("sources:connect").description("Connect another read-only JSON API through guided prompts")
  .action(async () => { const { connectApiWizard } = await import("./sources/api-setup.js"); await connectApiWizard(); });

program.command("tour").description("Show the configured product journey, media path, and next commands").action(async () => {
  const { productTour } = await import("./tour.js");
  productTour();
});

program.command("model:check").description("Send a minimal JSON request to the configured content model").action(async () => {
  const { modelJson, configuredModelRuntime } = await import("./llm/model.js");
  const { read, contained, activeRoot } = await import("./workspaces.js");
  const startedAt = new Date().toISOString();
  const runtime = configuredModelRuntime();
  const result = await modelJson<{ ok: boolean; provider: string }>(
    `Return ONLY JSON with ok=true and provider=${JSON.stringify(runtime.provider)}.`,
    (value) => value?.ok === true && value.provider === runtime.provider ? null : "response must preserve ok=true and the exact provider"
  );
  const recovery = read<any>(contained(activeRoot(), 'state/model-recovery.json'), {});
  console.log(`Model JSON check passed. ${recovery.at >= startedAt ? recovery.message : runtime.label} -> ${JSON.stringify(result)}`);
});

program.command("models:qualify").description("Check the configured HTTP or OpenCode writer against the editorial contract twice and record the result")
  .option("--attempts <n>", "attempts (default 2; one is diagnostic, never a qualification)")
  .option("--ceiling <seconds>", "time ceiling per attempt (default 600)")
  .action(async (opts) => {
    const { modelJson, configuredModelRuntime } = await import("./llm/model.js");
    const { qualifyModel, summarizeQualification } = await import("./llm/qualification.js");
    const { isLocalRuntime } = await import("./llm/qualification-state.js");
    const { activeRoot } = await import("./workspaces.js");
    const { loadConfig, CONFIG_DIR } = await import("./util.js");
    const runtime = configuredModelRuntime();
    if (["claude", "codex"].includes(runtime.provider)) throw new Error("Use a configured HTTP or OpenCode writer for this model comparison.");
    const attempts = opts.attempts === undefined ? 2 : Number(opts.attempts), ceilingSeconds = opts.ceiling === undefined ? 600 : Number(opts.ceiling);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isFinite(ceilingSeconds) || ceilingSeconds <= 0) throw new Error("Use 1–10 attempts and a positive ceiling; one attempt is diagnostic only.");
    console.log(`Active model config: ${CONFIG_DIR}/model.json`);
    console.log(`Effective writer: ${runtime.label}; ${runtime.baseUrl}; thinking=${runtime.reasoningEffort ?? "model default"}; context=${runtime.contextTokens ?? "provider default"}; request limit=${runtime.timeoutMs / 1000}s; attempt limit=${ceilingSeconds}s`);
    if (runtime.provider === "ollama") console.log(await (await import("./llm/local-models.js")).ollamaPreflight(runtime.baseUrl!, runtime.model!));
    else if (runtime.provider === "opencode" && runtime.model?.startsWith("ollama/")) console.log(await (await import("./llm/local-models.js")).ollamaPreflight(runtime.baseUrl!, runtime.model.slice(7)));
    else console.log(isLocalRuntime(runtime.provider, runtime.baseUrl, runtime.model) ? "Local endpoint; verify where its inference runs." : "Hosted inference; source material is sent to this provider.");
    const areas = loadConfig<{ editorial?: { areas?: import("./types.js").SelectionAreas } }>("sources").editorial?.areas;
    const { effectiveVideoWordBudget } = await import("./personalization.js");
    const budget = effectiveVideoWordBudget(activeRoot());
    console.log(`Effective video word budget: ${budget.min}–${budget.max}; ${attempts} attempt(s), rescue disabled.`);
    // Tools, hooks and rescue are disabled: this measures the selected writer alone.
    const rescueOff = { ...loadConfig<import("./llm/model.js").ModelConfig>("model"), rescue: { enabled: false } };
    const record = await qualifyModel(activeRoot(), runtime, (prompt, validate, deadline) => modelJson(prompt, validate, rescueOff, process.env, [], true, deadline), { attempts, ceilingSeconds, areas, budget });
    console.log(summarizeQualification(record));
    if (!record.qualified) process.exitCode = 1;
  });

program
  .command("models:recommend")
  .description("Analyze local hardware with llmfit and recommend OpenCode/Ollama models")
  .option("--json", "print machine-readable JSON")
  .option("--use-uvx", "run llmfit through uvx explicitly (may download it on first use)")
  .action(async (opts) => {
    const { recommendLocalModels } = await import("./model-recommend.js");
    recommendLocalModels({ json: opts.json, useUvx: opts.useUvx });
  });

program
  .command("models:ollama-profile")
  .description("Create an explicit 32K-context Ollama alias for an agent or content model")
  .requiredOption("--base <model>", "installed Ollama base model")
  .requiredOption("--name <alias>", "new Ollama alias")
  .action(async (opts) => {
    const { createOllamaProfile } = await import("./model-recommend.js");
    createOllamaProfile(opts.base, opts.name);
  });

program
  .command("sources:catalog")
  .description("Search the public-apis/public-apis discovery catalog without harvesting an endpoint")
  .option("--query <text>", "match API name, description, or category")
  .option("--category <name...>", "exact catalog category; repeat or pass multiple names")
  .option("--auth <type...>", "authentication filter, for example none apiKey OAuth")
  .option("--allow-http", "include catalog entries that do not advertise HTTPS")
  .option("--limit <n>", "maximum results", "20")
  .option("--json", "print machine-readable JSON")
  .action(async (opts) => {
    const { loadConfig } = await import("./util.js");
    const { fetchPublicApiCatalog, searchPublicApiCatalog } = await import("./sources/public-apis.js");
    const cfg = loadConfig<{ publicApis?: { catalog?: Record<string, unknown> } }>("sources");
    const configured = cfg.publicApis?.catalog ?? {};
    const limit = Number.parseInt(opts.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer from 1 to 100");
    const entries = searchPublicApiCatalog(await fetchPublicApiCatalog(), {
      ...configured,
      query: opts.query ?? configured.query,
      categories: opts.category ?? configured.categories,
      auth: opts.auth ?? configured.auth,
      httpsOnly: opts.allowHttp ? false : configured.httpsOnly !== false,
      limit,
    });
    if (opts.json) console.log(JSON.stringify(entries, null, 2));
    else if (entries.length === 0) console.log("No Public APIs catalog entries matched.");
    else entries.forEach((entry) => console.log(`[${entry.category}] ${entry.name} | auth=${entry.auth} | HTTPS=${entry.https} | CORS=${entry.cors}\n  ${entry.description}\n  ${entry.documentationUrl}`));
  });

program.command("harvest").description("Fetch the source families enabled in config/sources.json").action(async () => {
  const { harvest } = await import("./pipeline/harvest.js");
  await harvest();
});

program
  .command("rank")
  .description("Pick topics using the editorial preferences in config/sources.json")
  .option("--harvest <path>", "explicit harvest file")
  .option("--count <n>", "number of topics to pick (default: config topicsPerRun)")
  .action(async (opts) => {
    const { rank } = await import("./pipeline/rank.js");
    await rank(opts.harvest, opts.count ? parseInt(opts.count, 10) : undefined);
  });

program
  .command("script")
  .description("Generate the video script for a topic")
  .requiredOption("--id <id>", "video id")
  .action(async (opts) => {
    const { writeScript } = await import("./pipeline/script.js");
    await writeScript(opts.id);
  });

program
  .command("assets")
  .description("Fetch og-images, screenshots, star data for a video")
  .requiredOption("--id <id>")
  .action(async (opts) => {
    const { gatherAssets } = await import("./pipeline/assets.js");
    await gatherAssets(opts.id);
  });

program
  .command("voice")
  .description("Synthesize TTS audio + word timestamps")
  .requiredOption("--id <id>")
  .option("--engine <engine>", "kokoro|edge")
  .action(async (opts) => {
    const { voice } = await import("./pipeline/voice.js");
    await voice(opts.id, opts.engine);
  });

program
  .command("avatar")
  .description("Generate the HeyGen avatar (avatar/hybrid mode; no-op in cards mode)")
  .requiredOption("--id <id>")
  .action(async (opts) => {
    const { avatar } = await import("./pipeline/avatar.js");
    await avatar(opts.id);
  });

program
  .command("render")
  .description("Render the final.mp4 with Remotion")
  .requiredOption("--id <id>")
  .action(async (opts) => {
    const { render } = await import("./pipeline/render.js");
    await render(opts.id);
  });

program
  .command("produce")
  .description("Full pipeline: harvest → rank → script → assets → voice → render → review queue")
  .option("--topic-file <path>", "skip harvest/rank, use a fixture topic")
  .option("--until <stage>", "stop after stage: rank|script|assets|voice|avatar|render")
  .option("--force", "ignore the already-produced-recently guard")
  .option("--resume <id>", "continue an existing package (e.g. one waiting for visual choices); completed stages are kept")
  .option("--count <n>", "topics per run (default: config topicsPerRun)")
  .option("--edition <name>", "edition preset; defaults to daily-roundup")
  .option("--dry-run", "block every external mutation while exercising the local pipeline")
  .action(async (opts) => {
    if (opts.dryRun) enableDryRun();
    const { produce } = await import("./pipeline/produce.js");
    await produce(opts);
  });


program.command("review").description("List videos pending review").action(async () => {
  const { listPending } = await import("./review/queue.js");
  listPending();
});

program
  .command("preview")
  .argument("<id>")
  .description("Open the rendered video + show publish metadata")
  .action(async (id) => {
    const { preview } = await import("./review/queue.js");
    await preview(id);
  });

program
  .command("approve")
  .argument("<id>")
  .option("--edit-title <title>", "override the publish title")
  .action(async (id, opts) => {
    const { approve } = await import("./review/queue.js");
    approve(id, opts.editTitle);
  });

program
  .command("reject")
  .argument("<id>")
  .option("--reason <reason>")
  .action(async (id, opts) => {
    const { reject } = await import("./review/queue.js");
    reject(id, opts.reason);
  });

program
  .command("post")
  .description("Post all approved videos to enabled platforms (gated on today's newsletter being live)")
  .option("--only <platform>", "youtube|instagram|linkedin|x|threads|tiktok|reddit")
  .option("--retry-blocked", "explicitly retry a destination after repairing access")
  .option("--id <id>", "post a specific video")
  .option("--dry-run", "show planned destinations without posting")
  .action(async (opts) => {
    if (opts.dryRun) enableDryRun();
    const { postApproved } = await import("./post/index.js");
    await postApproved(opts);
  });

program
  .command("auth")
  .argument("<provider>", "google|linkedin|meta|x|threads|tiktok|reddit")
  .description("Run the OAuth flow for a provider")
  .action(async (provider) => {
    const { runAuth } = await import("./auth/index.js");
    await runAuth(provider);
  });

program
  .command("post:reddit-login")
  .description("One-time: sign the dedicated Reddit post profile in (browser-composer path)")
  .action(async () => {
    const { redditPostLogin } = await import("./post/reddit-browser.js");
    await redditPostLogin();
  });

program
  .command("post:x-login")
  .description("One-time: sign the dedicated X post profile in (browser-composer fallback path)")
  .action(async () => {
    const { xPostLogin } = await import("./post/x-browser.js");
    await xPostLogin();
  });

program
  .command("newsletter")
  .description("Generate today's configured newsletter (md + html)")
  .option("--video-id <id>", "use this exact selected video package")
  .option("--date <yyyy-mm-dd>", "generate for a specific day")
  .option("--rerender", "re-render md/html from cached issue data (no LLM call)")
  .option("--edition <name>", "edition preset (e.g. example-topic); scopes filenames + branding")
  .action(async (opts) => {
    const { newsletter } = await import("./pipeline/newsletter.js");
    await newsletter(opts.date, opts.rerender, opts.edition, opts.videoId);
  });

program
  .command("newsletter:linkedin")
  .description("Load the LinkedIn edition onto the clipboard and open the article composer")
  .option("--date <yyyy-mm-dd>")
  .action(async (opts) => {
    const { linkedinNewsletter } = await import("./pipeline/newsletter.js");
    await linkedinNewsletter(opts.date);
  });

program
  .command("newsletter:publish")
  .description("Explicitly publish a reviewed issue to LinkedIn (dedicated profile; sign in once via --login)")
  .option("--date <yyyy-mm-dd>")
  .option("--login", "one-time: open LinkedIn to sign into the dedicated publish profile")
  .option("--edition <name>", "edition preset; publishes the edition-scoped issue")
  .option("--dry-run", "validate and compose without opening a browser or publishing")
  .action(async (opts) => {
    if (opts.dryRun) enableDryRun();
    if (opts.dryRun && opts.login) {
      console.log("[dry-run] LinkedIn login browser blocked.");
      return;
    }
    const mod = await import("./publish/publishNewsletter.js");
    if (opts.login) { await mod.publishLogin(); return; }
    await mod.publishNewsletter(opts.date, opts.edition);
  });

program
  .command("newsletter:linkvideo")
  .description("Append a posted video's feed-post link into the already-published issue (browser; reverse link)")
  .requiredOption("--id <id>", "the posted video id — its meta.json posts.linkedin.url is the link added")
  .option("--date <yyyy-mm-dd>")
  .option("--edition <name>", "edition preset (e.g. example-topic)")
  .option("--dry-run", "validate the local video receipt without opening a browser or changing the issue")
  .action(async (opts) => {
    if (opts.dryRun) enableDryRun();
    const { readJson, videoDir } = await import("./util.js");
    const { join } = await import("node:path");
    const meta = readJson<{ posts?: { linkedin?: { url?: string } } }>(join(videoDir(opts.id), "meta.json"));
    const videoUrl = meta.posts?.linkedin?.url;
    if (!videoUrl) { console.error(`No posted LinkedIn URL on ${opts.id} — post the video first.`); process.exit(1); }
    if (opts.dryRun) {
      console.log("[dry-run] Valid receipt found for " + opts.id + "; newsletter browser and update were blocked.");
      return;
    }
    const editionId = opts.edition && opts.edition !== "daily-roundup" ? opts.edition : undefined;
    // default the date to the video's CONTENT day (its id), not the UTC wall clock
    const date = opts.date || (/^\d{8}/.test(opts.id) ? `${opts.id.slice(0, 4)}-${opts.id.slice(4, 6)}-${opts.id.slice(6, 8)}` : undefined);
    const { linkVideoIntoNewsletter } = await import("./publish/linkVideoIntoNewsletter.js");
    console.log(`link-video: ${await linkVideoIntoNewsletter({ date, editionId, videoUrl })}`);
  });

program
  .command("validate")
  .description("Liveness-check every URL cited by a day's newsletter + videos (exit 1 on dead links)")
  .option("--date <yyyy-mm-dd>")
  .action(async (opts) => {
    const { validateDay } = await import("./validate.js");
    const dead = await validateDay(opts.date);
    if (dead.length > 0) process.exit(1);
  });

program.command("doctor").description("Check tools, tokens, and config health").action(async () => {
  const { doctor } = await import("./doctor.js");
  await doctor();
});

registerControlCommands(program);

program.parseAsync().catch(async (e) => {
  console.error(`ERROR: ${e.message}`);
  await (await import('./managed-process.js')).terminateManagedChildren(e);
  process.exit(1);
});
