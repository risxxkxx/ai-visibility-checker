import type { BusinessInput } from '../src/lib/types.ts';

export function business(overrides: Partial<BusinessInput> = {}): BusinessInput {
  return {
    name: 'Example Studio',
    aliases: [],
    domain: 'examplestudio.example',
    category: 'web design agency',
    city: 'Skopje',
    country: 'North Macedonia',
    competitors: [],
    language: 'en',
    ...overrides,
  };
}
