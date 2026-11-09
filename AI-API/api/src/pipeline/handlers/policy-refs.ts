import axios from 'axios';
import http from 'http';
import { prompts } from '../../llm/prompts/prompts';
import {
  addEvent,
  getPages,
  getPolicyRefs,
  savePolicyRefs,
  setPipelineStep,
  updateDocumentPolicyId,
} from '../repository';
import { timeouts } from '../timeouts';
import type { StepContext } from '../types';

const ipv4Agent = new http.Agent({ keepAlive: false, family: 4 });

export async function runPolicyRefs(
  ctx: StepContext,
  extractPayload?: {
    document: Record<string, unknown>;
    elements: unknown[];
  }
): Promise<unknown> {
  const existing = await getPolicyRefs(ctx.documentId);
  if (existing) {
    await addEvent(
      ctx.documentId,
      'policy_refs',
      'Skipping policy refs; already stored'
    );
    return existing;
  }

  const interpretUrl = process.env.DOCUMENT_INTERPRET_URL;
  if (!interpretUrl) {
    await addEvent(
      ctx.documentId,
      'policy_refs',
      'DOCUMENT_INTERPRET_URL not set; storing empty refs'
    );
    await savePolicyRefs(ctx.documentId, {});
    await setPipelineStep(ctx.documentId, 'policy_refs', {
      pipelineStatus: 'running',
    });
    return {};
  }

  // Advance pipeline_step only after interpret succeeds (see below) so retries
  // resume this step instead of treating it as already done.
  await ctx.updateProgress({
    step: 'policy_refs',
    percent: 45,
    message: 'Finding policy reference details',
  });
  await addEvent(ctx.documentId, 'policy_refs', 'Interpretation started');

  const pages = await getPages(ctx.documentId);
  const compactElements =
    pages.length > 0
      ? pages.map((p) => ({
          type: 'Text',
          text: p.text,
          page_number: p.page_number,
          element_id: `page-${p.page_number}`,
        }))
      : ((extractPayload?.elements ?? []) as Array<Record<string, unknown>>).map(
          (el, i) => ({
            type: 'Text',
            text: typeof el?.text === 'string' ? el.text : JSON.stringify(el),
            page_number: el?.page_number ?? i + 1,
            element_id: String(el?.element_id ?? `el-${i}`),
          })
        );

  const document = {
    ...(extractPayload?.document ?? {}),
    page_count: pages.length || compactElements.length,
    filename: pathBasename(ctx.location),
    document_id: ctx.documentId,
  };

  const timeoutMs = Number(timeouts.interpret) || 600_000;
  console.log(
    `[policy-refs] POST ${interpretUrl} timeoutMs=${timeoutMs} pages=${compactElements.length}`
  );

  let resp;
  try {
    resp = await axios.post(
      interpretUrl,
      {
        document,
        elements: compactElements,
        prompt: prompts.extractDocument,
      },
      {
        timeout: timeoutMs,
        httpAgent: ipv4Agent,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        headers: { Connection: 'close' },
        validateStatus: (s) => s >= 200 && s < 300,
      }
    );
  } catch (err: unknown) {
    const ax = err as {
      code?: string;
      message?: string;
      response?: { status?: number; data?: unknown };
    };
    const detail =
      ax.response?.data != null
        ? JSON.stringify(ax.response.data).slice(0, 500)
        : ax.message || String(err);
    console.error(
      `[policy-refs] interpret failed code=${ax.code || 'n/a'} status=${ax.response?.status ?? 'n/a'}: ${detail}`
    );
    throw new Error(
      `Policy interpret failed (${ax.code || ax.response?.status || 'error'}): ${detail}`
    );
  }

  const interpretation =
    resp.data?.interpretation ?? resp.data ?? {};

  console.log(
    `[policy-refs] interpret ok keys=${Object.keys(interpretation || {}).join(',')}`
  );

  await savePolicyRefs(ctx.documentId, interpretation);

  // Still persist refs when invalid so UI/doc-ref shows the flag; runner
  // aborts before vector ingest / FAQs.
  if (isInvalidDocumentInterpretation(interpretation)) {
    await setPipelineStep(ctx.documentId, 'policy_refs', {
      pipelineStatus: 'running',
    });
    await addEvent(
      ctx.documentId,
      'policy_refs',
      'Document marked invalid_document by interpret — not an insurance policy',
      { invalid_document: true }
    );
    return interpretation;
  }

  const foundPolicyId = extractPolicyId(interpretation);
  if (foundPolicyId) {
    const updated = await updateDocumentPolicyId(ctx.documentId, foundPolicyId);
    await addEvent(ctx.documentId, 'policy_refs', 'Document policy_id updated', {
      policy_id: foundPolicyId,
      updated,
    });
  }

  await setPipelineStep(ctx.documentId, 'policy_refs', {
    pipelineStatus: 'running',
  });
  await addEvent(ctx.documentId, 'policy_refs', 'Policy refs saved', {
    policy_number:
      typeof interpretation === 'object' && interpretation
        ? (interpretation as { policy_number?: string }).policy_number
        : undefined,
    policy_id: foundPolicyId ?? undefined,
  });
  return interpretation;
}

/** True when interpret JSON says the file is not an insurance policy document. */
export function isInvalidDocumentInterpretation(
  interpretation: unknown
): boolean {
  if (!interpretation || typeof interpretation !== 'object') return false;
  const obj = interpretation as Record<string, unknown>;
  const flag = obj.invalid_document ?? obj.invalidDocument;
  return flag === true || flag === 'true' || flag === 1;
}

/** Prefer explicit policy_id; fall back to policy_number when present. */
function extractPolicyId(interpretation: unknown): string | null {
  if (!interpretation || typeof interpretation !== 'object') return null;
  const obj = interpretation as Record<string, unknown>;
  for (const key of ['policy_id', 'policyId', 'policy_number'] as const) {
    const raw = obj[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pathBasename(location: string): string {
  const parts = location.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || location;
}
