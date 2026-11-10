#!/usr/bin/env bash
# اختبار الدمج الشامل (معايير 8 و9) — يشغّل الخدمة المحاكية والاختبارات في نفس الجلسة
# لأن عمليات الخلفية لا تبقى حيّة بين أوامر الطرفية في هذه البيئة.
set -u
MOCK_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; }
trap cleanup EXIT

cd /home/z/my-project
bun /home/z/my-project/scripts/mock-merger.ts > /tmp/mock-merger.log 2>&1 &
MOCK_PID=$!
sleep 2
echo "=== MOCK READY? ==="
curl -s --max-time 5 http://127.0.0.1:9910/api/config > /dev/null && echo "mock up (pid $MOCK_PID)" || { echo "mock failed"; exit 1; }

mcp_call() { # $1 = id, $2 = json arguments
  curl -s -N --max-time 200 -X POST http://localhost:3000/mcp \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$1,\"method\":\"tools/call\",\"params\":{\"name\":\"merge_videos\",\"arguments\":$2}}"
}

echo; echo "=== (8) MERGE E2E — مقطعان عامان ==="
mcp_call 40 '{"urls":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}' > /tmp/merge-e2e.sse
FINAL=$(rg '^data:' /tmp/merge-e2e.sse | tail -1)
echo "$FINAL" | head -c 800
echo
echo "— إشعارات التقدم —"
rg -o 'جارٍ دمج المقاطع… [0-9]+%' /tmp/merge-e2e.sse | sort -t'…' -k2 -n -u | tr '\n' ' '; echo
MERGE_TASK=$(echo "$FINAL" | rg -o '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
RESULT_URL=$(echo "$FINAL" | rg -o 'https://[^"\\ ]+/video' | head -1)
if [ -n "$RESULT_URL" ]; then
  echo; echo "— التحقق من رابط النتيجة على نطاق خدمة الدمج —"
  curl -sI --max-time 10 "$RESULT_URL" | rg -i 'HTTP|content-type' | head -3
fi

echo; echo "=== (9-أ) مقطع واحد → رسالة عربية ==="
mcp_call 41 '{"urls":["https://www.w3schools.com/html/mov_bbb.mp4"]}' | rg '^data:' | tail -1 | rg -o '"text":"[^"]*"' | head -c 400
echo; echo "=== (9-ب) 11 مقاطع → رسالة عربية ==="
URLS=$(python3 -c "import json; print(json.dumps([f'https://example.com/clip{i}.mp4' for i in range(1,12)]))")
mcp_call 42 "{\"urls\":$URLS}" | rg '^data:' | tail -1 | rg -o '"text":"[^"]*"' | head -c 400
echo; echo "=== (9-ج) بدون معطيات → رسالة عربية ==="
mcp_call 43 '{}' | rg '^data:' | tail -1 | rg -o '"text":"[^"]*"' | head -c 400

echo; echo "=== (9-د) حل task_ids بالترتيب ==="
VIDEO_TASK="af3de05b-9818-424c-96bd-43e79b2c1b3b"   # مهمة فيديو مكتملة (القط)
IMAGE_TASK="c5c179d8-8835-4815-864b-60b19cca86eb"   # مهمة صورة مكتملة (الروبوت)
mcp_call 44 "{\"task_ids\":[\"$VIDEO_TASK\",\"$IMAGE_TASK\"],\"wait_seconds\":45}" > /tmp/merge-ids.sse
FINAL2=$(rg '^data:' /tmp/merge-ids.sse | tail -1)
echo "$FINAL2" | head -c 500
echo
MERGE_TASK2=$(echo "$FINAL2" | rg -o '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
if [ -n "$MERGE_TASK2" ]; then
  echo "— ترتيب المقاطع المستلمة لدى الخدمة (يجب أن يبدأ برابط القط ثم الروبوت) —"
  GET_JOB=$(curl -s --max-time 5 "http://127.0.0.1:9910/api/jobs/"$(rg -o '[0-9a-f]{11}' /tmp/mock-merger.log 2>/dev/null | tail -1))
  # نقرأ الترتيب من قاعدة المهام مباشرة عبر الحقل المخزن
  curl -s --max-time 10 "http://localhost:3000/api/tasks?limit=3" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for t in d['tasks']:
    if t['type']=='merge':
        print(t['id'][:8], '=>', (json.dumps(t.get('params',{}).get('requested',{}))[:120]))
"
fi

echo; echo "=== الشفاء الذاتي: مهمة الدمج العالقة من قبل ==="
curl -s -N --max-time 60 -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":45,"method":"tools/call","params":{"name":"get_task","arguments":{"task_id":"5b03ebb1-4672-4bbd-a93b-157790c66bb9"}}}' | rg '^data:' | tail -1 | rg -o '"text":"[^"]*"' | head -c 400
echo
