/**
 * اختبار وحدة تصنيف أخطاء المزودين + سلوك مجمع المفاتيح التسلسلي (معيار القبول 7).
 * يشغَّل بـ: bun run scripts/test-classify.ts
 * يفحص:
 * 1) classifyProviderError — كل فئات جدول 4.2 (بما فيها نفاد الرصيد بحالة 400 و402).
 * 2) المفتاح المستنزف يبقى في القائمة والقاعدة دون عرقلة المفاتيح التالية.
 * 3) maskKey (الطويل والقصير).
 * 4) isKeyRelatedFailure لرسائل فشل منتصف المهمة.
 */
import {
  classifyProviderError,
  getKeyPool,
  isKeyRelatedFailure,
  maskKey,
} from "../src/lib/keys";
import { insertKey, setKeyStatus, deleteKey, findDuplicateKey } from "../src/lib/turso";

let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log("— 1) تصنيف الأخطاء (جدول 4.2) —");
assert(classifyProviderError(401, "Unauthorized") === "disabled", "401 → disabled");
assert(classifyProviderError(403, "Forbidden") === "disabled", "403 → disabled");
assert(classifyProviderError(400, "invalid api key provided") === "disabled", "رسالة invalid api key → disabled");
assert(classifyProviderError(402, "Payment Required") === "exhausted", "402 → exhausted");
assert(classifyProviderError(400, "insufficient balance") === "exhausted", "نفاد الرصيد بحالة 400 → exhausted (فحص الرسالة قبل الحالة)");
assert(classifyProviderError(500, "quota exceeded for this billing cycle") === "exhausted", "رسالة quota → exhausted");
assert(classifyProviderError(400, "out of credits, please 充值") === "exhausted", "رسالة 充值 → exhausted");
assert(classifyProviderError(404, "model not found") === "provider", "model not found مع 404 → provider");
assert(classifyProviderError(400, "unsupported model for this account") === "provider", "unsupported model مع 400 → provider");
assert(classifyProviderError(400, "prompt too long") === "params", "400 معطيات → params");
assert(classifyProviderError(422, "invalid aspect_ratio value") === "params", "422 معطيات → params");
assert(classifyProviderError(429, "rate limit exceeded") === "temporary", "429 → temporary");
assert(classifyProviderError(500, "internal server error") === "temporary", "500 → temporary");
assert(classifyProviderError(503, "تعذر الوصول إلى kie.ai: fetch failed") === "temporary", "انقطاع شبكة → temporary");

console.log("— 2) رسائل فشل منتصف المهمة (4.3.2) —");
assert(isKeyRelatedFailure("Task failed: insufficient balance"), "insufficient → متعلقة بمفتاح");
assert(isKeyRelatedFailure("error 402 from provider"), "402 في الرسالة → متعلقة بمفتاح");
assert(!isKeyRelatedFailure("content policy violation"), "سياسة المحتوى ليست متعلقة بمفتاح");

console.log("— 3) إخفاء المفاتيح —");
assert(maskKey("aaaabbbbccccddddeeeeffff00001111") === "aaaabbb••••••••1111", "المفتاح الطويل: أول 7 + نقاط + آخر 4");
assert(maskKey("shortkey1") === "sho••••", "المفتاح القصير: أول 3 + نقاط");

console.log("— 4) المجمع التسلسلي والمفتاح المستنزف (402) —");
const fakeId = crypto.randomUUID();
await insertKey({ id: fakeId, provider: "kie", apiKey: "fake_exhausted_key_for_test_0001", label: "اختبار مستنزف" });
await setKeyStatus(fakeId, "exhausted"); // محاكاة مفتاح رد 402 ويُعلَّم exhausted

const pool = await getKeyPool(["kie", "cometapi"]);
assert(pool.some((k) => k.id === fakeId), "المفتاح المستنزف يبقى في القائمة (لا يُستبعد)");
const realIdx = pool.findIndex((k) => k.apiKey === "aaaabbbbccccddddeeeeffff00001111");
const fakeIdx = pool.findIndex((k) => k.id === fakeId);
assert(realIdx !== -1 && fakeIdx !== -1, "المفتاح الحقيقي والمستنزف موجودان في المجمع");
assert(realIdx < fakeIdx, "الترتيب تسلسلي حسب الإضافة (الحقيقي الأقدم أولًا) — المستنزف لا يعرقل ما بعده");
assert(!pool.some((k) => k.status === "disabled"), "المفتاح المعطّل (disabled) هو الوحيد المستبعد");

await deleteKey(fakeId);
// اختبار كشف التكرار بمفتاح مؤقت مستقل (بدون أي مفاتيح حقيقية في الكود)
const dupId = crypto.randomUUID();
await insertKey({ id: dupId, provider: "kie", apiKey: "dup_probe_key_0000000000", label: "مؤقت" });
const dup = await findDuplicateKey("kie", "dup_probe_key_0000000000");
assert(!!dup, "كشف التكرار يعمل");
await deleteKey(dupId);

console.log(`\nالنتيجة: ${pass} ناجح، ${fail} فاشل`);
process.exit(fail === 0 ? 0 : 1);
