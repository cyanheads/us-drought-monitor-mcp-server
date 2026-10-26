/**
 * @fileoverview Load operator environment before constructing public tool schemas.
 * @module config/load-env
 */
try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
