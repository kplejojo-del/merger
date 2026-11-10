/**
 * تعريف واجهة المزودات الموحدة — كل مزود ينفذها (kie / cometapi).
 * أي خطأ يُرمى كـ ProviderError {status, message} ليُصنَّف في طبقة المفاتيح.
 */
import type { ProviderId } from "../models";

export interface GenerationInput {
  prompt: string;
  /** صورة إطارية أولى لتوليد الفيديو (image-to-video) */
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
}

export interface ProviderKeyRef {
  id: string;
  provider: ProviderId;
  apiKey: string;
  label?: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

/** خطأ مزود موحد — status هو رمز HTTP أو code داخل الجسم كما يقيس الواقع */
export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(
    key: ProviderKeyRef,
    providerModel: string,
    input: GenerationInput,
  ): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (تعيد الروابط فورًا) */
  createImageSync?(
    key: ProviderKeyRef,
    providerModel: string,
    input: GenerationInput,
  ): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: ProviderKeyRef, providerTaskId: string): Promise<CheckTaskResult>;
}

/** تصنيف أي خطأ مُرمى إلى فئة طبقة المفاتيح (منطق جدول 4.2) */
export function classifyError(err: unknown): "disabled" | "exhausted" | "provider" | "params" | "temporary" {
  if (err instanceof ProviderError) {
    const status = err.status;
    const m = (err.message || "").toLowerCase();
    // نفاد الرصيد يُفحص بالرسالة أولًا — بعض المزودين يرسلونه بحالة 400
    if (/insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(m)) return "exhausted";
    if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(m)) {
      return "disabled";
    }
    if (status === 402) return "exhausted";
    if (
      (status === 400 || status === 404 || status === 422) &&
      /model not found|unsupported model|no such model|invalid model|not a valid model/.test(m)
    ) {
      return "provider";
    }
    if (status === 400 || status === 422) return "params";
    return "temporary";
  }
  // أخطاء شبكة/timeout/abort → مؤقتة دائمًا: ننتقل للمفتاح التالي دون تعليم المفتاح
  return "temporary";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
