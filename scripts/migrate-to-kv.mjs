#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(process.cwd(), 'data', 'scheduler-data.json');

let kvAdapter;
try {
  kvAdapter = await import('../dist/kvAdapter.js');
} catch (err) {
  console.error('Failed to import kvAdapter from dist. Did you build the project?');
  process.exit(1);
}

const { kvAvailable, kvSetSchedulerData, kvSetAppointments } = kvAdapter;

async function main() {
  if (!kvAvailable) {
    console.error('Vercel KV not available. Set VERCEL_KV_NAMESPACE and ensure @vercel/kv is configured.');
    process.exit(2);
  }

  try {
    const contents = await readFile(dataFile, 'utf8');
    const data = JSON.parse(contents);

    const ok = await kvSetSchedulerData(data);
    const ok2 = await kvSetAppointments(data.sessions || []);

    console.log('KV migration results: scheduler data ->', ok, ', appointments ->', ok2);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

main();
