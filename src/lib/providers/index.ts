/**
 * سجل المزودات — نقطة وصول واحدة لجلب المهايئ المناسب لكل مزود،
 * مع إعادة تصدير الأنواع المشتركة لتسهيل الاستيراد من الطبقات الأعلى.
 */
import type { ProviderId } from "../models";
import { cometAdapter } from "./cometapi";
import { kieAdapter } from "./kie";
import type { ProviderAdapter } from "./types";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider];
}

export { ProviderError, classifyError, errorMessage } from "./types";
export type { CheckTaskResult, GenerationInput, ProviderAdapter, ProviderKeyRef } from "./types";
