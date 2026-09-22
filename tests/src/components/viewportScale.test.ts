import { viewportScale } from '../../../src/components/viewportScale';

test('zoom limits cover both axes after fullscreen, panel changes and portrait resizing', () => {
  for (const [width, height] of [
    [800, 480],
    [2560, 1439],
    [2176, 1439],
    [480, 1000],
    [8000, 5000],
  ]) {
    const { minScale, maxScale } = viewportScale(width, height, 2048, 1536);
    expect(2048 * minScale).toBeGreaterThanOrEqual(width);
    expect(1536 * minScale).toBeGreaterThanOrEqual(height);
    expect(maxScale).toBeGreaterThanOrEqual(minScale);
  }
});
