/**
 * مزود kie.ai — Jobs API الموحد (المزود الأساسي).
 * الأشكال هنا مقاسة فعليًا بنداءات حقيقية (لا تخترع حقولًا):
 * - النجاح: HTTP 200 {"code":200,"msg":"success","data":{"taskId":"..."}}
 * - الأخطاء قد ترد بحالة HTTP 200 مع code!=200 — لذا نفحص كليهما حتمًا.
 * - recordInfo: data.state = waiting|queuing|generating|success|fail
 *   و resultJson نص JSON داخل JSON يحتاج JSON.parse ثانية (نتعامل معه دفاعيًا).
 */
import type { CheckTaskResult, GenerationInput, ProviderAdapter, ProviderKeyRef } from "./types";
import { ProviderError } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

async function kieRequest(
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
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // انقطاع شبكة/timeout — يُصنَّف مؤقتًا في الطبقة الأعلى
    throw new ProviderError(503, `تعذر الوصول إلى kie.ai: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // جسم غير JSON
  }
  const code = typeof body?.code === "number" ? body.code : null;
  const msg = String(body?.msg ?? body?.message ?? `HTTP ${res.status}`);
  // kie.ai قد يرسل الخطأ بحالة HTTP 200 مع code!=200 — الفحص الأول حتمي
  if (code !== null && code !== 200) throw new ProviderError(code, msg);
  if (!res.ok) throw new ProviderError(res.status, msg);
  return (body?.data as Record<string, unknown>) ?? {};
}

/** بناء input لـ kie من معطيات الأداة الموحدة (الحقول كما يتوقعها Jobs API) */
function buildKieInput(input: GenerationInput): Record<string, unknown> {
  const out: Record<string, unknown> = { prompt: input.prompt };
  if (input.imageUrl) out.image_url = input.imageUrl;
  if (input.aspectRatio && input.aspectRatio !== "auto") out.aspect_ratio = input.aspectRatio;
  if (input.resolution) out.resolution = input.resolution;
  if (input.background) out.background = input.background;
  if (input.outputFormat) out.output_format = input.outputFormat;
  if (typeof input.duration === "number") out.duration = input.duration;
  if (typeof input.enableAudio === "boolean") out.enable_audio = input.enableAudio;
  return out;
}

/** استخراج روابط النتائج دفاعيًا: resultJson نص JSON داخلي، وهناك أيضًا response.resultUrls */
function extractResultUrls(data: Record<string, unknown>): string[] {
  const candidates: unknown[] = [];
  const response = data.response as Record<string, unknown> | undefined;
  if (response?.resultUrls) candidates.push(response.resultUrls);
  const resultJson = data.resultJson;
  if (typeof resultJson === "string") {
    try {
      const parsed = JSON.parse(resultJson) as Record<string, unknown>;
      if (parsed?.resultUrls) candidates.push(parsed.resultUrls);
    } catch {
      // تجاهل — نعتمد المرشح الآخر
    }
  } else if (resultJson && typeof resultJson === "object") {
    const rj = resultJson as Record<string, unknown>;
    if (rj.resultUrls) candidates.push(rj.resultUrls);
  }
  const urls = candidates.find(
    (c) => Array.isArray(c) && c.length > 0 && typeof c[0] === "string" && /^https?:\/\//.test(c[0] as string),
  );
  return (Array.isArray(urls) ? (urls as string[]) : []).filter((u) => /^https?:\/\//.test(u));
}

function mapKieState(data: Record<string, unknown>): CheckTaskResult {
  const state = String(data.state ?? "").toLowerCase();
  if (state === "success") {
    const urls = extractResultUrls(data);
    if (urls.length === 0) {
      return { status: "failed", error: "اكتملت المهمة لدى kie.ai دون روابط نتائج قابلة للاستخدام" };
    }
    return { status: "completed", urls, progress: 100 };
  }
  if (state === "fail") {
    const failMsg = String(data.failMsg ?? "") || String(data.failCode ?? "");
    return { status: "failed", error: failMsg || "فشل التوليد لدى kie.ai" };
  }
  // waiting / queuing / generating — تقدم تقديري أساسي يُمزج لاحقًا مع الزمن المنقضي
  const base = state === "waiting" ? 8 : state === "queuing" ? 18 : 45;
  return { status: "processing", progress: base };
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKeyRef, providerModel: string, input: GenerationInput) {
    const data = await kieRequest(key, "/createTask", {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input: buildKieInput(input) }),
    });
    const taskId = data.taskId;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new ProviderError(500, "استجابة kie.ai بلا taskId");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKeyRef, providerTaskId: string): Promise<CheckTaskResult> {
    const data = await kieRequest(key, `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
    });
    return mapKieState(data);
  },
};
