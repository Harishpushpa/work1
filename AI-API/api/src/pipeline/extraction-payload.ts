/**
 * Build document-extraction elements from persisted document_pages
 * so FAQ/summary services can skip re-parsing the PDF.
 */

export type ExtractionElement = {
  type: string;
  text: string;
  page_number: number;
  element_id?: string;
  metadata?: Record<string, unknown>;
};

type PageRow = {
  page_number: number;
  text?: string | null;
  elements_json?: unknown;
};

function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Flatten page rows → extraction elements (prefer stored elements_json). */
export function pagesToExtractionElements(
  pages: PageRow[]
): ExtractionElement[] {
  const out: ExtractionElement[] = [];

  for (const page of pages) {
    const pageNumber = Number(page.page_number) || 1;
    const stored = asArray(page.elements_json);

    if (stored && stored.length > 0) {
      for (let i = 0; i < stored.length; i += 1) {
        const el = stored[i];
        if (!el || typeof el !== 'object') continue;
        const rec = el as Record<string, unknown>;
        const text =
          typeof rec.text === 'string'
            ? rec.text.trim()
            : rec.text != null
              ? String(rec.text).trim()
              : '';
        if (!text) continue;
        out.push({
          type: String(rec.type || 'Text'),
          text,
          page_number:
            Number(rec.page_number ?? pageNumber) || pageNumber,
          element_id: String(
            rec.element_id ?? `page-${pageNumber}-el-${i}`
          ),
          metadata:
            rec.metadata && typeof rec.metadata === 'object'
              ? (rec.metadata as Record<string, unknown>)
              : undefined,
        });
      }
      continue;
    }

    const text = String(page.text || '').trim();
    if (!text) continue;
    out.push({
      type: 'Text',
      text,
      page_number: pageNumber,
      element_id: `page-${pageNumber}`,
      metadata: { source: 'document_pages.text' },
    });
  }

  return out;
}
