/**
 * منسّق التوليد — قلب نظام «لا توقف أبدًا».
 * سلوك التبديل التسلسلي الصارم (4.3):
 * 1) المهمة تُسجَّل في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال.
 * 2) تُجرَّب المفاتيح بالترتيب الصارم حتى نجاح الإنشاء؛ كل محاولة تُسجَّل في attempts_json
 *    وعدّادات المفتاح تُحدَّث دائمًا.
 * 3) فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح
 *    التالي تلقائيًا — العميل يرى «قيد المعالجة» فقط ولا يعلم بأي تبديل.
 * 4) فشل الإنشاء على كل المفاتيح → المهمة تبقى processing «بانتظار توفر مفتاح صالح…»
 *    وتُعاد المحاولة مع كل get_task بعد تهدئة ~45 ثانية — لو شُحن أي مفتاح تكتمل المهمة.
 * 5) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا (انظر sanitize في mcp/formatting).
 */
import { findModelByCanonical, type ModelDef } from "./models";
import { classifyProviderError, getKeyPool, isKeyRelatedFailure } from "./keys";
import { getAdapter, ProviderError, type GenerationInput, type ProviderKeyRef } from "./providers";
import { errorMessage } from "./providers/types";
import {
  ensureSchema,
  findKeyById,
  getTask,
  insertTask,
  recordKeyOutcome,
  setKeyStatus,
  updateTask,
  type KeyRecord,
  type TaskRecord,
} from "./turso";

const POLL_INTERVAL_MS = 3_000; // استعلام الحالة كل 3 ثوانٍ أثناء نافذة الانتظار
const CREATION_COOLDOWN_MS = 45_000; // تهدئة بين محاولات الإنشاء الكاملة (لا نضغط المزودين)

export interface GenerationOptions {
  type: "image" | "video";
  model: ModelDef;
  input: GenerationInput;
  /** نافذة الانتظار 0–240 ثانية (الافتراضي 90 للصور و25 للفيديو) */
  waitSeconds: number;
  onProgress?: (p: { progress: number; message: string }) => void | Promise<void>;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updatedAtMs(task: TaskRecord): number {
  const t = Date.parse(`${task.updatedAt.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
}

function createdAtMs(task: TaskRecord): number {
  const t = Date.parse(`${task.createdAt.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : Date.now();
}

/** تقدم سلس مبني على الزمن المنقضي مقابل المدة المتوقعة، مع احترام تقدم المزود إن وُجد */
function estimateProgress(task: TaskRecord, providerProgress?: number): number {
  if (typeof providerProgress === "number" && providerProgress > 0) {
    return Math.max(5, Math.min(95, Math.round(providerProgress)));
  }
  const elapsedSec = (Date.now() - createdAtMs(task)) / 1000;
  const expected = task.type === "image" ? 30 : 150;
  return Math.max(5, Math.min(95, 10 + Math.floor((elapsedSec / expected) * 80)));
}

function keyRef(key: KeyRecord): ProviderKeyRef {
  return { id: key.id, provider: key.provider as ProviderKeyRef["provider"], apiKey: key.apiKey, label: key.label };
}

/**
 * تجربة الإنشاء على مجمّع المفاتيح بالترتيب الصارم.
 * - skipFailed=true: تجاهل المفاتيح التي فشلت مع هذه المهمة (للتبديل الفوري في منتصف المهمة).
 *   إعادة المحاولة بعد التهدئة تستخدم skipFailed=false (المستخدم ربما شحن رصيدًا).
 * النتيجة: "created" (إنشاء غير متزامن ناجح) | "completed" (صورة متزامنة اكتملت) |
 *          "params-failed" (فشل معطيات نهائي) | "exhausted-pool" (كل المفاتيح فشلت — تبقى processing).
 */
async function tryCreateOnPool(
  task: TaskRecord,
  model: ModelDef,
  input: GenerationInput,
  opts: { skipFailed: boolean },
): Promise<"created" | "completed" | "params-failed" | "exhausted-pool"> {
  const pool = await getKeyPool(model.providers);
  const failedIds = opts.skipFailed
    ? new Set(task.attempts.filter((a) => !a.ok).map((a) => a.keyId))
    : new Set<string>();

  for (const key of pool) {
    if (failedIds.has(key.id)) continue;
    const adapter = getAdapter(key.provider as never);
    const providerModel = model.providerModel[key.provider as keyof typeof model.providerModel];
    try {
      // صور متزامنة (CometAPI) تعيد الروابط فورًا — المهمة تكتمل عند الإنشاء نفسه
      if (task.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(keyRef(key), providerModel, input);
        await recordKeyOutcome(key, true);
        await updateTask(task.id, {
          provider: key.provider,
          keyId: key.id,
          status: "completed",
          progress: 100,
          resultUrls: urls,
          errorMessage: null,
          appendAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() },
        });
        return "completed";
      }
      const { providerTaskId } = await adapter.createTask(keyRef(key), providerModel, input);
      await recordKeyOutcome(key, true);
      await updateTask(task.id, {
        provider: key.provider,
        providerTaskId,
        keyId: key.id,
        status: "processing",
        progress: 8,
        errorMessage: null,
        appendAttempt: { provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString() },
      });
      return "created";
    } catch (err) {
      const cls = classifyProviderError(
        err instanceof ProviderError ? err.status : 503,
        errorMessage(err),
      );
      await recordKeyOutcome(key, false, { errorClass: cls, error: errorMessage(err) });
      await updateTask(task.id, {
        appendAttempt: {
          provider: key.provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: errorMessage(err).slice(0, 500),
          at: new Date().toISOString(),
        },
      });
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        await updateTask(task.id, { status: "failed", errorMessage: errorMessage(err) });
        return "params-failed";
      }
      if (cls === "disabled") await setKeyStatus(key.id, "disabled");
      if (cls === "exhausted") await setKeyStatus(key.id, "exhausted");
      // provider / temporary → انتقل للمفتاح التالي فورًا
      continue;
    }
  }

  // فشل الإنشاء على كل المفاتيح: تبقى processing برسالة داخلية (لا تُعرض للعميل كما هي)
  await updateTask(task.id, {
    status: "processing",
    providerTaskId: null,
    errorMessage: "بانتظار توفر مفتاح صالح…",
  });
  return "exhausted-pool";
}

/**
 * خطوة واحدة من دورة حياة مهمة توليد — تُستخدم من حلقة نافذة الانتظار ومن get_task.
 * تعيد المهمة بعد التحديث الحي من المزود، مع منطق التبديل نفسه عند فشل مفتاح/رصيد.
 */
export async function advanceGenerationTask(taskId: string): Promise<TaskRecord | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status !== "pending" && task.status !== "processing") return task;

  const model = findModelByCanonical(task.model);
  if (!model) {
    await updateTask(taskId, { status: "failed", errorMessage: `موديل غير معروف في السجل: ${task.model}` });
    return getTask(taskId);
  }

  // الحالة أ: بلا مهمة مزود بعد (بانتظار مفاتيح أو فشل إنشاء سابق) — أعد المحاولة بعد التهدئة
  if (!task.providerTaskId) {
    if (Date.now() - updatedAtMs(task) < CREATION_COOLDOWN_MS) return task;
    await tryCreateOnPool(task, model, (task.params as { input?: GenerationInput }).input ?? { prompt: task.prompt }, {
      skipFailed: false,
    });
    return getTask(taskId);
  }

  // الحالة ب: مهمة قائمة لدى المزود — استعلم حالتها بالمفتاح المرتبط
  const key = task.keyId ? await findKeyById(task.keyId) : null;
  if (!key) {
    // المفتاح حُذف يدويًا أثناء المهمة → حاول التبديل على المفاتيح المتبقية
    await updateTask(task.id, {
      appendAttempt: { provider: task.provider ?? "?", keyId: task.keyId ?? "?", keyLabel: "محذوف", ok: false, errorClass: "disabled", error: "المفتاح حُذف أثناء المهمة", at: new Date().toISOString() },
    });
    await tryCreateOnPool(task, model, (task.params as { input?: GenerationInput }).input ?? { prompt: task.prompt }, {
      skipFailed: true,
    });
    return getTask(taskId);
  }

  const adapter = getAdapter(key.provider as never);
  try {
    const check = await adapter.checkTask(keyRef(key), task.providerTaskId);
    if (check.status === "completed" && check.urls && check.urls.length > 0) {
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        resultUrls: check.urls,
        errorMessage: null,
      });
    } else if (check.status === "failed") {
      if (isKeyRelatedFailure(check.error ?? "")) {
        // فشل منتصف المهمة بسبب مفتاح/رصيد: علّم المفتاح وأعد الإنشاء على التالي بنفس task_id
        const cls = classifyProviderError(402, check.error ?? "");
        await recordKeyOutcome(key, false, { errorClass: cls, error: check.error });
        if (cls === "disabled") await setKeyStatus(key.id, "disabled");
        if (cls === "exhausted") await setKeyStatus(key.id, "exhausted");
        await updateTask(task.id, {
          appendAttempt: {
            provider: key.provider,
            keyId: key.id,
            keyLabel: key.label,
            ok: false,
            errorClass: cls,
            error: (check.error ?? "").slice(0, 500),
            at: new Date().toISOString(),
          },
        });
        await tryCreateOnPool(task, model, (task.params as { input?: GenerationInput }).input ?? { prompt: task.prompt }, {
          skipFailed: true,
        });
      } else {
        // فشل حقيقي (انتهاك سياسة/معطيات) — فشل نهائي
        await updateTask(task.id, { status: "failed", errorMessage: check.error ?? "فشل التوليد لدى المزود" });
      }
    } else {
      // معالجة جارية — حدّث التقدم في Turso (تحديث حي)
      await updateTask(task.id, { status: "processing", progress: estimateProgress(task, check.progress) });
    }
  } catch (err) {
    const cls = classifyProviderError(
      err instanceof ProviderError ? err.status : 503,
      errorMessage(err),
    );
    if (cls === "disabled" || cls === "exhausted") {
      // مفتاح سار إلى حالة سيئة أثناء المتابعة → علّمه وبدّل فورًا بنفس task_id
      await recordKeyOutcome(key, false, { errorClass: cls, error: errorMessage(err) });
      await setKeyStatus(key.id, cls);
      await updateTask(task.id, {
        appendAttempt: {
          provider: key.provider,
          keyId: key.id,
          keyLabel: key.label,
          ok: false,
          errorClass: cls,
          error: errorMessage(err).slice(0, 500),
          at: new Date().toISOString(),
        },
      });
      await tryCreateOnPool(task, model, (task.params as { input?: GenerationInput }).input ?? { prompt: task.prompt }, {
        skipFailed: true,
      });
    } else {
      // temporary (شبكة/timeout/429/5xx): ابقِ processing — المفتاح يبقى سليمًا ونستمر بالاستعلام
      await updateTask(task.id, { status: "processing", progress: estimateProgress(task) });
    }
  }
  return getTask(taskId);
}

/** التدفق الكامل لأداة generate_image / generate_video (القسم 6 من المواصفة) */
export async function runGeneration(opts: GenerationOptions): Promise<TaskRecord> {
  await ensureSchema();
  const taskId = crypto.randomUUID();

  // (3) سجّل المهمة قبل أي نداء خارجي — كل معطيات الطلب الأصلية محفوظة لإعادة الإنشاء عند التبديل
  await insertTask({
    id: taskId,
    model: opts.model.canonical,
    type: opts.type,
    prompt: opts.input.prompt,
    paramsJson: JSON.stringify({ input: opts.input }),
    status: "pending",
  });

  let task = (await getTask(taskId))!;

  // (4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const created = await tryCreateOnPool(task, opts.model, opts.input, { skipFailed: false });
  task = (await getTask(taskId))!;

  if (created === "params-failed") return task;
  if (created === "completed") return task; // صورة متزامنة اكتملت فورًا

  // (5) نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم كل ~3 ثوانٍ
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000;
  let lastProgress = task.progress ?? 0;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    await sleep(POLL_INTERVAL_MS);
    const step = await advanceGenerationTask(taskId);
    if (!step) break;
    if (step.status === "completed" || step.status === "failed") return step;
    // بث التقدم — رسالة عربية مع النسبة
    lastProgress = Math.max(lastProgress, step.progress ?? 0);
    await opts.onProgress?.({ progress: lastProgress, message: `قيد التوليد… ${lastProgress}%` });
  }

  // (7) انتهت النافذة دون نتيجة → تعاد processing والعميل يتابع بـ get_task
  return (await getTask(taskId))!;
}
