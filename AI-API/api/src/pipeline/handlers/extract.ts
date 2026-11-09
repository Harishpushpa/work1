import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import {
  copyExtractArtifacts,
  findCompatibleProcessing,
  findPageDonorForFile,
  resolveDocumentFilePath,
  upsertDocumentProcessing,
} from '../files';
import {
  addEvent,
  getDocument,
  getPages,
  hasDonePages,
  setPipelineStep,
  upsertPage,
} from '../repository';
import { timeouts } from '../timeouts';
import type { StepContext } from '../types';

const EXTRACTION_URL =
  process.env.DOCUMENT_EXTRACTION_URL || 'http://localhost:8001/extract';

type ExtractElement = {
  type?: string;
  text?: string;
  page_number?: number | null;
  element_id?: string;
  metadata?: Record<string, unknown>;
};

function groupByPage(elements: ExtractElement[]) {
  const map = new Map<number, ExtractElement[]>();
  for (const el of elements) {
    const page = Number(el.page_number ?? 1) || 1;
    const list = map.get(page) ?? [];
    list.push(el);
    map.set(page, list);
  }
  return map;
}

async function elementsFromPages(documentId: string): Promise<ExtractElement[]> {
  const pages = await getPages(documentId);
  return pages.flatMap((p) => {
    const els = p.elements_json;
    if (Array.isArray(els) && els.length) {
      return els as ExtractElement[];
    }
    return [
      {
        type: 'Text',
        text: p.text,
        page_number: p.page_number,
        element_id: `page-${p.page_number}`,
        metadata: { source: 'document_pages', page_number: p.page_number },
      },
    ];
  });
}

export async function runExtractSteps(ctx: StepContext): Promise<{
  document: Record<string, unknown>;
  elements: ExtractElement[];
}> {
  if (await hasDonePages(ctx.documentId)) {
    await addEvent(
      ctx.documentId,
      'pages_extracted',
      'Skipping extract; page checkpoints already present'
    );
    await setPipelineStep(ctx.documentId, 'pages_extracted', {
      pipelineStatus: 'running',
    });
    return { document: {}, elements: await elementsFromPages(ctx.documentId) };
  }

  const doc = await getDocument(ctx.documentId);
  const fileId = doc?.file_id ?? null;

  // Reuse pages from another association on the same shared file when compatible.
  if (fileId) {
    const compatible = await findCompatibleProcessing(fileId);
    const donorId =
      compatible?.donor_document_id ||
      (await findPageDonorForFile(fileId, ctx.documentId));
    if (donorId && donorId !== ctx.documentId) {
      const copied = await copyExtractArtifacts(donorId, ctx.documentId);
      if (copied.pagesCopied > 0) {
        await setPipelineStep(ctx.documentId, 'pages_extracted', {
          pipelineStatus: 'running',
          pageCount: copied.pagesCopied,
        });
        await addEvent(
          ctx.documentId,
          'pages_extracted',
          `Reused extract from donor ${donorId} (pages=${copied.pagesCopied}, refs=${copied.refsCopied})`,
          { donorDocumentId: donorId, fileId, reused: true }
        );
        await upsertDocumentProcessing({
          fileId,
          donorDocumentId: donorId,
        });
        return {
          document: { reused_from: donorId },
          elements: await elementsFromPages(ctx.documentId),
        };
      }
    }
  }

  const filePath =
    (doc ? await resolveDocumentFilePath(doc) : '') ||
    (path.isAbsolute(ctx.location)
      ? ctx.location
      : path.join(process.cwd(), ctx.location));
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found at ${filePath}`);
  }

  await ctx.updateProgress({
    step: 'layout_extracted',
    percent: 10,
    message: 'Calling document extraction',
  });
  await addEvent(ctx.documentId, 'layout_extracted', 'Extraction started');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  const headers: Record<string, string> = {
    ...form.getHeaders(),
  };
  if (process.env.API_SECRET) {
    headers['x-api-key'] = process.env.API_SECRET;
  }

  const resp = await axios.post(EXTRACTION_URL, form, {
    headers,
    timeout: timeouts.extract,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const document = (resp.data?.document ?? {}) as Record<string, unknown>;
  const elements = (resp.data?.elements ?? []) as ExtractElement[];

  await setPipelineStep(ctx.documentId, 'layout_extracted', {
    pipelineStatus: 'running',
  });
  await addEvent(ctx.documentId, 'layout_extracted', 'Layout/elements received', {
    elementCount: elements.length,
  });

  await ctx.updateProgress({
    step: 'pages_extracted',
    percent: 25,
    message: 'Persisting page checkpoints',
  });

  const byPage = groupByPage(elements);
  const pageNumbers = [...byPage.keys()].sort((a, b) => a - b);

  for (const pageNumber of pageNumbers) {
    const pageElements = byPage.get(pageNumber) ?? [];
    const text = pageElements
      .map((e) => (e.text || '').trim())
      .filter(Boolean)
      .join('\n\n');

    await upsertPage({
      documentId: ctx.documentId,
      pageNumber,
      text,
      elementsJson: pageElements,
      layoutJson: {
        source: 'document-extraction',
        elementCount: pageElements.length,
      },
      status: 'done',
    });

    await addEvent(
      ctx.documentId,
      'pages_extracted',
      `Page ${pageNumber}/${pageNumbers.length} saved`,
      { pageNumber, chars: text.length }
    );

    const percent =
      25 + Math.floor((pageNumber / Math.max(pageNumbers.length, 1)) * 15);
    await ctx.updateProgress({
      step: 'pages_extracted',
      percent,
      message: `Page ${pageNumber}/${pageNumbers.length}`,
    });
  }

  // If extractor returned no page numbers, store one synthetic page.
  if (pageNumbers.length === 0 && elements.length > 0) {
    const text = elements
      .map((e) => (e.text || '').trim())
      .filter(Boolean)
      .join('\n\n');
    await upsertPage({
      documentId: ctx.documentId,
      pageNumber: 1,
      text,
      elementsJson: elements,
      status: 'done',
    });
  }

  const pageCount =
    Number(document.page_count) ||
    pageNumbers.length ||
    (elements.length ? 1 : 0);

  await setPipelineStep(ctx.documentId, 'pages_extracted', {
    pipelineStatus: 'running',
    pageCount,
  });
  await addEvent(
    ctx.documentId,
    'pages_extracted',
    `Pages extracted (${pageCount})`
  );

  if (fileId) {
    await upsertDocumentProcessing({
      fileId,
      donorDocumentId: ctx.documentId,
    });
  }

  return { document, elements };
}
