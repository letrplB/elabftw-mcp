/**
 * Helpers for the extra-fields tools.
 *
 * Mirrors the shape-construction and cleanup logic of the elabftw UI's
 * field builder (`metadata.ts`) and `Metadata.class.ts` `cleanupMetadata`.
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
  /**
   * The field as it currently exists. In partial mode its `options` are
   * used to validate a new `select` / `radio` value.
   */
  existing?: ElabExtraFieldValue;
}

/**
 * Construct an `ElabExtraFieldValue` from typed args. Validates per type and
 * throws on invalid combinations (caller catches and reports). Undefined
 * properties are dropped from the output so the metadata blob stays clean.
 *
 * Mirrors the "save new field" handler of the UI's field-builder modal.
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
      // Replace mode needs options; partial mode needs them (given or
      // already on the field) only to validate a new value.
      const choices = args.options?.length
        ? args.options
        : partial
          ? options.existing?.options
          : undefined;
      if (args.options?.length) entry.options = args.options;
      if (!choices?.length && (!partial || valueProvided)) {
        throw new Error(
          `extra field type \`${args.type}\` requires \`options\` (non-empty string array).`
        );
      }
      if (valueProvided && value !== null && value !== '') {
        const values = Array.isArray(value) ? value : [String(value)];
        for (const v of values) {
          if (choices && !choices.includes(v)) {
            throw new Error(
              `value \`${v}\` is not in \`options\` (${choices.join(', ')}).`
            );
          }
        }
        entry.value = Array.isArray(value) ? value : String(value);
      } else if (!partial && choices) {
        // Replace-mode default: pre-select the first option, like the UI.
        entry.value = choices[0];
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
 * `''` otherwise, as the UI writes it.
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
 * Mirror of the UI's `Metadata.cleanupMetadata`: drops empty
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
 * Deep merge two `ElabMetadata` objects; `source` is the base.
 *   - `extra_fields`: with `keep: 'all'` (default) the target's field
 *     properties win wholesale — used when a caller's metadata is layered
 *     onto a template. With `keep: 'value'` the source defines the schema
 *     (type, options, units, group, …) and only the target's `value`
 *     survives — used to re-apply a template schema onto an entity.
 *   - `extra_fields_groups`: union by `id`, target's name wins.
 *   - Other `elabftw.*` props: shallow merge, target wins.
 */
export function mergeMetadataForClone(
  source: ElabMetadata,
  target: ElabMetadata,
  { keep = 'all' }: { keep?: 'all' | 'value' } = {}
): ElabMetadata {
  const out: ElabMetadata = { ...source, ...target };

  if (source.elabftw || target.elabftw) {
    const srcElab = source.elabftw ?? {};
    const tgtElab = target.elabftw ?? {};
    const mergedElab: NonNullable<ElabMetadata['elabftw']> = { ...srcElab, ...tgtElab };
    if (srcElab.extra_fields_groups || tgtElab.extra_fields_groups) {
      const byId = new Map<number, { id: number; name: string }>();
      for (const g of srcElab.extra_fields_groups ?? []) byId.set(g.id, g);
      for (const g of tgtElab.extra_fields_groups ?? []) byId.set(g.id, g);
      mergedElab.extra_fields_groups = [...byId.values()];
    }
    out.elabftw = mergedElab;
  }

  if (source.extra_fields || target.extra_fields) {
    const merged: Record<string, ElabExtraFieldValue> = {};
    for (const [k, v] of Object.entries(source.extra_fields ?? {})) {
      merged[k] = { ...v };
    }
    for (const [k, v] of Object.entries(target.extra_fields ?? {})) {
      const base = merged[k];
      merged[k] =
        base && keep === 'value'
          ? { ...base, ...(v.value !== undefined ? { value: v.value } : {}) }
          : { ...base, ...v };
    }
    out.extra_fields = merged;
  }

  return out;
}

/**
 * Strip default values from every extra_fields entry (mutates). Used when
 * cloning a schema with `blankValues=true`.
 */
export function blankExtraFieldValues(metadata: ElabMetadata): ElabMetadata {
  if (!metadata.extra_fields) return metadata;
  for (const k of Object.keys(metadata.extra_fields)) {
    const field = metadata.extra_fields[k];
    if (field) field.value = '';
  }
  return metadata;
}
