/**
 * Compatibility alias for pre-v88 clients.
 *
 * The former handler generated only four sampled indication rows for three
 * hard-coded symbols. Re-exporting the canonical cron handler makes every
 * caller use the configured symbol basket, complete Default/Additional/Common
 * matrices, exact lane timers, and the same Strategy pipeline.
 */
export {
  GET,
  POST,
  dynamic,
} from "@/app/api/cron/generate-indications/route"
