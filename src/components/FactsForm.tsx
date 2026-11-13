import type { Currency } from '../lib/types.ts';
import { FACT_LIMITS, type FactsDraft, type PriceDraft } from '../lib/validation.ts';

interface Props {
  value: FactsDraft;
  placeholderName: string;
  placeholderCity: string;
  disabled: boolean;
  onChange: (next: FactsDraft) => void;
}

const CURRENCIES: Currency[] = ['EUR', 'MKD', 'USD'];

/** Optional facts the owner knows are true; used to check what AI answers say. */
export function FactsForm({ value, placeholderName, placeholderCity, disabled, onChange }: Props) {
  const set = <K extends keyof FactsDraft>(key: K, v: FactsDraft[K]) => onChange({ ...value, [key]: v });
  const setPrice = (i: number, patch: Partial<PriceDraft>) =>
    set(
      'prices',
      value.prices.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    );
  const filled =
    value.officialName.trim() || value.nameVariants.trim() || value.phones.trim() || value.city.trim() || value.address.trim() || value.prices.length > 0;

  return (
    <details className="facts-form" open={Boolean(filled)}>
      <summary>
        <span className="facts-form__title">Known facts</span>
        <span className="facts-form__hint">Optional. Lets the report check whether AI states your prices, phone and name correctly.</span>
      </summary>
      <fieldset disabled={disabled} className="facts-form__body">
        <div className="field-row">
          <div className="field">
            <label htmlFor="k-name">Official name</label>
            <input
              id="k-name"
              type="text"
              maxLength={FACT_LIMITS.name}
              placeholder={placeholderName || 'NULA'}
              value={value.officialName}
              onChange={(e) => set('officialName', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="k-variants">Allowed name variants</label>
            <input
              id="k-variants"
              type="text"
              placeholder="НУЛА, Nula Studio"
              aria-describedby="k-variants-hint"
              value={value.nameVariants}
              onChange={(e) => set('nameVariants', e.target.value)}
            />
            <p className="field__hint" id="k-variants-hint">
              Comma separated. Any other name AI uses is flagged.
            </p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="k-phones">Phone numbers</label>
          <input
            id="k-phones"
            type="text"
            inputMode="tel"
            placeholder="073 745 473"
            value={value.phones}
            onChange={(e) => set('phones', e.target.value)}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="k-city">City</label>
            <input
              id="k-city"
              type="text"
              maxLength={FACT_LIMITS.city}
              placeholder={placeholderCity || 'Skopje'}
              value={value.city}
              onChange={(e) => set('city', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="k-address">Street address</label>
            <input
              id="k-address"
              type="text"
              maxLength={FACT_LIMITS.address}
              placeholder="ул. Македонија 12"
              value={value.address}
              onChange={(e) => set('address', e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <span className="field__label" id="k-prices-label">
            Prices
          </span>
          <p className="field__hint">Your starting (“from”) price per service. Tick “/month” for monthly packages.</p>
          {value.prices.length > 0 && (
            <ul className="price-rows" aria-labelledby="k-prices-label">
              {value.prices.map((p, i) => (
                <li key={i} className="price-row">
                  <input
                    type="text"
                    aria-label={`Price ${i + 1}: what it is for`}
                    placeholder="One Page website"
                    maxLength={FACT_LIMITS.label}
                    value={p.label}
                    onChange={(e) => setPrice(i, { label: e.target.value })}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`Price ${i + 1}: amount`}
                    placeholder="190"
                    className="price-row__amount"
                    value={p.amount}
                    onChange={(e) => setPrice(i, { amount: e.target.value })}
                  />
                  <select
                    aria-label={`Price ${i + 1}: currency`}
                    value={p.currency}
                    onChange={(e) => setPrice(i, { currency: e.target.value as Currency })}
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="price-row__month">
                    <input type="checkbox" checked={p.perMonth} onChange={(e) => setPrice(i, { perMonth: e.target.checked })} />
                    /month
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove price ${i + 1}`}
                    onClick={() => set('prices', value.prices.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {value.prices.length < FACT_LIMITS.prices && (
            <button
              type="button"
              className="link-button"
              onClick={() => set('prices', [...value.prices, { label: '', amount: '', currency: 'EUR', perMonth: false }])}
            >
              Add a price
            </button>
          )}
        </div>
      </fieldset>
    </details>
  );
}
