export const env = {
  signalingPort: Number(process.env.SIGNALING_PORT ?? 8080),
  aws: {
    region: process.env.AWS_REGION ?? '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? ''
  },
  dynamodbTablePrefix: process.env.DYNAMODB_TABLE_PREFIX ?? 'concord_',
  s3ServerIconsBucket: process.env.S3_SERVER_ICONS_BUCKET ?? ''
};

export function hasAwsCredentials(): boolean {
  return Boolean(env.aws.region && env.aws.accessKeyId && env.aws.secretAccessKey);
}
