import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pagesToExtractionElements } from '../extraction-payload';
import {
  addEvent,
  countSummaries,
  getDocument,
  getPages,
  listSummaries,
  replaceSummaries,
  setPipelineStep,
} from '../repository';
import { timeouts } from '../timeouts';
import type { StepContext } from '../types';
import { ingestSummariesToQdrant } from './summary-vector';

const SUMMARY_URL =
  process.env.SUMMARY_GENERATE_URL ||
  process.env.FAQ_GENERATE_URL?.replace(/\/generate-faqs\/?$/i, '/generate-summary') ||
  '';

function summaryBaseUrl(generateUrl: string): string {
  try {
    const u = new URL(generateUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return generateUrl.replace(/\/generate-summary\/?$/i, '');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summaryAuthHeaders(): Record<string, string> {
  const key =
    process.env.FAQ_Ai_API_KEY ||
    process.env.FAQ_AI_API_KEY ||
    process.env.API_SECRET ||
    '';
  if (!key) {
    throw new Error(
      'FAQ API key missing: set FAQ_Ai_API_KEY (or API_SECRET) in api/.env'
    );
  }
  return { 'x-api-key': key };
}

async function waitForSummaryJob(
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
      throw new Error(`Summary job ${jobId} not found`);
    }
    if (resp.status >= 400) {
      throw new Error(
        `Summary job poll failed (${resp.status}): ${JSON.stringify(resp.data).slice(0, 300)}`
      );
    }

    const job = resp.data ?? {};
    lastStatus = String(job.status || lastStatus);

    if (lastStatus === 'completed') {
      return job;
    }
    if (lastStatus === 'failed') {
      throw new Error(
        `Summary job failed: ${job.error || JSON.stringify(job).slice(0, 400)}`
      );
    }

    console.log(
      `[summaries] waiting job=${jobId} status=${lastStatus} elapsedMs=${Date.now() - started}`
    );
    await sleep(pollMs);
  }

  throw new Error(
    `Summary job ${jobId} timed out after ${timeoutMs}ms (last status=${lastStatus})`
  );
}

function mapSectionSummaries(sectionSummaries: any[]) {
  return sectionSummaries.map((s) => {
    const raw = String(s.type ?? s.scope ?? 'section').toLowerCase();
    const type: 'section' | 'full' =
      raw === 'full' || raw === 'document' ? 'full' : 'section';
    return {
      type,
      scope: type,
      sectionId: type === 'full' ? null : s.section_id,
      sectionName: type === 'full' ? null : s.section_name,
      pageStart: s.page_start,
      pageEnd: s.page_end,
      summary: s.summary,
      promptVersion: s.prompt_version,
      needsReview: s.needs_review,
    };
  });
}

/**
 * After FAQs. Prefer section_summaries already returned by FAQ generate;
 * otherwise call /generate-summary and wait for the job.
 */
export async function runSummarySteps(ctx: StepContext): Promise<void> {
  if ((await countSummaries(ctx.documentId)) > 0) {
    await addEvent(
      ctx.documentId,
      'summary_generated',
      'Skipping summary generation; already stored — ensuring Qdrant index'
    );
    await ingestSummariesToQdrant(ctx);
    await setPipelineStep(ctx.documentId, 'summary_generated', {
      pipelineStatus: 'running',
    });
    return;
  }

  await ctx.updateProgress({
    step: 'summary_generated',
    percent: 90,
    message: 'Generating section summaries',
  });
  await addEvent(ctx.documentId, 'summary_generated', 'Summary step started');

  const doc = await getDocument(ctx.documentId);
  const result = (doc?.result ?? {}) as Record<string, any>;
  const faqPayload = result.faq ?? result;
  let sectionSummaries: any[] =
    faqPayload.section_summaries ?? result.section_summaries ?? [];

  // FAQ first-time generate usually includes summaries; if not, call summary service.
  if (!sectionSummaries.length) {
    if (!SUMMARY_URL) {
      throw new Error(
        'No section_summaries from FAQ job and SUMMARY_GENERATE_URL / FAQ_GENERATE_URL not set'
      );
    }

    const filePath = path.isAbsolute(ctx.location)
      ? ctx.location
      : path.join(process.cwd(), ctx.location);

    const pages = await getPages(ctx.documentId);
    const elements = pagesToExtractionElements(pages);
    if (elements.length === 0) {
      throw new Error(
        'No extracted pages/elements for summary generation — extract step must complete first'
      );
    }

    const form = new FormData();
    form.append('elements', JSON.stringify(elements));
    form.append('document_id', String(ctx.documentId));
    if (fs.existsSync(filePath)) {
      form.append('file', fs.createReadStream(filePath));
    }

    const headers: Record<string, string> = {
      ...form.getHeaders(),
      ...summaryAuthHeaders(),
    };

    const timeoutMs = Number(timeouts.summary) || Number(timeouts.faq) || 1_800_000;
    console.log(
      `[summaries] POST ${SUMMARY_URL} timeoutMs=${timeoutMs} elements=${elements.length}`
    );

    let submitResp;
    try {
      submitResp = await axios.post(SUMMARY_URL, form, {
        headers,
        // Align with SUMMARY/FAQ_TIMEOUT_MS (default 30m) — do not hard-cap at 120s.
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
      throw new Error(
        `Summary submit failed (${ax.code || ax.response?.status || 'error'}): ${detail}`
      );
    }

    const data = submitResp.data ?? {};
    let summaryResult: Record<string, any>;

    if (data.job_id && !data.section_summaries && !data.result) {
      const base = summaryBaseUrl(SUMMARY_URL);
      await addEvent(
        ctx.documentId,
        'summary_generated',
        `Summary job queued: ${data.job_id}; waiting for completion`,
        { jobId: data.job_id }
      );
      const job = await waitForSummaryJob(
        base,
        String(data.job_id),
        summaryAuthHeaders(),
        timeoutMs
      );
      summaryResult = job.result ?? job;
    } else {
      summaryResult = data.result ?? data;
    }

    sectionSummaries = summaryResult.section_summaries ?? [];
  }

  if (!sectionSummaries.length) {
    throw new Error('Summary step finished but returned no section_summaries');
  }

  const faqVersion =
    typeof (result as any)?.faqVersion === 'number'
      ? (result as any).faqVersion
      : undefined;

  const stored = await replaceSummaries(
    ctx.documentId,
    mapSectionSummaries(sectionSummaries),
    {
      documentName: doc?.file_name ?? null,
      version: faqVersion,
    }
  );

  if (stored.inserted <= 0) {
    throw new Error('Failed to persist section summaries');
  }

  await addEvent(
    ctx.documentId,
    'summary_generated',
    `Stored ${stored.inserted} summaries (section+full) in summaries (v${stored.version})`
  );

  // Same collection as document chunks; tagged content_type=summary.
  const indexed = await ingestSummariesToQdrant(
    ctx,
    await listSummaries(ctx.documentId)
  );

  await setPipelineStep(ctx.documentId, 'summary_generated', {
    pipelineStatus: 'running',
  });
  await addEvent(
    ctx.documentId,
    'summary_generated',
    `Summary step done (db=${stored.inserted}, qdrant=${indexed.ingested}, collection=${indexed.collection})`
  );
}
