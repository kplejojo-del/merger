# خادم توليد الوسائط — Media Generator MCP

خادم **MCP** (Model Context Protocol) يوفّر ثلاث قدرات في أداة واحدة، ويستدعيه نموذج الذكاء الاصطناعي من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK):

1. **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** مع صوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل المدمج: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب

يتضمن المشروع **واجهة ويب عربية RTL** لإدارة مفاتيح API ومتابعة المهام حيًا وعرض إعدادات الربط جاهزة للنسخ.

## القواعد الجوهرية

- **لا يُنزَّل أي ملف وسائط على السيرفر** — روابط النتائج فقط تُخزَّن في قاعدة البيانات.
- **تبديل تسلسلي صارم للمفاتيح**: أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC, id ASC`) — ليس round-robin.
- **لا توقف عند نفاد الرصيد**: انتقال تلقائي للمفتاح التالي واستئناف **نفس المهمة بنفس `task_id`**.
- **العميل لا يرى أخطاء المفاتيح/الرصيد أبدًا** — التبديل صامت من وجهة نظته.
- المهمة التي تفشل على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة ~45 ثانية) — لو شُحن أي مفتاح تكتمل من تلقاء نفسها.
- أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء شبكتنا = مؤقتة وتستمر بالاستعلام.
- ملفات الدمج تُحذف بعد 24 ساعة من خدمة الدمج (مذكورة في وصف الأداة وتعليمات الخادم).

## التقنيات

Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + shadcn/ui • `@modelcontextprotocol/sdk` 1.32 (`McpServer` + `WebStandardStreamableHTTPServerTransport`) • `@libsql/client` مع Turso عبر HTTP (متوافق مع Vercel serverless — لا ملفات محلية).

> قرار معماري: مسار `/mcp` يعمل بوضع **عديم الجلسة (stateless)** لأن Vercel serverless لا يضمن ذاكرة مشتركة بين النسخ؛ هذا الوضع معتمد رسميًا في مواصفة MCP، وإشعارات التقدم تعمل كاملة داخل نفس نداء POST عبر بث SSE.

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة، تعيد الرابط جاهزًا إذا اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن، انتظار قصير ثم `task_id` |
| `merge_videos` | دمج 2–10 مقاطع عبر `urls` مباشرة أو `task_ids` لمهام مكتملة (بالترتيب) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — استعلمه كل ~10 ثوانٍ |
| `list_media` | أحدث الوسائط المخزنة بروابطها (استرجاع نتائج سابقة) |

## متغيرات البيئة

انسخ `.env.example` إلى `.env.local` محليًا، وأضف نفس القيم في Vercel → Settings → Environment Variables:

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso (`libsql://…`) |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | عنوان خدمة Video Merger API v2 |
| `MCP_ACCESS_TOKEN` | — | إن ضُبط يُطلب `Bearer` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | — | تجاوز اسم الموديل لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — | تجاوز اسم الموديل لدى CometAPI |

## التشغيل المحلي

```bash
bun install        # أو npm install
bun run dev        # http://localhost:3000
```

- الواجهة: `http://localhost:3000/` — مدير المفاتيح + لوحة المهام + بطاقة الربط.
- خادم MCP: `http://localhost:3000/mcp` (Streamable HTTP).
- فحص الجاهزية: `http://localhost:3000/api/health`

اختبارات سريعة:

```bash
bun run test:keys     # تصنيف الأخطاء وسلوك المجمع التسلسلي والمفتاح المستنزف
bun run mock:merger   # خدمة دمج محاكية على المنفذ 9910 (مع MERGER_API_BASE=http://127.0.0.1:9910)
bun run test:merge    # اختبار الدمج الشامل (يقيم الخدمة المحاكية بنفسه)
```

اختبار MCP بـ curl:

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# قائمة الأدوات (الوضع عديم الجلسة — لا حاجة لمعرّف جلسة)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## النشر على Vercel

1. اربط المستودع في Vercel (Import Project) — إطار العمل يُكتشف تلقائيًا (Next.js).
2. أضف متغيرات البيئة الثلاثة الإلزامية (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `MERGER_API_BASE`) واختياريًا `MCP_ACCESS_TOKEN`.
3. Deploy — كل شيء يعمل لأن libSQL يتصل عبر HTTP ومناسب للـ serverless، ومسار `/mcp` يدعم البث (`maxDuration = 300`).

## ربط العملاء

- **ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server وضع `<origin>/mcp` في «Server URL» — أو إعداد `{"mcpServers":{"media-generator":{"url":"<origin>/mcp"}}}`.
- **Claude Desktop**: نفس الصيغة مع `"type": "http"` في `claude_desktop_config.json`.
- **Cursor / Windsurf / Cline**: نفس صيغة `mcp.json`.

الواجهة تعرض هذه الإعدادات جاهزة للنسخ في بطاقة «ربط السيرفر».

## بنية المشروع

```
src/
├── app/
│   ├── mcp/route.ts            # خادم MCP (Streamable HTTP، وضع عديم الجلسة)
│   ├── api/health/route.ts     # فحص الجاهزية (Turso + خدمة الدمج + الموديلات)
│   ├── api/keys/route.ts       # GET القائمة المُقنَّعة / POST إضافة مع رفض التكرار
│   ├── api/keys/[id]/route.ts  # تعطيل/تنشيط/حذف
│   ├── api/tasks/route.ts      # لوحة المهام (مهام + إحصائيات)
│   ├── page.tsx                # لوحة التحكم العربية RTL
│   └── layout.tsx              # dir="rtl" lang="ar" + خط Cairo
├── lib/
│   ├── turso.ts                # طبقة قاعدة البيانات + ensureSchema + العمليات
│   ├── keys.ts                 # المجمع التسلسلي + classifyProviderError + maskKey
│   ├── models.ts               # سجل الموديلات (canonical/aliases/providerModel)
│   ├── providers/              # kie.ts (Jobs API الموحد) + cometapi.ts + الواجهة الموحدة
│   ├── generation.ts           # runGeneration/advanceGenerationTask — التبديل التسلسلي
│   ├── merger.ts               # عميل Video Merger API v2 (أخطاء حتمية/مؤقتة)
│   ├── merge.ts                # runMerge/advanceMergeTask + قفل process المفرد
│   ├── tasks.ts                # refreshTask الموحد
│   └── mcp/                    # تسجيل الأدوات الخمس + صياغة الردود العربية
└── components/dashboard/       # مدير المفاتيح + لوحة المهام + بطاقة الربط
```

## الأمان

- `.env*` مستثنى من Git منذ أول commit (استثناء: `.env.example` بالقيم الوهمية فقط).
- المفاتيح تظهر **مُقنَّعة دائمًا** في كل الاستجابات والسجلات (`maskKey`: أول 7 + `••••••••` + آخر 4).
- لا يُعاد المفتاح الكامل من أي مسار API إطلاقًا.
