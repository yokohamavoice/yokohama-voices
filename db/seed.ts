import seed from "@/data/seed.json";
import { database } from "@/db/raw";

export async function ensureSeedData() {
  const db = database();
  const row = await db.prepare("SELECT COUNT(*) n FROM opinions WHERE kind='seed'").first<{n: number}>();
  if ((row?.n ?? 0) < seed.opinions.length) {
    await db.batch(seed.opinions.map(o => db.prepare(
      "INSERT OR IGNORE INTO opinions (id,tag_id,text,kind,source_ids,created_at) VALUES (?,?,?,?,?,?)"
    ).bind(o.id, o.tagId, o.text, "seed", JSON.stringify(o.sourceIds), 0)));
  }
}
