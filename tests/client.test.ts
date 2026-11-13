import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditSite } from '../src/lib/client.ts';
import { factsFromDraft } from '../src/lib/validation.ts';
import { siteAudit } from './fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

describe('auditSite', () => {
  it('posts the domain and returns the audit', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ domain: 'examplestudio.example' });
      return Response.json({ audit: siteAudit() });
    });
    vi.stubGlobal('fetch', fetchMock);
    const audit = await auditSite('examplestudio.example');
    expect(audit.domain).toBe('examplestudio.example');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/audit');
  });

  it('passes on the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'The domain could not be found (DNS).' }, { status: 422 })));
    await expect(auditSite('nope.example')).rejects.toThrow('The domain could not be found (DNS).');
  });

  it('explains when the function is not running (Vite serves index.html)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    await expect(auditSite('a.example')).rejects.toThrow(/not running here/);
  });
});

describe('factsFromDraft', () => {
  it('cleans the form into known facts', () => {
    const facts = factsFromDraft({
      officialName: '  NULA  ',
      nameVariants: 'НУЛА, Nula Studio, НУЛА',
      phones: '073 745 473, 12, +389 2 555 0100',
      city: ' Skopje ',
      address: 'ул. Македонија 12',
      prices: [
        { label: 'One Page', amount: '190', currency: 'EUR', perMonth: false },
        { label: 'Social media', amount: '€150', currency: 'EUR', perMonth: true },
        { label: 'Store', amount: '12.000', currency: 'MKD', perMonth: false },
        { label: 'Empty', amount: '', currency: 'EUR', perMonth: false },
        { label: 'Zero', amount: '0', currency: 'EUR', perMonth: false },
      ],
    });
    expect(facts).toEqual({
      officialName: 'NULA',
      nameVariants: ['НУЛА', 'Nula Studio'],
      phones: ['073 745 473', '+389 2 555 0100'],
      city: 'Skopje',
      address: 'ул. Македонија 12',
      prices: [
        { label: 'One Page', amount: 190, currency: 'EUR', perMonth: false },
        { label: 'Social media', amount: 150, currency: 'EUR', perMonth: true },
        { label: 'Store', amount: 12000, currency: 'MKD', perMonth: false },
      ],
    });
  });
});
