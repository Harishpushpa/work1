/** Shared Ollama HTTP base (chat/embed providers use fetch, not the `ollama` SDK). */
export const ollamaBaseUrl =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
