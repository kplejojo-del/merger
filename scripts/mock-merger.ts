/**
 * خدمة دمج محلية محاكية — Video Merger API v2 بنفس الأشكال المقاسة في المواصفة (7.1).
 * تُستخدم فقط لاختبار تدفق الدمج e2e بشكل كامل إلى أن يزوّد المستخدم عنوان
 * خدمة الدمج الحقيقية في MERGER_API_BASE.
 * التشغيل: bun run scripts/mock-merger.ts (منفذ 9910)
 *
 * المحاكاة تحترم كل التفاصيل الدقيقة من المواصفة:
 * - POST /api/jobs → {"jobId","status":"queued","statusUrl","processUrl","expiresAt"}
 * - POST /api/jobs/{id}/process → حاجبة ~8 ثوانٍ → {"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}
 *   أو فشل HTTP 500 + {"error":"Download failed (HTTP 403)"} إذا رابط مصدر يحتوي "fail"
 * - GET /api/jobs/{id} → progress أحيانًا كسر 0..1 (لاختبار التحليل الدفاعي) وأحيانًا 0..100
 * - GET /api/jobs/{id}/video?download=1 → ملف video/mp4 مباشرة
 * - DELETE /api/jobs/{id}، GET /api/config
 */
interface Job {
  id: string;
  videos: string[];
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  createdAt: number;
  error: string | null;
  processed: boolean;
}

const jobs = new Map<string, Job>();
let counter = 0;

function makeJobId(): string {
  counter++;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 11; i++) id += letters[Math.floor(Math.random() * letters.length)];
  return id;
}

function expiresAt(): string {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

// MP4 صغير حقيقي كملف نتيجة (يُولَّد مرة واحدة) — للتحقق من content-type فقط
const dummyMp4 = new Uint8Array(1024 * 64).fill(0);

const server = Bun.serve({
  port: 9910,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/api/config") {
      return Response.json({
        maxVideos: 10,
        maxSourceSizeMb: 200,
        maxOutputSizeMb: 150,
        maxTotalDurationSec: 600,
        retentionHours: 24,
        output: { format: "mp4", videoCodec: "h264", audioCodec: "aac", crf: 18, maxResolution: "1080p" },
      });
    }

    if (req.method === "POST" && path === "/api/jobs") {
      const body = (await req.json()) as { videos?: string[] };
      const videos = body.videos ?? [];
      if (videos.length > 10) return Response.json({ error: "Too many videos" }, { status: 400 });
      const id = makeJobId();
      jobs.set(id, { id, videos, status: "queued", progress: 0, createdAt: Date.now(), error: null, processed: false });
      return Response.json({
        jobId: id,
        status: "queued",
        statusUrl: `http://localhost:9910/api/jobs/${id}`,
        processUrl: `http://localhost:9910/api/jobs/${id}/process`,
        expiresAt: expiresAt(),
      });
    }

    const processMatch = path.match(/^\/api\/jobs\/([^/]+)\/process$/);
    if (req.method === "POST" && processMatch) {
      const job = jobs.get(processMatch[1]);
      if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
      // حاجبة ~8 ثوانٍ (الواقع 10–15)
      await new Promise((r) => setTimeout(r, 8000));
      if (job.videos.some((v) => v.includes("fail"))) {
        job.status = "failed";
        job.error = "Download failed (HTTP 403)";
        return Response.json({ error: job.error }, { status: 500 });
      }
      job.status = "done";
      job.progress = 100;
      job.processed = true;
      return Response.json({
        status: "done",
        videoUrl: `http://localhost:9910/${job.id}/video`,
        downloadUrl: `http://localhost:9910/api/jobs/${job.id}/video?download=1`,
        size: 1_234_567,
        duration: 30.2,
        resolution: "640x360",
        expiresAt: expiresAt(),
      });
    }

    if (req.method === "GET" && path.startsWith("/api/jobs/")) {
      const id = path.split("/")[3] ?? "";
      const job = jobs.get(id);
      if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
      if (job.status !== "done" && job.status !== "failed" && !job.processed) {
        // نحاكي التقدم — أحيانًا كسر 0..1 (التحليل الدفاعي في العميل يجب أن يضربه في 100)
        const fraction = Math.random() < 0.5;
        job.progress = Math.min(95, job.progress + 15);
        const p = fraction ? job.progress / 100 : job.progress;
        return Response.json({
          status: job.status,
          progress: p,
          videos: job.videos, // حقل إضافي للتحقق من الترتيب في الاختبارات
        });
      }
      return Response.json({
        status: job.status,
        progress: job.progress,
        ...(job.status === "done"
          ? {
              videoUrl: `http://localhost:9910/${job.id}/video`,
              downloadUrl: `http://localhost:9910/api/jobs/${job.id}/video?download=1`,
            }
          : {}),
        ...(job.error ? { error: job.error } : {}),
        videos: job.videos,
      });
    }

    if (req.method === "GET" && path.endsWith("/video")) {
      return new Response(dummyMp4, {
        headers: { "Content-Type": "video/mp4", "Content-Length": String(dummyMp4.length) },
      });
    }

    if (req.method === "DELETE" && path.startsWith("/api/jobs/")) {
      const id = path.split("/")[3] ?? "";
      jobs.delete(id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log("Mock Video Merger API v2 يعمل على http://localhost:9910");
