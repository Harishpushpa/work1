# app (Node.js + BullMQ)

Lightweight Node.js service that demonstrates:
- Express API protected by a secret key middleware
- BullMQ job queue + worker

Quick start:
1. Copy `.env.example` to `.env` and set `API_SECRET` and `REDIS_URL`.
2. `npm install`
3. Start Redis (local or remote)
4. Run worker: `npm run worker` / `npm run dev:worker`
5. Run server: `npm start` / `npm run dev`

Endpoints (all require the API secret):
- POST /jobs { "name": "taskName", "data": { ... } } -> { "id": "<jobId>" }
- GET /jobs/:id -> job state and result

RAG testing pipeline:
- `POST /api/testing/runs` (multipart): `document` + `text` (meta: embedding/model) + optional `questions` xlsx
  - Creates a session → uploads → waits for ingestion → asks each Excel question in that session → stores report
- `GET /api/testing/runs/:runId` — status
- `GET /api/testing/runs/:runId/report` — question / actualAnswer / llmResponse
- Default questions path: `RAG_TEST_QUESTIONS_PATH` (see `.env.example`)

The middleware expects the secret in `x-api-key` header, `Authorization: Bearer <key>` header, or `?api_key=...`.
