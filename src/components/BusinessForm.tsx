import { useState } from 'react';
import type { BusinessInput, Language } from '../lib/types.ts';
import { LIMITS, splitList, type FieldErrors } from '../lib/validation.ts';

interface Props {
  value: BusinessInput;
  errors: FieldErrors;
  showErrors: boolean;
  disabled: boolean;
  onChange: (next: BusinessInput) => void;
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: (describedBy: string | undefined) => React.ReactNode;
}

function Field({ id, label, hint, error, children }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field--error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(describedBy)}
      {hint && !error && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Text area for comma/line separated lists that keeps the user's raw typing. */
function ListInput({
  id,
  value,
  max,
  maxLength,
  placeholder,
  disabled,
  describedBy,
  onChange,
}: {
  id: string;
  value: string[];
  max: number;
  maxLength: number;
  placeholder: string;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (list: string[]) => void;
}) {
  // Keeps the user's raw typing; the parent remounts this (via key) when the form is replaced.
  const [raw, setRaw] = useState(() => value.join(', '));
  return (
    <input
      id={id}
      type="text"
      value={raw}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(splitList(e.target.value, max + 1, maxLength));
      }}
    />
  );
}

export function BusinessForm({ value, errors, showErrors, disabled, onChange }: Props) {
  const set = <K extends keyof BusinessInput>(key: K, v: BusinessInput[K]) => onChange({ ...value, [key]: v });
  const err = (k: keyof BusinessInput) => (showErrors ? errors[k] : undefined);

  return (
    <fieldset className="business-form" disabled={disabled}>
      <legend className="panel-title">Your business</legend>

      <Field id="f-name" label="Business name" error={err('name')}>
        {(d) => (
          <input
            id="f-name"
            type="text"
            autoComplete="organization"
            maxLength={LIMITS.name}
            value={value.name}
            aria-describedby={d}
            aria-invalid={Boolean(err('name'))}
            onChange={(e) => set('name', e.target.value)}
          />
        )}
      </Field>

      <Field id="f-aliases" label="Other spellings" hint="Optional. A Cyrillic or short name people use, separated by commas." error={err('aliases')}>
        {(d) => (
          <ListInput
            id="f-aliases"
            value={value.aliases}
            max={LIMITS.aliases}
            maxLength={LIMITS.alias}
            placeholder="Егзампл Студио"
            disabled={disabled}
            describedBy={d}
            onChange={(list) => set('aliases', list)}
          />
        )}
      </Field>

      <Field id="f-domain" label="Website" hint="Used to spot your site in answers and cited sources." error={err('domain')}>
        {(d) => (
          <input
            id="f-domain"
            type="text"
            inputMode="url"
            autoComplete="url"
            maxLength={LIMITS.domain}
            placeholder="examplestudio.mk"
            value={value.domain}
            aria-describedby={d}
            aria-invalid={Boolean(err('domain'))}
            onChange={(e) => set('domain', e.target.value)}
          />
        )}
      </Field>

      <Field id="f-category" label="What customers look for" hint="Write it the way a customer would, e.g. “web design agency”." error={err('category')}>
        {(d) => (
          <input
            id="f-category"
            type="text"
            maxLength={LIMITS.category}
            value={value.category}
            aria-describedby={d}
            aria-invalid={Boolean(err('category'))}
            onChange={(e) => set('category', e.target.value)}
          />
        )}
      </Field>

      <div className="field-row">
        <Field id="f-city" label="City" error={err('city')}>
          {(d) => (
            <input
              id="f-city"
              type="text"
              autoComplete="address-level2"
              maxLength={LIMITS.city}
              value={value.city}
              aria-describedby={d}
              aria-invalid={Boolean(err('city'))}
              onChange={(e) => set('city', e.target.value)}
            />
          )}
        </Field>
        <Field id="f-country" label="Country" error={err('country')}>
          {(d) => (
            <input
              id="f-country"
              type="text"
              autoComplete="country-name"
              maxLength={LIMITS.country}
              value={value.country}
              aria-describedby={d}
              onChange={(e) => set('country', e.target.value)}
            />
          )}
        </Field>
      </div>

      <Field id="f-competitors" label="Competitors" hint="Optional, up to 5, separated by commas." error={err('competitors')}>
        {(d) => (
          <ListInput
            id="f-competitors"
            value={value.competitors}
            max={LIMITS.competitors}
            maxLength={LIMITS.competitor}
            placeholder="Northpine Web, Studio Lumen"
            disabled={disabled}
            describedBy={d}
            onChange={(list) => set('competitors', list)}
          />
        )}
      </Field>

      <div className="field">
        <span className="field__label" id="f-lang-label">
          Prompt language
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="f-lang-label">
          {(
            [
              ['en', 'English'],
              ['mk', 'Македонски'],
            ] as [Language, string][]
          ).map(([code, label]) => (
            <label key={code} className={`segmented__option${value.language === code ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="language"
                value={code}
                checked={value.language === code}
                onChange={() => set('language', code)}
              />
              {label}
            </label>
          ))}
        </div>
        {value.language === 'mk' && (
          <p className="field__hint">Write the category and city in Macedonian too, e.g. “веб дизајн”, “Скопје”.</p>
        )}
      </div>
    </fieldset>
  );
}
