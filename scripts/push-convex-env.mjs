#!/usr/bin/env node
// Pushes deployment environment variables from .env.convex into the Convex deployment.
//
// Convex functions read `process.env` from the *deployment's* env store, not from the machine
// (or container) the backend runs on -- so a var sitting in .env.local, or handed to the backend
// container by docker compose, is invisible to convex/util/llm.ts. Only `npx convex env set`
// puts it where functions can see it. This script does that in bulk so the keys live in one
// place instead of being retyped as a wall of `npx convex env set` commands.
//
// The file is the allowlist. Everything in .env.convex is a deployment variable by definition --
// that is what the file is for -- so everything in it is pushed. Don't put anything else there:
// `CONVEX_SELF_HOSTED_*` and `VITE_*` belong in .env.local, which this never reads.
//
// Wired into `predev`, so `npm run dev` (or `npm run predev`) syncs them automatically.
// Run it directly with `npm run env:push`.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const ENV_FILE = process.env.CONVEX_ENV_FILE ?? '.env.convex';

// The one exclusion, and it is not a matter of taste: `CONVEX_` is a reserved prefix that
// `convex env set` rejects outright, and `VITE_` is baked into the frontend bundle rather than
// read by a function. Either one in the file is a mistake, so say so and keep going rather than
// dying halfway through the push.
const NEVER_PUSH = /^(CONVEX_|VITE_)/;

function parseEnvFile(path) {
  const out = new Map();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way dotenv does.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

function convex(args) {
  return execFileSync('npx', ['convex', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function remoteEnv() {
  const raw = convex(['env', 'list']);
  const out = new Map();
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

if (!existsSync(ENV_FILE)) {
  console.log(`push-convex-env: no ${ENV_FILE}, nothing to sync`);
  process.exit(0);
}

const local = parseEnvFile(ENV_FILE);
const wanted = [];
for (const [key, value] of local) {
  if (NEVER_PUSH.test(key)) {
    console.log(`  ! ${key} (skipped: belongs in .env.local, not ${ENV_FILE})`);
    continue;
  }
  wanted.push([key, value]);
}

if (wanted.length === 0) {
  console.log(`push-convex-env: no deployment vars found in ${ENV_FILE}`);
  process.exit(0);
}

const remote = remoteEnv();
let set = 0;
for (const [key, value] of wanted) {
  if (remote.get(key) === value) {
    console.log(`  = ${key} (unchanged)`);
    continue;
  }
  convex(['env', 'set', key, value]);
  console.log(`  + ${key}`);
  set++;
}
console.log(`push-convex-env: ${set} set, ${wanted.length - set} unchanged (from ${ENV_FILE})`);
