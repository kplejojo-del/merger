"use client";

/**
 * لوحة المهام — شرائح إحصائيات + قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ.
 * تعرض: النوع، الحالة، شريط التقدم، الموديل، مقتطف الوصف، وقت الإنشاء، الروابط
 * عند الاكتمال، رسالة الخطأ عند الفشل، وعدد المحاولات.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
  completedAt: string | null;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  active: number;
}

const TYPE_LABELS: Record<TaskItem["type"], string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_LABELS: Record<TaskItem["status"], string> = {
  pending: "انتظار",
  processing: "قيد المعالجة",
  completed: "مكتملة",
  failed: "فاشلة",
};

function statusBadge(status: TaskItem["status"]) {
  switch (status) {
    case "completed":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "failed":
      return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "processing":
      return "bg-teal-500/15 text-teal-400 border-teal-500/30";
    default:
      return "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
  }
}

function StatChip({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className={`flex-1 rounded-xl border p-3 text-center ${className}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}

export function TasksPanel({ refreshSignal }: { refreshSignal: number }) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, active: 0 });
  const [updatedAt, setUpdatedAt] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = await res.json();
      if (data.tasks) setTasks(data.tasks);
      if (data.stats) setStats(data.stats);
      setUpdatedAt(new Date().toLocaleTimeString("ar", { hour12: false }));
    } catch {
      // تجاهل أخطاء التحديث الخلفي
    }
  }, []);

  useEffect(() => {
    void load();
    // تحديث تلقائي كل ~5 ثوانٍ
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, refreshSignal]);

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center justify-between text-lg text-zinc-100">
          <span className="flex items-center gap-2"><span aria-hidden>📊</span> لوحة المهام</span>
          <span className="text-xs font-normal text-zinc-500">
            تحديث تلقائي كل 5 ثوانٍ{updatedAt ? ` — آخر تحديث ${updatedAt}` : ""}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-3">
          <StatChip label="إجمالي" value={stats.total} className="border-zinc-700 bg-zinc-950/60 text-zinc-200" />
          <StatChip label="مكتملة" value={stats.completed} className="border-emerald-800/60 bg-emerald-950/30 text-emerald-300" />
          <StatChip label="فاشلة" value={stats.failed} className="border-rose-800/60 bg-rose-950/30 text-rose-300" />
          <StatChip label="جارية" value={stats.active} className="border-teal-800/60 bg-teal-950/30 text-teal-300" />
        </div>

        <div className="max-h-96 space-y-3 overflow-y-auto pr-1 dashboard-scroll">
          {tasks.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-500">
              لا مهام بعد — ستظهر هنا عند استخدام أدوات MCP (توليد صور/فيديو أو دمج)
            </p>
          ) : (
            tasks.map((t) => (
              <div key={t.id} className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-zinc-700 text-zinc-300">{TYPE_LABELS[t.type]}</Badge>
                  <Badge variant="outline" className={statusBadge(t.status)}>{STATUS_LABELS[t.status]}</Badge>
                  <span className="font-mono text-xs text-zinc-400">{t.model}</span>
                  <span className="text-xs text-zinc-600">
                    {t.createdAt?.slice(0, 16).replace("T", " ")}
                  </span>
                  {t.attemptsCount > 0 ? (
                    <span className="text-xs text-amber-500/90">محاولات: {t.attemptsCount}</span>
                  ) : null}
                </div>
                {t.prompt ? (
                  <p className="truncate text-sm text-zinc-400" title={t.prompt}>
                    {t.prompt.length > 90 ? `${t.prompt.slice(0, 90)}…` : t.prompt}
                  </p>
                ) : null}
                {t.status === "processing" || t.status === "pending" ? (
                  <div className="flex items-center gap-2">
                    <Progress value={t.progress} className="h-2 flex-1 bg-zinc-800 [&>div]:bg-teal-500" />
                    <span className="w-10 text-xs text-zinc-400">{t.progress}%</span>
                  </div>
                ) : null}
                {t.status === "completed" && t.resultUrls.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {t.resultUrls.map((u, i) => (
                      <Button
                        key={i}
                        size="sm"
                        variant="outline"
                        asChild
                        className="h-7 border-emerald-800/60 px-2 text-xs text-emerald-400 hover:bg-emerald-950/40"
                      >
                        <a href={u} target="_blank" rel="noreferrer" dir="ltr">
                          فتح الرابط ↗
                        </a>
                      </Button>
                    ))}
                  </div>
                ) : null}
                {t.status === "failed" && t.errorMessage ? (
                  <p dir="auto" className="text-xs text-rose-400/90" title={t.errorMessage}>
                    {t.errorMessage}
                  </p>
                ) : null}
                <p dir="ltr" className="font-mono text-[10px] text-zinc-600">task_id: {t.id}</p>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
