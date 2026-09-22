import { AgentContext } from './ports';
import { fetchEmbeddingBatch } from './model/client';

/**
 * Embeddings are expensive and repeat constantly, so they are cached by a hash of their text.
 *
 * The cache itself is two `AgentStore` calls now rather than a Convex query and mutation. Hashes
 * travel as hex strings rather than `ArrayBuffer`s: a hash is a key, and a key that survives
 * JSON is a key that survives the batch protocol of docs/11 §4.3.
 */

export async function fetchEmbedding(ctx: AgentContext, text: string) {
  const result = await fetchEmbeddingsCached(ctx, [text]);
  return result.embeddings[0];
}

export async function fetchEmbeddingsCached(ctx: AgentContext, texts: string[]) {
  const start = Date.now();

  const textHashes = await Promise.all(texts.map((text) => hashText(text)));
  const results = new Array<number[]>(texts.length);
  const cacheResults = await ctx.store.cachedEmbeddings(textHashes);
  for (const { index, embedding } of cacheResults) {
    results[index] = embedding;
  }
  const toWrite = [];
  if (cacheResults.length < texts.length) {
    const missingIndexes = [...results.keys()].filter((i) => !results[i]);
    const missingTexts = missingIndexes.map((i) => texts[i]);
    const response = await fetchEmbeddingBatch(missingTexts);
    if (response.embeddings.length !== missingIndexes.length) {
      throw new Error(
        `Expected ${missingIndexes.length} embeddings, got ${response.embeddings.length}`,
      );
    }
    for (let i = 0; i < missingIndexes.length; i++) {
      const resultIndex = missingIndexes[i];
      toWrite.push({
        textHash: textHashes[resultIndex],
        embedding: response.embeddings[i],
      });
      results[resultIndex] = response.embeddings[i];
    }
  }
  if (toWrite.length > 0) {
    await ctx.store.cacheEmbeddings(toWrite);
  }
  return {
    embeddings: results,
    hits: cacheResults.length,
    ms: Date.now() - start,
  };
}

export async function hashText(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
