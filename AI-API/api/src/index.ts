import express from 'express';
import { loadApiEnv } from './platform/database/postgres-env';

loadApiEnv();

import authMiddleware from './middleware/auth';
import corsMiddleware from './middleware/cors';
import jobsRouter from './routes/jobs';
import uploadRouter from './routes/upload';
import documentsRouter from './routes/documents';
import chatRouter from './routes/chat';
import conversationRouter from './conversation/conversation.route';
import testingRouter from './testing/testing.route';
import swaggerUi from 'swagger-ui-express';
import { redisClient } from './platform/cache/redis.client';
import { migrate } from './db/migrate';

const app = express();
// CORS before auth so browser preflight (OPTIONS + X-Api-Key) succeeds
app.use(corsMiddleware);
app.use(express.json());

// Swagger UI (no auth) — OpenAPI spec in swagger.json
import swaggerSpec from './swagger.json';
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec as any, {
    customSiteTitle: 'App AI API Docs',
    swaggerOptions: {
      persistAuthorization: true,
    },
  })
);
app.get('/openapi.json', (_req, res) => {
  res.json(swaggerSpec);
});

// Protect API routes with the secret-key middleware
app.use(authMiddleware);

app.use('/jobs', jobsRouter);
app.use('/upload', uploadRouter);
app.use('/documents', documentsRouter);
app.use('/chat', chatRouter);
app.use('/api/conversations', conversationRouter);
app.use('/api/testing', testingRouter);

const PORT = process.env.PORT || 3000;

async function init() {
  try {
    await migrate();
  } catch (err: any) {
    console.error('Pipeline DDL ensure failed:', err?.message ?? err);
  }

  try {
    await redisClient.connect();
    console.log('Redis client connected');
  } catch (err: any) {
    console.error('Failed to connect Redis client:', err?.message ?? err);
  }

  app.listen(Number(PORT), () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Swagger UI: http://localhost:${PORT}/docs`);
    console.log('Protected by API_SECRET; set .env or environment variable API_SECRET');
  });
}

init();

export default app;

