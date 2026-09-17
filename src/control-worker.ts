import { applyControlAction } from "./release-control.js";
import { watchStage } from './watchdog-progress.js';
let input = "";
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 32 * 1024 * 1024) throw new Error("Input too large"); }
try {
  const request = JSON.parse(input);
  const result = await watchStage('journey-action', async () => request.action === "journey" ? await (await import("./executive-actions.js")).applyExecutiveAction(request.operation, request.data) : await applyControlAction(request));
  console.log(JSON.stringify({ controlResult: result }));
}
catch (error) {
  let message = (error as Error).message;
  for (const [key, value] of Object.entries(process.env)) if (/TOKEN|SECRET|KEY|PASSWORD/.test(key) && value && value.length >= 4) message = message.split(value).join('[redacted]');
  console.error(JSON.stringify({ controlError: message })); process.exitCode = 1; // one tagged line: earlier stderr warnings cannot push the reason out
}
