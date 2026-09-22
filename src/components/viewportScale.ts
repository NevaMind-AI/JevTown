export function viewportScale(
  screenWidth: number,
  screenHeight: number,
  worldWidth: number,
  worldHeight: number,
) {
  const minScale = Math.max(screenWidth / worldWidth, screenHeight / worldHeight);
  return { minScale, maxScale: Math.max(3, minScale) };
}
