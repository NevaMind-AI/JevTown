export type Visual = { image: string; size?: number[]; anchor?: number[]; offset?: number[] };

export function validateVisual(visual: Visual) {
  if (
    typeof visual.image !== 'string' ||
    visual.image.length > 200 ||
    !/^assets\/[a-z0-9-]+\/[a-z0-9-]+\.png$/.test(visual.image)
  )
    throw new Error('Invalid art image');
  for (const key of ['size', 'anchor', 'offset'] as const) {
    const pair = visual[key];
    if (pair === undefined) continue;
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite))
      throw new Error('Invalid visual ' + key);
    if (
      key === 'anchor'
        ? pair.some((n) => n < 0 || n > 1)
        : pair.some(
            (n) =>
              !Number.isInteger(n) || (key === 'size' ? n < 1 || n > 2048 : Math.abs(n) > 2048),
          )
    )
      throw new Error('Invalid visual ' + key);
  }
}

// Position is the anchor's location; offsets and size affect appearance, not collision.
export function visualPlacement(visual: Visual, position: number[], depth: number) {
  return {
    x: position[0] + (visual.offset?.[0] ?? 0),
    y: position[1] + (visual.offset?.[1] ?? 0),
    anchor: { x: visual.anchor?.[0] ?? 0, y: visual.anchor?.[1] ?? 0 },
    zIndex: depth,
    ...(visual.size ? { width: visual.size[0], height: visual.size[1] } : {}),
  };
}
