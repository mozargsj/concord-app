import { AwsClient } from 'aws4fetch';

const UPLOAD_URL_TTL_SECONDS = 300;
const GET_URL_TTL_SECONDS = 3600;

/**
 * R2 presigned URLs via its S3-compatible API, signed with aws4fetch — same pattern Cloudflare's
 * own docs use for R2 (developers.cloudflare.com/r2/objects/upload-objects/#presigned-urls-workers).
 * Mirrors packages/server/src/aws/s3Client.ts, but R2 needs its own API token (Access Key
 * ID/Secret, from the R2 dashboard's "Manage API tokens") — not the same credentials as the
 * general Cloudflare account API token used elsewhere in this Worker's deploy tooling, and not
 * AWS credentials at all despite the aws4fetch/SigV4 machinery being reused.
 */
export interface R2Env {
  CF_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

function client(env: R2Env): AwsClient {
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY });
}

function objectUrl(env: R2Env, key: string): URL {
  return new URL(`https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`);
}

export async function createPresignedUploadUrl(env: R2Env, key: string, contentType: string): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL_SECONDS));
  const signed = await client(env).sign(new Request(url, { method: 'PUT', headers: { 'Content-Type': contentType } }), {
    aws: { signQuery: true }
  });
  return signed.url;
}

export async function createPresignedGetUrl(env: R2Env, key: string): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(GET_URL_TTL_SECONDS));
  const signed = await client(env).sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
  return signed.url;
}

