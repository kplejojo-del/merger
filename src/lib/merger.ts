/**
 * عميل خدمة دمج الفيديو — Video Merger API v2.
 * العنوان من MERGER_API_BASE — بلا مفاتيح أو توثيق.
 * المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا معاملات resolution/fps (الناتج ثابت).
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة (expiresAt في الاستجابات).
 * تمييز مهم (قاعدة 7.3.5): أخطاء HTTP معلنة من الخدمة = حتمية فورية؛ أخطاء شبكتنا نحن = مؤقتة.
 */
export class MergerServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "MergerServiceError";
  }
}

export class MergerNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerNetworkError";
  }
}

export function getMergerBase(): string | null {
  const base = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  return base && /^https?:\/\//.test(base) ? base : null;
}

interface MergerResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/** نداء HTTP موحد — يفرق بين خطأ الخدمة المعلن (حتمي) وانقطاع شبكتنا (مؤقت) */
async function mergerFetch(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<MergerResponse> {
  const base = getMergerBase();
  if (!base) {
    throw new MergerServiceError(0, "خدمة الدمج غير مُهيّأة — اضبط متغير البيئة MERGER_API_BASE بعنوان خدمة الدمج");
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MergerNetworkError(err instanceof Error ? err.message : String(err));
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // جسم غير JSON (مثل ملف فيديو) — مقبول
  }
  return { status: res.status, body };
}

/** تحليل حالة الدمج دفاعيًا (7.2): يغطي الصيغ المذكورة في المواصفة وأكثر */
export function normalizeMergerStatus(s: unknown): "queued" | "processing" | "done" | "failed" | null {
  const v = String(s ?? "").toLowerCase();
  if (!v) return null;
  if (/done|completed|complete|success|succeeded|finished/.test(v)) return "done";
  if (/error|failed|failure|cancelled|canceled/.test(v)) return "failed";
  if (/queued|pending|created/.test(v)) return "queued";
  if (/processing|running|in progress|working|started/.test(v)) return "processing";
  return null;
}

/** التقدم قد يرد كسرًا 0..1 — نضربه في 100 */
export function normalizeProgress(p: unknown): number | null {
  const n = typeof p === "string" ? parseFloat(p) : typeof p === "number" ? p : NaN;
  if (!Number.isFinite(n)) return null;
  const v = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا وبقي jobId فاضبط رابط الفيديو المباشر */
export function pickResultUrl(body: Record<string, unknown>, jobId: string, base: string): string {
  const videoUrl = typeof body.videoUrl === "string" && body.videoUrl.length > 0 ? body.videoUrl : null;
  const downloadUrl = typeof body.downloadUrl === "string" && body.downloadUrl.length > 0 ? body.downloadUrl : null;
  return videoUrl ?? downloadUrl ?? `${base}/api/jobs/${jobId}/video`;
}

export const mergerClient = {
  /** فحص الجهوزية: GET /api/config بمهلة 4 ثوانٍ (يُستخدم في /api/health) */
  async healthy(): Promise<boolean> {
    const base = getMergerBase();
    if (!base) return false;
    try {
      const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4_000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  /** POST /api/jobs — إنشاء مهمة دمج جديدة */
  async createJob(videos: string[]): Promise<{ jobId: string; status: string; expiresAt?: string }> {
    const { status, body } = await mergerFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ videos }),
    });
    if (status < 200 || status >= 300) {
      throw new MergerServiceError(status, String(body?.error ?? `HTTP ${status}`));
    }
    const jobId = String(body?.jobId ?? body?.id ?? "");
    if (!jobId) throw new MergerServiceError(500, "استجابة خدمة الدمج بلا jobId");
    return {
      jobId,
      status: String(body?.status ?? "queued"),
      expiresAt: typeof body?.expiresAt === "string" ? body.expiresAt : undefined,
    };
  },

  /** POST /api/jobs/{id}/process — حاجبة ~10–15 ثانية؛ النجاح يعيد النتيجة، الفشل HTTP 500 + error */
  async processJob(jobId: string): Promise<Record<string, unknown>> {
    const { status, body } = await mergerFetch(
      `/api/jobs/${encodeURIComponent(jobId)}/process`,
      { method: "POST", body: JSON.stringify({}) },
      90_000,
    );
    if (status < 200 || status >= 300) {
      throw new MergerServiceError(status, String(body?.error ?? `HTTP ${status}`));
    }
    if (body?.error) {
      throw new MergerServiceError(status, String(body.error));
    }
    return body ?? {};
  },

  /** GET /api/jobs/{id} — قد يرد الجسم فيه error بدون حقل status → نعامله failed فورًا */
  async getJob(jobId: string): Promise<Record<string, unknown>> {
    const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" });
    if (status === 404) {
      throw new MergerServiceError(404, "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    }
    if (status < 200 || status >= 300) {
      throw new MergerServiceError(status, String(body?.error ?? `HTTP ${status}`));
    }
    return body ?? {};
  },

  /** DELETE /api/jobs/{id} — حذف فوري (تنظيف) */
  async deleteJob(jobId: string): Promise<void> {
    try {
      await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    } catch {
      // التنظيف اختياري — نتجاهل الأخطاء
    }
  },
};
