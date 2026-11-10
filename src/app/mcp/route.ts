/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفة MCP.
 * استخدم SDK الرسمي فقط: McpServer + WebStandardStreamableHTTPServerTransport
 * (النسخة 1.32 من SDK تعمل بـ Web Request/Response مباشرة — الأنسب لمسار App Router).
 *
 * قرار معماري مهم: الوضع عديم الجلسة (stateless — sessionIdGenerator: undefined)
 * لأن Vercel serverless لا يضمن ذاكرة مشتركة بين النسخ؛ جلسة في الذاكرة ستنكسر بين
 * الطلبات. هذا الوضع معتمد رسميًا في مواصفة MCP ويدعمه كل العملاء (ChatGPT/Claude/
 * Cursor/…)، وإشعارات التقدم تعمل كاملة داخل نفس نداء POST عبر بث SSE.
 *
 * الحماية: إذا ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerMediaTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// أقصى مدة للسيرفرلس — تسمح بنافذة الانتظار + بث SSE قبل أن يتابع العميل بـ get_task
export const maxDuration = 300;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, mcp-session-id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-session-id",
};

function withCors(headers: Headers): Headers {
  const merged = new Headers(headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) merged.set(k, v);
  return merged;
}

function checkAccessToken(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true; // بلا توكن — الوصول مفتوح
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function handleMcpRequest(req: Request): Promise<Response> {
  if (!checkAccessToken(req)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: يلزم تمرير Authorization: Bearer <MCP_ACCESS_TOKEN>" },
        id: null,
      },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  // كل طلب ينشئ نسخة نقل/خادم مستقلة (stateless) — انظر القرار المعماري أعلاه
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerMediaTools(server);
  await server.connect(transport);

  try {
    const inner = await transport.handleRequest(req);

    // بلا جسم (مثل 202 للإشعارات) — أغلق النقل فورًا
    if (!inner.body) {
      void transport.close().catch(() => {});
      return new Response(null, { status: inner.status, headers: withCors(inner.headers) });
    }

    // غلاف البث: يضمن إغلاق النقل/الخادم بعد انتهاء البث أو قطع العميل
    // (تنظيف مؤقتات keep-alive ومنع التسريب بين الطلبات)
    const reader = inner.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            void transport.close().catch(() => {});
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          void transport.close().catch(() => {});
          controller.error(err);
        }
      },
      cancel(reason) {
        void transport.close().catch(() => {});
        return reader.cancel(reason);
      },
    });

    return new Response(stream, { status: inner.status, headers: withCors(inner.headers) });
  } catch (err) {
    void transport.close().catch(() => {});
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: `خطأ في معالجة الطلب: ${err instanceof Error ? err.message : String(err)}` },
        id: null,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
