/**
 * تسجيل الأدوات الخمس على خادم MCP — الأوصاف حرفية من المواصفة (القسم 8)،
 * أما نتائج الاستدعاء فتُصاغ بالعربية عبر formatting.ts.
 * إشعارات التقدم: تُبث كل ~3 ثوانٍ إذا زوّد العميل الطلب بـ _meta.progressToken.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { MODELS, findModel, modelEnumFor, type MediaType } from "../models";
import { getKeyPool } from "../keys";
import { runGeneration } from "../generation";
import { startMerge } from "../merge";
import { refreshTask } from "../tasks";
import { listRecentTasks } from "../turso";
import { formatMediaList, formatTaskMessage } from "./formatting";
import type { GenerationInput } from "../providers/types";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** مُبثّ إشعارات التقدم — يعمل فقط إذا زوّد العميل الطلب بـ progressToken */
function progressEmitter(extra: RequestHandlerExtra<ServerRequest, ServerNotification>) {
  const meta = (extra._meta ?? {}) as { progressToken?: string | number };
  const token = meta.progressToken;
  if (token === undefined || token === null) return undefined;
  return async (p: { progress: number; message: string }) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: p.progress,
          total: 100,
          message: p.message,
        },
      } as never);
    } catch {
      // فشل الإشعار لا يوقف المهمة أبدًا
    }
  };
}

function textResult(text: string, isError?: boolean) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** رسالة no_keys الحرفية من المواصفة (6.2) — الحالة الوحيدة المسموح أن تذكر المفاتيح */
function noKeysMessage(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

function buildGenerationInput(args: {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
}): GenerationInput {
  return {
    prompt: args.prompt,
    imageUrl: args.image_url,
    aspectRatio: args.aspect_ratio,
    resolution: args.resolution,
    background: args.background,
    outputFormat: args.output_format,
    enableAudio: args.enable_audio,
    duration: args.duration,
  };
}

/** تسجيل الأدوات الخمس كاملة على الخادم */
export function registerMediaTools(server: McpServer): void {
  const imageModelEnum = modelEnumFor("image");
  const videoModelEnum = modelEnumFor("video");
  const imageDefault = MODELS.find((m) => m.type === "image")!.canonical;
  const videoDefault = MODELS.find((m) => m.type === "video")!.canonical;

  /* ---------- 1) generate_image ---------- */
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "توليد صورة بـ gpt-image-2-6/flare-text-to-image (تبديل تلقائي عبر كل المفاتيح النشطة). تعيد رابط الصورة جاهزًا إذا اكتملت خلال نافذة الانتظار، وإلا تعيد task_id — استدعِ get_task كل ~10 ثوانٍ حتى completed ثم اعرض الرابط وتوقف.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(imageModelEnum as [string, ...string[]]).default(imageDefault),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const model = findModel(args.model) ?? MODELS.find((m) => m.type === "image")!;
      const pool = await getKeyPool(model.providers);
      if (pool.length === 0) return textResult(noKeysMessage(model.canonical), true);
      const task = await runGeneration({
        type: "image",
        model,
        input: buildGenerationInput(args),
        waitSeconds: args.wait_seconds,
        onProgress: progressEmitter(extra),
        signal: extra.signal,
      });
      const formatted = formatTaskMessage(task);
      return textResult(formatted.text, formatted.isError);
    },
  );

  /* ---------- 2) generate_video ---------- */
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "توليد فيديو بـ grok-imagine-video-1-5-preview (صوت متزامن أصلي، image-to-video اختياري). الفيديو يحتاج دقائق: انتظار قصير مع بث تقدم ثم task_id — تابع بـ get_task كل ~10 ثوانٍ.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(videoModelEnum as [string, ...string[]]).default(videoDefault),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const model = findModel(args.model) ?? MODELS.find((m) => m.type === "video")!;
      const pool = await getKeyPool(model.providers);
      if (pool.length === 0) return textResult(noKeysMessage(model.canonical), true);
      const task = await runGeneration({
        type: "video",
        model,
        input: buildGenerationInput(args),
        waitSeconds: args.wait_seconds,
        onProgress: progressEmitter(extra),
        signal: extra.signal,
      });
      const formatted = formatTaskMessage(task);
      return textResult(formatted.text, formatted.isError);
    },
  );

  /* ---------- 3) merge_videos ---------- */
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى. مرر urls (روابط فيديو مباشرة عامة — مثل روابط generate_video) أو task_ids (لمهام فيديو مكتملة تُحل روابطها من قاعدة البيانات بالترتيب — مثالي بعد توليد عدة مقاطع). الدمج سريع عادةً: انتظار قصير مع بث تقدم ثم task_id للدمج — تابعه بـ get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly. (2–10 clips)",
      inputSchema: {
        urls: z
          .array(z.string())
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video. 2–10 links.",
          ),
        task_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. 2–10 ids.",
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      // قرارات: حدّا 2/10 يتحققان هنا برسائل عربية حرفية (المخطط يصفهما في الوصف
      // حتى لا يقطع تحقق المخطط الرسالة العربية قبل وصولها للمعالج).
      const urls = args.urls ?? [];
      const taskIds = args.task_ids ?? [];
      if (urls.length === 0 && taskIds.length === 0) {
        return textResult(
          "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
          true,
        );
      }
      const result = await startMerge(
        { urls, task_ids: taskIds },
        {
          waitSeconds: args.wait_seconds,
          onProgress: progressEmitter(extra),
          signal: extra.signal,
        },
      );
      if (result.error) return textResult(result.error, true);
      const formatted = formatTaskMessage(result.task!);
      return textResult(formatted.text, formatted.isError);
    },
  );

  /* ---------- 4) get_task ---------- */
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "تتبع أي مهمة بمعرّفها — توليد صور/فيديو ودمج (يقرأ قاعدة Turso ويحدّث من المزود/الخدمة إن كانت جارية). استعلمه كل ~10 ثوانٍ؛ عند completed ستجد روابط النتائج — اعرضها للمستخدم وتوقف عن الاستعلام.",
      inputSchema: {
        task_id: z.string().describe("المعرّف المُعاد من generate_image / generate_video / merge_videos"),
      },
    },
    async (args) => {
      const task = await refreshTask(args.task_id);
      if (!task) {
        return textResult(`❌ لم أجد مهمة بهذا المعرّف: ${args.task_id}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`, true);
      }
      const formatted = formatTaskMessage(task);
      return textResult(formatted.text, formatted.isError);
    },
  );

  /* ---------- 5) list_media ---------- */
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد) — لاسترجاع نتائج سابقة.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, {
        type: args.type as MediaType | undefined,
        status: args.status,
      });
      const filters = [
        args.type ? `من نوع ${args.type}` : "",
        args.status ? `بالحالة ${args.status}` : "",
      ]
        .filter(Boolean)
        .join(" و ");
      return textResult(formatMediaList(tasks, filters));
    },
  );
}
