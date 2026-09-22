/**
 * The validator DSL the world format is written in, with no Convex behind it.
 *
 * Every `serialized*` record in `engine/aiTown/` is a schema declaration: it names the fields of
 * a persisted entity and the types they carry (docs/05-agentic-world-format.md §4.2). Those
 * declarations were written against `convex/values` because the same record also had to be a
 * Convex table definition. Convex is gone (phase 3), the records are not, and they are still the
 * one place the world format is stated in code rather than in prose.
 *
 * So this module keeps the DSL and drops the dependency. It is a faithful re-declaration of the
 * slice of `convex/values` the engine uses -- `v`, `Infer`, `ObjectType`, `PropertyValidators`,
 * `Value` -- with the same type-level behaviour, optional-key handling included.
 *
 * Nothing in the engine reads a validator at runtime: no field is walked, no argument is checked,
 * the `args` of an input handler exist only so `InputArgs<Name>` can be derived from them. The
 * builders below still return a small descriptor object rather than a bare cast, because a schema
 * that can only be read by the compiler is one that can never be checked at a trust boundary --
 * inputs arriving over the sync channel, a snapshot loaded from disk -- and those boundaries are
 * coming. `kind` is enough to write that checker against later; it is not used today.
 */

/** A value the engine can persist or hand back from an input handler. */
export type Value =
  | null
  | bigint
  | number
  | boolean
  | string
  | ArrayBuffer
  | Value[]
  | { [key: string]: undefined | Value };

export type OptionalProperty = 'optional' | 'required';

/**
 * `Type` is a phantom: it carries the declared type for `Infer` to read and holds nothing at
 * runtime. Reading `.type` off a validator gets you `undefined`, which is why it is never read.
 */
export interface Validator<Type, IsOptional extends OptionalProperty = 'required'> {
  readonly type: Type;
  readonly isOptional: IsOptional;
  readonly kind: string;
}

/** A record of field name to validator: the shape of every `serialized*` declaration. */
export type PropertyValidators = Record<string, Validator<any, OptionalProperty>>;

export type Infer<T extends Validator<any, OptionalProperty>> = T['type'];

type OptionalKeys<Fields extends PropertyValidators> = {
  [Key in keyof Fields]: Fields[Key]['isOptional'] extends 'optional' ? Key : never;
}[keyof Fields];
type RequiredKeys<Fields extends PropertyValidators> = Exclude<keyof Fields, OptionalKeys<Fields>>;

/** Flattens the intersection below so hovering a type shows its fields, not `A & B`. */
type Expand<T> = T extends infer O ? { [Key in keyof O]: O[Key] } : never;

/**
 * The object type a record of validators describes. `v.optional(...)` makes the key itself
 * optional (`field?: T`) rather than merely admitting `undefined`, which is what upstream did and
 * what the serialization code in `engine/aiTown/` is written against.
 */
export type ObjectType<Fields extends PropertyValidators> = Expand<
  { [Key in OptionalKeys<Fields>]?: Infer<Fields[Key]> } & {
    [Key in RequiredKeys<Fields>]: Infer<Fields[Key]>;
  }
>;

function validator<Type, IsOptional extends OptionalProperty = 'required'>(
  kind: string,
  isOptional: IsOptional,
  extra?: Record<string, unknown>,
): Validator<Type, IsOptional> {
  return { kind, isOptional, ...extra } as unknown as Validator<Type, IsOptional>;
}

export const v = {
  null: () => validator<null>('null', 'required'),
  number: () => validator<number>('number', 'required'),
  boolean: () => validator<boolean>('boolean', 'required'),
  string: () => validator<string>('string', 'required'),

  /** Escape hatch. Used where the world format deliberately carries opaque data, like god tags. */
  any: () => validator<any>('any', 'required'),

  literal: <L extends string | number | boolean | bigint>(value: L) =>
    validator<L>('literal', 'required', { value }),

  array: <T extends Validator<any, 'required'>>(element: T) =>
    validator<Infer<T>[]>('array', 'required', { element }),

  object: <Fields extends PropertyValidators>(fields: Fields) =>
    validator<ObjectType<Fields>>('object', 'required', { fields }),

  union: <T extends Validator<any, 'required'>[]>(...members: T) =>
    validator<Infer<T[number]>>('union', 'required', { members }),

  /** Only meaningful as a field of `v.object` or of a `serialized*` record. */
  optional: <T extends Validator<any, 'required'>>(inner: T) =>
    validator<Infer<T> | undefined, 'optional'>('optional', 'optional', { inner }),
};
