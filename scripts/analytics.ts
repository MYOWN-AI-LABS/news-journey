import { runAnalytics } from "../src/analytics/cli.js";
const option = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
runAnalytics(process.argv[2], Number(option("days") ?? 30), option("week")).catch((e) => { console.error(e); process.exitCode = 1; });
