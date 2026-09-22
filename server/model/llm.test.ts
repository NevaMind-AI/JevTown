import { rejectsStop, truncateAtStopWords } from './llm';

describe('truncateAtStopWords', () => {
  test('leaves content alone when no stop word appears', () => {
    expect(truncateAtStopWords('Hello there!', ['Alice:', 'alice:'])).toBe('Hello there!');
  });

  test('cuts at the first stop word and drops it', () => {
    expect(truncateAtStopWords('Hi Bob! Bob: Hi back', ['Bob:', 'bob:'])).toBe('Hi Bob!');
  });

  test('uses the earliest of several stop words', () => {
    expect(truncateAtStopWords('one alice: two Bob: three', ['Bob:', 'alice:'])).toBe('one');
  });

  test('handles an empty stop word list', () => {
    expect(truncateAtStopWords('unchanged', [])).toBe('unchanged');
  });
});

describe('rejectsStop', () => {
  // The exact body that wedged `agentGenerateMessage`: a 400 here is fatal to the whole action,
  // so the message never reaches the `messages` table.
  const real =
    '{"error":{"message":"Bad request: Unsupported parameter: \'stop\' is not supported with ' +
    'this model.","type":"invalid_request_error","param":"","code":null}}';

  test('recognizes a gateway rejecting the stop parameter', () => {
    expect(rejectsStop(400, real)).toBe(true);
  });

  test('ignores unrelated 400s', () => {
    expect(rejectsStop(400, 'context length exceeded')).toBe(false);
  });

  test('ignores non-400 statuses', () => {
    expect(rejectsStop(500, real)).toBe(false);
  });
});
