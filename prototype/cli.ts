import { createInterface } from 'node:readline';
import { MemoryWorld } from './world.js';

const world = new MemoryWorld();
console.log('In-memory room 404. Commands: state, events, reset, advance <ms>, quit, or JSON:');
console.log('{"requestId":"1","type":"move","dx":1,"dy":0}');
console.log('{"requestId":"2","type":"interact","target":"n07"}');
const lines = createInterface({ input: process.stdin, output: process.stdout });
lines.on('line', (line) => {
  try {
    const text = line.trim();
    if (!text) return;
    if (text === 'quit') {
      lines.close();
      return;
    }
    if (text === 'reset') {
      world.reset();
      console.log('Reset.');
      return;
    }
    const result =
      text === 'state'
        ? world.inspect()
        : text === 'events'
          ? world.history()
          : text.startsWith('advance ')
            ? world.advance(Number(text.slice(8)))
            : world.execute(JSON.parse(text));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error((error as Error).message);
  }
});
