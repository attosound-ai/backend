import { registerAs } from '@nestjs/config';

export default registerAs('email', () => ({
  provider: process.env.EMAIL_PROVIDER || 'mailpit',

  // Resend (production)
  resendApiKey: process.env.RESEND_API_KEY || '',

  // Mailpit / SMTP (development)
  mailpitHost: process.env.MAILPIT_HOST || 'mailpit',
  mailpitPort: parseInt(process.env.MAILPIT_PORT || '1025', 10),

  // Default sender (fallback for all templates)
  from: process.env.EMAIL_FROM || 'dev@atto.local',
  fromName: process.env.EMAIL_FROM_NAME || 'Atto Dev',

  // Per-category senders — fall back to EMAIL_FROM if unset
  fromAuth:    process.env.EMAIL_FROM_AUTH    || process.env.EMAIL_FROM || 'dev@atto.local',
  fromWelcome: process.env.EMAIL_FROM_WELCOME || process.env.EMAIL_FROM || 'dev@atto.local',

  // App
  appDeeplink: process.env.APP_DEEPLINK || 'atto://',
  appUrl: process.env.APP_URL || 'https://atto.app',
}));
