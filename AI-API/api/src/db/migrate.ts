/**
 * Pipeline-only DDL for app-ai (shared DB with app-api).
 *
 * Product tables (`documents`, `faqs`, `summaries`, `chat_sessions`, `files`, …)
 * are owned exclusively by app-api — run:
 *   cd ../app-api && npm run db:migrate
 *   (existing DBs) npm run db:ensure-document-pipeline
 *   (shared files) npm run db:ensure-shared-files
 *
 * This script only creates app-ai owned tables.
 */
import pool from '../db';

const migrationSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Requires app-api documents table (FK targets).
CREATE TABLE IF NOT EXISTS document_pages (
  id SERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  layout_json JSONB,
  elements_json JSONB,
  ocr_confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Required for upsertPage ON CONFLICT (document_id, page_number).
-- IF NOT EXISTS table skips UNIQUE on older creates — ensure index separately.
CREATE UNIQUE INDEX IF NOT EXISTS document_pages_doc_page_uidx
  ON document_pages (document_id, page_number);
CREATE INDEX IF NOT EXISTS document_pages_doc_idx ON document_pages (document_id);

CREATE TABLE IF NOT EXISTS document_policy_refs (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_pipeline_events (
  id SERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  message TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS document_pipeline_events_doc_idx
  ON document_pipeline_events (document_id, id);

-- Chat message log used by app-ai /chat (conversationId = chat_sessions.id).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversation_messages'
      AND column_name = 'id'
      AND data_type <> 'uuid'
  ) THEN
    DROP TABLE conversation_messages CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'unknown',
  model VARCHAR(100) NOT NULL DEFAULT 'unknown',
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS conversation_id UUID;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS role VARCHAR(20);
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'unknown';
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'unknown';
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS total_tokens INTEGER;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

UPDATE conversation_messages SET provider = 'unknown' WHERE provider IS NULL;
UPDATE conversation_messages SET model = 'unknown' WHERE model IS NULL;
UPDATE conversation_messages SET role = 'user' WHERE role IS NULL;
UPDATE conversation_messages SET content = '' WHERE content IS NULL;

DO $$
BEGIN
  ALTER TABLE conversation_messages ALTER COLUMN provider SET NOT NULL;
  ALTER TABLE conversation_messages ALTER COLUMN model SET NOT NULL;
  ALTER TABLE conversation_messages ALTER COLUMN role SET NOT NULL;
  ALTER TABLE conversation_messages ALTER COLUMN content SET NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'conversation_messages NOT NULL tighten skipped: %', SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_id_idx
  ON conversation_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id UUID PRIMARY KEY,
  summary TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_cost_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID,
  document_id UUID,
  client_id VARCHAR(100),
  operation VARCHAR(50) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  completion_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS summary_generation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  user_id VARCHAR(100),
  tenant_id VARCHAR(100),
  operation VARCHAR(20) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  completion_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  input_token_breakdown JSONB,
  input_cost_breakdown JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- RAG evaluation harness (app-ai owned)
CREATE TABLE IF NOT EXISTS rag_test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  document_id UUID,
  status TEXT NOT NULL DEFAULT 'queued',
  text TEXT NOT NULL DEFAULT '',
  questions_path TEXT,
  document_name TEXT,
  question_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  report_path TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rag_test_runs_created_idx
  ON rag_test_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS rag_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES rag_test_runs(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  actual_answer TEXT NOT NULL DEFAULT '',
  llm_response TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  latency_ms INTEGER,
  sources JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rag_test_results_run_idx
  ON rag_test_results (run_id, created_at);
`;

async function migrate(options?: { endPool?: boolean }): Promise<void> {
  const endPool = options?.endPool === true;
  let client;
  try {
    console.log(
      'Running app-ai pipeline setup (documents DDL = app-api only)...'
    );
    client = await pool.connect();
    await client.query(migrationSql);
    console.log('Pipeline setup complete');
  } catch (err: any) {
    console.error('Migration failed', err);
    if (err?.code === '28P01') {
      console.error(
        'Auth failed (28P01). Check [postgres] log / POSTGRES_URL encoding.'
      );
    }
    if (err?.code === '42P01' && /documents/i.test(String(err?.message))) {
      console.error(
        'Missing documents table. Run app-api migrations first:\n' +
          '  cd ../app-api && npm run db:migrate\n' +
          '  npm run db:ensure-document-pipeline'
      );
    }
    throw err;
  } finally {
    client?.release();
    if (endPool) {
      await pool.end();
    }
  }
}

if (require.main === module) {
  migrate({ endPool: true }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { migrate };
