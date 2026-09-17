#!/usr/bin/env node
// Explicit collection runner. Await real job completion; never approve or send a reply here.
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export async function followUpOnce({ base, token, workspace, videoId, platforms, runId, requestId, timeoutMs = 300000, pollMs = 1500 }) {
  base = new URL(base);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('HARNESS_API_URL must be a local loopback HTTP endpoint');
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Set HARNESS_TOKEN to this workspace owner/admin token');
  for (const value of [workspace, videoId, runId]) if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value || '')) throw new Error('Valid workspace, video ID and run ID are required');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId || '')) throw new Error('A stable request ID of 8–128 characters is required');
  if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !['x', 'youtube', 'linkedin', 'instagram', 'threads', 'reddit', 'tiktok'].includes(p))) throw new Error('Choose follow-up channels');
  const deadline = Date.now() + timeoutMs;
  const request = async (path, body) => {
    const url = new URL(path, base); url.searchParams.set('workspace', workspace);
    const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now()))), headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json', 'idempotency-key': requestId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const receipt = await response.json();
    if (!response.ok) throw new Error(receipt.error || `Follow-up HTTP ${response.status}`);
    return receipt;
  };
  const submitted = await request('/v1/journey/engagement-followup', { videoId, platforms, runId });
  if (!/^[a-f0-9]{64}$/.test(submitted.job || '')) throw new Error('No journey job receipt; inspect state before resubmitting');
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`Follow-up job ${submitted.job} timed out; inspect it before retrying. Submission is not completion.`);
    const job = await request('/v1/journey/jobs/' + submitted.job);
    if (job.status === 'done') {
      if (!job.result?.run || job.result.run.id !== runId || job.result.run.videoId !== videoId) throw new Error('Job completed without the matching follow-up receipt');
      const result = job.result;
      return { ...result, job: submitted.job, exitCode: result.run.status === 'complete' ? 0 : 2, message: result.message + ' Collection does not establish reply delivery.' };
    }
    if (['failed', 'interrupted'].includes(job.status)) throw new Error(`Follow-up job ${job.status}: ${job.error || submitted.job}. Retain the run ID; resume after resolving the cause.`);
    if (job.status !== 'running') throw new Error('Unknown job state; inspect before retrying');
    await sleep(pollMs);
  }
}

async function main() {
  const [workspace, videoId, platformList, runId, requestId, repeat] = process.argv.slice(2);
  if (!requestId) throw new Error('Usage: node scripts/engagement-followup.mjs <workspace> <video-id> <x,youtube,...> <run-id> <request-id> [--every-minutes=60]');
  const minutes = repeat === undefined ? null : /^--every-minutes=\d+$/.test(repeat) ? Number(repeat.split('=')[1]) : NaN;
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 15 || minutes > 10080)) throw new Error('Collection interval must be 15–10080 minutes');
  const token = process.env.HARNESS_TOKEN;
  const redact = value => token ? String(value).split(token).join('[redacted]') : String(value);
  // Repeat is opt-in and stops on the first failure/partial result. No unchanged-error retry storm.
  // An external agent must resolve manual channels, review replies and confirm authorized sends.
  for (;;) {
    const slot = minutes === null ? '' : '-' + Math.floor(Date.now() / (minutes * 60000));
    const result = await followUpOnce({ base: process.env.HARNESS_API_URL || 'http://127.0.0.1:4791', token, workspace, videoId, platforms: platformList.split(','), runId: runId + slot, requestId: requestId + slot });
    console.log(redact(JSON.stringify(result)));
    if (minutes === null || result.exitCode !== 0) { process.exitCode = result.exitCode; return; }
    await sleep(minutes * 60000);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const token = process.env.HARNESS_TOKEN;
  console.error('engagement-followup: ' + (token ? error.message.split(token).join('[redacted]') : error.message)); process.exitCode = 1;
});
