import 'dotenv/config';
import pool from '../db';
import { addEvent, getDocument, requeueDocumentResume } from '../pipeline/repository';
import { connection, enqueueDocumentJob } from './queue';

const id = process.argv[2];
if (!id) {
  console.error('Usage: ts-node requeue-doc.ts <documentUuid>');
  process.exit(1);
}

async function main() {
  const before = await getDocument(id);
  console.log('before', before);
  if (!before) {
    throw new Error(`document ${id} not found`);
  }

  const doc = await requeueDocumentResume(id);
  if (!doc) {
    throw new Error(
      `Cannot requeue (status=${before.pipeline_status}). Use force reupload to start over.`
    );
  }

  const job = await enqueueDocumentJob(
    { documentId: id, source: doc.source },
    { force: true }
  );
  await addEvent(id, doc.pipeline_step || 'uploaded', 'CLI requeue — resume from checkpoint', {
    resumeFrom: doc.pipeline_step,
    jobId: job.jobId,
    mode: 'resume',
  });
  console.log('requeued', { resumeFrom: doc.pipeline_step, ...job });
}

main()
  .then(async () => {
    await pool.end();
    await connection.quit();
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    try {
      await connection.quit();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
