import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pagesToExtractionElements } from '../extraction-payload';
import {
  addEvent,
  countFaqs,
  getDocument,
  getPages,
  isStepDone,
  listFaqCategoryNames,
  replaceFaqs,
  setPipelineStep,
} from '../repository';
import { timeouts } from '../timeouts';
import type { StepContext } from '../types';

const FAQ_URL =
  process.env.FAQ_GENERATE_URL ||
  process.env.FAQ_SERVICE_URL ||
  '';

function faqBaseUrl(generateUrl: string): string {
  try {
    const u = new URL(generateUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return generateUrl.replace(/\/generate-faqs\/?$/i, '');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function faqAuthHeaders(): Record<string, string> {
  const faqKey =
    process.env.FAQ_Ai_API_KEY ||
    process.env.FAQ_AI_API_KEY ||
    process.env.API_SECRET ||
    '';
  if (!faqKey) {
    throw new Error(
      'FAQ API key missing: set FAQ_Ai_API_KEY (or API_SECRET) in api/.env'
    );
  }
  return { 'x-api-key': faqKey };
}

/**
 * FAQ service is async (202 + job_id). Poll until completed/failed so the
 * pipeline stays synchronous from the worker's point of view.
 */
async function waitForFaqJob(
  baseUrl: string,
  jobId: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Record<string, any>> {
  const started = Date.now();
  const pollMs = Number(process.env.FAQ_POLL_INTERVAL_MS || 3000);
  let lastStatus = 'queued';

  while (Date.now() - started < timeoutMs) {
    const resp = await axios.get(`${baseUrl}/jobs/${jobId}`, {
      headers,
      timeout: Math.min(60_000, timeoutMs),
      validateStatus: (s) => s >= 200 && s < 500,
    });

    if (resp.status === 404) {
      throw new Error(`FAQ job ${jobId} not found`);
    }
    if (resp.status >= 400) {
      throw new Error(
        `FAQ job poll failed (${resp.status}): ${JSON.stringify(resp.data).slice(0, 300)}`
      );
    }

    const job = resp.data ?? {};
    lastStatus = String(job.status || lastStatus);

    if (lastStatus === 'completed') {
      return job;
    }
    if (lastStatus === 'failed') {
      throw new Error(
        `FAQ job failed: ${job.error || JSON.stringify(job).slice(0, 400)}`
      );
    }

    const progress = job.progress
      ? ` progress=${JSON.stringify(job.progress)}`
      : '';
    console.log(
      `[faqs] waiting job=${jobId} status=${lastStatus}${progress} elapsedMs=${Date.now() - started}`
    );
    await sleep(pollMs);
  }

  throw new Error(
    `FAQ job ${jobId} timed out after ${timeoutMs}ms (last status=${lastStatus})`
  );
}

function pageRefsFrom(f: Record<string, any>): number[] | unknown {
  if (Array.isArray(f.page_refs) && f.page_refs.length) return f.page_refs;
  if (Array.isArray(f.pages) && f.pages.length) return f.pages;
  const start = f.page_start;
  const end = f.page_end;
  if (typeof start === 'number' && typeof end === 'number') {
    const refs: number[] = [];
    for (let p = start; p <= end; p++) refs.push(p);
    return refs;
  }
  if (typeof start === 'number') return [start];
  return f.page_refs ?? null;
}

function mapOneFaq(
  f: Record<string, any>,
  scope: 'global' | 'specific'
) {
  return {
    scope,
    category: f.category ?? null,
    question: f.question,
    answer: f.answer,
    sectionId: f.section_id ?? null,
    sectionName: f.section_name ?? f.section ?? null,
    pageRefs: pageRefsFrom(f),
    promptVersion: f.prompt_version ?? null,
    needsReview: f.needs_review === true,
  };
}

/**
 * Accept app-api contract (general_faqs / specific_faqs) and legacy flat `faqs`.
 */
function mapFaqRows(result: Record<string, any>) {
  const general = result.general_faqs ?? result.general ?? [];
  const specific = result.specific_faqs ?? result.specific ?? [];
  if (general.length || specific.length) {
    return [
      ...general.map((f: any) => mapOneFaq(f, 'global')),
      ...specific.map((f: any) => mapOneFaq(f, 'specific')),
    ];
  }
  const flat = Array.isArray(result.faqs) ? result.faqs : [];
  return flat.map((f: any) =>
    mapOneFaq(
      f,
      f.type === 'general' || f.scope === 'global' ? 'global' : 'specific'
    )
  );
}

function faqRawFromDocResult(result: unknown): Record<string, any> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, any>;
  const raw = r.faqRaw ?? r.faq_raw ?? null;
  if (!raw || typeof raw !== 'object') return null;
  const general = raw.general_faqs ?? raw.general ?? [];
  const specific = raw.specific_faqs ?? raw.specific ?? [];
  const flat = raw.faqs;
  if (
    (Array.isArray(general) && general.length) ||
    (Array.isArray(specific) && specific.length) ||
    (Array.isArray(flat) && flat.length)
  ) {
    return raw;
  }
  return null;
}

async function pollFaqServiceJob(
  submitUrl: string,
  submitBody: FormData | Record<string, unknown>,
  isJson: boolean,
  label: string
): Promise<Record<string, any>> {
  const headers: Record<string, string> = {
    ...faqAuthHeaders(),
  };
  if (isJson) {
    headers['Content-Type'] = 'application/json';
  } else {
    Object.assign(headers, (submitBody as FormData).getHeaders());
  }

  const timeoutMs = Number(timeouts.faq) || 1_800_000;
  const submitStarted = Date.now();
  console.log(
    `[faqs] POST ${submitUrl} ${label} timeoutMs=${timeoutMs}`
  );

  let submitResp;
  try {
    submitResp = await axios.post(submitUrl, submitBody, {
      headers,
      timeout: timeoutMs,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: (s) => s === 200 || s === 202,
    });
  } catch (err: unknown) {
    const ax = err as {
      code?: string;
      message?: string;
      response?: { status?: number; data?: unknown };
    };
    const detail =
      ax.response?.data != null
        ? JSON.stringify(ax.response.data).slice(0, 400)
        : ax.message || String(err);
    console.error(
      `[faqs] ${label} submit FAILED elapsedMs=${Date.now() - submitStarted} ` +
        `code=${ax.code || ax.response?.status || 'error'}: ${detail}`
    );
    throw new Error(
      `FAQ ${label} submit failed (${ax.code || ax.response?.status || 'error'}): ${detail}`
    );
  }

  console.log(
    `[faqs] ${label} submit OK status=${submitResp.status} ` +
      `elapsedMs=${Date.now() - submitStarted} ` +
      `job_id=${submitResp.data?.job_id || 'n/a'} ` +
      `duplicate=${Boolean(submitResp.data?.duplicate)}`
  );

  const data = submitResp.data ?? {};
  if (
    data.job_id &&
    !data.general_faqs &&
    !data.specific_faqs &&
    !data.faqs &&
    !data.result
  ) {
    const base = faqBaseUrl(FAQ_URL);
    const pollStarted = Date.now();
    console.log(
      `[faqs] polling ${label} job=${data.job_id} base=${base} timeoutMs=${timeoutMs}`
    );
    const job = await waitForFaqJob(
      base,
      String(data.job_id),
      faqAuthHeaders(),
      timeoutMs
    );
    console.log(
      `[faqs] ${label} job completed job=${data.job_id} ` +
        `elapsedMs=${Date.now() - pollStarted} status=${job.status || 'completed'}`
    );
    return job.result ?? job;
  }
  return data.result ?? data;
}

/** LLM section generation only (skip embed dedupe). Checkpoints faqRaw. */
async function runFaqGenerate(ctx: StepContext): Promise<Record<string, any>> {
  const doc = await getDocument(ctx.documentId);
  const existingRaw = faqRawFromDocResult(doc?.result);
  if (
    existingRaw &&
    isStepDone(doc?.pipeline_step ?? null, 'faqs_generated')
  ) {
    console.log(
      `[faqs] skip LLM generate — faqRaw checkpoint present doc=${ctx.documentId}`
    );
    await addEvent(
      ctx.documentId,
      'faqs_generated',
      'Skipping FAQ LLM; raw FAQs already checkpointed'
    );
    return existingRaw;
  }

  if (!FAQ_URL) {
    throw new Error(
      'FAQ_GENERATE_URL not set; cannot mark document ready without FAQs'
    );
  }

  await ctx.updateProgress({
    step: 'faqs_generated',
    percent: 70,
    message: 'Generating FAQs',
  });
  await addEvent(ctx.documentId, 'faqs_generated', 'FAQ LLM generation started');

  const filePath = path.isAbsolute(ctx.location)
    ? ctx.location
    : path.join(process.cwd(), ctx.location);

  const categoryNames = await listFaqCategoryNames();
  const categoriesForPrompt = [...categoryNames];
  if (!categoriesForPrompt.some((n) => n.toLowerCase() === 'other')) {
    categoriesForPrompt.push('Other');
  }

  const pages = await getPages(ctx.documentId);
  const elements = pagesToExtractionElements(pages);
  if (elements.length === 0) {
    throw new Error(
      'No extracted pages/elements for FAQ generation — extract step must complete first'
    );
  }

  const form = new FormData();
  form.append('elements', JSON.stringify(elements));
  form.append('document_id', String(ctx.documentId));
  form.append('skip_dedupe', 'true');
  if (fs.existsSync(filePath)) {
    form.append('file', fs.createReadStream(filePath));
  }
  if (categoriesForPrompt.length > 0) {
    form.append('categories', JSON.stringify(categoriesForPrompt));
  }

  console.log(
    `[faqs] LLM generate doc=${ctx.documentId} categories=${categoriesForPrompt.length} ` +
      `elements=${elements.length} skip_dedupe=true`
  );

  const result = await pollFaqServiceJob(FAQ_URL, form, false, 'generate');
  const rows = mapFaqRows(result);
  if (rows.length === 0) {
    throw new Error('FAQ LLM job completed but returned no FAQs');
  }

  // Checkpoint raw FAQs so dedupe retries skip expensive LLM.
  await setPipelineStep(ctx.documentId, 'faqs_generated', {
    pipelineStatus: 'running',
    result: { faqRaw: result },
  });
  await addEvent(
    ctx.documentId,
    'faqs_generated',
    `FAQ LLM complete (${rows.length} raw FAQs); dedupe next`
  );
  return result;
}

/** Embed dedupe + DB store. Uses faqRaw checkpoint when present. */
async function runFaqDedupeAndStore(
  ctx: StepContext,
  faqRaw: Record<string, any>
): Promise<void> {
  if ((await countFaqs(ctx.documentId)) > 0) {
    await addEvent(
      ctx.documentId,
      'faqs_stored',
      'Skipping FAQ dedupe/store; faqs already stored'
    );
    await setPipelineStep(ctx.documentId, 'faqs_stored', {
      pipelineStatus: 'running',
    });
    return;
  }

  if (!FAQ_URL) {
    throw new Error('FAQ_GENERATE_URL not set');
  }

  await ctx.updateProgress({
    step: 'faqs_stored',
    percent: 80,
    message: 'Deduping FAQs',
  });
  await addEvent(ctx.documentId, 'faqs_stored', 'FAQ dedupe started');

  const base = faqBaseUrl(FAQ_URL);
  const dedupeUrl = `${base}/dedupe-faqs`;
  const payload = {
    ...faqRaw,
    document_id: faqRaw.document_id || ctx.documentId,
  };

  console.log(
    `[faqs] dedupe doc=${ctx.documentId} url=${dedupeUrl}`
  );
  const result = await pollFaqServiceJob(dedupeUrl, payload, true, 'dedupe');
  const rows = mapFaqRows(result);
  const doc = await getDocument(ctx.documentId);
  const stored = await replaceFaqs(ctx.documentId, rows, {
    documentName: doc?.file_name ?? null,
    policyId: doc?.policy_id ?? null,
  });
  if (rows.length === 0) {
    throw new Error('FAQ dedupe completed but returned no FAQs');
  }
  if (stored.inserted <= 0) {
    throw new Error(
      `FAQ dedupe returned ${rows.length} FAQs but none were persisted (all skipped?)`
    );
  }

  await setPipelineStep(ctx.documentId, 'faqs_stored', {
    pipelineStatus: 'running',
    result: {
      faqRaw,
      faq: result,
      faqVersion: stored.version,
    },
  });
  await addEvent(
    ctx.documentId,
    'faqs_stored',
    `Stored ${stored.inserted} FAQs in faqs (v${stored.version}; skipped ${stored.skippedGeneral} general dupes)`
  );
}

/**
 * Two checkpoints:
 * 1) faqs_generated — LLM sections done, raw FAQs in documents.result.faqRaw
 * 2) faqs_stored — embed dedupe + DB insert
 *
 * On retry after dedupe timeout, LLM is skipped when faqRaw is present.
 */
export async function runFaqSteps(ctx: StepContext): Promise<void> {
  if ((await countFaqs(ctx.documentId)) > 0) {
    await addEvent(
      ctx.documentId,
      'faqs_stored',
      'Skipping FAQ generation; faqs already stored'
    );
    await setPipelineStep(ctx.documentId, 'faqs_stored', {
      pipelineStatus: 'running',
    });
    return;
  }

  const faqRaw = await runFaqGenerate(ctx);
  await runFaqDedupeAndStore(ctx, faqRaw);
}
