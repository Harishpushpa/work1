export const CacheKeys = {
    conversation: (id: string) => `conversation:${id}`,
    prompt: (hash: string) => `prompt:${hash}`,
    session: (id: string) => `session:${id}`,
    otp: (email: string) => `otp:${email}`,
} as const;
