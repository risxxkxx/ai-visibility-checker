import { MAX_PROMPT_COUNT } from '../lib/prompts.ts';
import { MAX_PROMPT_LENGTH } from '../lib/limits.ts';

interface Props {
  prompts: string[];
  edited: boolean;
  count: number;
  disabled: boolean;
  onCountChange: (n: number) => void;
  onEdit: (prompts: string[]) => void;
  onReset: () => void;
}

export function PromptEditor({ prompts, edited, count, disabled, onCountChange, onEdit, onReset }: Props) {
  const update = (i: number, text: string) => onEdit(prompts.map((p, j) => (j === i ? text : p)));
  const remove = (i: number) => onEdit(prompts.filter((_, j) => j !== i));
  const add = () => onEdit([...prompts, '']);

  return (
    <section className="prompt-editor" aria-labelledby="prompts-title">
      <div className="prompt-editor__head">
        <h2 className="panel-title" id="prompts-title">
          What customers will ask
        </h2>
        <div className="prompt-editor__controls">
          {edited ? (
            <button type="button" className="link-button" onClick={onReset} disabled={disabled}>
              Reset to generated
            </button>
          ) : (
            <label className="count-picker">
              <span>Prompts</span>
              <select value={count} disabled={disabled} onChange={(e) => onCountChange(Number(e.target.value))}>
                {Array.from({ length: MAX_PROMPT_COUNT }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      <p className="prompt-editor__lede">
        Generated from your details. Your business name is left out on purpose: the test is whether the assistant brings
        you up by itself. Edit anything before you run.
      </p>

      <ol className="prompt-list">
        {prompts.map((p, i) => (
          <li key={i} className="prompt-list__item">
            <span className="prompt-list__n" aria-hidden="true">
              {i + 1}
            </span>
            <textarea
              rows={1}
              value={p}
              maxLength={MAX_PROMPT_LENGTH}
              disabled={disabled}
              aria-label={`Prompt ${i + 1}`}
              onChange={(e) => update(i, e.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => remove(i)}
              disabled={disabled || prompts.length <= 1}
              aria-label={`Remove prompt ${i + 1}`}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {prompts.length < MAX_PROMPT_COUNT && (
        <button type="button" className="link-button" onClick={add} disabled={disabled}>
          Add a prompt
        </button>
      )}
    </section>
  );
}
