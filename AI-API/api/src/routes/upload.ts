import { Router } from 'express';
import { uploadMiddleware, uploadFiles } from '../controllers/uploadController';

const router = Router();

/**
 * @openapi
 * /upload:
 *   post:
 *     summary: Upload documents and enqueue pipeline jobs
 *     description: |
 *       Saves files and enqueues pipeline jobs.
 *       Physical bytes are stored once in `files` (SHA-256). Each source gets its own
 *       `documents` association (never reuses admin/folder ownership for customer).
 *       - source=admin (default): no session_id; Qdrant `general`; FAQs only
 *       - source=folder: same as admin (FAQs); for folder ingest
 *       - source=customer: **session_id required**; Qdrant `customer`; summaries only.
 *         Same hash+policy completed customer doc reuses that row and re-posts summary.
 *     tags:
 *       - Upload
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - files
 *             properties:
 *               folder:
 *                 type: string
 *               source:
 *                 type: string
 *                 enum: [customer, admin, folder]
 *                 default: admin
 *               session_id:
 *                 type: string
 *                 format: uuid
 *                 description: Required when source=customer
 *               policy_id:
 *                 type: string
 *               force:
 *                 type: boolean
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       '202':
 *         description: Files accepted and pipeline jobs enqueued
 *       '400':
 *         description: Bad request (no files, or customer without valid active session_id)
 *       '404':
 *         description: session_id not found
 *       '500':
 *         description: Server error
 */
router.post('/', uploadMiddleware.array('files', 50), uploadFiles);

export default router;
