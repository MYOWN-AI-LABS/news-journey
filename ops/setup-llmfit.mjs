/** Explicit tool setup only. No model downloads, global configuration, dashboard or inference. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const LLMFIT_VERSION = '1.1.15';
export const LLMFIT_REPOSITORY = 'https://github.com/AlexsJones/llmfit';
const COMMIT = 'a0d9e5bdcf691707c2615e3805b53e7bea2d5151';
// Published official v1.1.15 asset digests verified against release metadata and .sha256 files.
export const LLMFIT_ASSETS = Object.freeze({
  'darwin/arm64': { target:'aarch64-apple-darwin', sha256:'6207b32a3fa97778a21afed7bbf5f33c569bda35202e04a27b4989880687e6d7' },
  'darwin/x64': { target:'x86_64-apple-darwin', sha256:'aadb97d706d3b03fb2c4573b0cfb8f421943023beb6617fea1229b033dfc6d4e' },
  'linux/arm64': { target:'aarch64-unknown-linux-musl', sha256:'d78cfcbc4d1905a02a7c79aef445b20d19020c37ab47baa83ee7bc687b4bcd13' },
  'linux/x64': { target:'x86_64-unknown-linux-musl', sha256:'4ba3519adf8f861af548554272193ad1ae45bd7e72db3879456b2e76d65a6100' },
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveName = asset => `llmfit-v${LLMFIT_VERSION}-${asset.target}.tar.gz`;

/** Read one bounded regular binary; never extract archive paths, symlinks or executable scripts. */
export function verifiedTarBinary(archive, expectedSha) {
  if (archive.length > 8 * 1024 * 1024 || sha(archive) !== expectedSha) throw new Error('Fit checker archive checksum did not match the pinned official release. Nothing was installed.');
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }); let binary;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '').trim();
    const rawSize = field(124,136), rawSum = field(148,156); if (!/^[0-7]+$/.test(rawSize) || !/^[0-7]+$/.test(rawSum)) throw new Error('Unsupported fit checker archive header.');
    const expected = parseInt(rawSum,8), checksum = header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0); if(checksum!==expected)throw new Error('Invalid fit checker archive header checksum.');
    const name = [field(345,500),field(0,100)].filter(Boolean).join('/'), type = String.fromCharCode(header[156] || 48), size = parseInt(rawSize,8);
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || !['0','5'].includes(type)) throw new Error('Unsafe fit checker archive path or entry type.');
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Truncated fit checker archive.');
    if (type==='0' && name.split('/').at(-1)==='llmfit') { if(binary || size<1 || size>32*1024*1024)throw new Error('Invalid fit checker binary entry.'); binary=Buffer.from(tar.subarray(offset+512,offset+512+size)); }
    offset += 512 + Math.ceil(size/512)*512;
  }
  if (!binary) throw new Error('The verified archive did not contain one regular llmfit binary.'); return binary;
}

export async function downloadOfficial(url, maxBytes, signal, fetcher=fetch) {
  let target = new URL(url);
  for (let n=0;n<5;n++) {
    if(target.protocol!=='https:' || target.username || target.password || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname))throw new Error('Fit checker download redirected outside the official release hosts.');
    const response=await fetcher(target,{signal,redirect:'manual',headers:{'user-agent':'content-harness-fit-checker-setup'}});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw new Error('Fit checker download redirect has no destination.');target=new URL(location,target);continue;}
    if(!response.ok || !response.body)throw new Error(`Fit checker download failed (HTTP ${response.status}).`);
    if(Number(response.headers.get('content-length'))>maxBytes){await response.body.cancel();throw new Error('Fit checker download exceeds its byte limit.');}
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try {for(let next=await reader.read();!next.done;next=await reader.read()){bytes+=next.value.length;if(bytes>maxBytes)throw new Error('Fit checker download exceeds its byte limit.');chunks.push(next.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    return Buffer.concat(chunks);
  }
  throw new Error('Fit checker download exceeded its redirect limit.');
}

function safeToolParent(codeRoot) {
  const root=realpathSync(codeRoot);let current=root;
  for(const part of ['workdir','tools','llmfit']){current=join(current,part);if(existsSync(current)){if(lstatSync(current).isSymbolicLink()||!lstatSync(current).isDirectory())throw new Error('Fit checker setup path is not a regular project directory.');}else mkdirSync(current);}
  return current;
}
export async function setupLlmfit(codeRoot, options={}) {
  const platform=options.platform??process.platform,arch=options.arch??process.arch,asset=LLMFIT_ASSETS[platform+'/'+arch];
  if(!asset)throw new Error('Automatic fit checker setup supports macOS and Linux on ARM64 or x64. Native Windows setup is unsupported in this version; continue with hardware fit unestimated.');
  const parent=safeToolParent(codeRoot),destination=join(parent,'v'+LLMFIT_VERSION),binaryPath=join(destination,'llmfit');
  if(existsSync(destination)) {
    if(lstatSync(destination).isSymbolicLink()||!lstatSync(destination).isDirectory()||!existsSync(binaryPath)||lstatSync(binaryPath).isSymbolicLink())throw new Error('Existing fit checker installation is not a regular verified directory.');
    const receipt=JSON.parse(readFileSync(join(destination,'provenance.json'),'utf8'));
    if(receipt.repository===LLMFIT_REPOSITORY&&receipt.version===LLMFIT_VERSION&&receipt.platform===platform&&receipt.arch===arch&&receipt.archiveSha256===asset.sha256&&receipt.binarySha256===sha(readFileSync(binaryPath)))return receipt;
    throw new Error('Existing fit checker files do not match the pinned release. They were kept; restore the verified tool before retrying.');
  }
  const name=archiveName(asset),url=`${LLMFIT_REPOSITORY}/releases/download/v${LLMFIT_VERSION}/${name}`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);let temp;
  try {
    const checksum=(await downloadOfficial(url+'.sha256',2048,controller.signal,options.fetcher)).toString('utf8').trim();
    const match=checksum.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/);if(!match||match[1]!==asset.sha256||match[2]!==name)throw new Error('Published fit checker checksum no longer matches the pinned official asset. Nothing was installed.');
    const archive=await downloadOfficial(url,8*1024*1024,controller.signal,options.fetcher),binary=verifiedTarBinary(archive,asset.sha256);
    const receipt={repository:LLMFIT_REPOSITORY,version:LLMFIT_VERSION,tag:'v'+LLMFIT_VERSION,commit:COMMIT,asset:name,url,archiveSha256:asset.sha256,binarySha256:sha(binary),platform,arch,installedAt:new Date().toISOString()};
    temp=mkdtempSync(join(parent,'.setup-'));writeFileSync(join(temp,'llmfit'),binary,{mode:0o755,flag:'wx'});chmodSync(join(temp,'llmfit'),0o755);writeFileSync(join(temp,'provenance.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
    renameSync(temp,destination);temp=undefined;return receipt;
  } finally {clearTimeout(timer);controller.abort();if(temp)rmSync(temp,{recursive:true,force:true});}
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length>2)throw new Error('No options accepted. Run from this harness checkout; the setup only installs its pinned fit checker.');
  try{const receipt=await setupLlmfit(resolve(dirname(fileURLToPath(import.meta.url)),'..'));console.log(JSON.stringify({message:'Verified fit checker ready. No model weights were downloaded and no inference started.',...receipt}));}catch(error){console.error(error.message);process.exitCode=1;}
}
