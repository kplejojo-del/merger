/**
 * طبقة مفاتيح API — قلب نظام التبديل التسلسلي الصارم.
 * القواعد الذهبية المنفذة هنا:
 * 1) getKeyPool تجلب المفاتيح بترتيب الإضافة الصارم (created_at ASC, id ASC) —
 *    ليس round-robin وليس «الأقل استخدامًا أولًا».
 * 2) المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة — الاستثناء الوحيد هو
 *    التعطيل اليدوي (disabled).
 * 3) classifyProviderError تصنّف كل خطأ مزود وفق جدول المواصفة؛ نفاد الرصيد يُفحص
 *    بالرسالة قبل الحالة 400 لأن بعض المزودين يرسلونه بحالة 400.
 * 4) maskKey إخفاء إلزامي للمفاتيح في كل الاستجابات والسجلات.
 */
import { ensureSchema, getTurso, mapKeyRow, type KeyRecord } from "./turso";
import type { ProviderId } from "./models";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/**
 * تصنيف موحد لأخطاء المزودين:
 * - exhausted: نفاد رصيد (يُفحص أولًا بالرسالة لأن بعض المزودين يرسلونه بحالة 400)
 * - disabled: مفتاح مرفوض 401/403 أو رسالة مصادقة
 * - provider: الموديل غير مدعوم لدى هذا المزود
 * - params: خطأ معطيات — توقف فورًا (تبديل المفاتيح لن يحلّه)
 * - temporary: 429/5xx/شبكة — انتقل للمفتاح التالي والمفتاح يبقى سليمًا
 */
export function classifyProviderError(status: number, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  const has = (...patterns: RegExp[]) => patterns.some((p) => p.test(m));

  if (has(/insufficient/, /quota/, /balance/, /credit/, /out of credits/, /exhausted/, /充值/)) {
    return "exhausted";
  }
  if (status === 401 || status === 403 || has(/invalid api key/, /unauthorized/, /forbidden/, /authentication/)) {
    return "disabled";
  }
  if (status === 402) return "exhausted";
  if (
    (status === 400 || status === 404 || status === 422) &&
    has(/model not found/, /unsupported model/, /no such model/, /invalid model/, /not a valid model/)
  ) {
    return "provider";
  }
  if (status === 400 || status === 422) return "params";
  return "temporary"; // 429، 5xx، انقطاع شبكة، timeout — والافتراضي الآمن
}

/**
 * رسائل فشل منتصف المهمة التي تعني مشكلة مفتاح/رصيد لدى المزود (4.3.2) —
 * مطابقتها تُفعّل إعادة إنشاء نفس المهمة على المفتاح التالي بنفس task_id.
 */
export function isKeyRelatedFailure(message: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|invalid api key|exhausted|forbidden|充值/i.test(
    message || "",
  );
}

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 (القصير: أول 3 + ••••) */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

/**
 * جلب مجمع المفاتيح بترتيب تسلسلي صارم حسب ترتيب الإضافة —
 * أول مفتاح أُضيف يُجرَّب أولًا ثم الثاني ثم الثالث…
 * (تحذير مهم: تُحوَّل الصفوف الخام عبر mapKeyRow حتى تتطابق أسماء الحقول
 * camelCase — إرسال "Bearer undefined" لكل مفتاح كان خللًا مصححًا هنا.)
 */
export async function getKeyPool(providers: ProviderId[]): Promise<KeyRecord[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as unknown as string[],
  });
  return rs.rows.map((r) => mapKeyRow(r as unknown as Record<string, unknown>));
}

/** شكل المفتاح المُقنَّع المُعاد للواجهة — لا يُعاد المفتاح الكامل في أي استجابة */
export function publicKey(k: KeyRecord) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.apiKey),
    status: k.status,
    usageCount: k.usageCount,
    successCount: k.successCount,
    failCount: k.failCount,
    lastUsedAt: k.lastUsedAt,
    lastCheckedAt: k.lastCheckedAt,
    lastError: k.lastError,
    createdAt: k.createdAt,
  };
}
