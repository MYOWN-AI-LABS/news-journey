import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Script } from '../types.js';
import type { Cast } from './cast.js';
import { assertCastTranscriptQc, castLines, retainCastTranscriptReceipt } from './voice-cast.js';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'cast-transcript-qc-'));
 const consent={grantedBy:'owner',at:'2026-09-15T00:00:00Z',statement:'Approved test voice'};
 const cast:Cast={version:1,format:'conversation',updatedAt:null,members:[{id:'host',name:'Host',role:'host',voice:{engine:'kokoro',id:'af_heart'},consent},{id:'expert',name:'Expert',role:'expert',voice:{engine:'voicebox',id:'approved-profile'},consent}]};
 const script={hook:'Welcome.',intro:'The briefing.',body:[{voiceover:'It is proposed. A vote is required.',lines:[{speaker:'host',text:'It is proposed.'},{speaker:'expert',text:'A vote is required.'}]}],cta:'Read the source.',fullVoiceoverText:'Welcome. The briefing. It is proposed. A vote is required. Read the source.'} as Script;
 const save=(path:string,value:unknown)=>writeFileSync(join(dir,path),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));
 for(const [i,line] of castLines(script,cast).entries()){
  const prefix=`voice-lines/${String(i+1).padStart(3,'0')}`;mkdirSync(join(dir,prefix),{recursive:true});
  const audio=Buffer.from(`isolated line ${i} fixture`);save(`${prefix}/line.txt`,line.text);save(`${prefix}/audio.wav`,audio);
  save(`${prefix}/timestamps.json`,{engine:line.speaker.voice.engine,durationSec:2,words:[{w:line.text,start:0,end:1}]});
  save(`${prefix}/audio-qc.json`,{version:1,status:'pass',method:'raw-asr-script-comparison',engine:line.speaker.voice.engine,voice:line.speaker.voice.id,requestedText:line.text.trim(),scriptSha256:sha(line.text.trim()),audioSha256:sha(audio),blocking:[],heardWords:[{w:line.text,start:0,end:1}]});
 }
 save('audio.wav','exact isolated concatenation fixture');
 return {dir,cast,script,save,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('cast aggregate preserves exact selected voices, ordered transcripts and paced audio binding',()=>{
 const f=fixture();try{
  const qc=retainCastTranscriptReceipt(f.dir,f.script,f.cast) as any;assert.equal(qc.listeningApproved,false);assert.equal(qc.lines.length,5);assert.equal(qc.lines[3].voice,'approved-profile');assert.equal(qc.heardWords[3].start,6);
  assert.deepEqual(assertCastTranscriptQc(f.dir,f.script,f.cast),qc);
  f.save('audio.wav','paced merged bytes');assert.throws(()=>assertCastTranscriptQc(f.dir,f.script,f.cast),/aggregate cast receipt/);
  f.save('audio-qc.json',{...qc,postProcessing:{speedFactor:1.25,audioSha256:sha('paced merged bytes')}});assert.doesNotThrow(()=>assertCastTranscriptQc(f.dir,f.script,f.cast));
  const swapped=structuredClone(f.cast);swapped.members[1]!.voice.id='different-profile';assert.throws(()=>assertCastTranscriptQc(f.dir,f.script,swapped),/exact script, approved voice and audio/);
 }finally{f.close();}
});
test('cast aggregate cannot conceal altered line audio, failed ASR, changed line receipts or a lost qualifier',()=>{
 const f=fixture();try{
  retainCastTranscriptReceipt(f.dir,f.script,f.cast);const name='voice-lines/004/audio-qc.json';const original=readFileSync(join(f.dir,name));const qc=JSON.parse(original.toString());
  f.save(name,{...qc,status:'hold',blocking:['lost vote qualification']});assert.throws(()=>assertCastTranscriptQc(f.dir,f.script,f.cast),/AUDIO QC HOLD: cast line 4/);
  f.save(name,{...qc,changes:['receipt altered after concatenation']});assert.throws(()=>assertCastTranscriptQc(f.dir,f.script,f.cast),/aggregate cast receipt/);
  f.save(name,original);f.save('voice-lines/004/audio.wav','different audio');assert.throws(()=>assertCastTranscriptQc(f.dir,f.script,f.cast),/AUDIO QC HOLD: cast line 4/);
  assert.throws(()=>retainCastTranscriptReceipt(f.dir,{...f.script,fullVoiceoverText:f.script.fullVoiceoverText.replace('A vote is required. ','')},f.cast),/sequence differs/);
 }finally{f.close();}
});
