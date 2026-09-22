import { saveDirectory } from './localMode';
import {
  createReplay,
  restoreSnapshot,
  checkRecordingLink,
  Recording,
} from '../../prototype/replay';
import { parseCommand, Snapshot } from '../../prototype/world';
import { decodeRecording, encodeRecording } from './recordingStorage';

export type SaveHead = { revision: string; slot: number; sequence: number };
export type SaveSlot = {
  id: number;
  file: string;
  savedAt: number;
  start: number;
  end: number;
  scene: string;
  time: number;
  balance: number;
  bytes?: number;
  tasks?: { active: string[]; completed: string[] };
};
type Catalogue = { head: SaveHead; slots: SaveSlot[] };
const empty = (): Catalogue => ({ head: { revision: 'empty', slot: 0, sequence: 0 }, slots: [] });
const directory = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle(saveDirectory, {
    create: true,
  });
async function writeJson(dir: FileSystemDirectoryHandle, name: string, value: unknown) {
  const file = await dir.getFileHandle(name, { create: true }),
    writer = await file.createWritable();
  const text = JSON.stringify(value);
  try {
    await writer.write(text);
    await writer.close();
    return new Blob([text]).size;
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}
async function readJson(dir: FileSystemDirectoryHandle, name: string) {
  return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
}
const writeRecording = (dir: FileSystemDirectoryHandle, name: string, run: Recording) =>
  writeJson(dir, name, encodeRecording(run));
function match(actual: SaveHead, expected: SaveHead) {
  if (actual.revision !== expected.revision)
    throw new Error('存档已被另一页面更新，请重新打开存档列表并加载。');
}
function taskSummary(run: Recording) {
  const active: string[] = [],
    completed: string[] = [];
  for (const task of run.content.story.tasks ?? []) {
    const progress = run.finalState.tasks[task.id];
    if (!progress || (task.trigger && !progress.activated)) continue;
    (task.steps.every((step) => progress.completed.includes(step.id)) ? completed : active).push(
      task.title,
    );
  }
  return { active, completed };
}
function slotFor(run: Recording, id: number, start: number): SaveSlot {
  if (
    (run.startSequence ?? 0) !== start ||
    !run.eventCount ||
    run.events.length !== run.eventCount ||
    run.events.at(-1)?.sequence !== start + run.eventCount
  )
    throw new Error('存档记录不连续');
  return {
    id,
    file: `${crypto.randomUUID()}.json`,
    savedAt: Date.now(),
    start,
    end: start + run.eventCount,
    scene:
      run.content.scenes.find((s) => s.id === run.finalState.sceneId)?.name ??
      run.finalState.sceneId,
    time: run.finalState.time,
    balance: run.finalState.balance,
    tasks: taskSummary(run),
  };
}
// Build resume metadata for older local files and replay-validated imports without re-executing events.
function withSnapshot(
  run: Recording,
  previous: Snapshot['requests'] = [],
  initialState?: Recording['initialState'],
): Recording {
  const requests = new Map(previous),
    start = run.startSequence ?? 0;
  for (const [i, event] of run.events.entries()) {
    if (event.sequence !== start + i + 1) throw new Error('存档记录不连续');
    if (event.cause.type === 'advance') continue;
    const command = parseCommand(event.cause);
    if (requests.has(command.requestId)) throw new Error('存档包含重复请求');
    requests.set(command.requestId, {
      fingerprint: JSON.stringify(command),
      result: event.result,
      sequence: event.sequence,
    });
  }
  return {
    ...run,
    initialState:
      run.initialState ??
      initialState ??
      (start === 0 ? createReplay(run).world.recordedState() : undefined),
    snapshot: {
      format: 'memory-world-snapshot-1',
      sequence: start + run.eventCount,
      requests: [...requests],
    },
  };
}
function validate(data: Catalogue) {
  if (!data?.head || typeof data.head.revision !== 'string' || !Array.isArray(data.slots))
    throw new Error('存档目录损坏');
  let end = 0;
  for (const [i, slot] of data.slots.entries()) {
    if (
      slot.id !== i + 1 ||
      slot.start !== end ||
      !Number.isSafeInteger(slot.end) ||
      slot.end <= end ||
      !/^[a-f0-9-]+\.json$/.test(slot.file)
    )
      throw new Error('存档目录不连续');
    end = slot.end;
  }
  if (data.head.slot !== data.slots.length || data.head.sequence !== end)
    throw new Error('存档目录位置不一致');
  return data;
}
async function readCatalogue(dir: FileSystemDirectoryHandle): Promise<Catalogue> {
  try {
    return validate(await readJson(dir, 'manifest.json'));
  } catch (error) {
    if ((error as DOMException).name !== 'NotFoundError') throw error;
  }
  const data = empty();
  try {
    await writeJson(dir, 'manifest.json', validate(data));
  } catch (error) {
    await dir.removeEntry('manifest.json').catch(() => {});
    throw error;
  }
  return data;
}
// The manifest is published last via close()'s atomic replacement; readers/writers share this lock.
const access = <T>(work: (dir: FileSystemDirectoryHandle, data: Catalogue) => Promise<T>) =>
  navigator.locks.request(saveDirectory, async () => {
    const dir = await directory();
    return work(dir, await readCatalogue(dir));
  });
export const catalogue = (details = false) =>
  access(async (dir, data) => {
    if (details) {
      let changed = false;
      for (const slot of data.slots) {
        if (slot.bytes !== undefined && slot.tasks) continue;
        const file = await (await dir.getFileHandle(slot.file)).getFile();
        slot.tasks = taskSummary(JSON.parse(await file.text()));
        slot.bytes = file.size;
        changed = true;
      }
      if (changed) await writeJson(dir, 'manifest.json', data);
    }
    return data;
  });
const readChunk = (id: number, expected: SaveHead) =>
  access(async (dir, data) => {
    match(data.head, expected);
    const slot = data.slots.find((s) => s.id === id);
    if (!slot) throw new Error(`存档 ${id} 的记录缺失`);
    return decodeRecording(await readJson(dir, slot.file));
  });
const checkPredecessor = (id: number, expected: SaveHead, run: Recording) =>
  access(async (dir, data) => {
    match(data.head, expected);
    if (id > 1 && run.initialState)
      checkRecordingLink(await readJson(dir, data.slots[id - 2].file), run);
  });
async function publish(dir: FileSystemDirectoryHandle, old: Catalogue, slots: SaveSlot[]) {
  const next = {
    head: { revision: crypto.randomUUID(), slot: slots.length, sequence: slots.at(-1)?.end ?? 0 },
    slots,
  };
  await writeJson(dir, 'manifest.json', next);
  const kept = new Set(slots.map((s) => s.file));
  // Unreferenced files cannot reappear as slots, even if physical cleanup is interrupted.
  for (const slot of old.slots)
    if (!kept.has(slot.file)) await dir.removeEntry(slot.file).catch(() => {});
  return next.head;
}
export function saveChunk(run: Recording, expected: SaveHead) {
  return access(async (dir, data) => {
    match(data.head, expected);
    const slot = slotFor(run, expected.slot + 1, expected.sequence);
    const previous = data.slots.at(-1);
    if (previous) checkRecordingLink(await readJson(dir, previous.file), run);
    try {
      slot.bytes = await writeRecording(dir, slot.file, run);
      return await publish(dir, data, [...data.slots, slot]);
    } catch (error) {
      await dir.removeEntry(slot.file).catch(() => {});
      throw error;
    }
  });
}
async function readSnapshot(
  id: number,
  expected: SaveHead,
  progress: (text: string) => void = () => {},
) {
  const before = await catalogue();
  match(before.head, expected);
  if (!Number.isInteger(id) || id < 1 || id > before.head.slot) throw new Error('存档槽位不存在');
  let run = await readChunk(id, expected);
  const upgrade = !run.snapshot;
  const checkPosition = (chunk: Recording, slot: number) => {
    const metadata = before.slots[slot - 1];
    if (
      metadata.start !== (chunk.startSequence ?? 0) ||
      metadata.end !== metadata.start + chunk.eventCount
    )
      throw new Error('存档索引与记录不一致');
  };
  checkPosition(run, id);
  await checkPredecessor(id, expected, run);
  if (upgrade) {
    let requests: Snapshot['requests'] = [];
    let previous: Recording | undefined;
    for (let slot = 1; slot <= id; slot++) {
      const chunk = slot === id ? run : await readChunk(slot, expected);
      checkPosition(chunk, slot);
      const upgraded = withSnapshot(chunk, requests, previous?.finalState);
      if (previous) checkRecordingLink(previous, upgraded);
      requests = upgraded.snapshot!.requests;
      previous = upgraded;
      progress(`正在补齐旧存档信息 ${slot}/${id}`);
    }
    run = previous!;
  }
  progress('正在恢复存档快照');
  const world = restoreSnapshot(run);
  if (upgrade)
    await access(async (dir, data) => {
      match(data.head, expected);
      const slot = data.slots[id - 1];
      slot.bytes = await writeRecording(dir, slot.file, run);
      slot.tasks = taskSummary(run);
      await writeJson(dir, 'manifest.json', data);
    });
  return { run, world };
}
export async function restoreSlot(
  id: number,
  expected: SaveHead,
  progress: (text: string) => void = () => {},
) {
  const { world } = await readSnapshot(id, expected, progress);
  const next = await access(async (dir, data) => {
    match(data.head, expected);
    if (data.slots[id - 1]?.end !== world.recordingStats().end)
      throw new Error('存档索引与恢复位置不一致');
    return publish(dir, data, data.slots.slice(0, id));
  });
  return { world, head: next };
}
export type SavePlayback = {
  id: number;
  head: SaveHead;
  slots: SaveSlot[];
  replay: ReturnType<typeof createReplay>;
};
export async function playSlot(
  id: number,
  expected: SaveHead,
  progress: (text: string) => void = () => {},
): Promise<SavePlayback> {
  const before = await catalogue();
  match(before.head, expected);
  if (!Number.isInteger(id) || id < 1 || id > before.slots.length)
    throw new Error('存档槽位不存在');
  const run = await readChunk(id, expected),
    slot = before.slots[id - 1];
  const origin =
    id > 1 && !run.initialState ? (await readSnapshot(id - 1, expected, progress)).run : undefined;
  if (slot.start !== (run.startSequence ?? 0) || slot.end !== slot.start + run.eventCount)
    throw new Error('存档索引与记录不一致');
  await checkPredecessor(id, expected, run);
  const replay = createReplay(run, origin);
  return { id, head: before.head, slots: before.slots, replay };
}
export async function continuePlayback(playback: SavePlayback) {
  const { id, head, replay } = playback,
    stats = replay.world.recordingStats();
  const next = await access(async (dir, data) => {
    match(data.head, head);
    const slot = data.slots[id - 1];
    if (
      !slot ||
      stats.startSequence !== slot.start ||
      stats.end !== replay.index ||
      replay.total !== slot.end ||
      replay.index < slot.start ||
      replay.index > slot.end
    )
      throw new Error('回放位置与存档不一致');
    return publish(dir, data, data.slots.slice(0, replay.index === slot.end ? id : id - 1));
  });
  const world = replay.continueGame();
  world.releaseRecording(next.sequence);
  return { world, head: next };
}
export function replaceTimeline(chunks: Recording[], expected: SaveHead) {
  return access(async (dir, data) => {
    match(data.head, expected);
    const slots: SaveSlot[] = [];
    let requests: Snapshot['requests'] = [];
    let previous: Recording | undefined;
    try {
      for (const recording of chunks) {
        if (!recording.eventCount) continue;
        const run = withSnapshot(recording, requests, previous?.finalState),
          slot = slotFor(run, slots.length + 1, slots.at(-1)?.end ?? 0);
        if (previous) checkRecordingLink(previous, run);
        requests = run.snapshot!.requests;
        previous = run;
        slots.push(slot);
        slot.bytes = await writeRecording(dir, slot.file, run);
      }
      return await publish(dir, data, slots);
    } catch (error) {
      for (const slot of slots) await dir.removeEntry(slot.file).catch(() => {});
      throw error;
    }
  });
}
