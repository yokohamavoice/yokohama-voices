import handler from "vinext/server/fetch-handler";
import { runDailyAnalysis } from "./lib/analysis-cache";

export default {
  fetch(request, env, ctx) {
    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller) {
    // Await completion so a failed refresh is reported as a failed scheduled run.
    const started = Date.now();
    try {
      const result = await runDailyAnalysis(controller.scheduledTime);
      console.info("daily analysis", { ...result, elapsedMs: Date.now() - started });
    } catch (error) {
      console.error("daily analysis failed", error);
      throw error;
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
