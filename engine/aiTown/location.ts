import { Player } from './player';

export type Location = {
  // Unpacked player position.
  x: number;
  y: number;

  // Normalized facing vector.
  dx: number;
  dy: number;

  speed: number;
};

export function playerLocation(player: Player): Location {
  return {
    x: player.position.x,
    y: player.position.y,
    dx: player.facing.dx,
    dy: player.facing.dy,
    speed: player.speed,
  };
}
