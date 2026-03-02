export default () => ({
  port: parseInt(process.env.PORT ?? "3009", 10),
  database: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://atto:atto_dev@localhost:5442/atto_telephony",
  },
  jwt: {
    secret: process.env.JWT_SECRET || "change-me-in-production",
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    useTls: process.env.KAFKA_USE_TLS === "true",
    saslUsername: process.env.KAFKA_SASL_USERNAME || "",
    saslPassword: process.env.KAFKA_SASL_PASSWORD || "",
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    apiKeySid: process.env.TWILIO_API_KEY_SID || "",
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET || "",
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID || "",
    pushCredentialSidFcm: process.env.TWILIO_PUSH_CREDENTIAL_SID_FCM || "",
    pushCredentialSidApns: process.env.TWILIO_PUSH_CREDENTIAL_SID_APNS || "",
    devMode: process.env.TWILIO_DEV_MODE === "true",
    bridgeNumber: process.env.TWILIO_BRIDGE_NUMBER || "",
  },
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || "http://localhost:3009",
  s3: {
    endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || "",
    accessKey: process.env.S3_ACCESS_KEY || "atto_minio",
    secretKey: process.env.S3_SECRET_KEY || "atto_minio_dev",
    bucket: process.env.S3_BUCKET || "atto-audio-segments",
    region: process.env.S3_REGION || "us-east-1",
  },
});
