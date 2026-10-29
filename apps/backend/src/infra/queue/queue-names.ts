/**
 * Queue name constants — extracted from queue.module.ts to break circular
 * imports between processors (which use @Processor(QUEUE_NAME)) and the
 * QueueModule (which lists those processors as providers).
 *
 * Every file that needs a queue name string should import from HERE, not
 * from queue.module.ts.
 */

export const NOTIFICATION_QUEUE = "notifications";
export const REPORT_QUEUE = "reports";
export const AI_QUEUE = "ai-tasks";
export const RI_RECALC_QUEUE = "ri-recalc";
export const BOOK_IMPORT_QUEUE = "book-import";
export const PAYMENT_TIMEOUT_QUEUE = "payment-timeout";
export const STATS_AGGREGATION_QUEUE = "stats-aggregation";
export const STORE_PRODUCT_IMPORT_QUEUE = "store-product-import";
