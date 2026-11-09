import { Router } from "express";
import { ConversationController } from "./conversation.controller";

const router = Router();

const controller = new ConversationController();

/**
 * @swagger
 * /api/conversations/summaries:
 *   get:
 *     tags:
 *       - Conversation
 *     summary: List all conversation summaries
 *     description: Returns all stored conversation summaries.
 *     responses:
 *       200:
 *         description: Conversation summaries fetched successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ConversationSummary'
 *       500:
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/summaries", controller.listSummaries.bind(controller));

/**
 * @swagger
 * /api/conversations/{conversationId}/messages:
 *   get:
 *     tags:
 *       - Conversation
 *     summary: Get conversation messages
 *     description: Retrieves all messages for the specified conversation.
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation identifier.
 *     responses:
 *       200:
 *         description: Conversation messages retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ChatMessage'
 *       500:
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
  "/:conversationId/messages",
  controller.getMessages.bind(controller)
);
/**
 * @swagger
 * /api/conversations/{conversationId}/messages:
 *   post:
 *     tags:
 *       - Conversation
 *     summary: Save or append conversation messages
 *     description: |
 *       - `{ "messages": [ { role, content } ] }` → append (FAQ browse, no LLM)
 *       - `{ "role", "content" }` → save a single message
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Single message saved
 *       201:
 *         description: Messages appended
 *       400:
 *         description: Invalid request
 */
router.post(
  "/:conversationId/messages",
  controller.postMessages.bind(controller)
);

/**
 * @swagger
 * /api/conversations/{conversationId}/messages:
 *   delete:
 *     tags:
 *       - Conversation
 *     summary: Delete conversation messages
 *     description: Deletes all messages for the specified conversation.
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation identifier.
 *     responses:
 *       200:
 *         description: Conversation messages deleted successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: string
 *                       example: Conversation messages deleted successfully
 *       500:
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete(
  "/:conversationId/messages",
  controller.deleteMessages.bind(controller)
);

/**
 * @swagger
 * /api/conversations/{conversationId}/summary/generate:
 *   post:
 *     tags:
 *       - Conversation
 *     summary: Generate conversation summary
 *     description: Generates or updates a conversation summary using LLM and stores it in PostgreSQL and Redis.
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation identifier.
 *     responses:
 *       200:
 *         description: Conversation summary generated successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/GenerateSummaryResult'
 *       404:
 *         description: No conversation history found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  "/:conversationId/summary/generate",
  controller.generateSummary.bind(controller)
);

/**
 * @swagger
 * /api/conversations/{conversationId}/summary:
 *   delete:
 *     tags:
 *       - Conversation
 *     summary: Delete conversation summary
 *     description: Deletes the summary for the specified conversation.
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation identifier.
 *     responses:
 *       200:
 *         description: Conversation summary deleted successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: string
 *                       example: Conversation summary deleted successfully
 *       500:
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete(
  "/:conversationId/summary",
  controller.deleteSummary.bind(controller)
);

export default router;
