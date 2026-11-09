import { Router, Request, Response } from 'express';
import { jobQueue } from '../queues/queue';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name = 'default', data = {} } = req.body || {};
    const job = await jobQueue.add(name, data, {
      removeOnComplete: 100,
      removeOnFail: 100
    });
    res.status(201).json({ id: job.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to enqueue job' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const job = await jobQueue.getJob(id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const state = await job.getState();
    res.json({
      id: job.id,
      name: job.name,
      state,
      progress: job.progress,
      returnvalue: job.returnvalue
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to get job' });
  }
});

export default router;
