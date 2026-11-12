import type { BusinessInput } from './types.ts';
import { normalizeDomain } from './normalize.ts';

export const LIMITS = {
  name: 80,
  category: 80,
  city: 60,
  country: 60,
  domain: 120,
  competitor: 80,
  competitors: 5,
  alias: 80,
  aliases: 3,
} as const;

export type FieldErrors = Partial<Record<keyof BusinessInput, string>>;

/** Splits a comma or newline separated field into a clean list. */
export function splitList(value: string, max: number, maxLength: number): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(0, max);
}

export function validateBusiness(b: BusinessInput): FieldErrors {
  const errors: FieldErrors = {};
  const required = (key: 'name' | 'category' | 'city', label: string) => {
    const v = b[key].trim();
    if (!v) errors[key] = `Enter the ${label}.`;
    else if (v.length > LIMITS[key]) errors[key] = `Keep the ${label} under ${LIMITS[key]} characters.`;
  };
  required('name', 'business name');
  required('category', 'category');
  required('city', 'city');
  if (b.country.length > LIMITS.country) errors.country = `Keep the country under ${LIMITS.country} characters.`;
  if (b.domain.trim() && !normalizeDomain(b.domain)) errors.domain = 'Enter a domain like examplestudio.mk.';
  if (b.competitors.length > LIMITS.competitors) errors.competitors = `Add at most ${LIMITS.competitors} competitors.`;
  if (b.aliases.length > LIMITS.aliases) errors.aliases = `Add at most ${LIMITS.aliases} other names.`;
  return errors;
}
