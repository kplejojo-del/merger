"use client";

/**
 * بطاقة ربط السيرفر — الرابط المطلق لمسار /mcp مع نسخ، وثلاث تبويبات JSON جاهزة
 * للصق في ChatGPT/GPT Agents وClaude Desktop وCursor/Windsurf/Cline،
 * ورقائق الأدوات الخمس وملاحظة الانتظار للفيديو.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

const TOOLS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (gpt-image-2-6/flare)" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (grok-imagine)" },
  { name: "merge_videos", desc: "دمج 2–10 مقاطع في فيديو واحد بالترتيب" },
  { name: "get_task", desc: "تتبع حالة أي مهمة بمعرّفها (task_id)" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

export function ConnectCard({ authRequired }: { authRequired: boolean }) {
  const { toast } = useToast();
  const [origin, setOrigin] = useState("");
  const [customUrl, setCustomUrl] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = customUrl.trim() || (origin ? `${origin}/mcp` : "<origin>/mcp");

  const snippets = useMemo(() => {
    const authHeaders = authRequired
      ? `,\n          "headers": {\n            "Authorization": "Bearer <MCP_ACCESS_TOKEN>"`
      : "";
    const authHeadersClaude = authRequired
      ? `,\n      "headers": {\n        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"`
      : "";
    return {
      chatgpt: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authHeaders}
      }
    }
  }
}`,
      claude: `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${authHeadersClaude}
      }
    }
  }
}`,
      cursor: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authHeaders}
      }
    }
  }
}`,
    };
  }, [mcpUrl, authRequired]);

  const copySnippet = (text: string, what: string) => {
    copyText(text);
    toast({ title: `نُسخ إعداد ${what}` });
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg text-zinc-100">
          <span aria-hidden>🔌</span> ربط السيرفر
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* رابط MCP */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              readOnly
              value={mcpUrl}
              dir="ltr"
              className="flex-1 border-zinc-700 bg-zinc-950 font-mono text-sm text-zinc-200"
            />
            <Button
              variant="outline"
              onClick={() => copySnippet(mcpUrl, "الرابط")}
              className="shrink-0 border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            >
              نسخ
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="استبدل الرابط يدويًا إن نشرت المشروع على نطاق آخر (مثل https://your-app.vercel.app/mcp)"
              dir="ltr"
              className="border-zinc-800 bg-zinc-950/60 text-xs text-zinc-400"
            />
          </div>
        </div>

        {/* تبويبات الإعدادات */}
        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="grid w-full grid-cols-3 bg-zinc-950 border border-zinc-800">
            <TabsTrigger value="chatgpt" className="text-xs sm:text-sm">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude" className="text-xs sm:text-sm">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor" className="text-xs sm:text-sm">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="space-y-2">
            <div className="relative">
              <pre dir="ltr" className="max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
                {snippets.chatgpt}
              </pre>
              <Button
                size="sm"
                onClick={() => copySnippet(snippets.chatgpt, "ChatGPT")}
                className="absolute left-2 top-2 h-7 bg-emerald-600 text-white hover:bg-emerald-500"
              >
                نسخ
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-zinc-400">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
            </p>
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <div className="relative">
              <pre dir="ltr" className="max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
                {snippets.claude}
              </pre>
              <Button
                size="sm"
                onClick={() => copySnippet(snippets.claude, "Claude Desktop")}
                className="absolute left-2 top-2 h-7 bg-emerald-600 text-white hover:bg-emerald-500"
              >
                نسخ
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-zinc-400">
              الصقه في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.
            </p>
          </TabsContent>
          <TabsContent value="cursor" className="space-y-2">
            <div className="relative">
              <pre dir="ltr" className="max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
                {snippets.cursor}
              </pre>
              <Button
                size="sm"
                onClick={() => copySnippet(snippets.cursor, "Cursor")}
                className="absolute left-2 top-2 h-7 bg-emerald-600 text-white hover:bg-emerald-500"
              >
                نسخ
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-zinc-400">
              الصقه في ملف mcp.json داخل Cursor / Windsurf / Cline.
            </p>
          </TabsContent>
        </Tabs>

        {/* رقائق الأدوات */}
        <div className="space-y-2">
          <p className="text-sm font-semibold text-zinc-300">الأدوات الخمس المتاحة:</p>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <Badge
                key={t.name}
                variant="outline"
                className="border-zinc-700 bg-zinc-950/70 px-3 py-1.5 text-xs text-zinc-300"
                title={t.desc}
              >
                <span dir="ltr" className="font-mono text-emerald-400">{t.name}</span>
                <span className="mx-1.5 text-zinc-600">·</span>
                {t.desc}
              </Badge>
            ))}
          </div>
        </div>

        {/* ملاحظة كهرمانية */}
        <div className="rounded-xl border border-amber-800/50 bg-amber-950/30 p-4 text-sm leading-relaxed text-amber-300">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ —
          وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress
          notifications) حتى لا تنقطع العملية.
        </div>
      </CardContent>
    </Card>
  );
}
