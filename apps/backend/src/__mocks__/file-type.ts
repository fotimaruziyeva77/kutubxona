/**
 * Plan 06-04 SCH-05 — `file-type` is an ESM-only package (v19+); ts-jest's
 * default CJS transform cannot resolve it. Tests that need to spy on
 * `fileTypeFromBuffer` should `jest.mock("file-type", ...)` to override
 * this default stub.
 */
export async function fileTypeFromBuffer(_buffer: Buffer): Promise<undefined> {
  return undefined;
}
