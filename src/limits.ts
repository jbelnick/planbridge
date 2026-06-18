export type Limits = {
  maxBytesPerFile: number;
  maxFilesPerRead: number;
  maxFilesPerSession: number;
  maxContextBytes: number;
  maxSearchResults: number;
  maxMatchPreviewBytes: number;
  maxDiffBytes: number;
  toolTimeoutMs: number;
  codexExecTimeoutMs: number;
  proConsultTimeoutMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxBytesPerFile: 64 * 1024,
  maxFilesPerRead: 20,
  maxFilesPerSession: 200,
  maxContextBytes: 512 * 1024,
  maxSearchResults: 50,
  maxMatchPreviewBytes: 4 * 1024,
  maxDiffBytes: 256 * 1024,
  toolTimeoutMs: 15000,
  codexExecTimeoutMs: 1_800_000,
  proConsultTimeoutMs: 600_000
};

export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...overrides };
}
