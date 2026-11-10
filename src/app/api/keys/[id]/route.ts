/**
 * PATCH /api/keys/{id} — تعطيل/تنشيط يدوي {action: "disable" | "enable"}
 * DELETE /api/keys/{id} — حذف نهائي
 */
import { deleteKey, findKeyById, setKeyStatus } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { action?: string };
    if (body.action !== "disable" && body.action !== "enable") {
      return Response.json({ error: 'الإجراء غير صالح — المسموح: "disable" أو "enable"' }, { status: 400 });
    }
    const existing = await findKeyById(id);
    if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });

    await setKeyStatus(id, body.action === "disable" ? "disabled" : "active");
    const updated = await findKeyById(id);
    return Response.json({ key: publicKey(updated!) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { error: `تعذر تحديث المفتاح: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const ok = await deleteKey(id);
    if (!ok) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { error: `تعذر حذف المفتاح: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
