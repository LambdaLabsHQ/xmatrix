export interface ProjectionObjectRef {
  /** Immutable, private R2 object key. This value is never a bearer capability. */
  objectKey: string;
  contentHash: string;
  encodedBytes: number;
  checksum: string;
}
