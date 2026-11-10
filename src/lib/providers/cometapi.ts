/**
 * مزود CometAPI — المزود الثاني (بلا مفتاح مختبر حاليًا؛ الأشكال من توثيق api.cometapi.com الرسمي).
 * - الصور: متزامنة عبر نقطة متوافقة مع OpenAI تعيد الرابط فورًا:
 *   POST https://api.cometapi.com/v1/images/generations
 *   الجسم: {model, prompt, size?, output_format?, response_format?} → {data:[{url|b64_json}]}
 * - الفيديو: مهمة غير متزامنة بنمط create/check (نقاط Grok video):
 *   POST https://api.cometapi.com/grok/v1/videos  → {request_id, status?...}
 *   GET  https://api.cometapi.com/grok/v1/videos/{request_id}
 *   → {status: pending|done|failed|expired, progress, video:{url}, error}
 * كل خطأ يُرمى كـ ProviderError ليُصنَّف موحدًا.
 */
import type { CheckTaskResult, GenerationInput, ProviderAdapter, ProviderKeyRef } from "./types";
import { ProviderError } from "./types";

const BASE = "https://api.cometapi.com";

function extractCometError(body: unknown, httpStatus: number): ProviderError {
  const b = (body ?? {}) as Record<string, unknown>;
  const errField = b.error;
  let msg = "";
  if (typeof errField === "string") msg = errField;
  else if (errField && typeof errField === "object") {
    const e = errField as Record<string, unknown>;
    msg = String(e.message ?? e.code ?? "");
  }
  if (!msg) msg = String(b.message ?? b.msg ?? `HTTP ${httpStatus}`);
  // بعض المزودين يرسلون code داخل الجسم (مثل 401/402) — نستخدمه إن وُجد
  const code = typeof b.code === "number" ? b.code : httpStatus;
  return new ProviderError(code, msg);
}

async function cometRequest(
  key: ProviderKeyRef,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ProviderError(503, `تعذر الوصول إلى CometAPI: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // جسم غير JSON — نعتمد حالة HTTP
  }
  if (!res.ok) throw extractCometError(body, res.status);
  if (body?.error && !body?.data && !body?.status && !body?.request_id) {
    // بعض الأخطاء ترد بحالة 200 مع حقل error — نعاملها كخطأ بحالة الجسم
    throw extractCometError(body, 500);
  }
  return (body ?? {}) as Record<string, unknown>;
}

/** تحويل نسبة الأبعاد إلى مقاسات gpt-image المدعومة لدى CometAPI (auto يُحذف) */
function mapSize(aspectRatio?: string): string | undefined {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "3:2":
    case "4:3":
    case "16:9":
    case "5:4":
    case "2:1":
    case "21:9":
    case "3:1":
      return "1536x1024";
    case "2:3":
    case "3:4":
    case "9:16":
    case "4:5":
    case "1:2":
    case "9:21":
    case "1:3":
      return "1024x1536";
    default:
      return undefined;
  }
}

/** النتيجة تفضل url؛ إن لم يوجد إلا b64_json نغلفه كـ data URI (لا ننزّل أي ملف على السيرفر) */
function extractImageUrls(data: Record<string, unknown>): string[] {
  const arr = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
  const urls: string[] = [];
  for (const item of arr) {
    if (typeof item?.url === "string" && /^https?:\/\//.test(item.url)) {
      urls.push(item.url);
    } else if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
      urls.push(`data:image/png;base64,${item.b64_json}`);
    }
  }
  return urls;
}

export const cometAdapter: ProviderAdapter = {
  async createTask(key: ProviderKeyRef, providerModel: string, input: GenerationInput) {
    const body: Record<string, unknown> = { model: providerModel, prompt: input.prompt };
    if (input.imageUrl) body.image_url = input.imageUrl;
    if (typeof input.duration === "number") body.duration = input.duration;
    if (input.aspectRatio && input.aspectRatio !== "auto") body.aspect_ratio = input.aspectRatio;
    const data = await cometRequest(key, "/grok/v1/videos", {
      method: "POST",
      body: JSON.stringify(body),
    });
    // الاستجابة عند القبول قد تحمل request_id فقط، أو كائن حالة كامل
    const id =
      (typeof data.request_id === "string" && data.request_id) ||
      (typeof data.id === "string" && data.id) ||
      (typeof data.task_id === "string" && data.task_id) ||
      "";
    if (!id) throw new ProviderError(500, "استجابة CometAPI بلا معرّف مهمة");
    return { providerTaskId: id };
  },

  async createImageSync(key: ProviderKeyRef, providerModel: string, input: GenerationInput) {
    const body: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
      n: 1,
      // نطلب رابطًا؛ إن أعاد b64_json نغلفه data URI (فوق)
      response_format: "url",
    };
    const size = mapSize(input.aspectRatio);
    if (size) body.size = size;
    if (input.outputFormat) body.output_format = input.outputFormat;
    if (input.background && input.background !== "auto") body.background = input.background;
    const data = await cometRequest(key, "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const urls = extractImageUrls(data);
    if (urls.length === 0) throw new ProviderError(500, "استجابة CometAPI للصور بلا روابط");
    return { urls };
  },

  async checkTask(key: ProviderKeyRef, providerTaskId: string): Promise<CheckTaskResult> {
    const data = await cometRequest(key, `/grok/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
    });
    const status = String(data.status ?? "").toLowerCase();
    if (status === "done" || status === "completed" || status === "success") {
      const video = (data.video as Record<string, unknown> | undefined) ?? {};
      const url = typeof video.url === "string" && video.url.length > 0 ? video.url : null;
      const urls = url
        ? [url]
        : (Array.isArray(data.urls) ? (data.urls as string[]) : []).filter(
            (u) => typeof u === "string" && /^https?:\/\//.test(u),
          );
      if (urls.length === 0) {
        return { status: "failed", error: "اكتملت المهمة لدى CometAPI دون رابط فيديو" };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (status === "failed" || status === "expired") {
      const errField = data.error;
      const msg =
        typeof errField === "string"
          ? errField
          : errField && typeof errField === "object"
            ? String((errField as Record<string, unknown>).message ?? "")
            : "";
      return { status: "failed", error: msg || `فشل التوليد لدى CometAPI (${status})` };
    }
    const progress = typeof data.progress === "number" ? data.progress : undefined;
    return { status: "processing", progress: typeof progress === "number" ? progress : 40 };
  },
};
