import { activeRoot, authorize, contained, loadWorkspaceEnv } from "../src/workspaces.ts";
loadWorkspaceEnv(); authorize("read");
// LIVE PIPELINE DASHBOARD — watch a produce → review → publish → post run move through its stages,
// in real time. Local only: it starts an HTTP server on 127.0.0.1 and polls the pipeline's own
// on-disk state every 4 seconds. Nothing here calls a model, a browser, or a network provider.
//
// Run: node scripts/live-dashboard.mjs [port] [day]   → http://127.0.0.1:4788
//
// Sources (all local):
//   config/editions/*.json        → which editions this harness runs, read live so a new edition
//                                    file shows up on the next poll without a restart
//   config/platforms.json         → which distribution channels are enabled
//   workdir/videos/<id>/meta.json → per-video status and per-platform post records
//   workdir/newsletters/*         → published-issue markers
//   workdir/logs/*.log            → tailed for the ticker line
//   graphify-out/graph.json       → the pipeline call graph, so the diagram reflects the ACTUAL
//                                    code rather than a hand-maintained picture that can drift
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = activeRoot();
const PORT = Number(process.argv[2] ?? 4788);
const DAY = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const rj = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const tail = (p, n = 40) => { try { const l = readFileSync(p, "utf8").trim().split("\n"); return l.slice(-n); } catch { return []; } };
/** Server-side escape for anything interpolated directly into the raw HTML document (not the JSON
 *  payload the client fetches — that side already escapes on the way into innerHTML). TITLE comes
 *  from operator config (config/editions/*.json), which is trusted less than the code itself: an
 *  edition file is still just text on disk, and this is the one place its content lands unescaped
 *  in markup rather than as a JSON value. */
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PLATFORMS = Object.keys(rj(join(ROOT, "config/platforms.json")) ?? {});

/** Editions read fresh on every request — the operator's own config/editions/, not a fixed list. */
function editions() {
  const dir = join(ROOT, "config/editions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => rj(join(dir, f)))
    .filter(Boolean)
    .map((ed) => ({
      id: ed.editionId,
      label: ed.displayName ?? ed.editionId,
      key: ed.editionId === "daily-roundup" ? DAY : `${DAY}-${ed.editionId}`,
      prefix: ed.editionId === "daily-roundup"
        ? `${DAY.replace(/-/g, "")}-roundup`
        : `${DAY.replace(/-/g, "")}-${ed.editionId}`,
    }));
}

function videoFor(prefix) {
  const dir = join(ROOT, "workdir/videos");
  if (!existsSync(dir)) return null;
  const ids = readdirSync(dir).filter((i) => i.startsWith(prefix));
  let best = null;
  for (const id of ids) {
    const m = rj(join(dir, id, "meta.json"));
    if (!m) continue;
    const rank = m.status === "posted" ? 3 : m.status === "approved" ? 2 : m.status?.startsWith("rejected") ? 0 : 1;
    if (!best || rank > best.rank) best = { id, meta: m, rank };
  }
  return best;
}

/**
 * Public-archive liveness is optional: only checked when the operator has configured `siteUrl`.
 * Uses execFile with an argument array (no shell), so a URL or key can never be interpreted as a
 * shell command.
 */
function archiveLive(siteUrl, key) {
  if (!siteUrl) return null;
  try {
    const url = `${siteUrl.replace(/\/$/, "")}/issues/${key}.html`;
    const out = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", url], {
      encoding: "utf8",
    });
    return out.trim();
  } catch {
    return "err";
  }
}

function state() {
  const cfg = rj(join(ROOT, "config/pipeline.json")) ?? {};
  const eds = editions().map((ed) => {
    const v = videoFor(ed.prefix);
    const meta = v?.meta ?? {};
    const pub = rj(join(ROOT, "workdir/newsletters", `.published-${ed.key}`));
    const posts = meta.posts ?? {};
    const primary = PLATFORMS.find((p) => posts[p]?.url) ?? null;
    const enabledPosted = PLATFORMS.filter((p) => rj(join(ROOT, "config/platforms.json"))?.[p]?.enabled);
    const steps = [
      { n: 0, name: "Video built", ok: !!v, detail: v ? `${v.id} · ${meta.status}` : "no video yet" },
      { n: 1, name: "Reviewed and approved", ok: !!meta.explicitApproval || meta.status === "approved" || meta.status === "posted", detail: meta.status ?? "pending_review" },
      { n: 2, name: "Newsletter published", ok: !!pub, detail: pub ? `${pub.url ?? "published"} @ ${pub.at?.slice(11, 19) ?? "?"}Z` : "waiting" },
      { n: 3, name: "Public archive live", ok: false, detail: cfg.siteUrl ? "checking" : "no siteUrl configured", key: ed.key },
      { n: 4, name: "Posted to channels", ok: enabledPosted.length > 0 && enabledPosted.every((p) => posts[p]?.url || posts[p]?.id), detail: PLATFORMS.map((p) => `${p}:${posts[p] ? "✓" : "·"}`).join("  ") },
    ];
    const code = archiveLive(cfg.siteUrl, ed.key);
    if (code !== null) { steps[3].ok = code === "200"; steps[3].detail = `HTTP ${code}`; }
    return { ...ed, video: v?.id ?? null, status: meta.status ?? "—", primary, posts, steps };
  });
  const logDir = join(ROOT, "workdir/logs");
  const logs = existsSync(logDir)
    ? Object.fromEntries(readdirSync(logDir).filter((f) => f.endsWith(".log")).slice(0, 6).map((l) => [l, tail(join(logDir, l), 30)]))
    : {};
  const procs = (() => {
    try {
      return execSync("ps -eo pid,etime,command | grep 'cli.ts' | grep -v grep | sed 's#.*ai-content-engine[^/]*/##g'", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch { return []; }
  })();
  const locks = existsSync(join(ROOT, "workdir")) ? readdirSync(join(ROOT, "workdir")).filter((f) => f.endsWith(".lock")) : [];
  return { now: new Date().toISOString(), day: DAY, editions: eds, logs, procs, locks };
}

/**
 * The pipeline sub-graph this dashboard animates, derived from `graphify-out/graph.json` rather than
 * hand-maintained. A hand-maintained file list drifts the moment a module is renamed and then draws a
 * confidently wrong picture; deriving it means a rename just moves where the dot appears.
 */
function pipelineGraph() {
  const g = rj(join(ROOT, "graphify-out/graph.json"));
  if (!g) return { nodes: [], links: [], total: { nodes: 0, links: 0 } };
  const KEEP = /^src\/(pipeline|publish|post)\/[^/]+\.ts$/;
  const IS_TEST = /\.test\.ts$/;
  const fileOf = new Map();
  for (const n of g.nodes) {
    const f = n.source_file ?? "";
    if (KEEP.test(f) && !IS_TEST.test(f)) fileOf.set(n.id, f);
  }
  const links = [];
  const seen = new Set();
  for (const e of g.links) {
    const a = fileOf.get(e.source), b = fileOf.get(e.target);
    if (!a || !b || a === b) continue;
    const k = a + "→" + b;
    if (seen.has(k)) continue;
    seen.add(k);
    links.push({ source: a, target: b, relation: e.relation });
  }
  const nodes = [...new Set(fileOf.values())].map((f) => ({
    id: f,
    label: f.split("/").pop().replace(/\.ts$/, ""),
    group: f.includes("/post/") ? "post" : f.includes("/publish/") ? "publish" : "pipeline",
  }));
  return { nodes, links, total: { nodes: g.nodes.length, links: g.links.length } };
}

const cfg = rj(join(ROOT, "config/pipeline.json")) ?? {};
const defaultEdition = rj(join(ROOT, "config/editions/daily-roundup.json"));
const TITLE = defaultEdition?.newsletterTitle || defaultEdition?.displayName || "News Journey";

const HTML = `<!doctype html><meta charset="utf-8"><title>${escHtml(TITLE)} — live run ${escHtml(DAY)}</title>
<style>
:root{--bg:#07080C;--card:rgba(14,15,19,.72);--line:rgba(255,255,255,.08);--fg:#EDEAF5;--mute:#9D97B2;--ok:#3DDC97;--wait:#F2C94C;--bad:#FF6B6B;--v:#7C5CFF;--c:#4CC9F0}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system;overflow:hidden}
body:before{content:"";position:fixed;inset:0;background:radial-gradient(900px 600px at 18% 30%,rgba(124,92,255,.22),transparent 60%),radial-gradient(800px 600px at 85% 75%,rgba(76,201,240,.16),transparent 60%);pointer-events:none}
.stage{position:relative;width:1920px;height:1080px;transform-origin:top left;display:grid;grid-template-rows:88px 1fr 64px;grid-template-columns:1180px 1fr;gap:18px;padding:22px 28px}
header{grid-column:1/-1;display:flex;align-items:center;gap:22px}
.wordmark{font-weight:800;letter-spacing:.18em;font-size:15px;color:var(--mute);white-space:nowrap}
.wordmark b{color:var(--fg);letter-spacing:.06em;font-size:26px;display:block;margin-top:2px}
.clock{margin-left:auto;font-variant-numeric:tabular-nums;font-size:44px;font-weight:700;letter-spacing:.02em}
.clock small{display:block;font-size:13px;color:var(--mute);font-weight:500;letter-spacing:.12em;text-align:right}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--mute);background:rgba(255,255,255,.03);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis}
.pill.on{color:var(--ok);border-color:rgba(61,220,151,.4)}.pill.on:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 12px var(--ok);animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
.hero{position:relative;border:1px solid var(--line);border-radius:18px;background:var(--card);backdrop-filter:blur(8px);overflow:hidden}
canvas{width:100%;height:100%;display:block}
.hero .cap{position:absolute;left:18px;bottom:14px;font-size:12px;color:var(--mute);letter-spacing:.1em;text-transform:uppercase}
.legend{position:absolute;right:18px;top:14px;display:flex;gap:14px;font-size:12px;color:var(--mute)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}
.rails{display:grid;grid-auto-rows:1fr;gap:18px;overflow-y:auto}
.card{border:1px solid var(--line);border-radius:18px;background:var(--card);backdrop-filter:blur(8px);padding:18px 20px;position:relative;overflow:hidden}
.card h2{margin:0 0 4px;font-size:20px;font-weight:800}
.card .sub{color:var(--mute);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px;display:flex;gap:8px;align-items:center}
.steps{position:relative;padding-left:26px}
.steps:before{content:"";position:absolute;left:8px;top:8px;bottom:8px;width:2px;background:var(--line)}
.prog{position:absolute;left:8px;top:8px;width:2px;background:linear-gradient(var(--ok),var(--c));transition:height .8s ease;box-shadow:0 0 10px rgba(61,220,151,.6)}
.step{position:relative;padding:5px 0 5px 4px;display:flex;gap:10px;align-items:baseline}
.step .dot{position:absolute;left:-23px;top:9px;width:12px;height:12px;border-radius:50%;background:#2A2C36;border:2px solid #3A3D4A}
.step.ok .dot{background:var(--ok);border-color:var(--ok);box-shadow:0 0 14px rgba(61,220,151,.7)}
.step.cur .dot{background:var(--wait);border-color:var(--wait);box-shadow:0 0 14px rgba(242,201,76,.7);animation:pulse 1.1s ease-in-out infinite}
.step .n{font-weight:700;color:var(--mute);width:16px}.step .name{font-weight:600}
.step.ok .name{color:var(--fg)}.step .name{color:#B8B3C8}.step.cur .name{color:var(--fg)}
.step .d{color:var(--mute);font-size:12px;margin-left:auto;max-width:46%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tick{grid-column:1/-1;border:1px solid var(--line);border-radius:14px;background:var(--card);display:flex;align-items:center;padding:0 18px;overflow:hidden;font:13px/1 ui-monospace,Menlo,monospace;color:#C9C4D6}
.tick .lbl{color:var(--mute);letter-spacing:.14em;font-size:11px;margin-right:18px;white-space:nowrap}
.tick .line{white-space:nowrap;opacity:.95}
</style>
<div class="stage" id="stage">
<header>
  <div class="wordmark">${escHtml(TITLE.toUpperCase())}<b>LIVE PIPELINE RUN</b></div>
  <span class="pill" id="date"></span><span class="pill" id="procs"></span><span class="pill" id="locks"></span>
  <div class="clock"><span id="clock">--:--:--</span><small>LOCAL TIME · REFRESH 4S</small></div>
</header>
<div class="hero"><canvas id="g"></canvas>
  <div class="legend"><span><i style="background:#7C5CFF"></i>pipeline</span><span><i style="background:#4CC9F0"></i>publish</span><span><i style="background:#F2C94C"></i>post</span><span><i style="background:#3DDC97"></i>active now</span></div>
  <div class="cap" id="gstat"></div></div>
<div class="rails" id="rails"></div>
<div class="tick"><span class="lbl">LIVE LOG</span><span class="line" id="tickline">waiting for a run…</span></div>
</div>
<script>
const G = ${JSON.stringify(pipelineGraph())};
function fit(){const s=Math.min(innerWidth/1920,innerHeight/1080);document.getElementById('stage').style.transform='scale('+s+')';}
fit();addEventListener('resize',fit);
const cv=document.getElementById('g');const ctx=cv.getContext('2d');const W=1180-2,H=1080-88-64-18*2-2-22*2;
cv.width=W*2;cv.height=H*2;ctx.setTransform(2,0,0,2,0,0);
const N=G.nodes.map(n=>({...n,x:W/2+(Math.random()-.5)*500,y:H/2+(Math.random()-.5)*400,vx:0,vy:0}));
const idx=Object.fromEntries(N.map((n,i)=>[n.id,i]));
const L=G.links.filter(l=>idx[l.source]!=null&&idx[l.target]!=null).map(l=>({a:idx[l.source],b:idx[l.target],ph:Math.random()}));
const color={pipeline:'#7C5CFF',publish:'#4CC9F0',post:'#F2C94C'};
const rgb={pipeline:'rgb(124,92,255)',publish:'rgb(76,201,240)',post:'rgb(242,201,76)',ok:'rgb(61,220,151)'};
let active=new Set(),done=new Set(),t=0,flows=[];
function step(){for(const n of N){n.vx*=.86;n.vy*=.86}
 for(let i=0;i<N.length;i++)for(let j=i+1;j<N.length;j++){const a=N[i],b=N[j];let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;const f=5200/(d*d);a.vx-=dx/d*f;a.vy-=dy/d*f;b.vx+=dx/d*f;b.vy+=dy/d*f}
 for(const l of L){const a=N[l.a],b=N[l.b];let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;const f=(d-170)*.018;a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}
 for(const n of N){n.vx+=(W/2-n.x)*.0025;n.vy+=(H/2-n.y)*.0025;n.x=Math.max(60,Math.min(W-160,n.x+n.vx));n.y=Math.max(40,Math.min(H-40,n.y+n.vy))}}
function glow(x,y,r,c,a){const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,c.replace(')',','+a+')').replace('rgb(','rgba('));g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill()}
function draw(){t++;step();ctx.clearRect(0,0,W,H);
 for(const l of L){const a=N[l.a],b=N[l.b];const fin=done.has(a.id)&&done.has(b.id);
  ctx.strokeStyle=fin?'rgba(76,201,240,.28)':'rgba(255,255,255,.09)';ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}
 for(const f of flows){const a=N[idx[f.a]],b=N[idx[f.b]];if(!a||!b)continue;
  ctx.strokeStyle='rgba(61,220,151,.7)';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
  const p=((t/110)+f.ph)%1;const x=a.x+(b.x-a.x)*p,y=a.y+(b.y-a.y)*p;glow(x,y,11,rgb.ok,.9);ctx.fillStyle='#3DDC97';ctx.beginPath();ctx.arc(x,y,3.4,0,7);ctx.fill()}
 for(const n of N){const hot=active.has(n.id),fin=done.has(n.id);const c=hot?rgb.ok:rgb[n.group];glow(n.x,n.y,hot?34+6*Math.sin(t/7):22,c,hot?.55:.28);
  ctx.fillStyle=hot?'#3DDC97':color[n.group];ctx.beginPath();ctx.arc(n.x,n.y,hot?9:fin?8:6.5,0,7);ctx.fill();
  if(fin&&!hot){ctx.strokeStyle='rgba(61,220,151,.9)';ctx.lineWidth=2;ctx.beginPath();ctx.arc(n.x,n.y,12,0,7);ctx.stroke()}
  ctx.fillStyle=hot?'#EDEAF5':'#B8B3C8';ctx.font=(hot?'700 ':'500 ')+'12px ui-monospace,Menlo';ctx.fillText(n.label,n.x+13,n.y+4)}
 requestAnimationFrame(draw)}
draw();
document.getElementById('gstat').textContent='pipeline call graph · '+G.nodes.length+' modules · '+L.length+' cross-module edges (of '+G.total.nodes+' project nodes / '+G.total.links+' edges)';
let lastLine='';
// Edition labels, statuses, and step details ultimately trace back to model-generated headlines and
// log lines — untrusted text. Escape before it ever reaches innerHTML.
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
async function poll(){const s=await (await fetch('/state.json')).json();
 document.getElementById('clock').textContent=new Date(s.now).toLocaleTimeString();
 document.getElementById('date').textContent=new Date(s.day+'T12:00:00').toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
 const pr=document.getElementById('procs');pr.textContent=s.procs.length?s.procs.length+' pipeline process'+(s.procs.length>1?'es':'')+' running':'idle';pr.className='pill'+(s.procs.length?' on':'');
 document.getElementById('locks').textContent=s.locks.length?'locks · '+s.locks.map(x=>x.replace('.lock','')).join(', '):'no locks';
 active=new Set();done=new Set();
 const rails=document.getElementById('rails');
 if(!s.editions.length){rails.innerHTML='<div class="card"><h2>No editions configured</h2><div class="sub">Add a file under config/editions/ to see it here.</div></div>';}
 rails.innerHTML=s.editions.map((ed,i)=>{const cur=ed.steps.findIndex(st=>!st.ok);
  const okN=ed.steps.filter(x=>x.ok).length;const pct=okN/ed.steps.length*100;
  return '<div class="card"><h2>'+esc(ed.label)+'</h2><div class="sub"><span>'+esc(ed.key)+'</span><span class="pill">'+esc(ed.status)+'</span><span class="pill">'+okN+'/'+ed.steps.length+'</span></div><div class="steps"><div class="prog" style="height:'+pct+'%"></div>'
   +ed.steps.map((st,k)=>'<div class="step '+(st.ok?'ok':(k===cur?'cur':''))+'"><span class="dot"></span><span class="n">'+st.n+'</span><span class="name">'+esc(st.name)+'</span><span class="d">'+esc(st.detail)+'</span></div>').join('')+'</div></div>';
 }).join('');
 const lines=Object.entries(s.logs).flatMap(([n,l])=>l.slice(-3).map(x=>({n,x})));const latest=lines.map(o=>o.x).filter(x=>x.startsWith('[20')).sort().slice(-1)[0];
 if(latest&&latest!==lastLine){lastLine=latest;document.getElementById('tickline').textContent=latest.slice(latest.indexOf(']')+1).trim()}}
poll();setInterval(poll,4000);
</script>`;

/**
 * DNS REBINDING GUARD.
 *
 * Binding to 127.0.0.1 keeps the socket off the network, but it does not stop a page loaded from
 * the public internet from reading this server's data: the browser resolves the attacker's hostname
 * to 127.0.0.1 AFTER the page has already loaded (DNS rebinding), then issues a same-origin fetch
 * from that hostname straight at this port. Nothing about "the socket only listens locally" defends
 * against that — the request really does arrive from 127.0.0.1's own loopback interface.
 *
 * The `Host` header is the only signal that survives the rebind: a legitimate browser tab pointed at
 * this dashboard sends `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`; a rebound request still
 * carries the attacker's original hostname, because DNS rebinding changes the IP a hostname resolves
 * to, not the Host header the browser sends for it. Reject anything else before touching disk state.
 */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function hostAllowed(req) {
  return ALLOWED_HOSTS.has(req.headers.host ?? "");
}

createServer((req, res) => {
  if (!hostAllowed(req)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden: unexpected Host header");
    return;
  }
  if (req.url?.startsWith("/state.json")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(state()));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(HTML);
}).listen(PORT, "127.0.0.1", () => console.log(`live dashboard → http://127.0.0.1:${PORT}  (day ${DAY})`));
