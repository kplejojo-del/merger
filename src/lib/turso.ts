/**
 * طبقة قاعدة البيانات — Turso عبر libSQL/HTTP.
 * قرارات معمارية:
 * 1) عميل واحد معاد استخدامه على مستوى العملية (اتصال HTTP خالص — لا ملفات SQLite محلية،
 *    وهو شرط إلزامي للتوافق مع بيئة Vercel serverless).
 * 2) ensureSchema تُنشئ الجداول عند أول وصول بـ CREATE TABLE IF NOT EXISTS
 *    حتى لا نحتاج أداة migrations منفصلة.
 * 3) كل عمليات المهام هنا فقط؛ منطق التبديل بين المفاتيح في طبقة أعلى (generation.ts).
 */
import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const db = getTurso();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // فهارس خفيفة تساعد قوائم الواجهة وفحص التكرار (الأداء لا الحصر له)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys(provider, created_at)`);
  })();
  return schemaPromise;
}

/** فحص جاهزية قاعدة البيانات (SELECT 1) — للـ health فقط */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/* ---------- أنواع السجلات ---------- */

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: AttemptRecord[];
  params: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface KeyRecord {
  id: string;
  provider: string;
  label: string;
  apiKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function mapTaskRow(r: Record<string, unknown>): TaskRecord {
  const parseJson = (v: unknown, fallback: unknown) => {
    try {
      return typeof v === "string" && v.length > 0 ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(r.id),
    provider: isoOrNull(r.provider),
    providerTaskId: isoOrNull(r.provider_task_id),
    keyId: isoOrNull(r.key_id),
    model: String(r.model ?? ""),
    type: (r.type as TaskRecord["type"]) ?? "image",
    prompt: String(r.prompt ?? ""),
    status: (r.status as TaskStatus) ?? "pending",
    progress: Number(r.progress ?? 0),
    resultUrls: parseJson(r.result_urls_json, []) as string[],
    errorMessage: isoOrNull(r.error_message),
    attempts: parseJson(r.attempts_json, []) as AttemptRecord[],
    params: parseJson(r.params_json, {}) as Record<string, unknown>,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    completedAt: isoOrNull(r.completed_at),
  };
}

/** تحويل صف قاعدة البيانات الخام إلى سجل مفتاح مكتمل الحقول */
export function mapKeyRow(r: Record<string, unknown>): KeyRecord {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label ?? ""),
    apiKey: String(r.api_key),
    status: (r.status as KeyRecord["status"]) ?? "active",
    usageCount: Number(r.usage_count ?? 0),
    successCount: Number(r.success_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    lastUsedAt: isoOrNull(r.last_used_at),
    lastCheckedAt: isoOrNull(r.last_checked_at),
    lastError: isoOrNull(r.last_error),
    createdAt: String(r.created_at ?? ""),
  };
}

/* ---------- عمليات المهام ---------- */

export interface NewTask {
  id: string;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  model: string;
  type: TaskRecord["type"];
  prompt?: string;
  paramsJson?: string;
  status: TaskStatus;
}

export async function insertTask(t: NewTask): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.providerTaskId ?? null,
      t.keyId ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.paramsJson ?? "{}",
      t.status,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [id],
  });
  if (rs.rows.length === 0) return null;
  return mapTaskRow(rs.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  status?: TaskStatus;
  progress?: number;
  resultUrls?: string[];
  errorMessage?: string | null;
  /** دمج مفاتيح إضافية داخل params_json دون فقدان الموجود (مثل processFiredAt لخدمة الدمج) */
  paramsMerge?: Record<string, unknown>;
  /** إضافة محاولة إلى سجل attempts_json (نجاح أو فشل + التصنيف) */
  appendAttempt?: AttemptRecord;
}

/** تحديث جزئي للمهمة: يضيف المحاولات ويضبط completed_at تلقائيًا عند الاكتمال، ويحدّث updated_at دائمًا */
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return;

  const attempts = patch.appendAttempt ? [...current.attempts, patch.appendAttempt] : current.attempts;
  const params = patch.paramsMerge ? { ...current.params, ...patch.paramsMerge } : current.params;
  const status = patch.status ?? current.status;
  const completedAt =
    status === "completed" && !current.completedAt
      ? new Date().toISOString()
      : current.completedAt;

  await getTurso().execute({
    sql: `UPDATE tasks SET
            provider = ?, provider_task_id = ?, key_id = ?, model = ?, type = ?, prompt = ?,
            params_json = ?, status = ?, progress = ?, result_urls_json = ?, error_message = ?,
            attempts_json = ?, completed_at = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      patch.provider !== undefined ? patch.provider : current.provider,
      patch.providerTaskId !== undefined ? patch.providerTaskId : current.providerTaskId,
      patch.keyId !== undefined ? patch.keyId : current.keyId,
      current.model,
      current.type,
      current.prompt,
      JSON.stringify(params),
      status,
      patch.progress !== undefined ? Math.max(0, Math.min(100, Math.round(patch.progress))) : current.progress,
      patch.resultUrls !== undefined ? JSON.stringify(patch.resultUrls) : JSON.stringify(current.resultUrls),
      patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage,
      JSON.stringify(attempts),
      completedAt,
      id,
    ],
  });
}

export async function listRecentTasks(
  limit: number,
  filter?: { type?: TaskRecord["type"]; status?: TaskStatus },
): Promise<TaskRecord[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter?.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  args.push(Math.max(1, Math.min(50, limit)));
  const rs = await getTurso().execute({ sql, args });
  return rs.rows.map((r) => mapTaskRow(r as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const rs = await getTurso().execute(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END), 0) AS active
    FROM tasks
  `);
  const r = rs.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    active: Number(r.active ?? 0),
  };
}

/* ---------- عمليات المفاتيح (تُستخدم من داخل الخادم فقط) ---------- */

export async function insertKey(k: { id: string; provider: string; apiKey: string; label?: string }): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.apiKey],
  });
}

export async function listKeys(): Promise<KeyRecord[]> {
  await ensureSchema();
  const rs = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC",
  );
  return rs.rows.map((r) => mapKeyRow(r as unknown as Record<string, unknown>));
}

export async function findKeyById(id: string): Promise<KeyRecord | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE id = ?",
    args: [id],
  });
  if (rs.rows.length === 0) return null;
  return mapKeyRow(rs.rows[0] as unknown as Record<string, unknown>);
}

/** فحص تكرار المفتاح لنفس المزود (يُستخدم عند الإضافة) */
export async function findDuplicateKey(provider: string, apiKey: string): Promise<KeyRecord | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (rs.rows.length === 0) return null;
  return mapKeyRow(rs.rows[0] as unknown as Record<string, unknown>);
}

export async function setKeyStatus(id: string, status: KeyRecord["status"]): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE api_keys SET status = ? WHERE id = ?",
    args: [status, id],
  });
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "DELETE FROM api_keys WHERE id = ?",
    args: [id],
  });
  return rs.rowsAffected > 0;
}

/**
 * تحديث عدادات المفتاح بعد كل محاولة (نجاح أو فشل) — يُستدعى دائمًا.
 * - النجاح يعيد المفتاح إلى active (لو شُحن رصيد مفتاح مستنزف يعمل فورًا) ويمسح آخر خطأ.
 * - الفشل المصنّف disabled/exhausted يضبط الحالة المناسبة.
 */
export async function recordKeyOutcome(
  key: KeyRecord,
  ok: boolean,
  opts?: { errorClass?: string; error?: string; status?: KeyRecord["status"] },
): Promise<void> {
  await ensureSchema();
  const status = ok ? "active" : opts?.status ?? key.status;
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?,
            status = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (opts?.error ?? "").slice(0, 500), status, key.id],
  });
}
