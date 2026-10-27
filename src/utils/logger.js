// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - Winston Logger Configuration
// ═══════════════════════════════════════════════════════════════════════════
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const config = require('../config');

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// JSON format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create transports array
const transports = [
  // Console output
  new winston.transports.Console({
    format: config.logging.prettyPrint ? consoleFormat : fileFormat
  })
];

// Add file transports if enabled
if (config.logging.fileEnabled) {
  // Error logs
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(config.logging.dir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      maxSize: '20m',
      format: fileFormat
    })
  );
  
  // Combined logs
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(config.logging.dir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '50m',
      format: fileFormat
    })
  );
  
  // HTTP logs
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(config.logging.dir, 'http-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'http',
      maxFiles: '7d',
      maxSize: '50m',
      format: fileFormat
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'yebs-api', env: config.env },
  transports,
  // Don't exit on handled exceptions
  exitOnError: false
});

// Add exception handlers
logger.exceptions.handle(
  new winston.transports.File({
    filename: path.join(config.logging.dir, 'exceptions.log')
  })
);

// Add rejection handlers
logger.rejections.handle(
  new winston.transports.File({
    filename: path.join(config.logging.dir, 'rejections.log')
  })
);

// Helper methods for structured logging
logger.logRequest = (req, message = 'HTTP Request') => {
  logger.http(message, {
    method: req.method,
    url: req.url,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    userId: req.auth?.payload?.sub,
    role: req.auth?.payload?.role
  });
};

logger.logError = (error, req = null, context = {}) => {
  const errorLog = {
    message: error.message,
    stack: error.stack,
    code: error.code,
    isOperational: error.isOperational,
    ...context
  };
  
  if (req) {
    errorLog.request = {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      userId: req.auth?.payload?.sub
    };
  }
  
  logger.error(errorLog);
};

logger.logPayment = (action, orderId, details = {}) => {
  logger.info(`Payment ${action}`, {
    orderId,
    ...details,
    category: 'payment'
  });
};

logger.logDriver = (action, driverId, details = {}) => {
  logger.info(`Driver ${action}`, {
    driverId,
    ...details,
    category: 'driver'
  });
};

logger.logOrder = (action, orderId, details = {}) => {
  logger.info(`Order ${action}`, {
    orderId,
    ...details,
    category: 'order'
  });
};

module.exports = logger;
