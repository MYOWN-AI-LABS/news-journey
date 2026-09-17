import type { NewsletterData, NewsletterMotionStory } from "./newsletter-html.js";
import { normalizeUrl } from "../util.js";
import { DIAGRAM_CSS, ROUGH_FILTER_DEFS, diagramStyleForDay, withMotionPackets } from "./diagram-style.js";
import { SCHEMATIC_CSS } from "./story-schematic.js";
import { visualMediaProblem } from "./visual-media.js";
const esc = (s:string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const url = (s:string) => {try{return /^https?:$/.test(new URL(s).protocol)?esc(s):"#";}catch{return "#";}};
export function newsletterMotionForSource(d:NewsletterData, source:string, index=0):NewsletterMotionStory|undefined {
  const key=normalizeUrl(source);
  const occurrence=[d.issue.lead.sourceUrl,...d.issue.items.map(i=>i.url)].slice(0,index).filter(u=>normalizeUrl(u)===key).length;
  return d.motionStories?.filter(s=>normalizeUrl(s.url)===key)[occurrence];
}
export const STORY_VISUAL_CSS = SCHEMATIC_CSS + DIAGRAM_CSS + `
.topic-motion{margin:24px 0;border:1px solid var(--hair,#d0d5db);padding:12px;border-radius:12px;overflow:hidden}
.topic-motion .tm-stage{padding:10px!important;height:auto!important;box-sizing:border-box;background:#141B26;border-radius:10px}
.topic-motion .tm-story-svg{width:100%;height:auto;display:block;overflow:visible}
.topic-motion figcaption,.topic-motion .tm-reading{font:16px/1.5 Arial,sans-serif;margin:12px 0;overflow-wrap:anywhere}
.topic-motion button,.topic-motion input{min-height:44px;max-width:100%}
.topic-motion button{padding:8px 12px;cursor:pointer}
@media(max-width:420px){.wrap{padding-left:12px!important;padding-right:12px!important}.topic-motion{padding:8px}}
@media(prefers-reduced-motion:reduce){.topic-motion *{animation:none!important;transition:none!important}}
`;
export function newsletterVisual(story:NewsletterMotionStory|undefined,date:string):string {
  if(!story?.diagram)return "";
  const d=story.diagram,p=d.visual;
  let art:string;
  if(p && p.kind==="source" && p.image && !p.clip){
    const problem=visualMediaProblem(p);if(problem)throw new Error(problem);
    // The reviewed still of the source image, plain: no player, no numbered labels.
    art=`<img class="story-visual-image" src="${p.image!.dataUri ?? p.media!.poster}" alt="${esc(p.intent)}" style="display:block;width:100%;height:auto;border-radius:8px">`;
  }else if(p && p.kind!=="diagram"){
    const problem=visualMediaProblem(p);if(problem)throw new Error(problem);
    art=`<video class="story-visual-video" controls muted playsinline preload="none" poster="${p.media!.poster}" src="${p.media!.mp4}" aria-label="${esc(p.intent)}" style="display:block;width:100%;height:auto"></video><p class="tm-reading">Silent visual preview. Use Play with narration when available.</p>`;
  }else art=`${ROUGH_FILTER_DEFS}<div class="tm-stage">${withMotionPackets(d.svg)}</div>`;
  // Review verdicts, repair frames and QA JSON are production diagnostics: they live in
  // diagram-phone-review.json and visual-results.json, never inside the customer's newsletter.
  return `<figure class="topic-motion" data-story-index="${story.n}" data-visual-kind="${p?.kind??"diagram"}" data-visual-hash="${p?.media?.hash??""}" data-diagram-style="${diagramStyleForDay(date)}" data-narration="${esc(JSON.stringify(p?.narration??null))}" data-reading-starts="${esc(JSON.stringify(p?.timing?.starts??[]))}">
  <p class="tm-reading"><b>${esc(story.title)}</b></p>${art}<figcaption>${esc(p?.caveat||story.status)} · <a href="${url(story.url)}">Story source</a>${p?.clip?` · <a href="${url(p.clip.pageUrl)}">Footage source</a>`:p?.image?` · <a href="${url(p.image.sourceUrl)}">Image source</a>`:""}</figcaption></figure>`;
}
export function newsletterVisualScript(words:{w:string;start:number;end:number}[]):string {return `/* Reading previews have an explicit clock; narration uses timestamp cues in the video renderer. */
(function(){
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var audio=document.getElementById('baud');
  var spokenWords=${JSON.stringify(words.map(w=>[w.start,w.end,w.w])).replace(/</g,"\\u003c")};
  ['bplay','btrack','btrbody'].forEach(function(id){var control=document.getElementById(id);if(control)control.addEventListener('click',function(){if(audio)delete audio.dataset.storyPlayer;},true);});
  document.querySelectorAll('.topic-motion').forEach(function(f){
    var narration=JSON.parse(f.dataset.narration || 'null'), mode='narration';
    function audioClock(){return audio && narration ? audio.currentTime-narration.startSec : null;}
    if(audio && narration && narration.timing.duration>0){
      var sound=document.createElement('button'), caption=document.createElement('p');
      sound.type='button';sound.className='story-narration-play';sound.textContent='Play with narration';sound.setAttribute('aria-pressed','false');
      sound.style.cssText='margin:12px 0;padding:10px 16px;cursor:pointer';
      caption.className='story-narration-caption';caption.style.cssText='font-size:18px;line-height:1.5;min-height:3em';
      var storyWords=spokenWords.filter(function(w){return w[0]>=narration.startSec && w[0]<narration.startSec+narration.timing.duration;});
      f.appendChild(sound);f.appendChild(caption);
      sound.onclick=function(){
        var t=audioClock();if(!audio.paused && t!==null && t>=0 && t<narration.timing.duration){audio.pause();return;}
        audio.dataset.storyPlayer=f.dataset.storyIndex;mode='narration';audio.muted=false;audio.volume=1;audio.currentTime=narration.startSec;
        audio.play().catch(function(){caption.textContent='Playback could not start. Try Play with narration again.';});
      };
      function reflectNarration(){
        var t=audioClock(),owns=audio.dataset.storyPlayer===f.dataset.storyIndex;
        if(owns && t!==null && t>=narration.timing.duration && !audio.seeking){delete audio.dataset.storyPlayer;audio.pause();}
        var playing=!audio.paused && t!==null && t>=0 && t<narration.timing.duration;
        sound.textContent=playing?'Pause narration':'Play with narration';sound.setAttribute('aria-pressed',String(playing));
        if(t!==null && t>=0 && t<narration.timing.duration){
          var i=0;while(i+1<storyWords.length && storyWords[i+1][0]<=audio.currentTime)i++;
          caption.textContent=storyWords.slice(Math.floor(i/8)*8,Math.floor(i/8)*8+8).map(function(w){return w[2];}).join(' ');
        }
      }
      ['timeupdate','play','pause','seeked'].forEach(function(event){audio.addEventListener(event,reflectNarration);});
    }
    var video = f.querySelector('.story-visual-video');
    if(video){
      if(audio && narration && narration.timing.method==='narration' && !reduced){
        var read=JSON.parse(f.dataset.readingStarts || '[]'), cue=narration.timing.starts;
        function syncVideo(){
          var t=audioClock();if(mode!=='narration' || t===null || t<0 || t>narration.timing.duration || !read.length)return;
          var i=0;while(i+1<cue.length && t>=cue[i+1])i++;
          var stop=i+1<cue.length?cue[i+1]:narration.timing.duration;
          var target=(read[i]||0)+Math.max(0,Math.min(1,(t-cue[i])/Math.max(.1,stop-cue[i])))*((read[i+1]||5.9)-(read[i]||0));
          video.pause();if(video.preload==='none'){video.preload='auto';video.load();}
          if(video.readyState>=1 && Math.abs(video.currentTime-target)>.08)video.currentTime=target;
        }
        audio.addEventListener('timeupdate',syncVideo);
        ['seeked','playing'].forEach(function(event){audio.addEventListener(event,function(){mode='narration';video.pause();syncVideo();});});
        ['play','pointerdown','keydown'].forEach(function(event){video.addEventListener(event,function(){mode='reading';audio.pause();});});
      }
      if('IntersectionObserver'  in window) new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting){video.pause();if(audio && audio.dataset.storyPlayer===f.dataset.storyIndex)audio.pause();}});}).observe(f);
      return;
    }
    var groups = f.querySelectorAll('.tm-story-svg [data-step]');
    if(!groups.length) return;
    var n = groups.length, duration = n * 3.4 + 1, elapsed = 0, last = 0, raf = 0;
    var controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px';
    var label = document.createElement('span'); label.textContent = 'Reading preview'; controls.appendChild(label);
    var toggle = document.createElement('button'), replay = document.createElement('button'), full = document.createElement('button'), seek = document.createElement('input');
    toggle.textContent='Play'; replay.textContent='Replay'; full.textContent='Show all';
    seek.type='range';seek.min='0';seek.max=String(duration);seek.step='.1';seek.value='0';seek.setAttribute('aria-label','Reading preview position');
    [toggle,replay,full,seek].forEach(function(el){controls.appendChild(el);});f.appendChild(controls);
    function paint(){seek.value=String(elapsed); f.setAttribute('data-tm-active',reduced || elapsed>=n*3.4 ? 'hold' : String(Math.floor(elapsed/3.4)+1));}
    function pause(){cancelAnimationFrame(raf);raf=0;toggle.textContent='Play';}
    function tick(now){elapsed=Math.min(duration,elapsed+(now-last)/1000);last=now;paint();if(elapsed<duration)raf=requestAnimationFrame(tick);else pause();}
    function play(){pause();if(reduced){f.setAttribute('data-tm-active','hold');return;}if(elapsed>=duration)elapsed=0;last=performance.now();toggle.textContent='Pause';raf=requestAnimationFrame(tick);}
    toggle.onclick=function(){if(raf)pause();else play();};replay.onclick=function(){elapsed=0;play();};full.onclick=function(){pause();elapsed=duration;paint();};seek.oninput=function(){elapsed=+seek.value;paint();};
    if(audio && narration && narration.timing.method==='narration'){
      label.textContent='Follows narration · reading controls below';
      function syncDiagram(){var t=audioClock();if(mode!=='narration' || t===null || t<0 || t>narration.timing.duration)return;pause();var active=0;narration.timing.starts.forEach(function(start,i){if(t>=start)active=i+1;});f.setAttribute('data-tm-active',reduced?'hold':String(active));}
      audio.addEventListener('timeupdate',syncDiagram);
      ['seeked','playing'].forEach(function(event){audio.addEventListener(event,function(){mode='narration';syncDiagram();});});
      controls.addEventListener('click',function(){mode='reading';audio.pause();},true);seek.addEventListener('input',function(){mode='reading';audio.pause();},true);
    }
    f.setAttribute('data-tm-active','hold');
    if('IntersectionObserver'  in window) new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting){pause();if(audio && audio.dataset.storyPlayer===f.dataset.storyIndex)audio.pause();}});}).observe(f);
  });
})();

`;}
