// SAL — Storage Abstraction Layer. Every adapter implements the same three operations
// (upload ticket, confirm, read ticket) so no application code depends on a provider.
// Phase 1 ships the S3-compatible dev adapter (CR-19); the Drive adapter waits on S7.

export type StorageCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type OrgStorageTarget = {
  endpoint: string;
  bucket: string;
  region: string;
  keyPrefix: string;
  pendingPrefix: string;
  credentials: StorageCredentials;
};

export type SignedUploadTicket = {
  url: string;
  method: "POST";
  /** Multipart form fields. Append these, then the file part, in this order. */
  fields: Record<string, string>;
  expiresAt: number;
};

export type SignedReadTicket = {
  url: string;
  expiresAt: number;
};

export interface StorageAdapter {
  readonly name: "s3";
  /** Each adapter declares which operations it supports (SAL contract). */
  readonly supports: { upload: boolean; confirm: boolean; read: boolean };
  requestUpload(args: {
    target: OrgStorageTarget;
    key: string;
    contentType: string;
    expiresInSeconds: number;
    /** Upper bound signed into the POST policy's `content-length-range`. */
    maxBytes: number;
  }): Promise<SignedUploadTicket>;
  /** HEAD on the pending object: exists?, actual size, stored content type. */
  headObject(args: {
    target: OrgStorageTarget;
    key: string;
  }): Promise<{ size: number; contentType: string | null } | null>;
  /** Server-side promotion out of pending/ — a bucket metadata operation, no bytes through us. */
  promoteObject(args: {
    target: OrgStorageTarget;
    fromKey: string;
    toKey: string;
  }): Promise<void>;
  requestRead(args: {
    target: OrgStorageTarget;
    key: string;
    expiresInSeconds: number;
  }): Promise<SignedReadTicket>;
  deleteObject(args: { target: OrgStorageTarget; key: string }): Promise<void>;
}
