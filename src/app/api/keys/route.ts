/**
 * إدارة المفاتيح للواجهة:
 * - GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد المفتاح الكامل أبدًا.
 * - POST /api/keys — إضافة مفتاح مع رفض التكرار لنفس المزود.
 */
import { randomUUID } from "node:crypto";
import { findDuplicateKey, insertKey, listKeys } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["kie", "cometapi"] as const;

export async function GET(): Promise<Response> {
  try {
    const keys = await listKeys();
    return Response.json({ keys: keys.map(publicKey) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { error: `تعذر جلب المفاتيح: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = (body.provider ?? "").trim();
    const apiKey = (body.api_key ?? "").trim();
    const label = (body.label ?? "").trim();

    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return Response.json({ error: "المزود غير صالح — المسموح: kie أو cometapi" }, { status: 400 });
    }
    if (apiKey.length < 8) {
      return Response.json({ error: "المفتاح قصير جدًا — أدخل مفتاح API صالحًا" }, { status: 400 });
    }

    const duplicate = await findDuplicateKey(provider, apiKey);
    if (duplicate) {
      return Response.json(
        { error: "هذا المفتاح مُضاف مسبقًا لنفس المزود — لا يجوز التكرار" },
        { status: 409 },
      );
    }

    const id = randomUUID();
    await insertKey({ id, provider, apiKey, label });
    const keys = await listKeys();
    const added = keys.find((k) => k.id === id)!;
    return Response.json({ key: publicKey(added) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { error: `تعذرت إضافة المفتاح: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
