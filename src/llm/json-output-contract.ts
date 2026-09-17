import { createHash } from 'node:crypto';

/** Decoder constraints only. The original validator remains the acceptance authority. */
export const JSON_OUTPUT_CONTRACT_VERSION = 2;
export const MAX_JSON_OUTPUT_SCHEMA_BYTES = 8192;
type JsonScalar = string | number | boolean | null;
type JsonType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
export interface JsonOutputSchema {
  type: JsonType | readonly JsonType[];
  properties?: Readonly<Record<string, JsonOutputSchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: JsonOutputSchema;
  minItems?: number; maxItems?: number;
  enum?: readonly JsonScalar[]; const?: JsonScalar;
  minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number;
}
export interface JsonOutputContract {
  readonly version: typeof JSON_OUTPUT_CONTRACT_VERSION;
  readonly hash: string; readonly bytes: number; readonly strict: boolean;
  readonly schema: JsonOutputSchema;
}
const contracts = new WeakMap<object, JsonOutputContract>();
const types = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
// CompactifAI's measured grammar rejects uniqueItems. Uniqueness remains an application
// validator obligation; one explicit subset keeps the frozen contract identical to the wire.
const keys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum']);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const scalar = (value: unknown) => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f]/.test(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function checkedSchema(input: JsonOutputSchema): JsonOutputSchema {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (!plain(value) || depth > 12 || ++nodes > 256 || seen.has(value)) throw new Error('JSON output schema must be a bounded acyclic plain structure');
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.has(key))
      || Object.values(descriptors).some(row => row.get || row.set || !row.enumerable)) throw new Error('JSON output schema contains unsupported fields or accessors');
    const selectedTypes = Array.isArray(value.type) ? value.type : [value.type];
    if (!selectedTypes.length || selectedTypes.length > 2 || new Set(selectedTypes).size !== selectedTypes.length || selectedTypes.some(type => !types.has(type as string))) throw new Error('JSON output schema needs supported explicit types');
    if (value.properties !== undefined || selectedTypes.includes('object')) {
      if (!selectedTypes.includes('object') || !plain(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)) throw new Error('JSON output objects need properties, required and additionalProperties:false');
      const propertyDescriptors = Object.getOwnPropertyDescriptors(value.properties), names = Object.keys(value.properties);
      if (names.length > 32 || Reflect.ownKeys(value.properties).length !== names.length
        || names.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) || Object.values(propertyDescriptors).some(row => row.get || row.set || !row.enumerable)
        || value.required.length > names.length || new Set(value.required).size !== value.required.length || value.required.some(name => typeof name !== 'string' || !names.includes(name))) throw new Error('JSON output schema has invalid object properties or required keys');
      Object.values(value.properties).forEach(child => visit(child, depth + 1));
    } else if (value.required !== undefined || value.additionalProperties !== undefined) throw new Error('JSON object constraints require an object type');
    if (selectedTypes.includes('array')) {
      if (!value.items) throw new Error('JSON output arrays need an item schema');
      visit(value.items, depth + 1);
    } else if (value.items !== undefined || value.minItems !== undefined || value.maxItems !== undefined) throw new Error('JSON array constraints require an array type');
    for (const [min, max, limit] of [['minItems', 'maxItems', 256], ['minLength', 'maxLength', 12000]] as const) {
      for (const key of [min, max]) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > limit)) throw new Error('JSON output schema has an invalid size bound');
      if (value[min] !== undefined && value[max] !== undefined && (value[min] as number) > (value[max] as number)) throw new Error('JSON output schema size bounds conflict');
    }
    if ((value.minLength !== undefined || value.maxLength !== undefined) && !selectedTypes.includes('string')) throw new Error('JSON string constraints require a string type');
    for (const key of ['minimum', 'maximum']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || !selectedTypes.some(type => type === 'integer' || type === 'number'))) throw new Error('JSON numeric constraints require finite numbers and a numeric type');
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) throw new Error('JSON numeric bounds conflict');
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 256 || value.enum.some(item => !scalar(item)) || new Set(value.enum).size !== value.enum.length)) throw new Error('JSON output enums need unique bounded scalar choices');
    if (Object.hasOwn(value, 'const') && !scalar(value.const)) throw new Error('JSON output const must be a bounded scalar');
    seen.delete(value);
  };
  visit(input, 0);
  if (input.type !== 'object') throw new Error('JSON output root must be an object');
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > MAX_JSON_OUTPUT_SCHEMA_BYTES) throw new Error('JSON output schema exceeds its 8192-byte decoder-contract bound');
  return freeze(JSON.parse(encoded) as JsonOutputSchema);
}

/** Attach an explicit code-owned schema, never derive one from prose, source data or a model reply.
 * A fresh wrapper prevents another task from rebinding this validator's immutable contract. */
export function withJsonOutputContract<T>(validate: (value: T) => string | null, schema: JsonOutputSchema,
  options: { strict?: boolean } = {}): (value: T) => string | null {
  if (typeof validate !== 'function' || !plain(options) || Object.keys(options).some(key => key !== 'strict')
    || options.strict !== undefined && typeof options.strict !== 'boolean') throw new Error('JSON output contract needs a validator and explicit boolean strict mode');
  const copied = checkedSchema(schema), strict = options.strict ?? true;
  const hash = createHash('sha256').update(JSON.stringify({ version: JSON_OUTPUT_CONTRACT_VERSION, schema: copied, strict })).digest('hex');
  const wrapped = (value: T) => validate(value);
  contracts.set(wrapped, freeze({ version: JSON_OUTPUT_CONTRACT_VERSION, hash, bytes: Buffer.byteLength(JSON.stringify(copied)), strict, schema: copied }));
  return wrapped;
}
export function jsonOutputContract(validate?: (value: any) => string | null): JsonOutputContract | undefined {
  return validate ? contracts.get(validate) : undefined;
}
