/**
 * نقطة الدخول الموحدة لتحديث أي مهمة حيًا (تُستخدم من أداة get_task):
 * - المهام الجارية تُحدَّث من المزود/خدمة الدمج مع نفس منطق إعادة المحاولة/التبديل.
 * - المهام المنتهية تُعاد كما هي.
 */
import { advanceGenerationTask } from "./generation";
import { advanceMergeTask } from "./merge";
import { getTask, type TaskRecord } from "./turso";

export async function refreshTask(taskId: string): Promise<TaskRecord | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.type === "merge") return advanceMergeTask(taskId);
  return advanceGenerationTask(taskId);
}
