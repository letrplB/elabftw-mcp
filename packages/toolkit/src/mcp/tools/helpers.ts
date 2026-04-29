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
  .describe(
    'elabftw entity kind. `experiments` = lab notebook entries (runs/notes). ' +
      '`items` = typed inventory (chemicals, samples, equipment). ' +
      '`experiments_templates` = reusable experiment templates. ' +
      '`items_types` = category schemas for items.'
  );

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
    const detail =
      'statusCode' in (e as ElabftwApiError)
        ? `${(e as ElabftwApiError).statusCode} ${e.message}${(e as ElabftwApiError).body ? `\n${(e as ElabftwApiError).body}` : ''}`
        : e.message;
    return errorText(detail);
  }
}

export function writeDisabledResponse(): TextResponse {
  return errorText(
    'Write tools are disabled. Set ELABFTW_ALLOW_WRITES=true to enable create / update / delete, and ELABFTW_ALLOW_DESTRUCTIVE=true to enable lock / sign / timestamp / bloxberg.'
  );
}
