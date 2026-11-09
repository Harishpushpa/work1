import { AsyncLocalStorage } from "node:async_hooks";

export interface ContextStore {
  requestId: string;
  userId?: string;
  tenantId?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<ContextStore>();

export class RequestContext {
  static run(store: ContextStore, callback: () => void) {
    asyncLocalStorage.run(store, callback);
  }

  static getStore() {
    return asyncLocalStorage.getStore();
  }

  static getRequestId() {
    return asyncLocalStorage.getStore()?.requestId;
  }

  static getUserId() {
    return asyncLocalStorage.getStore()?.userId;
  }

  static getTenantId() {
    return asyncLocalStorage.getStore()?.tenantId;
  }
}