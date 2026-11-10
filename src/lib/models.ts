/**
 * سجل الموديلات (MODELS registry).
 * - الاسم الرسمي (canonical) هو ما يراه عميل MCP، ونقبل صيغًا بديلة (نقاط/شرطات) ونوحّدها.
 * - providerModel هو الاسم الفعلي المرسل لكل مزود (قد يختلف بين المزودين).
 * - الأسماء قابلة للتجاوز بمتغيرات بيئة: KIE_IMAGE_MODEL, KIE_VIDEO_MODEL,
 *   COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL.
 */
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  /** المزودون القادرون على خدمة الموديل — تُجرَّب مفاتيحهم كلها بالترتيب التسلسلي */
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: dedupe([
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
      KIE_IMAGE_MODEL,
    ]),
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: dedupe([
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
      KIE_VIDEO_MODEL,
    ]),
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

/** توحيد اسم الموديل: إزالة الفراغات وتحويل النقاط إلى شرطات (نقبل الصيغتين) */
export function normalizeModelName(name: string): string {
  return name.trim().replace(/\./g, "-").toLowerCase();
}

/** البحث عن موديل بالاسم الرسمي أو البديل — غير معروف يُعاد null (خطأ معطيات) */
export function findModel(name?: string | null): ModelDef | null {
  if (!name) return null;
  const norm = normalizeModelName(name);
  return MODELS.find((m) => m.aliases.some((a) => normalizeModelName(a) === norm)) ?? null;
}

export function findModelByCanonical(canonical: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === canonical) ?? null;
}

/** القيم المسموحة لحقل model في مخطط الأداة (الاسم الرسمي + الصيغ البديلة) */
export function modelEnumFor(type: MediaType): string[] {
  return MODELS.filter((m) => m.type === type).flatMap((m) => m.aliases);
}
