// A disposable, loopback-only preview of synthetic responses using the real app.
// Usage: node scripts/preview-simulation.mjs fixture.json [--port 5185] [--verify-only]
// Build the intended app version first. No existing DB, credentials or server is reused.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node scripts/preview-simulation.mjs fixture.json [--port 5185] [--verify-only]');
  console.log('Synthetic fixture shape: {opinionIds: string[], votes: [{session_id, opinion_id, value}]}');
  console.log('Values: -1 agree, 1 disagree, 0 pass, 2 unrelated. Uses a fresh .wrangler/simulations/run-* directory.');
  process.exit(args.length ? 0 : 1);
}
const fixturePath = path.resolve(args.shift());
let port = 5185, verifyOnly = false;
while (args.length) {
  const arg = args.shift();
  if (arg === '--port') port = Number(args.shift());
  else if (arg === '--verify-only') verifyOnly = true;
  else throw new Error(`Unknown option: ${arg}`);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5173) {
  throw new Error('Choose an unused port from 1024 to 65535 other than the normal preview port 5173.');
}
const fixture = JSON.parse(await fsp.readFile(fixturePath, 'utf8'));
const seed = JSON.parse(await fsp.readFile(path.join(root, 'data/seed.json'), 'utf8'));
const seedIds = new Set(seed.opinions.map(opinion => opinion.id));
if (!Array.isArray(fixture.opinionIds) || fixture.opinionIds.length !== seedIds.size ||
    new Set(fixture.opinionIds).size !== seedIds.size || fixture.opinionIds.some(id => !seedIds.has(id))) {
  throw new Error('The fixture must use exactly the current seed opinion IDs.');
}
if (!Array.isArray(fixture.votes) || !fixture.votes.length) throw new Error('The fixture has no votes.');
const sessionIds = new Set(), pairs = new Set();
const opinionCounts = new Map(seed.opinions.map(opinion => [opinion.id, {agree: 0, disagree: 0, pass: 0, unrelated: 0}]));
for (const vote of fixture.votes) {
  if (typeof vote.session_id !== 'string' || !vote.session_id || vote.session_id.length > 512 ||
      !seedIds.has(vote.opinion_id) || ![-1, 0, 1, 2].includes(vote.value)) {
    throw new Error('Invalid synthetic vote. Expected session_id, a seed opinion_id and value -1/0/1/2.');
  }
  const pair = JSON.stringify([vote.session_id, vote.opinion_id]);
  if (pairs.has(pair)) throw new Error('Duplicate session/opinion pairs are not supported.');
  pairs.add(pair); sessionIds.add(vote.session_id);
  opinionCounts.get(vote.opinion_id)[({[-1]: 'agree', 0: 'pass', 1: 'disagree', 2: 'unrelated'})[vote.value]]++;
}
const sourceConfig = path.join(root, 'dist/server/wrangler.json');
if (!fs.existsSync(sourceConfig)) throw new Error('Build the intended app first: dist/server/wrangler.json is missing.');
const built = JSON.parse(await fsp.readFile(sourceConfig, 'utf8'));
if (built.triggers?.crons?.length !== 1 || built.triggers.crons[0] !== '0 18 * * *') {
  throw new Error('Build the daily-analysis Worker first; the expected 03:00 JST schedule is missing.');
}
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
if (!fs.existsSync(wrangler)) throw new Error('Local dependencies are missing.');
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
await new Promise(resolve => probe.close(resolve));

const simulations = path.join(root, '.wrangler/simulations');
await fsp.mkdir(simulations, {recursive: true});
const directory = await fsp.mkdtemp(path.join(simulations, 'run-'));
const persist = path.join(directory, 'state');
const config = path.join(directory, 'wrangler.json');
// Reconstruct a minimal local config, rather than copying any live bindings.
const localConfig = {
  name: 'yokohama-synthetic-local',
  main: path.resolve(path.dirname(sourceConfig), built.main),
  compatibility_date: built.compatibility_date,
  compatibility_flags: built.compatibility_flags,
  rules: built.rules,
  no_bundle: built.no_bundle,
  triggers: {crons: ['0 18 * * *']},
  assets: {directory: path.resolve(path.dirname(sourceConfig), built.assets.directory)},
  workers_dev: false,
  preview_urls: false,
  observability: {enabled: false},
  d1_databases: [{binding: 'DB', database_name: 'synthetic-local-only', database_id: randomUUID(), remote: false}],
  r2_buckets: [{binding: 'BUCKET', bucket_name: 'synthetic-local-only', remote: false}],
  vars: {MODERATION_REPOSITORY: ''},
};
await fsp.writeFile(config, JSON.stringify(localConfig, null, 2));
await fsp.writeFile(path.join(directory, '.dev.vars'), `MODERATION_TOKEN=${randomBytes(32).toString('hex')}\n`, {mode: 0o600});
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_)/.test(key)) delete env[key];
delete env.MODERATION_TOKEN;
Object.assign(env, {
  CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
  WRANGLER_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  WRANGLER_LOG_PATH: path.join(directory, 'logs'),
  WRANGLER_REGISTRY_PATH: path.join(directory, 'dev-registry'),
  MINIFLARE_REGISTRY_PATH: path.join(directory, 'miniflare-registry'),
});
function cli(command, json = false) {
  const result = spawnSync(process.execPath, [wrangler, ...command], {
    cwd: directory, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local fixture setup failed: ${result.stderr || result.stdout}`);
  return json ? JSON.parse(result.stdout.trim()) : result.stdout;
}
const d1 = ['d1', 'execute', 'DB', '--local', '--config', config, '--persist-to', persist];
console.log(`SYNTHETIC DATA ONLY — ${sessionIds.size} simulated participants / ${fixture.votes.length} responses.`);
console.log(`Isolated state and logs: ${directory}`);
for (const file of (await fsp.readdir(path.join(root, 'drizzle'))).filter(name => name.endsWith('.sql')).sort()) {
  cli([...d1, '--file', path.join(root, 'drizzle', file)]);
}
cli([...d1, '--file', path.join(root, 'scripts/initialize-empty.sql')]);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const rows = [];
for (const opinion of seed.opinions) rows.push(`INSERT INTO opinions(id,tag_id,text,kind,source_ids,created_at) VALUES(${quote(opinion.id)},${quote(opinion.tagId)},${quote(opinion.text)},'seed',${quote(JSON.stringify(opinion.sourceIds))},0);`);
for (const id of sessionIds) {
  const hash = createHash('sha256').update(`synthetic-preview:${id}:${randomUUID()}`).digest('hex');
  rows.push(`INSERT INTO sessions(id,token_hash,phase,created_at,ended_at,notice_version) VALUES(${quote(id)},${quote(hash)},'ended',0,0,'synthetic-preview');`);
}
// Counter triggers are exercised, including the separate unrelated flag.
for (let offset = 0; offset < fixture.votes.length; offset += 200) {
  const values = fixture.votes.slice(offset, offset + 200).map(vote => `(${quote(vote.session_id)},${quote(vote.opinion_id)},${vote.value === 2 ? 0 : vote.value},${vote.value === 2 ? 1 : 0},0)`);
  rows.push(`INSERT INTO votes(session_id,opinion_id,value,unrelated,created_at) VALUES ${values.join(',')};`);
}
const importPath = path.join(directory, 'synthetic-fixture.sql');
await fsp.writeFile(importPath, `${rows.join('\n')}\n`);
cli([...d1, '--file', importPath]);
const checks = cli([...d1, '--command', 'SELECT sessions,votes,ready FROM community_state WHERE id=1;', '--json'], true);
const state = checks.flatMap(result => result.results || [])[0];
if (state?.sessions !== sessionIds.size || state?.votes !== fixture.votes.length || state?.ready !== 1) {
  throw new Error(`Synthetic counters do not match the fixture: ${JSON.stringify(state)}`);
}

const logPath = path.join(directory, 'worker.log');
const log = fs.openSync(logPath, 'a');
const base = `http://127.0.0.1:${port}`;
let worker, stopping = false;
async function stop() {
  if (!worker || worker.exitCode !== null || stopping) return;
  stopping = true;
  worker.kill('SIGTERM');
  await new Promise(resolve => {
    const timeout = setTimeout(() => { if (worker.exitCode === null) worker.kill('SIGKILL'); resolve(); }, 4000);
    worker.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}
const shutdown = () => { void stop(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
try {
  worker = spawn(process.execPath, [path.join(root, 'tests/isolated-worker.mjs'), config, persist, String(port)],
  {cwd: directory, env, stdio: ['ignore', log, log]});
  let startError;
  worker.once('error', error => { startError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    if (startError) throw startError;
    if (worker.exitCode !== null) throw new Error(`Synthetic worker exited; inspect ${logPath}`);
    try { const response = await fetch(`${base}/api/community`, {signal: AbortSignal.timeout(2000)}); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Synthetic worker did not become ready; inspect ${logPath}`);
  const started = performance.now();
  // The public reader never computes a map. Exercise the real scheduled handler
  // once, through Miniflare's local-only route, before checking its saved output.
  const scheduled = new URL('/cdn-cgi/handler/scheduled', base);
  scheduled.searchParams.set('cron', '0 18 * * *');
  scheduled.searchParams.set('time', String(Date.now()));
  const scheduledResponse = await fetch(scheduled, {
    headers: {'MF-Route-Override': localConfig.name}, signal: AbortSignal.timeout(60000),
  });
  if (!scheduledResponse.ok) throw new Error(`Synthetic daily analysis failed (${scheduledResponse.status}); inspect ${logPath}`);
  const response = await fetch(`${base}/api/community?analysis=1`, {signal: AbortSignal.timeout(60000)});
  const community = await response.json();
  if (!response.ok || community.stats?.sessions !== sessionIds.size || community.stats?.votes !== fixture.votes.length ||
      !community.analysis || !community.snapshotId || ['processing', 'waiting'].includes(community.analysis.status)) {
    throw new Error(`Synthetic API validation failed: ${JSON.stringify({status: response.status, stats: community.stats, analysisStatus: community.analysis?.status})}`);
  }
  for (const opinion of community.opinions) {
    const expected = opinionCounts.get(opinion.id);
    if (!expected || ['agree', 'disagree', 'pass', 'unrelated'].some(key => Number(opinion[key]) !== expected[key])) {
      throw new Error(`Synthetic per-opinion counters do not match the fixture for ${opinion.id}.`);
    }
  }
  const verification = {
    synthetic: true, fixture: fixturePath, preview: `${base}/participate`, directory,
    sourceBuild: sourceConfig, checkedAt: new Date().toISOString(), stats: community.stats,
    analysisMs: Math.round(performance.now() - started), analysisStatus: community.analysis.status,
    eligible: community.analysis.eligible, groups: community.analysis.groups, bridges: community.analysis.bridges.length,
    snapshotId: community.snapshotId,
  };
  await fsp.writeFile(path.join(directory, 'verification.json'), JSON.stringify(verification, null, 2));
  await fsp.writeFile(path.join(directory, 'community-analysis.json'), JSON.stringify(community, null, 2));
  console.log(JSON.stringify(verification, null, 2));
  console.log(`SYNTHETIC LOCAL PREVIEW: ${base}/participate — choose 「共通する意見を見る」.`);
  if (!verifyOnly) {
    console.log('Leave this command running for the preview. Ctrl+C stops only this isolated worker.');
    await new Promise(resolve => { if (worker.exitCode !== null) resolve(); else worker.once('exit', resolve); });
  }
} finally {
  await stop();
  fs.closeSync(log);
  process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  console.log(`Synthetic preview stopped; isolated fixture retained at ${directory}`);
}
