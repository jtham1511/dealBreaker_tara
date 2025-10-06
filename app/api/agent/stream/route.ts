export const runtime = 'nodejs';

import { NextRequest } from 'next/server';

import { CONTRACT_CONTEXT } from '../context';

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
    const choice = Array.isArray(parsed?.choices)
      ? parsed.choices[0]
      : undefined;
    const delta = choice?.delta;

    if (delta) {
      const segments: string[] = [];

      const collect = (value: unknown) => {
        if (typeof value === 'string' && value.length > 0) {
          segments.push(value);
        }
      };

      if (typeof delta.content === 'string' || Array.isArray(delta.content)) {
        const content = delta.content;
        if (typeof content === 'string') {
          collect(content);
        } else {
          for (const part of content) {
            if (typeof part === 'string') {
              collect(part);
            } else if (part && typeof part === 'object') {
              const maybeText =
                'text' in part && typeof part.text === 'string'
                  ? part.text
                  : undefined;
              if (maybeText) {
                collect(maybeText);
              }
            }
          }
        }
      }

      if (typeof delta.content === 'undefined' && Array.isArray(delta?.messages)) {
        for (const message of delta.messages) {
          if (message && typeof message === 'object') {
            const maybeText =
              'content' in message && typeof message.content === 'string'
                ? message.content
                : undefined;
            if (maybeText) {
              collect(maybeText);
            }
          }
        }
      }

      if (Array.isArray(delta.reasoning)) {
        for (const step of delta.reasoning) {
          if (step && typeof step === 'object') {
            const maybeText =
              'text' in step && typeof step.text === 'string' ? step.text : undefined;
            if (maybeText) {
              collect(maybeText);
            }
          }
        }
      }

      if (segments.length > 0) {
        queue(`data: ${JSON.stringify({ text: segments.join('') })}\n\n`);
        return false;
      }
    }

    const messageContent = choice?.message?.content;
    if (typeof messageContent === 'string' && messageContent.length > 0) {
      queue(`data: ${JSON.stringify({ text: messageContent })}\n\n`);
      return false;
    }

    return false;
  } catch {
    // Fall back to raw emission below when parsing fails.
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
    const apiKey = requiredEnv('OPENAI_API_KEY');
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are the embedded analyst for the Singapore Government Gartner contract evaluation portal. Respond with confident, data-backed insights from the provided context. Avoid asking the user to clarify what the Gartner contract is—assume they are referring to this dataset unless they specify otherwise. When data gaps exist, note them succinctly while still giving actionable guidance.',
          },
          { role: 'system', content: `Contract intelligence summary:\n${CONTRACT_CONTEXT}` },
          { role: 'user', content: message },
        ],
        temperature: 0.2,
        max_tokens: 600,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();
      const payload =
        formatEvent('error', { detail: detail || 'Upstream error' }) +
        formatEvent('done', {});
      return new Response(payload, {
        status: 200,
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
    const payload = formatEvent('error', { detail }) + formatEvent('done', {});

    return new Response(payload, {
      status: 200,
      headers: sseHeaders,
    });
  }
}
