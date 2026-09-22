import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { LangfuseBatch, buildSpan, langfuseConfig, langfuseEnabled } from './langfuse';
import { spanIdForKey, traceIdForKey } from '../../agent/model/trace';

const KEYS = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_BASE_URL: 'https://jp.cloud.langfuse.com/',
};

function withKeys(extra: Record<string, string> = {}) {
  Object.assign(process.env, KEYS, extra);
}

function withoutKeys() {
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  delete process.env.LANGFUSE_ENVIRONMENT;
}

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  jest.restoreAllMocks();
});

describe('configuration', () => {
  test('is off when either key is missing', () => {
    withoutKeys();
    expect(langfuseEnabled()).toBe(false);
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    expect(langfuseEnabled()).toBe(false);
  });

  test('is on with both keys, and trims the base URL', () => {
    withKeys();
    const config = langfuseConfig();
    expect(config?.baseUrl).toBe('https://jp.cloud.langfuse.com');
    expect(config?.environment).toBe('default');
  });
});

describe('ids', () => {
  test('a trace id is 32 hex chars and depends only on the key', async () => {
    const a = await traceIdForKey('conversation:w1:c1');
    const b = await traceIdForKey('conversation:w1:c1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
  });

  // The whole cross-process scheme rests on this: separate action invocations reach the same
  // trace id with nothing shared but the conversation id.
  test('different conversations get different traces', async () => {
    expect(await traceIdForKey('conversation:w1:c1')).not.toBe(
      await traceIdForKey('conversation:w1:c2'),
    );
  });

  test('a span id is 16 hex chars and is not a prefix of its trace id', async () => {
    const traceId = await traceIdForKey('conversation:w1:c1');
    const spanId = await spanIdForKey('conversation:w1:c1');
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId.startsWith(spanId)).toBe(false);
  });
});

describe('span construction', () => {
  const attributes = (span: ReturnType<typeof buildSpan>) =>
    Object.fromEntries(
      span.attributes.map((a) => [a.key, 'stringValue' in a.value ? a.value.stringValue : a.value]),
    );

  test('carries the full messages array as input', () => {
    withKeys();
    const messages = [
      { role: 'system', content: 'You are Alice.' },
      { role: 'user', content: 'Bob to Alice: hello' },
    ];
    const span = buildSpan(
      langfuseConfig()!,
      { traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16) },
      {
        name: 'conversation.start',
        type: 'generation',
        startTime: 1_000,
        endTime: 2_000,
        input: messages,
        output: 'Hi Bob!',
        model: 'gpt-test',
        usage: { input: 10, output: 3, total: 13 },
      },
    );
    const attrs = attributes(span);
    expect(span.parentSpanId).toBe('b'.repeat(16));
    expect(span.startTimeUnixNano).toBe('1000000000');
    expect(attrs['langfuse.observation.type']).toBe('generation');
    // The system prompt has to survive into the span, not just the user turn.
    expect(JSON.parse(attrs['langfuse.observation.input'] as string)).toEqual(messages);
    expect(attrs['langfuse.observation.output']).toBe('Hi Bob!');
    expect(JSON.parse(attrs['langfuse.observation.usage_details'] as string)).toEqual({
      input: 10,
      output: 3,
      total: 13,
    });
  });

  test('a root span has no parent', () => {
    withKeys();
    const span = buildSpan(
      langfuseConfig()!,
      { traceId: 'a'.repeat(32), traceName: 'Alice ↔ Bob' },
      { name: 'conversation', startTime: 0, endTime: 1 },
    );
    expect(span.parentSpanId).toBeUndefined();
    expect(attributes(span)['langfuse.trace.name']).toBe('Alice ↔ Bob');
  });

  test('metadata is flattened into per-key attributes', () => {
    withKeys();
    const span = buildSpan(
      langfuseConfig()!,
      { traceId: 'a'.repeat(32) },
      {
        name: 'x',
        startTime: 0,
        endTime: 1,
        metadata: { retries: 2, speaker: 'Alice', dropped: undefined },
      },
    );
    const attrs = attributes(span);
    expect(attrs['langfuse.observation.metadata.retries']).toBe('2');
    expect(attrs['langfuse.observation.metadata.speaker']).toBe('Alice');
    expect(attrs).not.toHaveProperty('langfuse.observation.metadata.dropped');
  });

  test('an oversized attribute is truncated rather than sent whole', () => {
    withKeys({ LANGFUSE_MAX_ATTRIBUTE_CHARS: '50' });
    const span = buildSpan(
      langfuseConfig()!,
      { traceId: 'a'.repeat(32) },
      { name: 'x', startTime: 0, endTime: 1, output: 'z'.repeat(500) },
    );
    const value = attributes(span)['langfuse.observation.output'] as string;
    expect(value.length).toBeLessThan(500);
    expect(value).toContain('truncated');
  });
});

describe('batching', () => {
  test('collects nothing and sends nothing when the keys are unset', async () => {
    withoutKeys();
    const fetchMock = jest.spyOn(globalThis, 'fetch' as any);
    const batch = new LangfuseBatch();
    expect(batch.enabled).toBe(false);
    batch.add({ traceId: 'a'.repeat(32) }, { name: 'x', startTime: 0, endTime: 1 });
    await batch.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends every collected span in one authenticated request', async () => {
    withKeys();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch' as any)
      .mockResolvedValue({ ok: true, text: async () => '' } as any);
    const batch = new LangfuseBatch();
    batch.add({ traceId: 'a'.repeat(32) }, { name: 'turn.0', startTime: 0, endTime: 1 });
    batch.add({ traceId: 'a'.repeat(32) }, { name: 'turn.1', startTime: 1, endTime: 2 });
    await batch.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://jp.cloud.langfuse.com/api/public/otel/v1/traces');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic ' + btoa('pk-lf-test:sk-lf-test'));
    expect(headers['x-langfuse-ingestion-version']).toBe('4');
    const body = JSON.parse(init.body as string);
    expect(body.resourceSpans[0].scopeSpans[0].spans.map((s: any) => s.name)).toEqual([
      'turn.0',
      'turn.1',
    ]);
  });

  // The point of the whole module: a tracing failure must never reach the caller.
  test('a failing export is swallowed', async () => {
    withKeys();
    jest.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('network down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const batch = new LangfuseBatch();
    batch.add({ traceId: 'a'.repeat(32) }, { name: 'x', startTime: 0, endTime: 1 });
    await expect(batch.flush()).resolves.toBeUndefined();
  });

  test('a flushed batch does not resend on a second flush', async () => {
    withKeys();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch' as any)
      .mockResolvedValue({ ok: true, text: async () => '' } as any);
    const batch = new LangfuseBatch();
    batch.add({ traceId: 'a'.repeat(32) }, { name: 'x', startTime: 0, endTime: 1 });
    await batch.flush();
    await batch.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
