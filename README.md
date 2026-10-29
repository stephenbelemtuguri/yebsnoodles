# 🍜 YEBS Noodles - Production-Ready Food Delivery Platform

[![License](https://img.shields.io/badge/license-PROPRIETARY-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/postgresql-14%2B-blue.svg)](https://www.postgresql.org/)

> **The Standard of Delicacy** - A comprehensive, production-ready food delivery platform for Ghana with real-time GPS tracking, MTN Mobile Money integration, driver approval workflows, and Bolt/Yango-style live tracking.

---

## ✨ What's Been Implemented

### 🎯 All 13 Critical Production Components Added

1. ✅ **Complete Database Schema** (Prisma + PostgreSQL)
2. ✅ **Environment Configuration** (.env with all services)
3. ✅ **Winston Logging** (File rotation, structured logging)
4. ✅ **Error Handling** (Centralized, operational errors)
5. ✅ **Input Validation** (Joi schemas for all endpoints)
6. ✅ **MTN MoMo Integration** (Collections API ready)
7. ✅ **Geocoding Service** (Google Maps, Mapbox, Nominatim)
8. ✅ **Rate Limiting** (Brute-force protection)
9. ✅ **Security Hardening** (Helmet, CORS, JWT)
10. ✅ **Production Config** (PM2, Docker, Nginx)
11. ✅ **Deployment Guides** (Step-by-step instructions)
12. ✅ **Monitoring Setup** (Prometheus metrics, health checks)
13. ✅ **Testing Framework** (Jest, Playwright ready)

### 🆕 Week 1: Priority Features Complete!

14. ✅ **Customer Portal** (Order history, saved addresses, promo codes)
15. ✅ **Driver Earnings Dashboard** (Charts, performance metrics, payouts)
16. ✅ **Admin Analytics Dashboard** (Business intelligence, KPIs, insights)
17. ✅ **18+ API Endpoints** (Customers, drivers, analytics routes)

### 🆕 Week 2: Advanced Features Complete!

18. ✅ **Reviews & Ratings** (Customer reviews, admin replies, ratings breakdown)
19. ✅ **In-App Chat** (Customer-driver-admin messaging, system messages)
20. ✅ **Menu Management** (CRUD operations, availability toggle, reorder)
21. ✅ **Inventory Management** (Stock tracking, low-stock alerts, restock, purchase orders)
22. ✅ **SMS Notifications** (Multi-provider: Arkesel, Hubtel, Twilio with fallback)
23. ✅ **Loyalty Program** (4 tiers, 7 rewards, points earning/redemption)
24. ✅ **Referral System** (Unique codes, dual rewards, conversion tracking)
25. ✅ **Dynamic Pricing** (7 rules: peak hours, low stock, happy hour, weekend, bulk, weather, late night)
26. ✅ **Notifications System** (In-app, SMS, preferences, bulk broadcast)
27. ✅ **Order Receipts** (View, download, print, save, delete - with payment status & method)
28. ✅ **56+ API Endpoints** across all feature modules

**📄 See [WEEK2_FEATURES.md](WEEK2_FEATURES.md) for complete documentation!**

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 3. Set up database
createdb yebs_noodles
npx prisma migrate dev
npx prisma db seed

# 4. Start development
npm run dev
```

### Access Points
- **Customer Store**: http://localhost:3000
- **Driver Portal**: http://localhost:3000/driver
- **Admin Dashboard**: http://localhost:3000/admin

### NEW Feature Portals
- **Customer Portal**: http://localhost:3000/public/customer-portal.html
- **Driver Earnings**: http://localhost:3000/public/driver-earnings.html
- **Admin Analytics**: http://localhost:3000/public/admin-analytics.html
- **Admin Management**: http://localhost:3000/public/admin-management.html
- **Order Receipts**: http://localhost:3000/public/receipts.html
- **Reviews & Loyalty**: http://localhost:3000/public/customer-reviews.html

### Admin Login
- Set a private `ADMIN_USERNAME` and a unique, strong `ADMIN_PASSWORD` in `.env`
  (or your hosting environment). There is no built-in default administrator
  password; the account is created automatically only after credentials are set.
- Change the password from **Admin → Settings** after the first login.

---

## 📚 Documentation

- **[FEATURES_COMPLETE.md](FEATURES_COMPLETE.md)** - 🆕 **NEW! Complete guide to all features**
- **[PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md)** - Complete implementation guide
- **[INSTALLATION.md](INSTALLATION.md)** - Deployment instructions
- **[.env.example](.env.example)** - Configuration template

---

## 🏗️ Architecture

```
Frontend (HTML/JS) → Express.js → PostgreSQL
                        ↓
                    Redis Cache
                        ↓
            MTN MoMo | Geocoding | SMS
```

### Tech Stack
- **Backend**: Node.js 18+ with Express
- **Database**: PostgreSQL 14+ with Prisma ORM
- **Cache**: Redis 7+
- **Payments**: MTN Mobile Money API
- **Maps**: Google Maps / Mapbox
- **Logging**: Winston with file rotation
- **Process Manager**: PM2 with clustering
- **Web Server**: Nginx with SSL

---

## 📦 Project Structure

```
yebs-noodles/
├── index.html                    # Customer storefront
├── driver.html                   # Driver portal
├── admin.html                    # Admin dashboard
├── server.js                     # Express API server
│
├── public/                       # 🆕 NEW Feature Portals
│   ├── customer-portal.html      # Order history & saved addresses
│   ├── driver-earnings.html      # Earnings dashboard with charts
│   └── admin-analytics.html      # Business intelligence dashboard
│
├── src/
│   ├── config/                   # Environment configuration
│   ├── middleware/               # Validation, error handling
│   ├── services/                 # MoMo, geocoding, notifications
│   ├── routes/                   # 🆕 NEW API route handlers
│   │   ├── customers.js          # Customer endpoints
│   │   ├── drivers.js            # Driver endpoints
│   │   └── analytics.js          # Analytics endpoints
│   └── utils/                    # Logger, helpers
│
├── prisma/
│   └── schema.prisma             # 9-model database schema
├── ecosystem.config.js           # PM2 configuration
└── docker-compose.yml            # Docker setup
```

---

## 🔐 Security Features

✅ Bcrypt password hashing  
✅ JWT authentication  
✅ Rate limiting  
✅ Input validation (Joi)  
✅ SQL injection prevention  
✅ XSS protection  
✅ HTTPS enforcement  
✅ Audit logging  

---

## 🧪 Testing

```bash
npm test           # Run all tests
npm run test:e2e   # End-to-end tests
```

---

## 📈 Monitoring

- **Metrics**: http://localhost:9090/metrics
- **Health**: http://localhost:3000/api/health
- **Logs**: `./logs/`

---

## 🚀 Deployment

### Quick Deploy (PM2)
```bash
npm run pm2:start
```

### Docker Deploy
```bash
docker-compose up -d
```

See [INSTALLATION.md](INSTALLATION.md) for complete guide.

---

## 📞 Support

- Technical: Create GitHub issue
- Business: info@yebs-noodles.com
- WhatsApp: +233 55 910 3452

---

<div align="center">

**Built with ❤️ in Accra, Ghana**

[Documentation](./PRODUCTION_ROADMAP.md) • [Installation](./INSTALLATION.md)

</div>
