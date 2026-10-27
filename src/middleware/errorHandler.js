// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - Centralized Error Handling
// ═══════════════════════════════════════════════════════════════════════════
const logger = require('../utils/logger');

/**
 * Custom Application Error Class
 */
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Common Error Types
 */
class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, true, details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, true);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, true);
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, true);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, true);
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfter = 900) {
    super(message, 429, true, { retryAfter });
  }
}

/**
 * Error Handler Middleware
 */
function errorHandler(err, req, res, next) {
  let error = err;
  
  // Convert non-AppError errors to AppError
  if (!(error instanceof AppError)) {
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal server error';
    error = new AppError(message, statusCode, false);
  }
  
  // Log the error
  if (error.statusCode >= 500) {
    logger.logError(error, req, {
      body: req.body,
      params: req.params,
      query: req.query
    });
  } else {
    logger.warn(error.message, {
      statusCode: error.statusCode,
      url: req.url,
      method: req.method,
      userId: req.auth?.payload?.sub
    });
  }
  
  // Prepare error response
  const response = {
    success: false,
    message: error.message,
    statusCode: error.statusCode
  };
  
  // Add details in development or for operational errors
  if (process.env.NODE_ENV === 'development' || error.isOperational) {
    if (error.details) response.details = error.details;
  }
  
  // Add stack trace in development
  if (process.env.NODE_ENV === 'development') {
    response.stack = error.stack;
  }
  
  // Don't leak internal errors in production
  if (process.env.NODE_ENV === 'production' && !error.isOperational) {
    response.message = 'An unexpected error occurred';
  }
  
  // Send response
  res.status(error.statusCode).json(response);
}

/**
 * Async Error Wrapper
 * Wraps async route handlers to catch errors and pass to error handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 Handler
 */
function notFoundHandler(req, res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}

/**
 * Validation Error Formatter
 * Converts Joi validation errors to readable format
 */
function formatValidationError(error) {
  if (!error.details) return error.message;
  
  const details = error.details.map(detail => ({
    field: detail.path.join('.'),
    message: detail.message,
    type: detail.type
  }));
  
  return new ValidationError('Validation failed', details);
}

/**
 * Database Error Handler
 * Converts Prisma errors to readable format
 */
function handleDatabaseError(error) {
  // Prisma unique constraint violation
  if (error.code === 'P2002') {
    const field = error.meta?.target?.[0] || 'field';
    return new ConflictError(`${field} already exists`);
  }
  
  // Prisma record not found
  if (error.code === 'P2025') {
    return new NotFoundError('Record');
  }
  
  // Prisma foreign key constraint failed
  if (error.code === 'P2003') {
    return new ValidationError('Referenced record does not exist');
  }
  
  // Default database error
  logger.error('Database error:', error);
  return new AppError('Database operation failed', 500, false);
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  errorHandler,
  asyncHandler,
  notFoundHandler,
  formatValidationError,
  handleDatabaseError
};
