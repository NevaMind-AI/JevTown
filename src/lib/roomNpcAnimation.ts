export type RoomNpcAsset = {
  frames: Record<string, { x: number; y: number; w: number; h: number; anchor: number[] }>;
  animations: Record<string, { frames: string[]; duration: number; loop: boolean; label?: string }>;
};

export function roomNpcId(image?: string) {
  return image?.match(/^assets\/room-npcs\/([a-z0-9-]+)-idle\.png$/)?.[1];
}

export function roomNpcFrame(asset: RoomNpcAsset, group: string, time: number) {
  const animation = asset.animations[group];
  const index = Math.floor(Math.max(0, time) / animation.duration);
  return animation.frames[
    animation.loop ? index % animation.frames.length : Math.min(index, animation.frames.length - 1)
  ];
}

export async function loadRoomNpcAsset(
  id: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<RoomNpcAsset> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid NPC asset ID');
  const response = await fetch(`${baseUrl}assets/room-npcs/${id}.json`, { signal });
  if (!response.ok) throw new Error(`NPC metadata load failed: ${id}`);
  const asset: RoomNpcAsset = await response.json();
  for (const group of ['idle', 'talk', 'duty-1', 'duty-2']) {
    const animation = asset.animations?.[group];
    if (
      !animation ||
      !Array.isArray(animation.frames) ||
      !animation.frames.length ||
      !Number.isFinite(animation.duration) ||
      animation.duration <= 0 ||
      typeof animation.loop !== 'boolean' ||
      animation.frames.some((name) => !asset.frames?.[name])
    )
      throw new Error(`Invalid NPC animation: ${id}/${group}`);
  }
  for (const frame of Object.values(asset.frames)) {
    if (
      ![frame.x, frame.y, frame.w, frame.h].every(Number.isInteger) ||
      frame.x < 0 ||
      frame.y < 0 ||
      frame.w <= 0 ||
      frame.h <= 0 ||
      !Array.isArray(frame.anchor) ||
      frame.anchor.length !== 2 ||
      !frame.anchor.every(Number.isFinite)
    )
      throw new Error(`Invalid NPC frame: ${id}`);
  }
  return asset;
}
