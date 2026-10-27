# YEBS Noodles - Production Implementation Roadmap

## ✅ Phase 1: Infrastructure & Configuration (COMPLETED)

### 1.1 Environment Configuration
- [x] Created `.env.example` with all required environment variables
- [x] Added comprehensive config management (`src/config/index.js`)
- [x] Set up feature flags and business rules
- [x] Added security configurations

### 1.2 Database Schema
- [x] Migrated from SQLite to PostgreSQL
- [x] Created complete Prisma schema with 9 models:
  - Admin, Driver, MenuItem, Order, Session
  - AuditLog, Notification, Earning, Setting
- [x] Added proper indexes and relationships
- [x] Added full-text search capabilities

### 1.3 Package Dependencies
- [x] Updated package.json with production dependencies:
  - Prisma ORM for database
  - Bull for job queues
  - Redis for caching
  - Helmet & rate-limit for security
  - Winston for logging
  - Prometheus for metrics
  - Jest & Playwright for testing

## 🔨 Phase 2: Core Backend Services (IN PROGRESS)

### 2.1 Database Layer (`src/db/`)
**Status**: To be created
**Files needed**:
- `src/db/client.js` - Prisma client initialization
- `src/db/migrations/` - Database migration files
- `src/db/seed.js` - Initial data seeding

**Actions**:
```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npx prisma db seed
```

### 2.2 Authentication & Security (`src/auth/`)
**Status**: Partially implemented in server.js
**Improvements needed**:
- Extract JWT logic to `src/auth/jwt.js`
- Add refresh token support
- Implement password reset flow
- Add 2FA for admins
- Add session management with Redis

### 2.3 Payment Integration (`src/services/payment/`)
**Status**: To be created
**Files needed**:
- `src/services/payment/momo.js` - MTN MoMo API integration
- `src/services/payment/webhook.js` - Payment webhook handlers
- `src/services/payment/verification.js` - Payment verification logic

**MTN MoMo Implementation Steps**:
1. Register at https://momodeveloper.mtn.com/
2. Generate API credentials (Subscription Key, API User, API Key)
3. Implement Collections API for receiving payments
4. Set up webhook for payment notifications
5. Add retry logic for failed transactions

### 2.4 Geocoding Service (`src/services/geocoding/`)
**Status**: To be created
**Files needed**:
- `src/services/geocoding/google.js` - Google Maps Geocoding
- `src/services/geocoding/mapbox.js` - Mapbox alternative
- `src/services/geocoding/nominatim.js` - Free OSM fallback
- `src/services/geocoding/index.js` - Provider abstraction

**Implementation**:
```javascript
// src/services/geocoding/index.js
const google = require('./google');
const mapbox = require('./mapbox');
const config = require('../../config');

async function geocode(address) {
  const provider = config.googleMaps.geocodingProvider;
  switch (provider) {
    case 'google': return await google.geocode(address);
    case 'mapbox': return await mapbox.geocode(address);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

module.exports = { geocode, reverseGeocode };
```

### 2.5 Notification Service (`src/services/notifications/`)
**Status**: To be created
**Files needed**:
- `src/services/notifications/sms.js` - SMS via Hubtel/Twilio
- `src/services/notifications/email.js` - Email notifications
- `src/services/notifications/push.js` - FCM push notifications
- `src/services/notifications/sse.js` - Server-sent events

### 2.6 Logging & Monitoring (`src/utils/logger.js`)
**Status**: To be created
```javascript
const winston = require('winston');
const config = require('../config');

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'yebs-api' },
  transports: [
    new winston.transports.Console({
      format: config.logging.prettyPrint 
        ? winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        : winston.format.json()
    })
  ]
});

if (config.logging.fileEnabled) {
  logger.add(new winston.transports.DailyRotateFile({
    filename: `${config.logging.dir}/error-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxFiles: '30d'
  }));
  
  logger.add(new winston.transports.DailyRotateFile({
    filename: `${config.logging.dir}/combined-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxFiles: '30d'
  }));
}

module.exports = logger;
```

## 🚀 Phase 3: API Enhancement

### 3.1 Input Validation (`src/middleware/validation.js`)
```javascript
const Joi = require('joi');

const orderSchema = Joi.object({
  customer: Joi.string().min(2).max(100).required(),
  phone: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
  location: Joi.string().min(5).max(500).required(),
  items: Joi.array().items(Joi.object({
    menuId: Joi.string().uuid().required(),
    quantity: Joi.number().integer().min(1).max(50).required()
  })).min(1).required(),
  total: Joi.number().min(0).required()
});

function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }
    next();
  };
}

module.exports = { validate, orderSchema };
```

### 3.2 Rate Limiting (`src/middleware/rateLimit.js`)
```javascript
const rateLimit = require('express-rate-limit');
const config = require('../config');

const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { success: false, message: 'Too many requests, please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: config.rateLimit.login.windowMs,
  max: config.rateLimit.login.maxAttempts,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts, please try again later.' }
});

module.exports = { generalLimiter, loginLimiter };
```

### 3.3 Error Handling (`src/middleware/errorHandler.js`)
```javascript
const logger = require('../utils/logger');

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

function errorHandler(err, req, res, next) {
  let { statusCode = 500, message } = err;
  
  // Log error
  logger.error({
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userId: req.user?.id
  });
  
  // Don't leak error details in production
  if (process.env.NODE_ENV === 'production' && !err.isOperational) {
    message = 'Something went wrong';
  }
  
  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

module.exports = { AppError, errorHandler };
```

## 📊 Phase 4: Metrics & Monitoring

### 4.1 Prometheus Metrics (`src/metrics/index.js`)
```javascript
const client = require('prom-client');

const register = new client.Register();

// HTTP request duration
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code']
});

// Active orders
const activeOrders = new client.Gauge({
  name: 'yebs_active_orders_total',
  help: 'Total number of active orders'
});

// Payment success rate
const paymentSuccess = new client.Counter({
  name: 'yebs_payments_success_total',
  help: 'Total successful payments'
});

const paymentFailed = new client.Counter({
  name: 'yebs_payments_failed_total',
  help: 'Total failed payments'
});

register.registerMetric(httpRequestDuration);
register.registerMetric(activeOrders);
register.registerMetric(paymentSuccess);
register.registerMetric(paymentFailed);

module.exports = {
  register,
  metrics: {
    httpRequestDuration,
    activeOrders,
    paymentSuccess,
    paymentFailed
  }
};
```

## 🧪 Phase 5: Testing

### 5.1 Unit Tests (`tests/unit/`)
```javascript
// tests/unit/auth.test.js
const { hashPassword, verifyPassword } = require('../../src/auth/password');

describe('Password Hashing', () => {
  test('should hash password', async () => {
    const password = 'test123';
    const hash = await hashPassword(password);
    expect(hash).not.toBe(password);
    expect(hash.startsWith('$2')).toBe(true);
  });
  
  test('should verify correct password', async () => {
    const password = 'test123';
    const hash = await hashPassword(password);
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });
  
  test('should reject incorrect password', async () => {
    const hash = await hashPassword('test123');
    const isValid = await verifyPassword('wrong', hash);
    expect(isValid).toBe(false);
  });
});
```

### 5.2 Integration Tests (`tests/integration/`)
```javascript
// tests/integration/orders.test.js
const request = require('supertest');
const app = require('../../src/app');

describe('POST /api/orders', () => {
  it('should create order with valid data', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        customer: 'John Doe',
        phone: '0241234567',
        location: 'Adabraka, Accra',
        items: [{ menuId: 'uuid-here', quantity: 2 }],
        total: 50
      });
    
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.order.id).toMatch(/^YB-\d{4}$/);
  });
  
  it('should reject order with invalid phone', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        customer: 'John Doe',
        phone: 'invalid',
        location: 'Adabraka',
        items: [],
        total: 50
      });
    
    expect(res.statusCode).toBe(400);
  });
});
```

## 🔒 Phase 6: Security Hardening

### 6.1 Helmet Configuration
```javascript
const helmet = require('helmet');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "unpkg.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));
```

### 6.2 CORS Configuration
```javascript
const cors = require('cors');

const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://yebs-noodles.com', 'https://www.yebs-noodles.com']
    : true,
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
```

## 📦 Phase 7: Deployment

### 7.1 PM2 Ecosystem (`ecosystem.config.js`)
```javascript
module.exports = {
  apps: [{
    name: 'yebs-api',
    script: './server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    autorestart: true,
    max_memory_restart: '1G',
    watch: false
  }]
};
```

### 7.2 Nginx Configuration
```nginx
upstream yebs_backend {
    least_conn;
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
}

server {
    listen 80;
    server_name yebs-noodles.com www.yebs-noodles.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yebs-noodles.com www.yebs-noodles.com;
    
    ssl_certificate /etc/letsencrypt/live/yebs-noodles.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yebs-noodles.com/privkey.pem;
    
    location / {
        proxy_pass http://yebs_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    
    location /api/sse/ {
        proxy_pass http://yebs_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}
```

### 7.3 Docker Setup
```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "start"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://yebs:password@db:5432/yebs_noodles
      REDIS_URL: redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped
  
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: yebs
      POSTGRES_PASSWORD: password
      POSTGRES_DB: yebs_noodles
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped
  
  redis:
    image: redis:7-alpine
    restart: unless-stopped

volumes:
  postgres_data:
```

## ✅ Implementation Checklist

### Critical (Week 1-2)
- [ ] Set up PostgreSQL database
- [ ] Run Prisma migrations
- [ ] Implement MTN MoMo API integration
- [ ] Add Google Maps Geocoding
- [ ] Set up Winston logging
- [ ] Add comprehensive error handling
- [ ] Implement SSE for real-time notifications

### Important (Week 3-4)
- [ ] Add Redis caching layer
- [ ] Implement SMS notifications (Hubtel)
- [ ] Set up email service
- [ ] Add Prometheus metrics
- [ ] Implement job queue with Bull
- [ ] Add unit & integration tests
- [ ] Set up CI/CD pipeline

### Nice to Have (Week 5-6)
- [ ] Add FCM push notifications
- [ ] Implement admin analytics dashboard
- [ ] Add driver earnings tracking
- [ ] Set up Sentry error tracking
- [ ] Implement surge pricing
- [ ] Add loyalty program
- [ ] Mobile app support

## 🚀 Quick Start Commands

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your credentials

# 3. Set up database
npx prisma migrate dev
npx prisma db seed

# 4. Start development server
npm run dev

# 5. Run tests
npm test

# 6. Start production (with PM2)
npm run pm2:start
```

## 📚 Additional Resources

- MTN MoMo API Docs: https://momodeveloper.mtn.com/
- Google Maps API: https://developers.google.com/maps
- Hubtel SMS API: https://developers.hubtel.com/
- Prisma Docs: https://www.prisma.io/docs/
- Bull Queue: https://github.com/OptimalBits/bull
- Winston Logger: https://github.com/winstonjs/winston
