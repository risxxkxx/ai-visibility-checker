import type { BusinessInput, Currency, KnownFacts } from './types.ts';
import { normalizeDomain } from './normalize.ts';
import { parseAmount } from './facts.ts';

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

// ---------- known facts form ----------

export const FACT_LIMITS = { name: 80, variants: 4, phones: 3, phone: 40, city: 60, address: 120, prices: 8, label: 60 } as const;

export interface PriceDraft {
  label: string;
  amount: string;
  currency: Currency;
  perMonth: boolean;
}

/** What the "Known facts" form holds while the user types. */
export interface FactsDraft {
  officialName: string;
  nameVariants: string;
  phones: string;
  city: string;
  address: string;
  prices: PriceDraft[];
}

export const EMPTY_FACTS_DRAFT: FactsDraft = { officialName: '', nameVariants: '', phones: '', city: '', address: '', prices: [] };

const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Turns the form into KnownFacts: trims, caps lengths and drops price rows without a usable amount. */
export function factsFromDraft(d: FactsDraft): KnownFacts {
  return {
    officialName: clip(d.officialName, FACT_LIMITS.name),
    nameVariants: splitList(d.nameVariants, FACT_LIMITS.variants, FACT_LIMITS.name),
    phones: splitList(d.phones, FACT_LIMITS.phones, FACT_LIMITS.phone).filter((p) => p.replace(/\D/g, '').length >= 6),
    city: clip(d.city, FACT_LIMITS.city),
    address: clip(d.address, FACT_LIMITS.address),
    prices: d.prices
      .slice(0, FACT_LIMITS.prices)
      .map((p) => ({ label: clip(p.label, FACT_LIMITS.label), amount: parseAmount(p.amount.replace(/[^\d.,\s]/g, '')), currency: p.currency, perMonth: p.perMonth }))
      .filter((p) => Number.isFinite(p.amount) && p.amount > 0 && p.amount < 10_000_000),
  };
}
