// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - Request Validation Middleware
// ═══════════════════════════════════════════════════════════════════════════
const Joi = require('joi');
const { formatValidationError } = require('./errorHandler');

/**
 * Validation Schemas
 */

// Admin Login
const adminLoginSchema = Joi.object({
  username: Joi.string().min(3).max(50).required(),
  password: Joi.string().min(6).required()
});

// Driver Signup
const driverSignupSchema = Joi.object({
  fname: Joi.string().min(2).max(50).required(),
  lname: Joi.string().min(2).max(50).required(),
  phone: Joi.string().pattern(/^[0-9]{10,15}$/).required()
    .messages({
      'string.pattern.base': 'Phone number must be 10-15 digits'
    }),
  password: Joi.string().min(6).max(100).required(),
  vehicle: Joi.string().min(3).max(120).required(),
  photo: Joi.string().dataUri().required()
    .messages({
      'string.dataUri': 'Photo must be a valid base64 data URL'
    })
});

// Driver Login
const driverLoginSchema = Joi.object({
  username: Joi.string().min(3).max(80).required(),
  password: Joi.string().min(6).required()
});

// Order Creation
const createOrderSchema = Joi.object({
  customer: Joi.string().min(2).max(100).required(),
  phone: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
  email: Joi.string().email().optional(),
  fulfilment: Joi.string().valid('Delivery', 'Pickup').default('Delivery'),
  location: Joi.string().min(5).max(500).required(),
  mapPin: Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required()
  }).optional(),
  timing: Joi.string().valid('ASAP', 'Scheduled').default('ASAP'),
  scheduledFor: Joi.date().min('now').when('timing', {
    is: 'Scheduled',
    then: Joi.required()
  }),
  notes: Joi.string().max(1000).optional(),
  items: Joi.array().items(
    Joi.object({
      menuId: Joi.string().required(),
      name: Joi.string().required(),
      noodle: Joi.string().required(),
      toppings: Joi.array().items(Joi.string()).optional(),
      quantity: Joi.number().integer().min(1).max(50).required(),
      price: Joi.number().min(0).required()
    })
  ).min(1).required(),
  subtotal: Joi.number().min(0).required(),
  deliveryFee: Joi.number().min(0).default(15),
  total: Joi.number().min(0).required(),
  payment: Joi.string().required(),
  paymentMode: Joi.string().valid('momo', 'cash', 'card').default('momo')
});

// MoMo Payment
const momoPaymentSchema = Joi.object({
  orderId: Joi.string().pattern(/^YB-\d{4}$/).required(),
  transactionRef: Joi.string().min(5).max(60).optional(),
  amount: Joi.number().min(0).required(),
  receiptImage: Joi.string().dataUri().optional(),
  method: Joi.string().valid('auto-momo', 'auto-receipt', 'manual-admin').default('auto-momo')
});

// Driver Location Update
const driverLocationSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  speedKmh: Joi.number().min(0).max(200).optional(),
  statusText: Joi.string().max(120).optional(),
  isActive: Joi.boolean().optional()
});

// Pickup Point Update
const pickupPointSchema = Joi.object({
  name: Joi.string().min(3).max(200).required(),
  lat: Joi.number().min(-90).max(90).optional(),
  lng: Joi.number().min(-180).max(180).optional()
});

// Driver Approval
const driverApprovalSchema = Joi.object({
  driverId: Joi.string().uuid().required(),
  approved: Joi.boolean().required(),
  reason: Joi.string().max(500).when('approved', {
    is: false,
    then: Joi.required()
  })
});

// Order Status Update
const orderStatusSchema = Joi.object({
  status: Joi.string().valid(
    'pending', 'kitchen', 'driver_assigned', 'enroute', 'arrived', 'delivered', 'cancelled'
  ).required(),
  cancellationReason: Joi.string().max(500).when('status', {
    is: 'cancelled',
    then: Joi.required()
  })
});

/**
 * Validation Middleware Factory
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true
    });
    
    if (error) {
      return next(formatValidationError(error));
    }
    
    // Replace request data with validated & sanitized data
    req[property] = value;
    next();
  };
}

/**
 * Common Validators
 */
const validators = {
  // Auth
  adminLogin: validate(adminLoginSchema),
  driverSignup: validate(driverSignupSchema),
  driverLogin: validate(driverLoginSchema),
  
  // Orders
  createOrder: validate(createOrderSchema),
  orderStatus: validate(orderStatusSchema),
  
  // Payments
  momoPayment: validate(momoPaymentSchema),
  
  // Drivers
  driverLocation: validate(driverLocationSchema),
  driverApproval: validate(driverApprovalSchema),
  
  // Pickup Points
  pickupPoint: validate(pickupPointSchema),
  
  // ID Parameters
  orderId: validate(
    Joi.object({
      id: Joi.string().pattern(/^YB-\d{4}$/).required()
    }),
    'params'
  ),
  
  driverId: validate(
    Joi.object({
      id: Joi.string().uuid().required()
    }),
    'params'
  ),
  
  // Pagination
  pagination: validate(
    Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
      sortBy: Joi.string().optional(),
      sortOrder: Joi.string().valid('asc', 'desc').default('desc')
    }),
    'query'
  )
};

/**
 * Sanitization Helpers
 */
function sanitizeString(value, maxLength = 500) {
  if (!value) return '';
  return String(value)
    .trim()
    .slice(0, maxLength)
    .replace(/[<>]/g, ''); // Remove potential XSS characters
}

function sanitizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^\d]/g, ''); // Remove non-digits
}

function sanitizeCoordinate(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(min, Math.min(max, num));
}

module.exports = {
  validate,
  validators,
  schemas: {
    adminLoginSchema,
    driverSignupSchema,
    driverLoginSchema,
    createOrderSchema,
    momoPaymentSchema,
    driverLocationSchema,
    pickupPointSchema,
    driverApprovalSchema,
    orderStatusSchema
  },
  sanitize: {
    string: sanitizeString,
    phone: sanitizePhone,
    coordinate: sanitizeCoordinate
  }
};
