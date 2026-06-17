export const ERROR_CODES = [
  "E_PROJECT_NOT_ALLOWED",
  "E_PATH_TRAVERSAL",
  "E_SECRET_BLOCKED",
  "E_GITIGNORED",
  "E_SIZE_EXCEEDED",
  "E_NOT_FOUND",
  "E_HANDOFF_INCOMPLETE",
  "E_NOT_A_REPO",
  "E_WORKTREE_FAILED",
  "E_API_KEY_MODE",
  "E_AUTH_FAILED",
  "E_AUTH_RATE_LIMITED",
  "E_SELF_PROBE_OPEN"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ToolError = {
  error: {
    code: ErrorCode;
    message: string;
    path?: string;
  };
};

export class PlanbridgeError extends Error {
  readonly code: ErrorCode;
  readonly path?: string;

  constructor(code: ErrorCode, message: string, path?: string) {
    super(message);
    this.name = "PlanbridgeError";
    this.code = code;
    this.path = path;
  }
}
