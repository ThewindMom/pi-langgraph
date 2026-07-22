export function items(value: unknown, field: string, max: number, validate: (item: unknown, field: string) => void, min = 0): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(field);
  value.forEach((item, index) => validate(item, `${field}[${index}]`));
  return value;
}

export function strings(value: unknown, field: string, maxItems: number, maxLength: number, minItems = 0): void {
  items(value, field, maxItems, (item, itemField) => void text(item, itemField, maxLength), minItems);
}

export function optional<T>(value: unknown, validate: (value: unknown) => T): T | undefined {
  if (value !== undefined && value !== null) return validate(value);
  return undefined;
}

export function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid(field);
  return value;
}

export function boolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") invalid(field);
}

export function text(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) invalid(field);
  return value;
}

export function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(field);
  return value as Readonly<Record<string, unknown>>;
}

export function invalid(field: string): never {
  throw new Error(`invalid persisted workflow ${field}`);
}
