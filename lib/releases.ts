/**
 * Resumable, immutable reviewed exports.
 *
 * Required invariants:
 * - opinions, votes, impressions, events are append-only with respect to rowid.
 *   Do not delete/reuse/rewrite rowids while a build exists.
 * - votes and impression allocation fields are immutable.
 * - every publication-relevant opinion edit / moderation decision increments
 *   community_state(id=1).moderation_revision in the same transaction.
 * - retirement writes a server-generated events.type='retired' record in the
 *   same transaction. Do not accept that event type from browser clients.
 * - public APIs authorize the release before calling getReleaseObject().
 */
import { env } from "cloudflare:workers";
import { database } from "@/db/raw";
import seed from "@/data/seed.json";
import { digest, HttpError, validId } from "@/lib/server";
import { ROUTING_VERSION } from "@/lib/routing";

export const RELEASE_SCHEMA = 3;
export const RELEASE_PAGE_ROWS = 500;
export const RELEASE_PAGE_BYTES = 1024 * 1024;
export const RELEASE_INDEX_ENTRIES = 256;
const encoder = new TextEncoder();
const KINDS = ["opinions", "responses", "presentations"] as const;
type Kind = (typeof KINDS)[number];
type Phase = Kind | `index_${Kind}` | "manifest" | "done";

export type PartReference = {
  part: string;
  sha256: string;
  row_count: number;
  byte_length: number;
};
type TableCounts = {
  rows: number;
  pages: number;
  index_pages: number;
  index: PartReference | null;
};
type Counts = Record<Kind, TableCounts> & { commit_token: string };
type Watermarks = {
  opinions: number;
  votes: number;
  impressions: number;
  events: number;
  metadata: {
    tags: typeof seed.tags;
    sources: typeof seed.sources;
    routing_version: string;
  };
};
export type ReleaseRow = {
  id: string;
  schema_version: number;
  status: "preparing" | "draft" | "released" | "invalidated";
  phase: Phase;
  cursor: number;
  build_revision: number;
  watermarks: string;
  counts: string;
  moderation_revision: number;
  sha256: string;
  object_key: string;
  created_at: number;
  published_at: number | null;
  summary: string;
  opinion_revisions: string;
  actor: string;
  reason: string;
  prepare_run_url: string | null;
};
type PartRow = {
  release_id: string;
  part_id: string;
  kind: string;
  object_key: string;
  sha256: string;
  row_count: number;
  byte_length: number;
};
type SourceRow = Record<string, string | number | null> & { source_cursor: number };
type FrozenOpinion = { opinion_id: string; revision: number; payload: string };
type PageResult = {
  payload: string;
  rowCount: number;
  cursor: number;
  done: boolean;
  opinions: FrozenOpinion[];
};

export function bucket() {
  if (!env.BUCKET) throw new HttpError(503, "公開データの保存先を確認してください。");
  return env.BUCKET;
}

function emptyCounts(): Counts {
  const fresh = (): TableCounts => ({ rows: 0, pages: 0, index_pages: 0, index: null });
  return { opinions: fresh(), responses: fresh(), presentations: fresh(), commit_token: "" };
}
const summary = (counts: Counts) => JSON.stringify(Object.fromEntries(KINDS.map(kind => [kind, counts[kind].rows])));
const partId = (type: "d" | "i", kind: Kind, page: number) => `${type}-${kind}-${String(page).padStart(12, "0")}`;
const reference = (part: PartRow): PartReference => ({ part: part.part_id, sha256: part.sha256, row_count: part.row_count, byte_length: part.byte_length });
const nextDataPhase = (kind: Kind): Phase => kind === "opinions" ? "responses" : kind === "responses" ? "presentations" : "index_opinions";
const nextIndexPhase = (kind: Kind): Phase => kind === "opinions" ? "index_responses" : kind === "responses" ? "index_presentations" : "manifest";
const cursorForPhase = (phase: Phase, counts: Counts) => phase.startsWith("index_") ? counts[phase.slice(6) as Kind].pages : 0;

async function releaseById(id: string): Promise<ReleaseRow> {
  if (!validId(id)) throw new HttpError(400, "公開候補IDを確認してください。");
  const release = await database().prepare("SELECT * FROM releases WHERE id=?").bind(id).first<ReleaseRow>();
  if (!release) throw new HttpError(404, "公開候補が見つかりません。");
  return release;
}

async function invalidateIfChanged(id: string): Promise<boolean> {
  const db = database();
  await db.prepare(`UPDATE releases SET status='invalidated'
    WHERE id=? AND status IN ('preparing','draft')
      AND NOT EXISTS (SELECT 1 FROM community_state WHERE id=1 AND moderation_revision=releases.moderation_revision)`)
    .bind(id).run();
  const row = await releaseById(id);
  return row.status === "invalidated";
}

/** First call fixes all high-watermarks with a single INSERT ... SELECT. */
export async function prepareRelease(id: string, actor: string, reason: string, runUrl: string): Promise<ReleaseRow> {
  if (!validId(id)) throw new HttpError(400, "公開候補IDを確認してください。");
  const db = database();
  const old = await db.prepare("SELECT * FROM releases WHERE id=?").bind(id).first<ReleaseRow>();
  if (old) return old;
  const counts = emptyCounts();
  const metadata = JSON.stringify({ tags: seed.tags, sources: seed.sources, routing_version: ROUTING_VERSION });
  if (encoder.encode(metadata).length > RELEASE_PAGE_BYTES / 2) throw new HttpError(503, "公開用の分野・資料一覧が大きすぎます。");
  await db.prepare(`INSERT OR IGNORE INTO releases
      (id,schema_version,status,phase,cursor,build_revision,watermarks,counts,moderation_revision,
       sha256,object_key,created_at,summary,opinion_revisions,actor,reason,prepare_run_url)
    SELECT ?,3,'preparing','opinions',0,0,
      json_object(
        'opinions',COALESCE((SELECT MAX(rowid) FROM opinions),0),
        'votes',COALESCE((SELECT MAX(rowid) FROM votes),0),
        'impressions',COALESCE((SELECT MAX(rowid) FROM impressions),0),
        'events',COALESCE((SELECT MAX(rowid) FROM events),0),
        'metadata',json(?)),
      ?,moderation_revision,'','',
      CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER),
      ?,'{}',?,?,?
    FROM community_state WHERE id=1`)
    .bind(id, metadata, JSON.stringify(counts), summary(counts), actor, reason, runUrl).run();
  const release = await db.prepare("SELECT * FROM releases WHERE id=?").bind(id).first<ReleaseRow>();
  if (!release) throw new HttpError(503, "公開候補の保存状態を初期化できませんでした。");
  return release;
}

/**
 * Every read scans at most PAGE_ROWS source records before applying the frozen
 * opinion membership. A sparse permitted set cannot cause an unbounded scan.
 * The source cursor advances even when all scanned records are excluded.
 */
async function sourceRows(release: ReleaseRow, kind: Kind, marks: Watermarks): Promise<SourceRow[]> {
  const db = database();
  if (kind === "opinions") {
    const result = await db.prepare(`SELECT rowid source_cursor,id,tag_id,text,kind,source_ids,created_at,status,revision
      FROM opinions WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`)
      .bind(release.cursor, marks.opinions, RELEASE_PAGE_ROWS).all<SourceRow>();
    return result.results;
  }
  if (kind === "responses") {
    const result = await db.prepare(`SELECT s.*,r.opinion_id included
      FROM (SELECT rowid source_cursor,session_id,opinion_id,value,unrelated
        FROM votes WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?) s
      LEFT JOIN release_opinions r ON r.release_id=? AND r.opinion_id=s.opinion_id
      ORDER BY s.source_cursor`)
      .bind(release.cursor, marks.votes, RELEASE_PAGE_ROWS, release.id).all<SourceRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT s.*,r.opinion_id included,
      EXISTS(SELECT 1 FROM events e WHERE e.impression_id=s.id AND e.type='shown' AND e.rowid<=?) displayed,
      EXISTS(SELECT 1 FROM votes v WHERE v.impression_id=s.id AND v.rowid<=?) answered,
      EXISTS(SELECT 1 FROM events e WHERE e.impression_id=s.id AND e.type='retired' AND e.rowid<=?) retired
    FROM (SELECT rowid source_cursor,id,session_id,opinion_id,sequence,probability,routing_version
      FROM impressions WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?) s
    LEFT JOIN release_opinions r ON r.release_id=? AND r.opinion_id=s.opinion_id
    ORDER BY s.source_cursor`)
    .bind(marks.events, marks.votes, marks.events, release.cursor, marks.impressions, RELEASE_PAGE_ROWS, release.id).all<SourceRow>();
  return result.results;
}

function publicRow(kind: Kind, row: SourceRow): Record<string, unknown> | null {
  if (kind === "opinions") {
    if (row.status !== "approved") return null;
    return {
      id: row.id, tag_id: row.tag_id, text: row.text, kind: row.kind,
      source_ids: JSON.parse(String(row.source_ids)),
      created_date: Number(row.created_at) ? new Date(Number(row.created_at)).toISOString().slice(0, 10) : null,
    };
  }
  if (!row.included) return null;
  if (kind === "responses") {
    return {
      session_id: row.session_id, opinion_id: row.opinion_id,
      response: row.unrelated ? "unrelated" : row.value === -1 ? "agree" : row.value === 1 ? "disagree" : "pass",
      analysis_value: row.unrelated ? null : row.value,
    };
  }
  return {
    id: row.id, session_id: row.session_id, opinion_id: row.opinion_id,
    sequence: row.sequence, probability: row.probability, routing_version: row.routing_version,
    displayed: Boolean(row.displayed), answered: Boolean(row.answered), retired: Boolean(row.retired),
  };
}

async function dataPage(release: ReleaseRow, kind: Kind, marks: Watermarks): Promise<PageResult> {
  const rows = await sourceRows(release, kind, marks);
  const lines: string[] = [], opinions: FrozenOpinion[] = [];
  let bytes = 0, cursor = release.cursor, processed = 0;
  for (const row of rows) {
    const projected = publicRow(kind, row);
    if (projected) {
      const line = JSON.stringify(projected) + "\n";
      const length = encoder.encode(line).length;
      if (length > RELEASE_PAGE_BYTES) throw new HttpError(503, "1件の公開用データが大きすぎます。内容を確認してください。");
      if (bytes + length > RELEASE_PAGE_BYTES) break;
      lines.push(line); bytes += length;
      if (kind === "opinions") opinions.push({ opinion_id: String(row.id), revision: Number(row.revision), payload: JSON.stringify(projected) });
    }
    cursor = Number(row.source_cursor); processed++;
  }
  const upper = marks[kind === "responses" ? "votes" : kind === "presentations" ? "impressions" : "opinions"];
  const done = processed === rows.length && (rows.length < RELEASE_PAGE_ROWS || cursor >= upper);
  return { payload: lines.join(""), rowCount: lines.length, cursor, done, opinions };
}

async function savePart(release: ReleaseRow, id: string, kind: string, payload: string, rowCount: number): Promise<PartRow> {
  const byteLength = encoder.encode(payload).length;
  if (byteLength > RELEASE_PAGE_BYTES) throw new HttpError(503, "公開用ファイルが分割サイズを超えました。");
  const sha256 = await digest(payload);
  const extension = KINDS.includes(kind as Kind) ? "jsonl" : "json";
  const objectKey = `releases/${release.id}/${id}/${sha256}.${extension}`;
  await bucket().put(objectKey, payload, { httpMetadata: { contentType: extension === "jsonl" ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8" } });
  return { release_id: release.id, part_id: id, kind, object_key: objectKey, sha256, row_count: rowCount, byte_length: byteLength };
}

/**
 * The unique commit token lives in private counts JSON. It prevents statements
 * following a losing CAS from accidentally using a concurrent winner's revision.
 */
async function checkpoint(release: ReleaseRow, change: {
  counts: Counts; phase: Phase; cursor: number; part?: PartRow;
  opinions?: FrozenOpinion[]; root?: PartRow;
}): Promise<ReleaseRow> {
  const db = database(), commitToken = crypto.randomUUID(), nextRevision = release.build_revision + 1;
  change.counts.commit_token = commitToken;
  const statements = [db.prepare(`UPDATE releases SET phase=?,cursor=?,build_revision=?,counts=?,summary=?,
      status=?,sha256=?,object_key=?
    WHERE id=? AND status='preparing' AND build_revision=? AND moderation_revision=?
      AND EXISTS(SELECT 1 FROM community_state WHERE id=1 AND moderation_revision=?)`)
    .bind(change.phase, change.cursor, nextRevision, JSON.stringify(change.counts), summary(change.counts),
      change.root ? "draft" : "preparing", change.root?.sha256 || release.sha256, change.root?.object_key || release.object_key,
      release.id, release.build_revision, release.moderation_revision, release.moderation_revision)];
  const guard = `EXISTS(SELECT 1 FROM releases WHERE id=? AND build_revision=? AND json_extract(counts,'$.commit_token')=?)`;
  if (change.opinions?.length) {
    statements.push(db.prepare(`INSERT INTO release_opinions(release_id,opinion_id,revision,payload)
      SELECT ?,json_extract(value,'$.opinion_id'),json_extract(value,'$.revision'),json_extract(value,'$.payload')
      FROM json_each(?) WHERE ${guard}`)
      .bind(release.id, JSON.stringify(change.opinions), release.id, nextRevision, commitToken));
  }
  if (change.part) {
    const p = change.part;
    statements.push(db.prepare(`INSERT INTO release_parts(release_id,part_id,kind,object_key,sha256,row_count,byte_length)
      SELECT ?,?,?,?,?,?,? WHERE ${guard}`)
      .bind(p.release_id, p.part_id, p.kind, p.object_key, p.sha256, p.row_count, p.byte_length, release.id, nextRevision, commitToken));
  }
  const results = await db.batch(statements);
  if (!results[0].meta.changes) {
    if (await invalidateIfChanged(release.id)) throw new HttpError(409, "候補作成中に掲載判断が変わりました。候補を作り直してください。");
    throw new HttpError(409, "別の処理が先に進みました。現在の進捗を取得して続けてください。");
  }
  return releaseById(release.id);
}

/** Exactly one bounded source page or one bounded index page per invocation. */
export async function continueRelease(id: string, expectedRevision?: number): Promise<ReleaseRow> {
  let release = await releaseById(id);
  if (release.status === "released") return release;
  if (release.schema_version !== RELEASE_SCHEMA) throw new HttpError(400, "この公開候補は段階作成方式ではありません。");
  if (await invalidateIfChanged(id)) throw new HttpError(409, "候補作成中に掲載判断が変わりました。候補を作り直してください。");
  release = await releaseById(id);
  if (release.status === "draft") return release;
  if (release.status !== "preparing") throw new HttpError(409, "この公開候補は継続できません。");
  if (expectedRevision !== undefined && expectedRevision !== release.build_revision) throw new HttpError(409, "公開候補の進捗が変わりました。取得し直してください。");
  const counts = JSON.parse(release.counts) as Counts, marks = JSON.parse(release.watermarks) as Watermarks;

  if (KINDS.includes(release.phase as Kind)) {
    const kind = release.phase as Kind, page = await dataPage(release, kind, marks);
    let part: PartRow | undefined;
    if (page.rowCount) {
      part = await savePart(release, partId("d", kind, counts[kind].pages + 1), kind, page.payload, page.rowCount);
      counts[kind].rows += page.rowCount; counts[kind].pages++;
    }
    const phase = page.done ? nextDataPhase(kind) : release.phase;
    return checkpoint(release, { counts, phase, cursor: page.done ? cursorForPhase(phase, counts) : page.cursor, part, opinions: page.opinions });
  }

  if (release.phase.startsWith("index_")) {
    const kind = release.phase.slice(6) as Kind;
    if (!KINDS.includes(kind)) throw new HttpError(503, "公開候補の工程を確認してください。");
    if (!release.cursor) {
      const phase = nextIndexPhase(kind);
      return checkpoint(release, { counts, phase, cursor: cursorForPhase(phase, counts) });
    }
    const first = Math.max(1, release.cursor - RELEASE_INDEX_ENTRIES + 1);
    const parts = await database().prepare(`SELECT * FROM release_parts
      WHERE release_id=? AND kind=? AND part_id>=? AND part_id<=? ORDER BY part_id LIMIT ?`)
      .bind(release.id, kind, partId("d", kind, first), partId("d", kind, release.cursor), RELEASE_INDEX_ENTRIES).all<PartRow>();
    if (parts.results.length !== release.cursor - first + 1) throw new HttpError(503, "公開候補のファイルに不足があります。再開前に確認してください。");
    const payload = JSON.stringify({ schema_version: 3, kind: "page_index", release_id: release.id, table: kind, pages: parts.results.map(reference), next: counts[kind].index });
    const part = await savePart(release, partId("i", kind, counts[kind].index_pages + 1), `index_${kind}`, payload, parts.results.length);
    counts[kind].index_pages++; counts[kind].index = reference(part);
    const remaining = first - 1, phase = remaining ? release.phase : nextIndexPhase(kind);
    return checkpoint(release, { counts, phase, cursor: remaining || cursorForPhase(phase, counts), part });
  }

  if (release.phase === "manifest") {
    for (const kind of KINDS) if ((counts[kind].pages > 0) !== Boolean(counts[kind].index)) throw new HttpError(503, "公開候補の目次が完成していません。");
    const cutoff = new Date(release.created_at).toISOString();
    const root = {
      schema_version: 3, format: "jsonl-pages-v1",
      release: { id: release.id, prepared_at: cutoff, cutoff, routing_version: marks.metadata.routing_version, description: release.reason },
      updated_through: cutoff, tags: marks.metadata.tags, sources: marks.metadata.sources,
      tables: Object.fromEntries(KINDS.map(kind => [kind, { rows: counts[kind].rows, pages: counts[kind].pages, index: counts[kind].index }])),
    };
    const part = await savePart(release, "manifest", "manifest", JSON.stringify(root), 1);
    return checkpoint(release, { counts, phase: "done", cursor: 0, part, root: part });
  }
  throw new HttpError(503, "公開候補の工程を確認してください。");
}

/**
 * Caller must independently enforce admin auth OR releases.status='released'.
 * Never pass an arbitrary bucket key from a query parameter.
 */
export async function getReleaseObject(id: string, part?: string): Promise<{
  body: ReadableStream;
  sha256: string;
  contentType: string;
  byteLength: number;
}> {
  const release = await releaseById(id);
  if (release.status !== "draft" && release.status !== "released") throw new HttpError(409, "公開候補はまだ取得できません。");
  let objectKey = release.object_key, sha256 = release.sha256, contentType = "application/json; charset=utf-8";
  let expectedLength: number | undefined;
  if (part) {
    if (release.schema_version !== 3 || !/^(?:manifest|[di]-(?:opinions|responses|presentations)-\d{12})$/.test(part)) throw new HttpError(404, "公開用ファイルが見つかりません。");
    const row = await database().prepare("SELECT * FROM release_parts WHERE release_id=? AND part_id=?").bind(id, part).first<PartRow>();
    if (!row) throw new HttpError(404, "公開用ファイルが見つかりません。");
    objectKey = row.object_key; sha256 = row.sha256; expectedLength = row.byte_length;
    if (KINDS.includes(row.kind as Kind)) contentType = "application/x-ndjson; charset=utf-8";
  }
  const object = await bucket().get(objectKey);
  if (!object || (expectedLength !== undefined && object.size !== expectedLength)) throw new HttpError(503, "公開用ファイルを取得できません。");
  return { body: object.body, sha256, contentType, byteLength: object.size };
}
