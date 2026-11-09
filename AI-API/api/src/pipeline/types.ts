export const DOCUMENT_SOURCES = ['customer', 'admin', 'folder'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

/** Document primary key (UUID string). */
export type DocumentId = string;

/**
 * Customer (user) uploads: summaries only — no FAQ generation.
 * Admin / folder: FAQ generation; summaries skipped.
 */
export function sourceNeedsSummaries(
  source: DocumentSource | string | null | undefined
): boolean {
  return String(source || '').toLowerCase() === 'customer';
}

/** Admin / folder build the FAQ knowledge base; customer user flow skips FAQs. */
export function sourceNeedsFaqs(
  source: DocumentSource | string | null | undefined
): boolean {
  const s = String(source || '').toLowerCase();
  return s === 'admin' || s === 'folder';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when value is a UUID string (post-migration document ids). */
export function isDocumentUuid(value: unknown): value is DocumentId {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** @deprecated prefer isDocumentUuid */
export function isDocumentId(value: string): boolean {
  return isDocumentUuid(value);
}

export const PIPELINE_STEPS = [
  'uploaded',
  'layout_extracted',
  'pages_extracted',
  'policy_refs',
  'vector_indexed',
  'faqs_generated',
  'faqs_stored',
  'summary_generated',
  'completed',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const PIPELINE_STATUSES = [
  'queued',
  'running',
  'chat_ready',
  'completed',
  'failed',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/**
 * Enrichment steps before chat_ready / document ready.
 * Customer: summaries only. Admin / folder: FAQs only.
 */
export const POST_CHAT_STEPS: PipelineStep[] = [
  'faqs_generated',
  'faqs_stored',
  'summary_generated',
  'completed',
];

export function postChatStepsForSource(
  source: DocumentSource | string | null | undefined
): PipelineStep[] {
  const steps = [...POST_CHAT_STEPS];
  if (!sourceNeedsFaqs(source)) {
    return steps.filter(
      (s) => s !== 'faqs_generated' && s !== 'faqs_stored'
    );
  }
  if (!sourceNeedsSummaries(source)) {
    return steps.filter((s) => s !== 'summary_generated');
  }
  return steps;
}

export type ProcessDocumentJobData = {
  documentId: DocumentId;
  source: DocumentSource;
};

export type StepContext = {
  documentId: DocumentId;
  location: string;
  source: DocumentSource;
  updateProgress: (progress: {
    step: PipelineStep;
    percent: number;
    message?: string;
  }) => Promise<void>;
};
