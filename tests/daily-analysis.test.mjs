// Runs only through run-isolated.mjs against its disposable local D1/R2 state.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const base = new URL(process.env.API_TEST_BASE || '');
assert.equal(base.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests are local-only');
const scheduled = new URL(process.env.API_TEST_SCHEDULE_URL || '');
assert.equal(scheduled.origin, base.origin);
assert.equal(scheduled.pathname, '/cdn-cgi/handler/scheduled');
const root = await fs.realpath(process.env.API_TEST_ROOT || '');
const config = await fs.realpath(process.env.API_TEST_CONFIG || '');
const fixture = path.dirname(config);
assert.equal(fixture, await fs.realpath(process.cwd()), 'Only the harness fixture can be changed');
assert.equal(path.dirname(fixture), await fs.realpath(os.tmpdir()));
assert.ok(path.basename(fixture).startsWith('yokohama-isolated-api-'));
const persist = await fs.realpath(process.env.API_TEST_PERSIST || '');
assert.equal(persist, path.join(fixture, 'state'));
const cfg = JSON.parse(await fs.readFile(config, 'utf8'));
assert.equal(cfg.name, 'yokohama-isolated-api-test');
assert.equal(cfg.d1_databases[0].database_name, 'yokohama-isolated-test');
assert.equal(cfg.r2_buckets[0].bucket_name, 'yokohama-isolated-test');
assert.equal(cfg.d1_databases[0].remote, undefined);
assert.equal(cfg.r2_buckets[0].remote, undefined);
const secret = (await fs.readFile('.dev.vars', 'utf8')).trim().split('=', 2)[1];
const { projectParticipant } = await import(pathToFileURL(path.join(root, 'lib/polis-math.ts')));
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const DAY = 86_400_000;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

async function sql(statement) {
  const file = path.join(fixture, 'daily-fixture.sql');
  await fs.writeFile(file, statement);
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--config', config, '--persist-to', persist, '--file', file, '--json'], { cwd: fixture, env: process.env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).flatMap(result => result.results || []);
}
async function call(route, { body, token, admin = false } = {}) {
  const response = await fetch(new URL(route, base), {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'x-session-token': token } : {}), ...(admin ? { Authorization: `Bearer ${secret}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function daily(time) {
  const url = new URL(scheduled);
  url.searchParams.set('cron', '0 18 * * *');
  url.searchParams.set('time', String(time));
  // Miniflare's default entry service is the static-assets router. A local-only
  // override targets the actual Worker, whose scheduled handler must be tested.
  const response = await fetch(url, { headers: { 'MF-Route-Override': cfg.name } });
  assert.equal(response.status, 200, await response.text());
}
const snapshots = async () => (await sql('SELECT COUNT(*) count FROM result_snapshots'))[0].count;
const publicAnalysis = token => call('/api/analysis', { token });
const privateAnalysis = id => call(`/api/moderation?view=analysis&id=${id}`, { admin: true });
function assertPublic(data, syntheticIds) {
  const encoded = JSON.stringify(data);
  for (const field of ['sessionIds', 'session_id', 'token_hash', 'warmStart', 'pcaWarmStarted', 'diagnostics', 'object_key']) assert.ok(!encoded.includes(`"${field}"`), `Private field ${field} must stay private`);
  for (const id of syntheticIds) assert.ok(!encoded.includes(id));
  assert.ok(!encoded.includes(secret));
}

const community = await call('/api/community');
const ids = community.opinions.map(opinion => opinion.id).sort();
assert.ok(ids.length >= 12, 'Need enough approved features for a clear local fixture');
const myToken = randomBytes(32).toString('hex');
await call('/api/session', { token: myToken, body: { action: 'start', noticeVersion: process.env.API_TEST_NOTICE } });
const myHash = createHash('sha256').update(myToken).digest('hex');
const [{ id: myId }] = await sql(`SELECT id FROM sessions WHERE token_hash=${quote(myHash)}`);
const syntheticIds = Array.from({ length: 120 }, (_, index) => `local-daily-${String(index).padStart(3, '0')}-${randomUUID()}`);
const now = Date.now();
let random = 0x12345678;
function draw() { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) / 2 ** 32; }
const sessions = syntheticIds.map(id => `(${quote(id)},${quote(createHash('sha256').update(id).digest('hex'))},'active',${now},${quote(process.env.API_TEST_NOTICE)})`);
const votes = [];
for (let i = 0; i < syntheticIds.length; i++) for (let j = 0; j < ids.length; j++) {
  const value = j < 3 ? -1 : (i % 2 ? 1 : -1) * (j % 2 ? 1 : -1) * (draw() > .93 ? -1 : 1);
  votes.push(`(${quote(syntheticIds[i])},${quote(ids[j])},${value},${now})`);
}
for (let j = 3; j < 9; j++) votes.push(`(${quote(myId)},${quote(ids[j])},${j % 2 ? 1 : -1},${now})`);
const fixtureSql = [`INSERT INTO sessions(id,token_hash,phase,created_at,notice_version) VALUES ${sessions.join(',')};`];
for (let offset = 0; offset < votes.length; offset += 200) fixtureSql.push(`INSERT INTO votes(session_id,opinion_id,value,created_at) VALUES ${votes.slice(offset, offset + 200).join(',')};`);
await sql(fixtureSql.join('\n'));
const countBefore = await snapshots();
assert.equal((await publicAnalysis()).snapshotId, null, 'Reads must not rebuild an invalidated daily map');
assert.equal(await snapshots(), countBefore, 'Public reads must not create snapshots');

const firstDay = now + DAY;
await daily(firstDay);
const first = await publicAnalysis(myToken);
assert.equal(first.analysis.status, 'ready');
assert.equal(first.analysis.groups.length, 2);
assert.ok(first.analysis.eligible >= 121);
assert.ok(first.projectionModel);
assert.equal(first.analysis.points.filter(point => point.mine).length, 1);
assertPublic(first, [...syntheticIds, myId]);
assert.equal(await snapshots(), countBefore + 1);
const initialPrivate = await privateAnalysis(first.snapshotId);
assert.equal((await fetch(new URL(`/api/moderation?view=analysis&id=${first.snapshotId}`, base))).status, 401, 'Private saved model requires admin authentication');
assert.ok(initialPrivate.sessionIds.includes(myId));
assert.deepEqual(initialPrivate.model, first.projectionModel);
assert.deepEqual(initialPrivate.diagnostics.pcaWarmStarted, [false, false]);

const conditional = await call(`/api/analysis?snapshot=${first.snapshotId}`, { token: myToken });
assert.equal(conditional.analysisUnchanged, true);
assert.equal(conditional.snapshotId, first.snapshotId);
assert.ok(!Object.hasOwn(conditional, 'analysis'));
assert.ok(!Object.hasOwn(conditional, 'projectionModel'));
assert.ok(JSON.stringify(conditional).length < JSON.stringify(first).length / 10);

const beforeVote = await call('/api/community', { token: myToken });
const beforePoint = projectParticipant(first.projectionModel, beforeVote.session.votes);
assert.ok(beforePoint);
const card = (await call('/api/session', { token: myToken, body: { action: 'next' } })).impression;
assert.ok(card && first.projectionModel.opinionIds.includes(card.opinion.id));
const distance = point => Math.hypot(point.x - beforePoint.x, point.y - beforePoint.y);
const candidates = [-1, 1].map(value => ({ value, point: projectParticipant(first.projectionModel, { ...beforeVote.session.votes, [card.opinion.id]: value }) }));
candidates.sort((a, b) => distance(b.point) - distance(a.point));
const answer = candidates[0];
assert.ok(distance(answer.point) > 1e-8);
await call('/api/session', { token: myToken, body: { action: 'vote', opinionId: card.opinion.id, impressionId: card.id, value: answer.value } });
const afterVote = await call('/api/community', { token: myToken });
assert.deepEqual(projectParticipant(first.projectionModel, afterVote.session.votes), answer.point, 'Only the participant projection changes after answering');
const afterVoteMap = await publicAnalysis(myToken);
assert.equal(afterVoteMap.snapshotId, first.snapshotId);
assert.deepEqual(afterVoteMap.analysis.points, first.analysis.points, 'The shared map stays fixed for the day');
assert.deepEqual(afterVoteMap.projectionModel, first.projectionModel);
assert.equal(await snapshots(), countBefore + 1, 'An answer does not create a full fit');
await Promise.all(Array.from({ length: 3 }, () => daily(firstDay)));
assert.equal((await publicAnalysis()).snapshotId, first.snapshotId);
assert.equal(await snapshots(), countBefore + 1, 'Repeated same-day schedules do not fit again');

await Promise.all(Array.from({ length: 3 }, () => daily(firstDay + DAY)));
const second = await publicAnalysis(myToken);
assert.equal(second.analysis.status, 'ready');
assert.notEqual(second.snapshotId, first.snapshotId);
assert.equal(await snapshots(), countBefore + 2, 'Concurrent daily schedules publish one snapshot');
const secondPrivate = await privateAnalysis(second.snapshotId);
assert.ok(secondPrivate.diagnostics.pcaWarmStarted.every(Boolean), 'Daily PCA reuses the previous axes');
assert.ok(secondPrivate.diagnostics.candidates.some(candidate => candidate.warmStart), 'Daily clustering starts from previous memberships');
assert.equal(secondPrivate.stats.votes, initialPrivate.stats.votes + 1);
assert.ok(secondPrivate.sourceRevision > initialPrivate.sourceRevision);
const secondOwn = second.analysis.points.find(point => point.mine);
const projectedOwn = projectParticipant(second.projectionModel, afterVote.session.votes);
assert.ok(Math.abs(secondOwn.x - projectedOwn.x) < 1e-10);
assert.ok(Math.abs(secondOwn.y - projectedOwn.y) < 1e-10);
assertPublic(second, [...syntheticIds, myId]);

await daily(firstDay + 2 * DAY);
const unchanged = await publicAnalysis(myToken);
assert.equal(unchanged.snapshotId, second.snapshotId, 'No changed data means no extra daily fit');
assert.equal(unchanged.analysisComputedAt, second.analysisComputedAt);
assert.equal(await snapshots(), countBefore + 2);
const hiddenId = second.projectionModel.opinionIds.at(-1);
const hidden = (await call('/api/community')).opinions.find(opinion => opinion.id === hiddenId);
await call('/api/moderation', { admin: true, body: { id: randomUUID(), action: 'hide', opinionId: hidden.id, expectedRevision: hidden.revision, reviewedUnrelated: Number(hidden.unrelated || 0), reviewedReports: 0, actor: 'すすすす', reason: '隔離された日次分析テストで非表示を確認', runUrl: 'https://github.com/project-test/yokohama-voices-moderation/actions/runs/1' } });
const invalidated = await call(`/api/analysis?snapshot=${second.snapshotId}`, { token: myToken });
assert.equal(invalidated.snapshotId, null, 'Moderation invalidates even a conditional request');
assert.equal(invalidated.projectionModel, null);
assert.equal(invalidated.analysisUnchanged, undefined);
assert.deepEqual(invalidated.analysis.points, []);
await daily(firstDay + 2 * DAY);
assert.equal((await publicAnalysis()).snapshotId, null, 'Same-day moderation waits for the next daily update');
await daily(firstDay + 3 * DAY);
const third = await publicAnalysis(myToken);
assert.equal(third.analysis.status, 'ready');
assert.notEqual(third.snapshotId, second.snapshotId);
assert.ok(!third.projectionModel.opinionIds.includes(hiddenId));
assert.ok(!third.analysisOpinions.some(opinion => opinion.id === hiddenId));
assert.ok(!third.analysis.bridges.some(opinion => opinion.id === hiddenId));
assertPublic(third, [...syntheticIds, myId]);
await fs.writeFile(path.join(fixture, 'preview-session.json'), JSON.stringify({ token: myToken, snapshotId: third.snapshotId }), { mode: 0o600 });
console.log('PASS: daily-only fitting, fixed shared map with live personal projection, private warm starts, compact unchanged reads, concurrent/duplicate cron coalescing, unchanged-day reuse, and moderation invalidation/rebuild in isolated D1/R2.');
