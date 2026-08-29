/** Shared by every src/db/*.ts repo — just the D1 binding, nothing else, so each repo module
 * stays a plain set of functions (same shape as packages/server/src/db/*.ts) rather than a class. */
export interface DbEnv {
  DB: D1Database;
}
