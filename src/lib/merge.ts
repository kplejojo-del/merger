/**
 * تنسيق عمليات الدمج — خدمة Video Merger API v2 (القسم 7 من المواصفة).
 * القواعد الحاسمة المنفذة هنا:
 * 1) تحقق صارم: ≥2 و ≤10 روابط، كلها http/https مباشرة وعامة؛ روابط task_ids أولاً ثم urls.
 * 2) مهمة الدمج تُسجَّل في Turso أولًا ثم تُنشأ لدى الخدمة.
 * 3) POST /process يُطلق خلفيًا وبمرة واحدة فقط — قفل ذاكرة (processInFlight) + علم
 *    processFiredAt في قاعدة البيانات (حماية إضافية بين نسخ serverless).
 * 4) كل تحديث حالة من الخدمة يُكتب في Turso فورًا.
 * 5) أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري بلا إعادة محاولة؛
 *    أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → نستمر بالاستعلام حتى انتهاء النافذة.
 * 6) GET يعيد 404 → فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة).
 */
import { getTask, insertTask, updateTask, type TaskRecord } from "./turso";
import {
  getMergerBase,
  mergerClient,
  normalizeMergerStatus,
  normalizeProgress,
  pickResultUrl,
  MergerNetworkError,
  MergerServiceError,
} from "./merger";

const POLL_INTERVAL_MS = 3_000; // استعلام كل 3 ثوانٍ مع بث تقدم
const PROCESS_FLAG_TTL_MS = 180_000; // صلاحية علم processFiredAt — بعد انقضائه يُسمح بإعادة الإطلاق

/** قفل ذاكرة: منع تزامن POST /process مع get_task داخل نفس النسخة */
const processInFlight = new Set<string>();

export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updatedAtMs(task: TaskRecord): number {
  const t = Date.parse(`${task.updatedAt.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
}

/** حل المدخلات: روابط task_ids أولاً (المهام المكتملة بالترتيب) ثم urls المباشرة بنفس ترتيبها */
async function resolveMergeInputs(args: MergeArgs): Promise<{ videos: string[]; failedDetails: string[] }> {
  const videos: string[] = [];
  const failedDetails: string[] = [];

  for (const tid of args.task_ids ?? []) {
    const t = await getTask(tid);
    const url = t && t.status === "completed" && t.resultUrls.length > 0 ? t.resultUrls[0] : null;
    if (url) {
      videos.push(url);
    } else {
      const reason = !t
        ? "غير موجودة في قاعدة البيانات"
        : t.resultUrls.length === 0
          ? `حالتها ${t.status} دون روابط نتائج`
          : `حالتها ${t.status} وليست مكتملة`;
      failedDetails.push(`${tid}: ${reason}`);
    }
  }
  for (const u of args.urls ?? []) videos.push(u.trim());
  return { videos, failedDetails };
}

/** إطلاق POST /process مرة واحدة فقط لكل مهمة (قفل ذاكرة + علم في قاعدة البيانات) */
async function ensureProcessFired(taskId: string, jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  const task = await getTask(taskId);
  if (!task) return;
  const firedAt = task.params.processFiredAt;
  if (typeof firedAt === "number" && Date.now() - firedAt < PROCESS_FLAG_TTL_MS) return;

  processInFlight.add(jobId);
  // علّم الإطلاق في القاعدة أولًا لتقليل التزامن بين نسخ serverless
  await updateTask(taskId, { paramsMerge: { processFiredAt: Date.now() } });
  void (async () => {
    try {
      const result = await mergerClient.processJob(jobId);
      // نجاح المعالجة الحاجبة — طبّق النتيجة فورًا
      await applyMergePollResult(taskId, jobId, result);
    } catch (err) {
      if (err instanceof MergerServiceError) {
        // فشل معلن من الخدمة → حتمي فوري بلا إعادة محاولة (مثل مصدر يرفض التحميل)
        await updateTask(taskId, { status: "failed", errorMessage: err.message, progress: 100 });
      }
      // أخطاء الشبكة: الاستعلام الدوري GET سيتابع حتى انتهاء النافذة
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/** تطبيق نتيجة/حالة من خدمة الدمج على مهمتنا في Turso (دفاعي حسب 7.2) */
async function applyMergePollResult(
  taskId: string,
  jobId: string,
  body: Record<string, unknown>,
): Promise<TaskRecord | null> {
  const base = getMergerBase() ?? "";
  const bodyError = typeof body.error === "string" && body.error.length > 0 ? body.error : null;

  // جسم فيه error بدون حقل status → failed فورًا
  if (bodyError && !body.status) {
    await updateTask(taskId, { status: "failed", errorMessage: bodyError });
    return getTask(taskId);
  }

  const normalized = normalizeMergerStatus(body.status);
  if (normalized === "done") {
    const url = pickResultUrl(body, jobId, base);
    await updateTask(taskId, { status: "completed", progress: 100, resultUrls: [url], errorMessage: null });
  } else if (normalized === "failed" || (bodyError && normalized === null)) {
    await updateTask(taskId, {
      status: "failed",
      errorMessage: bodyError ?? "فشل الدمج لدى الخدمة",
      progress: 100,
    });
  } else {
    // queued / processing / غير معروف → حدّث التقدم فقط
    const progress = normalizeProgress(body.progress) ?? 10;
    const status = bodyError ? "processing" : undefined;
    await updateTask(taskId, { status, progress: Math.max(5, progress), errorMessage: null });
    // مهمة ما زالت queued تعني أن process لم يُنفَّذ/لم يكتمل بعد — أطلقه الآن إن لزم
    if (normalized === "queued" || normalized === null) {
      await ensureProcessFired(taskId, jobId);
    }
  }
  return getTask(taskId);
}

/**
 * خطوة واحدة من دورة حياة مهمة الدمج — تُستخدم من نافذة الانتظار ومن get_task.
 */
export async function advanceMergeTask(taskId: string): Promise<TaskRecord | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status !== "pending" && task.status !== "processing") return task;

  // أ) بلا jobId بعد: فشل إنشاء سابق (شبكة) — أعد المحاولة بعد تهدئة قصيرة
  if (!task.providerTaskId) {
    if (Date.now() - updatedAtMs(task) < 10_000) return task;
    const videos = (task.params.videos as string[] | undefined) ?? [];
    try {
      const job = await mergerClient.createJob(videos);
      await updateTask(taskId, {
        providerTaskId: job.jobId,
        status: "processing",
        progress: 5,
        errorMessage: null,
        appendAttempt: { provider: "merger", keyId: "-", keyLabel: "-", ok: true, at: new Date().toISOString() },
      });
      await ensureProcessFired(taskId, job.jobId);
    } catch (err) {
      if (err instanceof MergerServiceError) {
        await updateTask(taskId, { status: "failed", errorMessage: err.message });
      } else {
        await updateTask(taskId, { status: "processing", errorMessage: "تعذر إنشاء مهمة الدمج مؤقتًا — تُعاد المحاولة تلقائيًا" });
      }
    }
    return getTask(taskId);
  }

  // ب) مهمة قائمة لدى الخدمة — استعلم حالتها
  const jobId = task.providerTaskId;
  let body: Record<string, unknown>;
  try {
    body = await mergerClient.getJob(jobId);
  } catch (err) {
    if (err instanceof MergerServiceError) {
      // خطأ معلن من الخدمة (يشمل 404: حذف/انتهاء صلاحية) → فشل نهائي فوري
      await updateTask(taskId, { status: "failed", errorMessage: err.message, progress: 100 });
    }
    // MergerNetworkError: خطأ شبكتنا → مؤقت، نستمر بالاستعلام دون تغيير
    return getTask(taskId);
  }
  await ensureProcessFired(taskId, jobId);
  return await applyMergePollResult(taskId, jobId, body);
}

/**
 * التدفق الكامل لأداة merge_videos (7.3).
 * يعيد إما {error} برسالة عربية جاهزة أو {task} بعد نافذة الانتظار.
 */
export async function startMerge(
  args: MergeArgs,
  opts: { waitSeconds: number; onProgress?: (p: { progress: number; message: string }) => void | Promise<void>; signal?: AbortSignal },
): Promise<{ error?: string; task?: TaskRecord }> {
  const { videos, failedDetails } = await resolveMergeInputs(args);

  if (videos.length > 10) {
    return { error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  if (videos.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failedDetails.length > 0) {
      msg += "\n\nتفاصيل المعرّفات الفاشلة:\n" + failedDetails.map((d) => `- ${d}`).join("\n");
    }
    return { error: msg };
  }
  const badUrl = videos.find((v) => !/^https?:\/\/.+/i.test(v));
  if (badUrl) {
    return { error: `❌ يجب أن تكون كل الروابط روابط http/https مباشرة وعامة. رابط غير صالح: ${badUrl}` };
  }
  if (!getMergerBase()) {
    return {
      error:
        "❌ خدمة الدمج غير مُهيّأة على السيرفر (MERGER_API_BASE غير مضبوط). أضف عنوان خدمة الدمج في متغيرات البيئة ثم أعد المحاولة.",
    };
  }

  // (2) سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    paramsJson: JSON.stringify({ videos, requested: { task_ids: args.task_ids ?? [], urls: args.urls ?? [] } }),
    status: "pending",
  });

  // (3) أنشئ المهمة لدى الخدمة ثم أطلق process خلفيًا وبمرة واحدة
  let jobId: string | null = null;
  try {
    const job = await mergerClient.createJob(videos);
    jobId = job.jobId;
    await updateTask(taskId, {
      providerTaskId: jobId,
      status: "processing",
      progress: 5,
      appendAttempt: { provider: "merger", keyId: "-", keyLabel: "-", ok: true, at: new Date().toISOString() },
    });
    await ensureProcessFired(taskId, jobId);
  } catch (err) {
    if (err instanceof MergerServiceError) {
      await updateTask(taskId, { status: "failed", errorMessage: err.message });
      return { task: (await getTask(taskId))! };
    }
    // شبكة — نستمر داخل نافذة الانتظار وadvanceMergeTask يعيد المحاولة
    await updateTask(taskId, { status: "processing", errorMessage: "تعذر إنشاء مهمة الدمج مؤقتًا — تُعاد المحاولة تلقائيًا" });
  }

  // (4) نافذة الانتظار (الافتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم وكتابة Turso كل مرة
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000;
  let lastProgress = 5;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    await sleep(POLL_INTERVAL_MS);
    const step = await advanceMergeTask(taskId);
    if (!step) break;
    if (step.status === "completed" || step.status === "failed") return { task: step };
    lastProgress = Math.max(lastProgress, step.progress ?? 0);
    await opts.onProgress?.({ progress: lastProgress, message: `جارٍ دمج المقاطع… ${lastProgress}%` });
  }
  return { task: (await getTask(taskId))! };
}
