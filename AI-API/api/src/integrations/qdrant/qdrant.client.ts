import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../platform/config";

export const qdrantClient = new QdrantClient({
  url: config.qdrant.url,
  apiKey: config.qdrant.apiKey || undefined,
});