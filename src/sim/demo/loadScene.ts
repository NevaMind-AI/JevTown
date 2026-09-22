import { loadPackage } from '../../../prototype/package';
import { Scene } from '../../../prototype/content';
import { contentPackage } from '../../lib/localMode';

/**
 * One scene out of the room content package.
 *
 * The whole package is loaded and validated, not just the scene asked for, and that is on
 * purpose: `loadContent` cross-checks portals against the scenes they name, so a single-scene
 * loader would either have to skip validation or reimplement it. Loading all twenty-six costs a
 * few hundred kilobytes once, and it means the demo stands on exactly the content `dev` runs.
 */
export async function loadScene(sceneId: string, signal?: AbortSignal): Promise<Scene> {
  const root = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/content/${contentPackage}/`;
  // Maps and animation sheets live under `src/content/`, not `public/`, so they are hashed
  // assets rather than fetched paths. Same glob `LocalGame` uses, one directory deeper.
  const bundled = import.meta.glob('../../content/*/{maps,animations}/*.json', {
    as: 'url',
    eager: true,
  });
  const read = async (path: string): Promise<unknown> => {
    const url = bundled[`../../content/${contentPackage}/${path}`] ?? root + path;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Content load failed: ${path}`);
    const parsed: unknown = JSON.parse(await response.text());
    return parsed;
  };
  const content = await loadPackage(await read('manifest.json'), read);
  const scene = content.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    throw new Error(`Scene "${sceneId}" is not in the ${contentPackage} package`);
  }
  return scene;
}
