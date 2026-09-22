import { parseImportance } from './memory';

describe('parseImportance', () => {
  test('reads the bare digit the prompt asks for', () => {
    expect(parseImportance('7')).toBe(7);
  });

  test('tolerates whitespace the token budget now leaves room for', () => {
    expect(parseImportance('\n 3\n')).toBe(3);
  });

  test('digs the rating out of a short wrapper', () => {
    expect(parseImportance('**8**')).toBe(8);
    expect(parseImportance('Rating: 2')).toBe(2);
  });

  test('clamps an off-scale answer onto 0-9', () => {
    expect(parseImportance('10')).toBe(9);
  });

  test('falls back rather than trust the first number of an echoed prompt', () => {
    expect(parseImportance('On a scale of 0 to 9, I would rate this memory a 7.')).toBe(5);
  });

  test('falls back when there is no number at all', () => {
    expect(parseImportance('quite poignant')).toBe(5);
  });
});
