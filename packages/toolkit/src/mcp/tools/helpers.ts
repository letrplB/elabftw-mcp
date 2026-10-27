import type { ElabftwApiError } from '../../client';
import { z } from 'zod';

export type TextResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Shared zod enum for the four entity kinds. Reused across every tool
 * that accepts an entity type.
 */
export const entityTypeSchema = z
  .enum(['experiments', 'items', 'experiments_templates', 'items_types'])
  .describe('Entity kind.');

export function text(body: string): TextResponse {
  return { content: [{ type: 'text', text: body }] };
}

export function errorText(message: string): TextResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Any tool handler can call through this — it converts ElabftwApiError and
 * generic errors into MCP text responses with `isError=true` instead of
 * crashing the MCP connection.
 */
export async function guard<T>(
  fn: () => Promise<T>,
  handler: (value: T) => TextResponse | Promise<TextResponse>
): Promise<TextResponse> {
  try {
    const value = await fn();
    return await handler(value);
  } catch (error) {
    const e = error as ElabftwApiError | Error;
    // Transport errors (timeout, redirect, network) carry statusCode 0 and
    // already say what happened.
    const api = e as ElabftwApiError;
    const status = 'statusCode' in api && api.statusCode ? `${api.statusCode} ` : '';
    const detail = `${status}${e.message}${api.body ? `\n${api.body}` : ''}`;
    return errorText(detail);
  }
}

const entityLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier call holding the same key has finished.
 * Tools that read, modify and re-write an entity's whole `metadata` blob
 * take this lock: models fire such calls in parallel, and without it the
 * last write silently drops the others' fields.
 */
export async function withEntityLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = entityLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  entityLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (entityLocks.get(key) === tail) entityLocks.delete(key);
  }
}
