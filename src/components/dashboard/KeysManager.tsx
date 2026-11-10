"use client";

/**
 * مدير المفاتيح — إضافة/تعطيل/تنشيط/حذف مفاتيح API للمزودين.
 * المفاتيح تظهر مُقنَّعة دائمًا (لا يُعاد المفتاح الكامل من الخادم إطلاقًا).
 * التجربة تسلسلية صارمة بترتيب الإضافة مع تبديل فوري تلقائي عند أي خطأ.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export interface PublicKey {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const STATUS_STYLES: Record<PublicKey["status"], { label: string; className: string }> = {
  active: { label: "نشط", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  exhausted: { label: "مستنزف", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  disabled: { label: "معطّل", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

const PROVIDER_LABELS: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };

export function KeysManager({ refreshSignal }: { refreshSignal: number }) {
  const { toast } = useToast();
  const [keys, setKeys] = useState<PublicKey[]>([]);
  const [provider, setProvider] = useState<string>("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = await res.json();
      setKeys(data.keys ?? []);
    } catch {
      // تجاهل أخطاء التحديث الخلفي
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "أدخل مفتاح API أولًا", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "تعذرت الإضافة", description: data.error, variant: "destructive" });
      } else {
        toast({ title: "أُضيف المفتاح بنجاح", description: `سيُجرَّب أولًا حسب ترتيب الإضافة (${PROVIDER_LABELS[provider]})` });
        setApiKey("");
        setLabel("");
        await load();
      }
    } catch (err) {
      toast({ title: "خطأ شبكة", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggleKey = async (k: PublicKey) => {
    const action = k.status === "disabled" ? "enable" : "disable";
    try {
      const res = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast({ title: "تعذر التحديث", description: data.error, variant: "destructive" });
      } else {
        await load();
      }
    } catch (err) {
      toast({ title: "خطأ شبكة", description: String(err), variant: "destructive" });
    }
  };

  const removeKey = async (k: PublicKey) => {
    try {
      const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        toast({ title: "تعذر الحذف", description: data.error, variant: "destructive" });
      } else {
        toast({ title: "حُذف المفتاح" });
        await load();
      }
    } catch (err) {
      toast({ title: "خطأ شبكة", description: String(err), variant: "destructive" });
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg text-zinc-100">
          <span aria-hidden>🔑</span> مدير المفاتيح
        </CardTitle>
        <CardDescription className="leading-relaxed text-zinc-400">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
          تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="provider" className="text-zinc-300">المزود</Label>
            <Select value={provider} onValueChange={setProvider} dir="rtl">
              <SelectTrigger id="provider" className="w-full border-zinc-700 bg-zinc-900 text-zinc-100">
                <SelectValue placeholder="اختر المزود" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kie">kie.ai</SelectItem>
                <SelectItem value="cometapi">CometAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label" className="text-zinc-300">تسمية اختيارية</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="مثال: حساب رئيسي"
              className="border-zinc-700 bg-zinc-900 text-zinc-100"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="api-key" className="text-zinc-300">مفتاح API</Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="الصق المفتاح هنا…"
                className="flex-1 border-zinc-700 bg-zinc-900 text-zinc-100"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addKey();
                }}
              />
              <Button onClick={() => void addKey()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-500">
                {busy ? "جارٍ الإضافة…" : "إضافة"}
              </Button>
            </div>
          </div>
        </div>

        {/* قائمة المفاتيح */}
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1 dashboard-scroll">
          {loading ? (
            <p className="py-6 text-center text-sm text-zinc-500">جارٍ التحميل…</p>
          ) : keys.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-500">
              لا مفاتيح بعد — أضف أول مفتاح لبدء التوليد
            </p>
          ) : (
            keys.map((k) => {
              const style = STATUS_STYLES[k.status];
              return (
                <div
                  key={k.id}
                  className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                        {PROVIDER_LABELS[k.provider] ?? k.provider}
                      </Badge>
                      <span dir="ltr" className="font-mono text-sm text-zinc-200">{k.maskedKey}</span>
                      <Badge variant="outline" className={style.className}>{style.label}</Badge>
                      {k.label ? <span className="text-xs text-zinc-500">({k.label})</span> : null}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                      <span>استخدام: {k.usageCount}</span>
                      <span>نجاح: {k.successCount}</span>
                      <span>فشل: {k.failCount}</span>
                      <span>أُضيف: {k.createdAt?.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    {k.lastError ? (
                      <p dir="ltr" className="truncate text-xs text-rose-400/90" title={k.lastError}>
                        آخر خطأ: {k.lastError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void toggleKey(k)}
                      className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                    >
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void removeKey(k)}
                      className="border-rose-900/60 text-rose-400 hover:bg-rose-950/40"
                    >
                      حذف
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
