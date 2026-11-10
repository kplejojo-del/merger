/**
 * فحص الجاهزية العام: قاعدة Turso + خدمة الدمج + الموديلات + حالة الحماية.
 * merger.healthy = فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ.
 */
import { MODELS } from "@/lib/models";
import { dbHealthy } from "@/lib/turso";
import { getMergerBase, mergerClient } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let dbOk = false;
  let mergerHealthy = false;
  try {
    dbOk = await dbHealthy();
  } catch {
    dbOk = false;
  }
  try {
    mergerHealthy = await mergerClient.healthy();
  } catch {
    mergerHealthy = false;
  }

  return Response.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "disconnected",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: { base: getMergerBase(), healthy: mergerHealthy },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
