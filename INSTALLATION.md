# YEBS Noodles - Installation & Deployment Guide

## 📋 Prerequisites

### System Requirements
- **Node.js**: 18.x or higher
- **PostgreSQL**: 14.x or higher
- **Redis**: 7.x or higher (for caching & sessions)
- **RAM**: Minimum 2GB, Recommended 4GB+
- **Storage**: Minimum 10GB free space
- **OS**: Ubuntu 20.04+ / Debian 11+ / Windows Server 2019+

### External Services (Optional but Recommended)
- **MTN MoMo Account**: For mobile money payments
- **Google Maps API Key**: For geocoding & maps
- **Hubtel Account**: For SMS notifications (Ghana)
- **Sentry Account**: For error tracking

---

## 🚀 Quick Start (Development)

### 1. Clone & Install
```bash
cd c:\Users\Admin\Desktop\stephen
npm install
```

### 2. Set Up Environment
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Set Up Database
```bash
# Create PostgreSQL database
createdb yebs_noodles

# Run migrations
npx prisma migrate dev

# Seed initial data
npx prisma db seed
```

### 4. Start Development Server
```bash
npm run dev
```

Access the application:
- Customer Storefront: http://localhost:3000
- Driver Portal: http://localhost:3000/driver
- Admin Dashboard: http://localhost:3000/admin

Default admin credentials:
- Username: `yebsnoodles`
- Password: `yebs@123`

---

## 🔧 Production Deployment

### Option 1: Traditional VPS (Ubuntu/Debian)

#### Step 1: Install Dependencies
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install Redis
sudo apt install -y redis-server

# Install Nginx
sudo apt install -y nginx

# Install PM2 globally
sudo npm install -g pm2

# Install Certbot for SSL
sudo apt install -y certbot python3-certbot-nginx
```

#### Step 2: Set Up PostgreSQL
```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE yebs_noodles;
CREATE USER yebs_user WITH ENCRYPTED PASSWORD 'secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE yebs_noodles TO yebs_user;
\q
```

#### Step 3: Configure Redis
```bash
# Edit Redis config
sudo nano /etc/redis/redis.conf

# Add password (find and uncomment)
requirepass your_redis_password_here

# Restart Redis
sudo systemctl restart redis
sudo systemctl enable redis
```

#### Step 4: Deploy Application
```bash
# Create application directory
sudo mkdir -p /var/www/yebs-noodles
sudo chown -R $USER:$USER /var/www/yebs-noodles

# Clone/copy your code
cd /var/www/yebs-noodles
# Upload your code here

# Install dependencies
npm ci --only=production

# Set up environment
cp .env.example .env
nano .env
# Configure all production variables

# Run database migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Seed database
node prisma/seed.js
```

#### Step 5: Configure PM2
```bash
# Start application with PM2
pm2 start ecosystem.config.js

# Set up PM2 to start on boot
pm2 startup
pm2 save

# View logs
pm2 logs yebs-api

# Monitor
pm2 monit
```

#### Step 6: Configure Nginx
```bash
# Create Nginx configuration
sudo nano /etc/nginx/sites-available/yebs-noodles

# Add this configuration:
```

```nginx
upstream yebs_backend {
    least_conn;
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name yebs-noodles.com www.yebs-noodles.com;
    
    # Redirect all HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yebs-noodles.com www.yebs-noodles.com;
    
    # SSL certificates (Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/yebs-noodles.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yebs-noodles.com/privkey.pem;
    
    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Logs
    access_log /var/log/nginx/yebs-access.log;
    error_log /var/log/nginx/yebs-error.log;
    
    # Root directory for static files
    root /var/www/yebs-noodles;
    
    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    
    # API and SSE routes
    location /api/ {
        proxy_pass http://yebs_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }
    
    # Server-Sent Events (SSE) - no buffering
    location /api/sse/ {
        proxy_pass http://yebs_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
    }
    
    # Static files
    location / {
        try_files $uri $uri/ @backend;
        expires 1d;
        add_header Cache-Control "public, immutable";
    }
    
    # Fallback to backend
    location @backend {
        proxy_pass http://yebs_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/yebs-noodles /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
```

#### Step 7: Set Up SSL with Let's Encrypt
```bash
# Obtain SSL certificate
sudo certbot --nginx -d yebs-noodles.com -d www.yebs-noodles.com

# Test auto-renewal
sudo certbot renew --dry-run

# Certificate will auto-renew every 60 days
```

#### Step 8: Set Up Firewall
```bash
# Allow SSH, HTTP, HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable

# Check status
sudo ufw status
```

#### Step 9: Set Up Monitoring
```bash
# Install monitoring tools
npm install -g pm2-logrotate
pm2 install pm2-logrotate

# Configure log rotation
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
```

---

### Option 2: Docker Deployment

#### Step 1: Build Docker Image
```bash
# Build image
docker build -t yebs-noodles:latest .

# Or use docker-compose
docker-compose up -d
```

#### Step 2: Run with Docker Compose
```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop services
docker-compose down
```

---

## 🔐 Security Checklist

- [ ] Change all default passwords
- [ ] Set strong JWT_SECRET (min 64 characters)
- [ ] Enable HTTPS/SSL
- [ ] Configure firewall rules
- [ ] Set up Redis password
- [ ] Restrict database access
- [ ] Enable rate limiting
- [ ] Set up Sentry error tracking
- [ ] Configure CORS properly
- [ ] Enable security headers (Helmet)
- [ ] Regular security updates
- [ ] Database backups enabled

---

## 📊 Database Backup

### Automated Daily Backups
```bash
# Create backup script
sudo nano /usr/local/bin/backup-yebs-db.sh
```

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/yebs-noodles"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
DB_NAME="yebs_noodles"
DB_USER="yebs_user"

mkdir -p $BACKUP_DIR

# Backup database
pg_dump -U $DB_USER $DB_NAME | gzip > $BACKUP_DIR/db_backup_$DATE.sql.gz

# Keep only last 30 days
find $BACKUP_DIR -name "db_backup_*.sql.gz" -mtime +30 -delete

echo "Backup completed: db_backup_$DATE.sql.gz"
```

```bash
# Make executable
sudo chmod +x /usr/local/bin/backup-yebs-db.sh

# Add to cron (daily at 2 AM)
sudo crontab -e
# Add line:
0 2 * * * /usr/local/bin/backup-yebs-db.sh
```

### Manual Backup
```bash
# Backup
pg_dump -U yebs_user yebs_noodles > backup.sql

# Restore
psql -U yebs_user yebs_noodles < backup.sql
```

---

## 🔧 Maintenance Commands

```bash
# View application logs
pm2 logs yebs-api

# Restart application
pm2 restart yebs-api

# View status
pm2 status

# Monitor resources
pm2 monit

# Database migrations
npx prisma migrate deploy

# Clear Redis cache
redis-cli FLUSHALL

# Check Nginx logs
sudo tail -f /var/log/nginx/yebs-error.log

# Test Nginx config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- orders.test.js

# Run with coverage
npm test -- --coverage

# Run E2E tests
npm run test:e2e
```

---

## 📈 Monitoring & Metrics

### Prometheus Metrics
Access metrics at: `http://localhost:9090/metrics`

### PM2 Monitoring
```bash
# Install PM2 monitoring (optional paid service)
pm2 link <secret> <public>

# Or use free monitoring
pm2 monit
```

### Application Health Check
```bash
# Check health endpoint
curl http://localhost:3000/api/health

# Response should be:
# {"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}
```

---

## 🆘 Troubleshooting

### Application Won't Start
```bash
# Check PM2 logs
pm2 logs yebs-api --err

# Check if port is in use
sudo lsof -i :3000

# Check database connection
psql -U yebs_user -d yebs_noodles -c "SELECT 1;"
```

### Database Connection Issues
```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Check if database exists
sudo -u postgres psql -l | grep yebs_noodles

# Test connection
psql postgresql://yebs_user:password@localhost:5432/yebs_noodles
```

### Redis Connection Issues
```bash
# Check Redis status
sudo systemctl status redis

# Test Redis
redis-cli ping
# Should return: PONG
```

### SSL Certificate Issues
```bash
# Check certificate validity
sudo certbot certificates

# Renew manually
sudo certbot renew

# Check Nginx SSL config
sudo nginx -t
```

---

## 📞 Support

For issues and questions:
- GitHub Issues: [Your repo URL]
- Email: support@yebs-noodles.com
- WhatsApp: +233 55 910 3452

---

## 🔄 Updating the Application

```bash
# Pull latest code
cd /var/www/yebs-noodles
git pull origin main

# Install new dependencies
npm ci --only=production

# Run migrations
npx prisma migrate deploy

# Restart application
pm2 restart yebs-api

# Clear cache if needed
redis-cli FLUSHALL
```

---

## ✅ Post-Deployment Checklist

- [ ] Application accessible via domain
- [ ] HTTPS working correctly
- [ ] Admin login working
- [ ] Driver registration working
- [ ] Customer orders working
- [ ] MoMo payments configured
- [ ] SMS notifications working (if enabled)
- [ ] Database backups scheduled
- [ ] Monitoring set up
- [ ] Error tracking configured (Sentry)
- [ ] PM2 configured for auto-restart
- [ ] Nginx serving static files
- [ ] SSL certificate auto-renewal working
- [ ] Firewall configured
- [ ] Documentation updated with production URLs

---

**🎉 Congratulations! Your YEBS Noodles platform is now live!**
