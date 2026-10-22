import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const targets = [
  { region: "us-east-1", label: "US East (N. Virginia)", url: process.env.S6_US_URL },
  { region: "ap-southeast-2", label: "Asia Pacific (Sydney)", url: process.env.S6_SYDNEY_URL },
  { region: "eu-west-1", label: "Europe (Ireland)", url: process.env.S6_EU_URL },
  { region: "ca-central-1", label: "Canada (Central)", url: process.env.S6_CANADA_URL },
].filter((t) => Boolean(t.url));

const WARMUP = 10;
const SAMPLES = 100;

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

const output = [];
for (const target of targets) {
  const client = new ConvexHttpClient(target.url);
  for (let i = 0; i < WARMUP; i++) {
    await client.mutation(api.probes.ping, { nonce: `${target.region}-warm-${i}` });
  }
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    await client.mutation(api.probes.ping, { nonce: `${target.region}-${i}` });
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  output.push({
    region: target.region,
    label: target.label,
    samples: SAMPLES,
    medianMs: Math.round(percentile(sorted, 50) * 10) / 10,
    p95Ms: Math.round(percentile(sorted, 95) * 10) / 10,
    minMs: Math.round(sorted[0] * 10) / 10,
    maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log(JSON.stringify(output, null, 2));
