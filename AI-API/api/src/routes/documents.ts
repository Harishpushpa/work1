import { Router } from 'express';
import {
  bulkDeleteDocuments,
  deleteDocument,
  getDocumentStatus,
  listAdminDocuments,
  listDocumentFaqs,
  listDocumentSummaries,
  requeueDocument,
} from '../controllers/documentController';

const router = Router();

/**
 * @openapi
 * /documents:
 *   get:
 *     summary: List documents (admin KB portal)
 *     tags: [Documents]
 *     parameters:
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [admin, customer]
 *           default: admin
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 */
router.get('/', listAdminDocuments);

/**
 * @openapi
 * /documents/bulk-delete:
 *   post:
 *     summary: Delete multiple documents (file, Qdrant vectors, FAQs, pipeline)
 *     tags: [Documents]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       '200':
 *         description: Bulk delete result
 */
router.post('/bulk-delete', bulkDeleteDocuments);

/**
 * @openapi
 * /documents/{id}:
 *   get:
 *     summary: Get document pipeline status
 *     tags: [Documents]
 *   delete:
 *     summary: Delete document (file, Qdrant vectors, FAQs, pipeline)
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '200':
 *         description: Document deleted
 *       '404':
 *         description: Document not found
 *       '409':
 *         description: Document is still processing
 */
router.get('/:id', getDocumentStatus);
router.delete('/:id', deleteDocument);

/**
 * @openapi
 * /documents/{id}/requeue:
 *   post:
 *     summary: Requeue a failed/queued document (resume from last checkpoint)
 *     description: |
 *       Clears error and retry budget, keeps pages/policy_refs/FAQs, and resumes
 *       from `pipeline_step`. Use force re-upload to wipe checkpoints and start over.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       '202':
 *         description: Document requeued for resume
 *       '404':
 *         description: Document not found
 *       '409':
 *         description: Document is running or completed
 */
router.post('/:id/requeue', requeueDocument);

/**
 * @openapi
 * /documents/{id}/faqs:
 *   get:
 *     summary: List FAQs for a document
 *     tags: [Documents]
 */
router.get('/:id/faqs', listDocumentFaqs);

/**
 * @openapi
 * /documents/{id}/summaries:
 *   get:
 *     summary: List summaries for a document
 *     tags: [Documents]
 */
router.get('/:id/summaries', listDocumentSummaries);

export default router;
