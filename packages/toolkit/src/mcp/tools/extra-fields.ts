/**
 * Helpers for the Phase-2 extra-fields tools.
 *
 * Mirrors the shape-construction + cleanup logic of the elabftw UI's
 * field-builder (`elabftw/src/ts/metadata.ts:281-344`) and `Metadata.class.ts`'s
 * `cleanupMetadata` (`elabftw/src/ts/Metadata.class.ts:138-168`).
 *
 * The functions here intentionally fail loud on per-type validation rather
 * than silently coercing — agents calling `elab_set_extra_field` benefit
 * from a clear error like "select requires options" more than from a field
 * that quietly lands in an unusable state.
 */

import type {
  ElabExtraFieldType,
  ElabExtraFieldValue,
  ElabMetadata,
} from '../../client/types';

export interface BuildExtraFieldArgs {
  type: ElabExtraFieldType;
  value?: string | number | boolean | string[] | null;
  options?: string[];
  unit?: string;
  units?: string[];
  description?: string;
  required?: boolean;
  readonly?: boolean;
  blank_value_on_duplicate?: boolean;
  allow_multi_values?: boolean;
  group_id?: number;
  position?: number;
}

export interface BuildExtraFieldOptions {
  /**
   * When true, build a sparse entry that includes ONLY explicitly-provided
   * properties — no defaulting of `value` to `''` / first option, no auto-
   * picking `unit = units[0]`. Used by `mode: 'merge'` so the subsequent
   * `{...existing, ...incoming}` merge preserves untouched properties.
   * Validations still run.
   */
  partial?: boolean;
}

/**
 * Construct an `ElabExtraFieldValue` from typed args. Validates per type and
 * throws on invalid combinations (caller catches and reports). Undefined
 * properties are dropped from the output so the metadata blob stays clean.
 *
 * Mirrors `metadata.ts:281-344` (the "save-new-field" handler in the UI's
 * field-builder modal).
 *
 * Pass `{partial: true}` for merge-mode callers: skips default-value
 * injection so unprovided keys stay absent in the result and `{...existing,
 * ...incoming}` merges preserve existing values.
 */
export function buildExtraFieldEntry(
  args: BuildExtraFieldArgs,
  options: BuildExtraFieldOptions = {}
): ElabExtraFieldValue {
  const entry: ElabExtraFieldValue = { type: args.type };
  const value = args.value;
  const valueProvided = value !== undefined;
  const partial = options.partial === true;

  switch (args.type) {
    case 'select':
    case 'radio': {
      // Options is required for replace mode; for partial mode it's required
      // only when the caller passed a value (to validate against).
      if (!args.options || args.options.length === 0) {
        if (!partial || valueProvided) {
          throw new Error(
            `extra field type \`${args.type}\` requires \`options\` (non-empty string array).`
          );
        }
      } else {
        entry.options = args.options;
      }
      if (valueProvided && value !== null && value !== '') {
        if (Array.isArray(value)) {
          if (args.options) {
            for (const v of value) {
              if (!args.options.includes(v)) {
                throw new Error(
                  `value \`${v}\` is not in \`options\` (${args.options.join(', ')}).`
                );
              }
            }
          }
          entry.value = value;
        } else {
          const s = String(value);
          if (args.options && !args.options.includes(s)) {
            throw new Error(
              `value \`${s}\` is not in \`options\` (${args.options.join(', ')}).`
            );
          }
          entry.value = s;
        }
      } else if (!partial && args.options) {
        // Replace-mode default: pre-select first option (UI behavior).
        entry.value = args.options[0];
      }
      break;
    }
    case 'number': {
      if (args.units && args.units.length > 0) {
        entry.units = args.units;
        entry.unit = args.unit ?? args.units[0];
      } else if (args.unit !== undefined) {
        entry.unit = args.unit;
      }
      if (valueProvided) {
        if (value === null || value === '') {
          entry.value = '';
        } else if (typeof value === 'number') {
          if (!Number.isFinite(value)) {
            throw new Error(`number value must be finite, got ${value}.`);
          }
          entry.value = String(value);
        } else if (typeof value === 'string') {
          if (value.trim() !== '' && Number.isNaN(Number(value))) {
            throw new Error(`number value \`${value}\` is not numeric.`);
          }
          entry.value = value;
        } else {
          throw new Error(`number value must be numeric or numeric-string, got ${typeof value}.`);
        }
      } else if (!partial) {
        entry.value = '';
      }
      break;
    }
    case 'checkbox': {
      if (valueProvided) {
        entry.value = coerceCheckboxValue(value);
      } else if (!partial) {
        entry.value = '';
      }
      break;
    }
    case 'experiments':
    case 'items':
    case 'users':
    case 'compounds': {
      if (valueProvided) {
        if (value === null || value === '') {
          entry.value = '';
        } else {
          const n =
            typeof value === 'number'
              ? value
              : typeof value === 'string'
                ? Number(value)
                : NaN;
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(
              `extra field type \`${args.type}\` requires a positive integer id as \`value\`, got ${JSON.stringify(value)}.`
            );
          }
          entry.value = String(n);
        }
      } else if (!partial) {
        entry.value = '';
      }
      break;
    }
    case 'date':
    case 'datetime-local':
    case 'time':
    case 'email':
    case 'url':
    case 'text':
    case 'uploads': {
      if (valueProvided) {
        if (value === null) {
          entry.value = '';
        } else if (Array.isArray(value)) {
          entry.value = value;
        } else {
          entry.value = String(value);
        }
      } else if (!partial) {
        entry.value = '';
      }
      break;
    }
    default: {
      if (valueProvided && value !== null) {
        entry.value = value;
      }
    }
  }

  if (args.description !== undefined) entry.description = args.description;
  if (args.required !== undefined) entry.required = args.required;
  if (args.readonly !== undefined) entry.readonly = args.readonly;
  if (args.blank_value_on_duplicate !== undefined)
    entry.blank_value_on_duplicate = args.blank_value_on_duplicate;
  if (args.allow_multi_values !== undefined)
    entry.allow_multi_values = args.allow_multi_values;
  if (args.group_id !== undefined && args.group_id !== -1)
    entry.group_id = args.group_id;
  if (args.position !== undefined) entry.position = args.position;

  return entry;
}

/**
 * Coerce a checkbox value to elabftw's wire format: `'on'` when truthy,
 * `''` (empty string) otherwise. Mirrors the UI at `metadata.ts:319-321`
 * which writes `'on'` or `''` to the metadata blob.
 */
export function coerceCheckboxValue(
  value: string | number | boolean | string[] | null | undefined
): 'on' | '' {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'on' : '';
  if (typeof value === 'number') return value ? 'on' : '';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'on' || v === 'true' || v === 'checked' || v === '1') return 'on';
    return '';
  }
  if (Array.isArray(value)) return value.length > 0 ? 'on' : '';
  return '';
}

/**
 * Merge two extra-field property objects. `incoming`'s defined keys win; the
 * existing entry's other keys are preserved. Used by `elab_set_extra_field`
 * `mode: 'merge'`.
 *
 * NOTE: this is shallow — we don't try to merge `options` arrays element-wise.
 * The caller passes the full replacement options/units list when they want
 * to change them.
 */
export function mergeExtraFieldEntry(
  existing: ElabExtraFieldValue,
  incoming: ElabExtraFieldValue
): ElabExtraFieldValue {
  return { ...existing, ...incoming };
}

/**
 * Cleanup mirror of `elabftw/src/ts/Metadata.class.ts:138-168`. Drops empty
 * `extra_fields`, prunes unreferenced `extra_fields_groups`, and removes an
 * empty `elabftw` namespace. Mutates the input and returns it.
 */
export function cleanupMetadata(metadata: ElabMetadata): ElabMetadata {
  // Drop empty extra_fields map.
  if (
    metadata.extra_fields &&
    Object.keys(metadata.extra_fields).length === 0
  ) {
    delete metadata.extra_fields;
  }
  // Clean extra_fields_groups.
  if (metadata.elabftw?.extra_fields_groups) {
    if (!metadata.extra_fields) {
      delete metadata.elabftw.extra_fields_groups;
    } else {
      const usedGroupIds = new Set<number>(
        Object.values(metadata.extra_fields)
          .map((f) => f.group_id)
          .filter((id): id is number => typeof id === 'number')
      );
      metadata.elabftw.extra_fields_groups =
        metadata.elabftw.extra_fields_groups.filter((g) => usedGroupIds.has(g.id));
      if (metadata.elabftw.extra_fields_groups.length === 0) {
        delete metadata.elabftw.extra_fields_groups;
      }
    }
  }
  // Remove empty elabftw namespace.
  if (metadata.elabftw && Object.keys(metadata.elabftw).length === 0) {
    delete metadata.elabftw;
  }
  return metadata;
}

/**
 * Deep merge two `ElabMetadata` objects. Used by `elab_clone_extra_fields_schema`:
 *   - For `extra_fields[name]`: source is the base, target's value wins per-field;
 *     other properties (type, options, unit, description, required, group_id, ...)
 *     in source fill any missing slots in the target.
 *   - For `extra_fields_groups`: union by `id` (target's name wins on conflict;
 *     groups only in source are appended).
 *   - Other top-level `elabftw.*` props: shallow-merge (target wins).
 *
 * Mirrors the UI's `lodash.merge` semantics used by "Load fields" at
 * `metadata.ts:250-260`, with one deliberate difference: when the *same*
 * extra-field exists in both, we keep the target's `value` (don't overwrite
 * user data with the source schema's default).
 */
export function mergeMetadataForClone(
  source: ElabMetadata,
  target: ElabMetadata
): ElabMetadata {
  const out: ElabMetadata = { ...source, ...target };

  // Deep-merge `elabftw` namespace.
  if (source.elabftw || target.elabftw) {
    const srcElab = source.elabftw ?? {};
    const tgtElab = target.elabftw ?? {};
    const mergedElab: NonNullable<ElabMetadata['elabftw']> = { ...srcElab, ...tgtElab };
    // Merge groups by id: union, target wins on name conflict.
    if (srcElab.extra_fields_groups || tgtElab.extra_fields_groups) {
      const byId = new Map<number, { id: number; name: string }>();
      for (const g of srcElab.extra_fields_groups ?? []) byId.set(g.id, g);
      for (const g of tgtElab.extra_fields_groups ?? []) byId.set(g.id, g);
      mergedElab.extra_fields_groups = [...byId.values()];
    }
    out.elabftw = mergedElab;
  }

  // Deep-merge extra_fields.
  if (source.extra_fields || target.extra_fields) {
    const merged: Record<string, ElabExtraFieldValue> = {};
    // Start with all source fields (they define the schema).
    for (const [k, v] of Object.entries(source.extra_fields ?? {})) {
      merged[k] = { ...v };
    }
    // Layer target on top: target's properties win per-key, with target's
    // `value` always preserved when present.
    for (const [k, v] of Object.entries(target.extra_fields ?? {})) {
      const base = merged[k] ?? {};
      merged[k] = { ...base, ...v };
    }
    out.extra_fields = merged;
  }

  return out;
}

/**
 * Strip default values from every extra_fields entry. Used when cloning a
 * schema with `blankValues=true` — matches the server-side behavior in
 * `elabftw/src/Elabftw/Metadata.php:130-153` which sets `value = ''`.
 */
export function blankExtraFieldValues(metadata: ElabMetadata): ElabMetadata {
  if (!metadata.extra_fields) return metadata;
  for (const k of Object.keys(metadata.extra_fields)) {
    const field = metadata.extra_fields[k];
    if (field) field.value = '';
  }
  return metadata;
}

/**
 * "this metadata blob is effectively empty" check — used by
 * `elab_remove_extra_field` to decide whether to PATCH `metadata: "null"`
 * (mirroring elabftw's no-metadata normalization) or to send a real JSON
 * payload.
 */
export function isMetadataEmpty(metadata: ElabMetadata): boolean {
  return Object.keys(metadata).length === 0;
}
