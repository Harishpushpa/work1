import { ChatRole } from "./chat-message";
import { Usage } from "./usage";

export interface Citation {
  index: number;
  documentId?: string;
  documentName?: string;
  pageNumber?: number | null;
  // single chunk id (if non-condensed)
  chunkId?: string;
  // condensed chunk ids when multiple chunks map to same page
  chunkIds?: string[];
}

export interface ChatResponse {
  conversationId: string;
  provider: string;
  model: string;
  message: ChatResponseMessage;
  cost?: any;
  finishReason?: string;
  // Optional citations when response used knowledge retrieval.
  citations?: Citation[];
  // Optional detailed citation texts (website/document metadata + snippets)
  citationDetails?: any[];
  // Optional used sources when response used knowledge retrieval.
  usedSources?: any[];
}

export interface ChatResponseMessage {
  role: ChatRole;
  content: string;
}