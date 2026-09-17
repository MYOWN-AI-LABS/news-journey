import { contained } from "../workspaces.js";
import { publicResponse, safePublicUrl } from "../sources/public-apis.js";
import { withPublicPage } from "../sources/public-page.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, resolve, sep, dirname } from "node:path";
import * as cheerio from "cheerio";
import { RenderInternals } from "@remotion/renderer";
import { log } from "../util.js";
import type { VisualPlan } from "./visual-plan.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const run = promisify(execFile);

/** Bounded HTTPS capture through the same pinned sockets as Public API sources. */
async function download(raw: string, limit: number): Promise<{bytes:Buffer;url:string}> {
  const url = safePublicUrl(raw, "Visual source");
  const response = await publicResponse(url, {"User-Agent":"Content-Harness/0.2"}, 15_000, limit);
  return {bytes:Buffer.from(await response.arrayBuffer()),url};
}

export function sourceVideoUrls(html: string, pageUrl: string): string[] {
  const $=cheerio.load(html), urls:string[]=[];
  $('video[src],video source[src],meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]').each((_,el)=>{
    try {const u=new URL($(el).attr("src")??$(el).attr("content")??"",pageUrl);if(/^https?:$/.test(u.protocol)&&/\.(mp4|webm)$/i.test(u.pathname))urls.push(u.href);}catch{/* optional malformed source */}
  });
  return [...new Set(urls)].slice(0,3);
}

/** ponytail: direct embedded clips only; add an embed resolver when a real story needs one. */
export async function gatherSourceFootage(dir: string, ref: string, storyUrl: string, repoUrl?: string): Promise<string | null> {
  if(!/^[\w-]+$/.test(ref)) return null;
  const folder=contained(dir,"assets",`${ref}-footage`), receipt=contained(dir,"assets",`${ref}-footage`,"capture.json");
  mkdirSync(folder,{recursive:true});
  if(existsSync(receipt)) {
    const old=JSON.parse(readFileSync(receipt,"utf8"));
    const clips=old.clips ?? (old.clip?[old.clip]:[]);
    if(old.storyUrl===storyUrl && old.repoUrl===repoUrl && (!clips.length || clips.every((_:unknown,i:number)=>loadSourceFootage(dir,relative(dir,receipt),storyUrl,i)))) return clips.length?relative(dir,receipt):null;
  }
  const pages=[new URL(storyUrl).href], clips:NonNullable<VisualPlan["clip"]>[]=[];
  try {
    if(repoUrl) {
      const repo=new URL(repoUrl);
      if(repo.hostname==="github.com" && /^\/[^/]+\/[^/]+\/?$/.test(repo.pathname)) {
        const api=await download(`https://api.github.com/repos${repo.pathname.replace(/\/$/,"")}`,1_000_000);
        const homepage=JSON.parse(api.bytes.toString()).homepage;
        if(typeof homepage==="string" && /^https?:\/\//.test(homepage) && !pages.includes(new URL(homepage).href))pages.push(new URL(homepage).href);
      }
    }
  } catch(e){log(`source footage homepage: ${(e as Error).message}`);}
  for(const pageUrl of pages.slice(0,2)) {
    try {
      const page=await download(pageUrl,3_000_000);
      let urls=sourceVideoUrls(page.bytes.toString(),page.url);
      if(!urls.length)urls=await withPublicPage(page.url,async browserPage=>sourceVideoUrls(await browserPage.content(),browserPage.url()));
      for(const url of urls) {
        if(clips.length>=3)break;
        try {
          const source=await download(url,16_000_000), original=contained(folder,/\.webm$/i.test(new URL(url).pathname)?`original-${clips.length}.webm`:`original-${clips.length}.mp4`);
          writeFileSync(original,source.bytes);
          const probe=RenderInternals.getExecutablePath({type:"ffprobe",indent:false,logLevel:"error",binariesDirectory:null});
          const {stdout}=await run(probe,["-v","error","-show_streams","-show_format","-of","json",original],{timeout:10_000,env:process.platform === "darwin" ? {...process.env,DYLD_LIBRARY_PATH:dirname(probe)} : process.env});
          const info=JSON.parse(stdout), stream=info.streams.find((s:any)=>s.codec_type==="video"), duration=Math.min(12,Number(info.format.duration));
          if(!stream || stream.width<320 || stream.height<240 || !Number.isFinite(duration) || duration<2 || Number(info.format.duration)>180)throw new Error("source clip is not a bounded, useful demo");
          const file=contained(folder,`clip-${clips.length}.mp4`);
          const ff=(args:string[])=>RenderInternals.callFf({args:["-y","-loglevel","error",...args],bin:"ffmpeg",indent:false,logLevel:"error",binariesDirectory:null,cancelSignal:undefined,options:{timeout:30_000,killSignal:"SIGKILL"}});
          await ff(["-i",original,"-t",String(duration),"-an","-vf","scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2","-r","30","-c:v","libx264","-crf","23","-pix_fmt","yuv420p",file]);
          const frames=[];
          for(const [i,fraction] of [.1,.4,.7].entries()) {
            const frame=contained(folder,`frame-${clips.length}-${i}.png`),sec=Number((duration*fraction).toFixed(2));
            await ff(["-ss",String(sec),"-i",file,"-frames:v","1",frame]);
            frames.push({file:relative(dir,frame),sec,sha256:sha(readFileSync(frame))});
          }
          const clip:NonNullable<VisualPlan["clip"]>={file:relative(dir,file),sha256:sha(readFileSync(file)),sourceUrl:source.url,pageUrl:page.url,originalSha256:sha(source.bytes),duration,frames,startSec:0};
          clips.push(clip);
        } catch(e){log(`source footage candidate: ${(e as Error).message}`);}
      }
    } catch(e){log(`source footage page: ${(e as Error).message}`);}
  }
  writeFileSync(receipt,JSON.stringify({storyUrl,repoUrl,observedAt:new Date().toISOString(),clips},null,2));
  return clips.length?relative(dir,receipt):null;
}

export function loadSourceFootage(dir:string,receipt:string|undefined,storyUrl:string,index=0):VisualPlan["clip"] {
  if(!receipt)return undefined;
  const safe=(file:string)=>contained(dir,file);
  try {
    const data=JSON.parse(readFileSync(safe(receipt),"utf8")),c=(data.clips?.[index] ?? (index===0?data.clip:undefined)) as VisualPlan["clip"];
    if(data.storyUrl!==storyUrl || !c || sha(readFileSync(safe(c.file)))!==c.sha256 || c.frames.length!==3 || c.frames.some(f=>sha(readFileSync(safe(f.file)))!==f.sha256))return undefined;
    return c;
  }catch{return undefined;}
}
