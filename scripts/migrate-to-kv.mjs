#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(process.cwd(), 'data', 'scheduler-data.json');

let kvAdapter, upAdapter;
try {
  kvAdapter = await import('../dist/kvAdapter.js');
} catch (err) {
  // ignore
}
try {
  upAdapter = await import('../dist/upstashAdapter.js');
} catch (err) {
  // ignore
}

const kvAvailable = kvAdapter?.kvAvailable ?? false;
const kvSetSchedulerData = kvAdapter?.kvSetSchedulerData;
const kvSetAppointments = kvAdapter?.kvSetAppointments;
const upstashAvailable = upAdapter?.upstashAvailable ?? false;
const upSetSchedulerData = upAdapter?.upSetSchedulerData;
const upSetAppointments = upAdapter?.upSetAppointments;

async function main() {
  if (!kvAvailable && !upstashAvailable) {
    console.error('No KV provider available. Set VERCEL_KV_NAMESPACE or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN.');
    process.exit(2);
  }

  try {
    const contents = await readFile(dataFile, 'utf8');
    const data = JSON.parse(contents);

    let ok = false, ok2 = false;
    if (kvAvailable && kvSetSchedulerData) ok = await kvSetSchedulerData(data);
    if (!ok && upstashAvailable && upSetSchedulerData) ok = await upSetSchedulerData(data);
    if (kvAvailable && kvSetAppointments) ok2 = await kvSetAppointments(data.sessions || []);
    if (!ok2 && upstashAvailable && upSetAppointments) ok2 = await upSetAppointments(data.sessions || []);

    console.log('KV migration results: scheduler data ->', ok, ', appointments ->', ok2);
  } catch (err) {
    console.error('Migration failed', err);
    process.exit(1);
  }
}

main();
