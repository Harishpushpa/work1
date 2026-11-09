/**
 * Pipeline-only tables owned by app-ai.
 *
 * Shared `documents` row (product + pipeline columns) is owned by app-api —
 * do not define/migrate that table here. See app-api `src/db/schema.ts`.
 */
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  real,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const documentPagesTable = pgTable(
  'document_pages',
  {
    id: serial('id').primaryKey(),
    documentId: uuid('document_id').notNull(),
    pageNumber: integer('page_number').notNull(),
    text: text('text').notNull().default(''),
    layoutJson: jsonb('layout_json'),
    elementsJson: jsonb('elements_json'),
    ocrConfidence: real('ocr_confidence'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    docPageUnique: uniqueIndex('document_pages_doc_page_uidx').on(
      t.documentId,
      t.pageNumber
    ),
  })
);

export const documentPipelineEventsTable = pgTable(
  'document_pipeline_events',
  {
    id: serial('id').primaryKey(),
    documentId: uuid('document_id').notNull(),
    step: text('step').notNull(),
    message: text('message').notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  }
);

/** Policy interpretation refs from Haystack interpret step. */
export const documentPolicyRefsTable = pgTable('document_policy_refs', {
  documentId: uuid('document_id').primaryKey(),
  refs: jsonb('refs').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
