import { Router } from 'express';
import { handleChat } from '../controllers/chatController';

const router = Router();

/**
 * @openapi
 * /chat:
 *   post:
 *     summary: Proxy chat requests to Haystack chat service
 *     tags:
 *       - Chat
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               conversationId:
 *                 type: string
 *                 format: uuid
 *                 description: Conversation identifier (optional). If provided, messages will be persisted.
 *               message:
 *                 type: string
 *               recent_messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                     content:
 *                       type: string
 *               summary:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       '200':
 *         description: Chat response from Haystack
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       '400':
 *         description: Bad request
 *       '500':
 *         description: Server error or haystack proxy failure
 */
router.post('/', handleChat);

export default router;
