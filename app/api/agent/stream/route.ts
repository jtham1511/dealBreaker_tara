// export const runtime='edge';
// export const preferredRegion=['sin1','hkg1','bom1'];
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';

type ChatRequestBody = {
  message?: unknown;
};

const encoder = new TextEncoder();
const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function formatEvent(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  return `event: ${event}\ndata: ${payload}\n\n`;
}

function emitDataPayload(data: string, queue: (chunk: string) => void): boolean {
  if (!data) {
    return false;
  }

  if (data === '[DONE]') {
    queue(formatEvent('done', {}));
    return true;
  }

  try {
    const parsed = JSON.parse(data);
    const delta = parsed?.choices?.[0]?.delta?.content;
    if (delta) {
      queue(`data: ${JSON.stringify({ text: delta })}\n\n`);
      return false;
    }
  } catch {
    // fall through to emit raw text below
  }

  queue(`data: ${JSON.stringify({ text: data })}\n\n`);
  return false;
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const message =
    typeof body?.message === 'string' && body.message.trim().length > 0
      ? body.message.trim()
      : 'Hello';

  const requiredVars = ['OPENAI_API_KEY'] as const;

  const missing = requiredVars.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    const detail = `Missing required environment variable${
      missing.length > 1 ? 's' : ''
    }: ${missing.join(', ')}`;
    const payload = formatEvent('error', { detail }) + formatEvent('done', {});
    return new Response(payload, { status: 200, headers: sseHeaders });
  }

  try {
//    const endpoint = requiredEnv('AZURE_OPENAI_ENDPOINT');
//    const deployment = requiredEnv('AZURE_OPENAI_DEPLOYMENT');
//    const apiVersion = requiredEnv('AZURE_OPENAI_API_VERSION');
//    const apiKey = requiredEnv('AZURE_OPENAI_API_KEY');
    const apiKey = requiredEnv('OPENAI_API_KEY');
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

//    const url = new URL(`/openai/deployments/${deployment}/chat/completions`, endpoint);
//    url.searchParams.set('api-version', apiVersion);
//
//    const upstream = await fetch(url.toString(), {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
//        'api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant for a Singapore Government analysis portal.',
          },
          { role: 'user', content: message },
        ],
        temperature: 0.2,
        max_tokens: 600,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();
      return new Response(formatEvent('error', { detail: detail || 'Upstream error' }), {
        status: upstream.status || 502,
        headers: sseHeaders,
      });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const queue = (chunk: string) => controller.enqueue(encoder.encode(chunk));

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop() ?? '';

            for (const raw of parts) {
              const line = raw.trim();
              if (!line.startsWith('data:')) {
                continue;
              }

              const data = line.slice(5).trim();
              if (emitDataPayload(data, queue)) {
                controller.close();
                return;
              }
            }
          }

          const trailing = buffer.trim();
          if (trailing.startsWith('data:')) {
            const data = trailing.slice(5).trim();
            if (emitDataPayload(data, queue)) {
              controller.close();
              return;
            }
          }
          buffer = '';

          queue(formatEvent('done', {}));
        } catch (error) {
          queue(formatEvent('error', {
            detail: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          controller.close();
          }
        },
        async cancel() {
            await reader.cancel().catch(() => undefined);
        },
      });

      return new Response(stream, { headers: sseHeaders });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = detail.startsWith('Missing required environment variable') ? 500 : 502;

      return new Response(JSON.stringify({ error: 'Configuration error', detail }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

}
