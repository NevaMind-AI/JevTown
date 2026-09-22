import { getJevConfig, normalizeUsage } from './jev';

describe('normalizeUsage', () => {
  // The shape the API actually returns, from a live call.
  test('renames the fields and totals them', () => {
    expect(normalizeUsage({ input_tokens: 425, output_tokens: 73 })).toEqual({
      input: 425,
      output: 73,
      total: 498,
    });
  });

  test('is undefined for anything without token counts', () => {
    for (const usage of [undefined, null, {}, 'lots', { cost: 1 }]) {
      expect(normalizeUsage(usage)).toBeUndefined();
    }
  });
});

describe('getJevConfig', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  test('pins a version rather than following an alias', () => {
    delete process.env.JEV_MODEL;
    expect(getJevConfig().model).toBe('jev-1.13.0');
  });

  test('takes a gateway URL, without a trailing slash', () => {
    process.env.JEV_API_URL = 'https://nevatoken.com/';
    expect(getJevConfig().url).toBe('https://nevatoken.com');
  });
});
