"use client";

/**
 * لوحة التحكم الرئيسية — هيدر بحالة /api/health (شارة Turso) + ثلاث بطاقات:
 * أ) مدير المفاتيح، ب) لوحة المهام، ج) ربط السيرفر.
 */
import { useCallback, useEffect, useState } from "react";
import { ConnectCard } from "@/components/dashboard/ConnectCard";
import { KeysManager } from "@/components/dashboard/KeysManager";
import { TasksPanel } from "@/components/dashboard/TasksPanel";
import { Badge } from "@/components/ui/badge";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
  models: { canonical: string; type: string; providers: string[] }[];
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = (await res.json()) as Health;
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    const timer = setInterval(() => void loadHealth(), 15000);
    return () => clearInterval(timer);
  }, [loadHealth]);

  const dbConnected = health?.database === "turso-connected";

  return (
    <main className="min-h-screen bg-zinc-950 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.06),transparent_60%)]">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        {/* الهيدر */}
        <header className="flex flex-col gap-4 border-b border-zinc-800 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-100 sm:text-3xl">
              خادم توليد الوسائط <span dir="ltr" className="text-emerald-400">MCP</span>
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              توليد صور وفيديو بصوت متزامن ودمج المقاطع — بتبديل تسلسلي تلقائي للمفاتيح دون توقف
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {health === null ? (
              <Badge variant="outline" className="border-zinc-700 text-zinc-400">
                جارٍ فحص الاتصال…
              </Badge>
            ) : dbConnected ? (
              <Badge variant="outline" className="border-emerald-600/50 bg-emerald-500/10 text-emerald-400">
                ● Turso متصل
              </Badge>
            ) : (
              <Badge variant="outline" className="border-rose-600/50 bg-rose-500/10 text-rose-400">
                ● Turso غير متصل
              </Badge>
            )}
            {health ? (
              <Badge
                variant="outline"
                className={
                  health.merger.healthy
                    ? "border-emerald-600/50 bg-emerald-500/10 text-emerald-400"
                    : "border-amber-700/50 bg-amber-500/10 text-amber-400"
                }
                title={health.merger.base ?? "MERGER_API_BASE غير مضبوط"}
              >
                {health.merger.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير مضبوطة"}
              </Badge>
            ) : null}
            {health?.authRequired ? (
              <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                🔒 حماية Bearer على /mcp
              </Badge>
            ) : null}
          </div>
        </header>

        {/* البطاقات الثلاث */}
        <div className="grid gap-6">
          <KeysManager refreshSignal={refreshSignal} />
          <TasksPanel refreshSignal={refreshSignal} />
          <ConnectCard authRequired={health?.authRequired ?? false} />
        </div>

        <footer className="border-t border-zinc-800 pt-4 text-center text-xs text-zinc-600">
          الخادم يعمل على المسار <span dir="ltr" className="font-mono text-zinc-500">/mcp</span> —
          متوافق مع مواصفة MCP Streamable HTTP (وضع عديم الجلسة المناسب لـ Vercel)
        </footer>
      </div>
    </main>
  );
}
