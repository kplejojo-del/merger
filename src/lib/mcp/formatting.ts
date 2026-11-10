/**
 * صياغة الردود العربية لأدوات MCP (القسم 8 من المواصفة).
 * القاعدة الذهبية 4: لا تخرج من السيرفر أي رسالة تذكر المفاتيح أو الرصيد أبدًا —
 * كل سبب فشل يمر عبر sanitizeClientError قبل العرض للعميل.
 */
import type { TaskRecord } from "../turso";
import { isKeyRelatedFailure } from "../keys";

/** تنظيف سبب الفشل قبل عرضه للعميل — رسائل مفتاح/رصيد تُستبدل برسالة عامة آمنة */
export function sanitizeClientError(msg: string | null): string {
  const s = (msg ?? "").trim();
  if (s.length === 0) return "سبب غير معروف";
  if (isKeyRelatedFailure(s)) {
    return "تعذّر إكمال التوليد حاليًا — أعد المحاولة بعد قليل وستُتابَع المهمة تلقائيًا.";
  }
  return s;
}

/** صياغة رد المهمة الواحدة حسب حالتها — الصيغ حرفية من المواصفة */
export function formatTaskMessage(task: TaskRecord): { text: string; isError?: boolean } {
  const urls = task.resultUrls.filter((u) => /^https?:\/\//.test(u));

  if (task.status === "completed") {
    if (task.type === "image") {
      const parts = ["✅ تم توليد الصورة بنجاح", ""];
      for (const u of urls) parts.push(`![image](${u})`, "", `الرابط المباشر: ${u}`);
      return { text: parts.join("\n") };
    }
    if (task.type === "video") {
      const links = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
      return { text: `✅ تم توليد الفيديو بنجاح\n\n${links}` };
    }
    // دمج — التحذير الحرفي للملف المؤقت 24 ساعة
    const links = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
    return {
      text: `✅ تم دمج المقاطع بنجاح\n\n${links}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
    };
  }

  if (task.status === "failed") {
    return { text: `❌ فشلت المهمة: ${sanitizeClientError(task.errorMessage)}`, isError: true };
  }

  // pending / processing — بما فيها «بانتظار توفر مفتاح صالح…» الداخلية (لا تُذكر للعميل)
  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

const TYPE_LABELS: Record<TaskRecord["type"], string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

const STATUS_LABELS: Record<TaskRecord["status"], string> = {
  pending: "⏳ قيد الانتظار",
  processing: "⏳ قيد المعالجة",
  completed: "✅ مكتملة",
  failed: "❌ فاشلة",
};

/** صياغة قائمة الوسائط المخزنة — مرتبة من الأحدث مع الروابط والمعرّفات */
export function formatMediaList(tasks: TaskRecord[], filterText: string): string {
  if (tasks.length === 0) {
    return `🗂️ لا توجد وسائط مخزنة${filterText ? ` ${filterText}` : ""} بعد. المهام المكتملة ستظهر هنا بروابطها عند توليدها.`;
  }
  const lines: string[] = [`🗂️ أحدث الوسائط المخزنة (${tasks.length}):`, ""];
  tasks.forEach((t, i) => {
    lines.push(`${i + 1}. [${TYPE_LABELS[t.type]}] ${t.model} — ${STATUS_LABELS[t.status]} — أُضيفت: ${t.createdAt}`);
    if (t.resultUrls.length > 0) {
      for (const u of t.resultUrls) lines.push(`   الرابط: ${u}`);
    }
    if (t.status === "failed" && t.errorMessage) {
      lines.push(`   السبب: ${sanitizeClientError(t.errorMessage)}`);
    }
    lines.push(`   task_id: ${t.id}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
