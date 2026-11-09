import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  real,
  uuid,
} from 'drizzle-orm/pg-core';

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  location: text('location').notNull(),
  status: text('status').notNull().default('pending'),
  pipeline_step: text('pipeline_step').notNull().default('uploaded'),
  pipeline_status: text('pipeline_status').notNull().default('queued'),
  /** Enum: customer | admin | folder */
  source: text('source').notNull().default('admin'),
  priority: integer('priority').notNull().default(10),
  file_name: text('file_name'),
  file_hash: text('file_hash'),
  /** FK → files.id (shared physical bytes). DDL owned by app-api. */
  file_id: uuid('file_id'),
  page_count: integer('page_count'),
  chat_ready: boolean('chat_ready').notNull().default(false),
  last_heartbeat_at: timestamp('last_heartbeat_at', { mode: 'date' }),
  result: jsonb('result'),
  error: text('error'),
  /** Optional Insursa policy id / policy number; null until linked */
  policy_id: text('policy_id'),
  /** Customer chat session (required for source=customer uploads) */
  session_id: uuid('session_id'),
  retry_count: integer('retry_count').notNull().default(0),
  retry_limit: integer('retry_limit').notNull().default(3),
  created_at: timestamp('created_at', { mode: 'date' }).defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'date' }).defaultNow(),
});


export const document_pages = pgTable('document_pages', {
  id: serial('id').primaryKey(),
  document_id: uuid('document_id').notNull(),
  page_number: integer('page_number').notNull(),
  text: text('text').notNull().default(''),
  layout_json: jsonb('layout_json'),
  elements_json: jsonb('elements_json'),
  ocr_confidence: real('ocr_confidence'),
  status: text('status').notNull().default('pending'),
  created_at: timestamp('created_at', { mode: 'date' }).defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'date' }).defaultNow(),
});

export type Documents = typeof documents.$inferSelect;
