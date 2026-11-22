// Object storage (Railway bucket, S3-compatible). The bucket is the source of truth for all files;
// GDAL work happens on local copies in the cache folder (see cache.ts).
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BUCKET = process.env.S3_BUCKET ?? '';
if (!BUCKET) throw new Error('S3_BUCKET ontbreekt. Start lokaal met `npm run dev` (gebruikt `railway run`).');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'auto',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '' },
  forcePathStyle: false,
});

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.geojson': 'application/geo+json', '.pdf': 'application/pdf', '.tif': 'image/tiff',
  '.mbtiles': 'application/vnd.sqlite3',
};
export const contentType = (key: string) => TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';

export async function putFile(key: string, file: string): Promise<number> {
  const { size } = await fs.stat(file);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: contentType(key) }));
  return size;
}

export async function putBuffer(key: string, body: Buffer | string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType(key) }));
}

export async function getFile(key: string, file: string): Promise<void> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  await pipeline(r.Body as Readable, createWriteStream(tmp));
  await fs.rename(tmp, file);
}

/** Streams an object (for serving through the API). Returns null when it doesn't exist. */
export async function getStream(key: string): Promise<{ body: Readable; type: string; size?: number } | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { body: r.Body as Readable, type: r.ContentType ?? contentType(key), size: r.ContentLength };
  } catch (e: any) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function list(prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function removePrefix(prefix: string): Promise<void> {
  const keys = (await list(prefix)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
}

export async function remove(key: string): Promise<void> {
  await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: key }] } }));
}

export async function copy(from: string, to: string): Promise<void> {
  await s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${encodeURI(from)}`, Key: to }));
}

export async function copyPrefix(from: string, to: string): Promise<void> {
  for (const o of await list(from)) await copy(o.key, to + o.key.slice(from.length));
}

/** Temporary download link straight from the bucket (the app downloads big files this way, not through the server). */
export function signedUrl(key: string, seconds = 3600): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: seconds });
}
