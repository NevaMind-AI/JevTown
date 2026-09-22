import { requestStateUpdate } from './stateUpdate';
import { STATE_WORD_BUDGET } from '../../engine/prose/contract';

const GOOD_DOC = 'state: uneasy\n\nThe mill runs hot at night.\n\nShe means to ask the miller.';

function envelope(state?: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ state, reason: 'The conversation changed things.', ...extra });
}

const promise = (value: string) => Promise.resolve(value);

const TOO_LONG = `state: verbose\n\n${new Array(STATE_WORD_BUDGET + 50)
  .fill('word')
  .join(' ')}\n\nShe goes on.`;

describe('requestStateUpdate', () => {
  test('accepts a well-formed update without re-asking', async () => {
    const asks: (string | undefined)[] = [];
    const outcome = await requestStateUpdate({
      ask: (hint) => {
        asks.push(hint);
        return promise(envelope(GOOD_DOC));
      },
    });

    expect(asks).toEqual([undefined]);
    expect(outcome.reasks).toBe(0);
    expect(outcome.fellBack).toBe(false);
    expect(outcome.state).toBe(GOOD_DOC);
    expect(outcome.conformance).toMatchObject({ headState: 'matched', headStateToken: 'uneasy' });
  });

  test('re-asks once when the document is over budget, and accepts a shorter one', async () => {
    const hints: (string | undefined)[] = [];
    const outcome = await requestStateUpdate({
      ask: (hint) => {
        hints.push(hint);
        return promise(envelope(hints.length === 1 ? TOO_LONG : GOOD_DOC));
      },
    });

    expect(hints).toHaveLength(2);
    expect(hints[1]).toContain(`${STATE_WORD_BUDGET}-word limit`);
    expect(outcome.reasks).toBe(1);
    expect(outcome.fellBack).toBe(false);
    expect(outcome.state).toBe(GOOD_DOC);
    expect(outcome.conformance?.reasks).toBe(1);
  });

  test('keeps the previous document when the re-ask is still over budget', async () => {
    let calls = 0;
    const outcome = await requestStateUpdate({
      ask: () => {
        calls += 1;
        return promise(envelope(TOO_LONG));
      },
    });

    expect(calls).toBe(2);
    expect(outcome.fellBack).toBe(true);
    expect(outcome.state).toBeUndefined();
    expect(outcome.update.state).toBeUndefined();
    expect(outcome.conformance?.fellBack).toBe(true);
    expect(outcome.problems.join(' ')).toContain('still over');
  });

  test('length is the only thing worth re-asking over — structure is tolerated', async () => {
    let calls = 0;
    const outcome = await requestStateUpdate({
      ask: () => {
        calls += 1;
        return promise(envelope('she is fine i guess'));
      },
    });

    expect(calls).toBe(1);
    expect(outcome.fellBack).toBe(false);
    expect(outcome.state).toBe('she is fine i guess');
    expect(outcome.conformance).toMatchObject({
      headState: 'missing',
      headStateToken: undefined,
      blockCount: 1,
    });
  });

  test('an invented head-state is accepted and recorded', async () => {
    const outcome = await requestStateUpdate({
      ask: () => promise(envelope('state: absolutely livid\n\nShe is.\n\nShe will.')),
    });

    expect(outcome.conformance?.headState).toBe('matched');
    expect(outcome.state).toContain('absolutely livid');
  });

  test('an envelope with no state applies its memory without falling back', async () => {
    const outcome = await requestStateUpdate({
      ask: () =>
        promise(
          JSON.stringify({
            memory: ['I said nothing.'],
            reason: 'Nothing changed about her.',
          }),
        ),
    });

    expect(outcome.fellBack).toBe(false);
    expect(outcome.state).toBeUndefined();
    expect(outcome.update.memory).toEqual(['I said nothing.']);
  });

  test('a physics tag rides inside the document rather than beside it', async () => {
    const doc = 'state: open\n<unblocked/>\n\nThe bar is splintered.';
    const outcome = await requestStateUpdate({ ask: () => promise(envelope(doc)) });

    expect(outcome.state).toBe(doc);
    expect(outcome.document?.physicsTag).toBe('unblocked');
    expect(outcome.conformance?.physicsTag).toBe('unblocked');
  });

  test('a refusal with no JSON is recorded rather than thrown', async () => {
    const outcome = await requestStateUpdate({
      ask: () => promise('I would rather not.'),
    });

    expect(outcome.state).toBeUndefined();
    expect(outcome.problems.join(' ')).toContain('no JSON object found');
  });

  test('a document is carried through whole, with no attempt to split its body', async () => {
    const doc = 'state: open\n\nThe bar is splintered.\n\nThe hinges are bent.';
    const outcome = await requestStateUpdate({ ask: () => promise(envelope(doc)) });

    expect(outcome.state).toBe(doc);
    expect(outcome.document?.raw).toBe(doc);
    expect(outcome.conformance).toMatchObject({ headStateToken: 'open', blockCount: 3 });
  });

  test('honours a raised re-ask limit', async () => {
    let calls = 0;
    const outcome = await requestStateUpdate({
      reaskLimit: 3,
      ask: () => {
        calls += 1;
        return promise(envelope(calls <= 3 ? TOO_LONG : GOOD_DOC));
      },
    });

    expect(calls).toBe(4);
    expect(outcome.reasks).toBe(3);
    expect(outcome.fellBack).toBe(false);
  });
});
