/**
 * لوحة المهام للواجهة: GET /api/tasks?limit=20&type=&status=
 * تعيد أحدث المهام مع إحصائياتها — دون أي معلومات حساسة (المفاتيح لا تُلمَس هنا إطلاقًا).
 */
import { listRecentTasks, taskStats, type TaskRecord, type TaskStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicTask(t: TaskRecord) {
  return {
    id: t.id,
    provider: t.provider,
    model: t.model,
    type: t.type,
    prompt: t.prompt,
    status: t.status,
    progress: t.progress,
    resultUrls: t.resultUrls,
    errorMessage: t.errorMessage,
    attemptsCount: t.attempts.length,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? "20")));
    const type = url.searchParams.get("type") as TaskRecord["type"] | null;
    const status = url.searchParams.get("status") as TaskStatus | null;

    const tasks = await listRecentTasks(limit, {
      type: type ?? undefined,
      status: status ?? undefined,
    });
    const stats = await taskStats();
    return Response.json(
      { tasks: tasks.map(publicTask), stats },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { error: `تعذر جلب المهام: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
