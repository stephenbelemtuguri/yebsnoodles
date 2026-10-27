// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - Application Configuration
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();

const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  
  // Security
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
  sessionSecret: process.env.SESSION_SECRET || 'session-secret-change-in-production',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '43200000', 10), // 12 hours
  
  // Database
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisPassword: process.env.REDIS_PASSWORD,
  
  // MTN MoMo
  momo: {
    enabled: process.env.MOMO_ENABLED === 'true',
    subscriptionKey: process.env.MOMO_SUBSCRIPTION_KEY,
    apiKey: process.env.MOMO_API_KEY,
    apiSecret: process.env.MOMO_API_SECRET,
    referenceId: process.env.MOMO_REFERENCE_ID,
    callbackHost: process.env.MOMO_CALLBACK_HOST || process.env.BASE_URL,
    environment: process.env.MOMO_ENVIRONMENT || 'sandbox',
    businessNumber: process.env.MOMO_BUSINESS_NUMBER || '0559103452',
    merchantName: process.env.MOMO_MERCHANT_NAME || 'YEBS Noodles',
    // API endpoints
    baseUrl: process.env.MOMO_ENVIRONMENT === 'production' 
      ? 'https://proxy.momoapi.mtn.com'
      : 'https://sandbox.momodeveloper.mtn.com'
  },
  
  // Google Maps & Geocoding
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
    geocodingProvider: process.env.GEOCODING_PROVIDER || 'google'
  },
  mapbox: {
    accessToken: process.env.MAPBOX_ACCESS_TOKEN
  },
  
  // SMS
  sms: {
    enabled: process.env.SMS_ENABLED === 'true',
    provider: process.env.SMS_PROVIDER || 'hubtel',
    hubtel: {
      clientId: process.env.HUBTEL_CLIENT_ID,
      clientSecret: process.env.HUBTEL_CLIENT_SECRET,
      senderId: process.env.HUBTEL_SENDER_ID || 'YEBS'
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      fromNumber: process.env.TWILIO_FROM_NUMBER
    }
  },
  
  // Email
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    provider: process.env.EMAIL_PROVIDER || 'smtp',
    from: process.env.EMAIL_FROM || 'YEBS Noodles <noreply@yebs-noodles.com>',
    smtp: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD
    },
    sendgrid: {
      apiKey: process.env.SENDGRID_API_KEY
    }
  },
  
  // Push Notifications (FCM)
  fcm: {
    enabled: process.env.FCM_ENABLED === 'true',
    serverKey: process.env.FCM_SERVER_KEY,
    projectId: process.env.FCM_PROJECT_ID
  },
  
  // File Storage
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',
    path: process.env.STORAGE_PATH || './uploads',
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      bucket: process.env.AWS_S3_BUCKET,
      region: process.env.AWS_S3_REGION || 'eu-west-1'
    },
    cloudinary: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      apiSecret: process.env.CLOUDINARY_API_SECRET
    }
  },
  
  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    fileEnabled: process.env.LOG_FILE_ENABLED === 'true',
    dir: process.env.LOG_DIR || './logs',
    prettyPrint: process.env.PRETTY_LOGS === 'true'
  },
  
  // Monitoring
  sentry: {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV
  },
  metrics: {
    enabled: process.env.METRICS_ENABLED === 'true',
    port: parseInt(process.env.METRICS_PORT || '9090', 10)
  },
  
  // Rate Limiting
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 min
    login: {
      maxAttempts: parseInt(process.env.LOGIN_MAX_ATTEMPTS || '5', 10),
      windowMs: parseInt(process.env.LOGIN_WINDOW_MS || '900000', 10)
    }
  },
  
  // Business Rules
  business: {
    kitchen: {
      openHour: parseInt(process.env.KITCHEN_OPEN_HOUR || '18', 10),
      closeHour: parseInt(process.env.KITCHEN_CLOSE_HOUR || '21', 10)
    },
    delivery: {
      defaultFee: parseFloat(process.env.DEFAULT_DELIVERY_FEE || '15'),
      maxRadiusKm: parseFloat(process.env.MAX_DELIVERY_RADIUS_KM || '10'),
      minOrderAmount: parseFloat(process.env.MIN_ORDER_AMOUNT || '20')
    },
    timeouts: {
      orderPending: parseInt(process.env.ORDER_PENDING_TIMEOUT_MINUTES || '30', 10),
      orderPreparation: parseInt(process.env.ORDER_PREPARATION_TIMEOUT_MINUTES || '45', 10),
      driverAcceptance: parseInt(process.env.DRIVER_ACCEPTANCE_TIMEOUT_MINUTES || '5', 10)
    }
  },
  
  // Feature Flags
  features: {
    cashPayment: process.env.FEATURE_CASH_PAYMENT !== 'false',
    momoPayment: process.env.FEATURE_MOMO_PAYMENT !== 'false',
    cardPayment: process.env.FEATURE_CARD_PAYMENT === 'true',
    loyaltyProgram: process.env.FEATURE_LOYALTY_PROGRAM === 'true',
    referrals: process.env.FEATURE_REFERRALS === 'true',
    surgePricing: process.env.FEATURE_SURGE_PRICING === 'true'
  },
  
  // Development & Debug
  debug: process.env.DEBUG === 'true',
  disableAuth: process.env.DISABLE_AUTH === 'true' && process.env.NODE_ENV === 'development',
  mock: {
    momo: process.env.MOCK_MOMO === 'true',
    sms: process.env.MOCK_SMS === 'true',
    geocoding: process.env.MOCK_GEOCODING === 'true'
  }
};

// Validation
if (config.env === 'production') {
  const required = {
    'JWT_SECRET': config.jwtSecret
  };

  // Supabase-backed deployments keep state in Postgres via the REST API, so a
  // raw DATABASE_URL is not needed there.
  if (!process.env.SUPABASE_URL) {
    required['DATABASE_URL'] = config.databaseUrl;
  }
  
  for (const [key, value] of Object.entries(required)) {
    if (!value || value.includes('change') || value.includes('your-')) {
      throw new Error(`${key} must be set in production environment`);
    }
  }
  
  if (config.disableAuth) {
    throw new Error('DISABLE_AUTH cannot be true in production');
  }
}

module.exports = config;
