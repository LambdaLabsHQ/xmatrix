/** Common command rejection fields; domains retain their public error classes. */
export class ControlError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryable = false) {
    super(message);
  }
}

/** Rejections that also carry scoped recovery or conflict details. */
export class DetailedControlError extends ControlError {
  constructor(code: string, status: number, message: string, retryable = false,
    readonly details?: Readonly<Record<string, unknown>>) {
    super(code, status, message, retryable);
  }
}
