import type { VisibilityReport } from '../lib/types.ts';
import { reportFileName, reportToHtml, reportToJson } from '../lib/exportReport.ts';

/** Triggers a browser download of a text file. */
function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportBar({ report, disabled }: { report: VisibilityReport; disabled: boolean }) {
  return (
    <div className="export-bar" role="group" aria-label="Export report">
      <button
        type="button"
        className="button button--light"
        disabled={disabled}
        onClick={() => downloadText(reportFileName(report, 'json'), reportToJson(report), 'application/json')}
      >
        Download JSON
      </button>
      <button
        type="button"
        className="button button--light"
        disabled={disabled}
        onClick={() => downloadText(reportFileName(report, 'html'), reportToHtml(report), 'text/html;charset=utf-8')}
      >
        Download HTML report
      </button>
      <button type="button" className="button button--light" disabled={disabled} onClick={() => window.print()}>
        Print or save as PDF
      </button>
    </div>
  );
}
