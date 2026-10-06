// @ts-ignore Node's native TS runner requires .ts; Wrangler resolves and validates the same source.

export type RelayR2DownloadGatewayErrorCode =
  | "method_not_allowed"
  | "invalid_request"
  | "not_authorized"
  | "authority_integrity_unavailable";

export class RelayR2DownloadGatewayError extends Error {
  readonly code: RelayR2DownloadGatewayErrorCode;
  readonly status: number;

  constructor(code: RelayR2DownloadGatewayErrorCode, status: number, message: string) {
    super(message);
    this.name = "RelayR2DownloadGatewayError";
    this.code = code;
    this.status = status;
  }
}

export interface RelayPrivateR2ObjectMetadata {
  size: number;
  checksumSha256: string;
  etag: string;
}

