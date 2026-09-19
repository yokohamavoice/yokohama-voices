// Direct Miniflare avoids Wrangler's extra HTTP proxy swallowing native cron
// triggers. The application bundle and bindings still come from built config.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

const [config, persist, port] = process.argv.slice(2);
const cfg = JSON.parse(await fs.readFile(config, 'utf8'));
const directory = path.dirname(await fs.realpath(config));
assert.equal(directory, await fs.realpath(process.cwd()), 'Run only inside the disposable fixture directory');
assert.equal(await fs.realpath(persist), path.join(directory, 'state'));
assert.ok(Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535 && Number(port) !== 5173);
let bindingName;
if (cfg.name === 'yokohama-isolated-api-test') {
  assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('yokohama-isolated-api-'));
  bindingName = 'yokohama-isolated-test';
} else if (cfg.name === 'yokohama-synthetic-local') {
  const simulations = fileURLToPath(new URL('../.wrangler/simulations/', import.meta.url));
  assert.equal(path.dirname(directory), await fs.realpath(simulations));
  assert.ok(path.basename(directory).startsWith('run-'));
  bindingName = 'synthetic-local-only';
} else {
  throw new Error('Only isolated API tests and disposable synthetic previews are allowed');
}
assert.equal(cfg.d1_databases.length, 1);
assert.equal(cfg.r2_buckets.length, 1);
assert.equal(cfg.d1_databases[0].binding, 'DB');
assert.equal(cfg.r2_buckets[0].binding, 'BUCKET');
assert.equal(cfg.d1_databases[0].database_name, bindingName);
assert.equal(cfg.r2_buckets[0].bucket_name, bindingName);
assert.notEqual(cfg.d1_databases[0].remote, true);
assert.notEqual(cfg.r2_buckets[0].remote, true);
assert.deepEqual(cfg.triggers?.crons, ['0 18 * * *']);
const { workerOptions, main, externalWorkers } = unstable_getMiniflareWorkerOptions(config);
assert.equal(externalWorkers.length, 0);
const moduleRoot = path.dirname(main);
const modulePaths = (await fs.readdir(moduleRoot, { recursive: true })).filter(file => /\.(?:js|mjs)$/.test(file)).map(file => path.join(moduleRoot, file));
// vinext uses dynamic imports, so supply the emitted modules explicitly, with
// the Worker entry first, as Wrangler's no-bundle loader does.
const modules = [main, ...modulePaths.filter(file => file !== main)].map(file => ({ type: 'ESModule', path: file }));
const runtime = new Miniflare({
  host: '127.0.0.1', port: Number(port), cf: false,
  unsafeTriggerHandlers: true,
  defaultPersistRoot: path.join(persist, 'v3'),
  workers: [{ ...workerOptions, name: cfg.name, modules, modulesRoot: moduleRoot }],
});
await runtime.ready;
console.log(`Isolated Worker ready on port ${port}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await runtime.dispose(); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
