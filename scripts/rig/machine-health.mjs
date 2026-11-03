#!/usr/bin/env node
/* Is the machine and the road to our servers fit to measure on? Waits for N healthy checks in a row before a rig run or a gate.
   node scripts/rig/machine-health.mjs [--need=3] [--every=20] [--max-min=30] [--max-load=8] [--max-s=3]
   Exit 0 healthy; exit 1 gave up, with the last reasons printed.

   THE FALSE "HEALTHY" THIS CLOSES (2026-11-03): the first watcher read only a time under a limit, and a curl that failed at once
   took 0.0016s - "HEALTHY after 48 checks: edge 0.0015919s" while the network was down. A check now passes only on HTTP 200 AND a
   time between MIN_S and the limit: nothing that crosses a network and TLS answers in under 0.1s, so a faster answer is a failure. */
import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";

export const MIN_S = 0.1;

/** One probe's verdict. @returns {string|null} why it failed, or null when it passed */
export function probeFailure({ http, seconds }, maxS = 3) {
  if (http !== 200) return `http ${http}`;
  if (!(seconds >= MIN_S)) return `instant ${seconds}s (under ${MIN_S}s)`;
  if (seconds > maxS) return `slow ${seconds}s`;
  return null;
}

const PROBES = [
  { name: "origin", url: "https://app.pear-ai.io/api/health" },
  { name: "edge", url: "https://rt.pear-ai.io/prompt", body: JSON.stringify({ item: { name: "health" }, angle: "front" }) },
];

function curl({ url, body }) {
  const args = ["-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", "-m", "10", url];
  if (body) args.push("-X", "POST", "-H", "Content-Type: application/json", "-H", "Origin: https://app.pear-ai.io", "-d", body);
  return new Promise((resolve) => execFile("curl", args, (_e, out) => {
    const [http, seconds] = String(out || "000 0").trim().split(/\s+/);
    resolve({ http: Number(http) || 0, seconds: Number(seconds) || 0 });
  }));
}

async function main() {
  const arg = (k, d) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1]) || d;
  const need = arg("need", 3), every = arg("every", 20), maxMin = arg("max-min", 30), maxLoad = arg("max-load", 8), maxS = arg("max-s", 3);
  const end = Date.now() + maxMin * 60_000;
  let streak = 0, checks = 0, last = [];
  for (;;) {
    checks++;
    const results = await Promise.all(PROBES.map(async (p) => ({ name: p.name, ...(await curl(p)) })));
    const load = loadavg()[0];
    last = results.map((r) => { const why = probeFailure(r, maxS); return why && `${r.name}: ${why}`; }).filter(Boolean);
    if (load > maxLoad) last.push(`load ${load.toFixed(1)}`);
    streak = last.length ? 0 : streak + 1;
    const line = results.map((r) => `${r.name} ${r.http} ${r.seconds}s`).join(", ");
    console.log(`[${checks}] ${last.length ? `FAIL ${last.join("; ")}` : `ok ${streak}/${need}`} - ${line}, load ${load.toFixed(1)}`);
    if (streak >= need) { console.log(`HEALTHY: ${need} in a row after ${checks} checks`); return 0; }
    if (Date.now() >= end) { console.log(`NOT HEALTHY after ${checks} checks: ${last.join("; ")}`); return 1; }
    await new Promise((r) => setTimeout(r, every * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
