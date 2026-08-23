export const env = {
  signalingPort: Number(process.env.SIGNALING_PORT ?? 8080),
  tls: {
    certPath: process.env.TLS_CERT_PATH ?? '',
    keyPath: process.env.TLS_KEY_PATH ?? ''
  },
  aws: {
    region: process.env.AWS_REGION ?? ''
  },
  dynamodbTablePrefix: process.env.DYNAMODB_TABLE_PREFIX ?? 'concord_',
  s3ServerIconsBucket: process.env.S3_SERVER_ICONS_BUCKET ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? ''
};

export function hasAwsRegion(): boolean {
  return Boolean(env.aws.region);
}

export function hasSessionSecret(): boolean {
  return Boolean(env.sessionSecret);
}
