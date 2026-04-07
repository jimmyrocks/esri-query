// Lightweight S3 helpers with lazy AWS SDK import.
// No compile-time dependency: modules are loaded dynamically only when used.

import { PassThrough } from 'stream';
import { createReadStream } from 'fs';

export type S3Url = { bucket: string; key: string; params?: Record<string, string> };

export function parseS3Url(url: string): S3Url | null {
  if (!url || typeof url !== 'string') return null;
  // Accept s3://bucket/key or s3://bucket
  if (!url.startsWith('s3://')) return null;
  const restAll = url.slice('s3://'.length);
  const qpos = restAll.indexOf('?');
  const rest = qpos >= 0 ? restAll.slice(0, qpos) : restAll;
  const search = qpos >= 0 ? restAll.slice(qpos + 1) : '';
  const slash = rest.indexOf('/');
  if (slash < 0) return { bucket: rest, key: '' };
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!bucket) return null;
  const params: Record<string, string> = {};
  if (search) {
    for (const part of search.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 0) { params[decodeURIComponent(part)] = ''; continue; }
      const k = decodeURIComponent(part.slice(0, eq));
      const v = decodeURIComponent(part.slice(eq + 1));
      params[k] = v;
    }
  }
  return { bucket, key, params: Object.keys(params).length ? params : undefined };
}

async function getS3(): Promise<{ S3Client: any; PutObjectCommand: any } & { Upload?: any } > {
  try {
    const c = await import('@aws-sdk/client-s3');
    let Upload: any;
    try {
      // Optional for streaming uploads
      ({ Upload } = await import('@aws-sdk/lib-storage'));
    } catch {}
    return { ...c, Upload } as any;
  } catch (e) {
    const msg = 'S3 support requires @aws-sdk/client-s3 (and optionally @aws-sdk/lib-storage). Install with: npm i @aws-sdk/client-s3 @aws-sdk/lib-storage';
    throw new Error(msg);
  }
}

export async function createS3Client(config?: { region?: string; endpoint?: string; forcePathStyle?: boolean }) {
  const { S3Client } = await getS3();
  const region = config?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const endpoint = config?.endpoint ?? process.env.AWS_S3_ENDPOINT;
  const forcePathStyle = config?.forcePathStyle ?? (process.env.AWS_S3_FORCE_PATH_STYLE === '1');
  const client = new S3Client({ region, endpoint, forcePathStyle });
  return client;
}

// Start a streaming multi-part upload and return a writable stream and a completion promise.
export async function startS3UploadStream(opts: { bucket: string; key: string; contentType?: string; acl?: string; storageClass?: string; sse?: string; ssekmsKeyId?: string; clientConfig?: { region?: string; endpoint?: string; forcePathStyle?: boolean } }) {
  const { Upload } = await getS3();
  if (!Upload) throw new Error('Streaming uploads require @aws-sdk/lib-storage. Install with: npm i @aws-sdk/lib-storage');
  const client = await createS3Client(opts.clientConfig);
  const body = new PassThrough();
  const uploader = new Upload({
    client,
    params: {
      Bucket: opts.bucket,
      Key: opts.key,
      Body: body,
      ContentType: opts.contentType,
      ACL: opts.acl as any,
      StorageClass: opts.storageClass as any,
      ServerSideEncryption: opts.sse as any,
      SSEKMSKeyId: opts.ssekmsKeyId,
    },
    queueSize: 4,
    partSize: 8 << 20,
    leavePartsOnError: false,
  } as any);
  const done = uploader.done();
  return { stream: body, done };
}

export async function putS3Object(opts: { bucket: string; key: string; bytes: Uint8Array; contentType?: string; acl?: string; storageClass?: string; sse?: string; ssekmsKeyId?: string; clientConfig?: { region?: string; endpoint?: string; forcePathStyle?: boolean } }) {
  const { S3Client, PutObjectCommand } = await getS3();
  const client = await createS3Client(opts.clientConfig);
  const cmd = new PutObjectCommand({
    Bucket: opts.bucket,
    Key: opts.key,
    Body: opts.bytes,
    ContentType: opts.contentType,
    ACL: opts.acl as any,
    StorageClass: opts.storageClass as any,
    ServerSideEncryption: opts.sse as any,
    SSEKMSKeyId: opts.ssekmsKeyId,
  } as any);
  return client.send(cmd);
}

export async function uploadFileToS3(opts: { bucket: string; key: string; filePath: string; contentType?: string; acl?: string; storageClass?: string; sse?: string; ssekmsKeyId?: string; clientConfig?: { region?: string; endpoint?: string; forcePathStyle?: boolean } }) {
  const { S3Client, PutObjectCommand, Upload } = await getS3();
  const client = await createS3Client(opts.clientConfig);
  const body = createReadStream(opts.filePath);
  if (Upload) {
    const up = new (Upload as any)({
      client,
      params: {
        Bucket: opts.bucket,
        Key: opts.key,
        Body: body,
        ContentType: opts.contentType,
        ACL: opts.acl as any,
        StorageClass: opts.storageClass as any,
        ServerSideEncryption: opts.sse as any,
        SSEKMSKeyId: opts.ssekmsKeyId,
      },
      queueSize: 4,
      partSize: 8 << 20,
      leavePartsOnError: false,
    });
    return up.done();
  }
  const cmd = new PutObjectCommand({
    Bucket: opts.bucket,
    Key: opts.key,
    Body: body,
    ContentType: opts.contentType,
    ACL: opts.acl as any,
    StorageClass: opts.storageClass as any,
    ServerSideEncryption: opts.sse as any,
    SSEKMSKeyId: opts.ssekmsKeyId,
  } as any);
  return client.send(cmd);
}
