declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    MODERATION_TOKEN?: string;
    MODERATION_REPOSITORY?: string;
    BUCKET?: R2Bucket;
  }
}
