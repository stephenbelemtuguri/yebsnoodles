// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - Promo Code Service
// ═══════════════════════════════════════════════════════════════════════════
const logger = require('../utils/logger');

/**
 * Promo Code Management Service
 */

// In-memory promo code storage (will be moved to database)
const promoCodes = new Map([
  ['YEBS20', {
    code: 'YEBS20',
    type: 'percentage',
    value: 20,
    description: 'Get 20% off your order',
    minOrderAmount: 30,
    maxDiscount: 50,
    maxUses: 1000,
    maxUsesPerUser: 1,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2025-12-31'),
    isActive: true,
    timesUsed: 0,
    usageHistory: []
  }],
  ['FREEDEL', {
    code: 'FREEDEL',
    type: 'free_delivery',
    value: 15,
    description: 'Free delivery on your order',
    minOrderAmount: 25,
    maxUses: 500,
    maxUsesPerUser: 1,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2025-12-31'),
    isActive: true,
    timesUsed: 0,
    usageHistory: []
  }],
  ['FIRST50', {
    code: 'FIRST50',
    type: 'fixed_amount',
    value: 50,
    description: 'GH₵50 off your first order',
    minOrderAmount: 80,
    firstOrderOnly: true,
    maxUsesPerUser: 1,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2025-12-31'),
    isActive: true,
    timesUsed: 0,
    usageHistory: []
  }]
]);

/**
 * Validate and apply promo code
 */
function validatePromoCode(code, orderTotal, userPhone, isFirstOrder = false) {
  const upperCode = String(code).trim().toUpperCase();
  const promo = promoCodes.get(upperCode);
  
  if (!promo) {
    return {
      valid: false,
      error: 'Invalid promo code',
      discount: 0
    };
  }
  
  // Check if active
  if (!promo.isActive) {
    return {
      valid: false,
      error: 'This promo code is no longer active',
      discount: 0
    };
  }
  
  // Check date validity
  const now = new Date();
  if (now < promo.startDate || now > promo.endDate) {
    return {
      valid: false,
      error: 'This promo code has expired',
      discount: 0
    };
  }
  
  // Check minimum order amount
  if (promo.minOrderAmount && orderTotal < promo.minOrderAmount) {
    return {
      valid: false,
      error: `Minimum order of GH₵${promo.minOrderAmount} required for this promo`,
      discount: 0
    };
  }
  
  // Check first order only restriction
  if (promo.firstOrderOnly && !isFirstOrder) {
    return {
      valid: false,
      error: 'This promo is only valid for first-time customers',
      discount: 0
    };
  }
  
  // Check user usage limit
  if (promo.maxUsesPerUser) {
    const userUsageCount = promo.usageHistory.filter(u => u.phone === userPhone).length;
    if (userUsageCount >= promo.maxUsesPerUser) {
      return {
        valid: false,
        error: 'You have already used this promo code',
        discount: 0
      };
    }
  }
  
  // Check total usage limit
  if (promo.maxUses && promo.timesUsed >= promo.maxUses) {
    return {
      valid: false,
      error: 'This promo code has reached its usage limit',
      discount: 0
    };
  }
  
  // Calculate discount
  let discount = 0;
  
  switch (promo.type) {
    case 'percentage':
      discount = (orderTotal * promo.value) / 100;
      if (promo.maxDiscount) {
        discount = Math.min(discount, promo.maxDiscount);
      }
      break;
      
    case 'fixed_amount':
      discount = Math.min(promo.value, orderTotal);
      break;
      
    case 'free_delivery':
      discount = promo.value; // Delivery fee amount
      break;
      
    default:
      return {
        valid: false,
        error: 'Invalid promo type',
        discount: 0
      };
  }
  
  logger.info('Promo code validated', {
    code: upperCode,
    discount,
    orderTotal,
    type: promo.type
  });
  
  return {
    valid: true,
    code: upperCode,
    type: promo.type,
    discount: Math.round(discount * 100) / 100,
    description: promo.description,
    message: `Promo code applied! You saved GH₵${discount.toFixed(2)}`
  };
}

/**
 * Record promo code usage
 */
function recordPromoUsage(code, orderId, userPhone, discount) {
  const upperCode = String(code).trim().toUpperCase();
  const promo = promoCodes.get(upperCode);
  
  if (!promo) return false;
  
  promo.timesUsed += 1;
  promo.usageHistory.push({
    orderId,
    phone: userPhone,
    discount,
    usedAt: new Date()
  });
  
  logger.info('Promo code used', {
    code: upperCode,
    orderId,
    discount,
    totalUses: promo.timesUsed
  });
  
  return true;
}

/**
 * Create new promo code (Admin only)
 */
function createPromoCode(promoData) {
  const code = String(promoData.code).trim().toUpperCase();
  
  if (promoCodes.has(code)) {
    throw new Error('Promo code already exists');
  }
  
  const promo = {
    code,
    type: promoData.type || 'percentage',
    value: Number(promoData.value) || 0,
    description: promoData.description || '',
    minOrderAmount: promoData.minOrderAmount || null,
    maxDiscount: promoData.maxDiscount || null,
    maxUses: promoData.maxUses || null,
    maxUsesPerUser: promoData.maxUsesPerUser || 1,
    firstOrderOnly: promoData.firstOrderOnly || false,
    startDate: new Date(promoData.startDate || Date.now()),
    endDate: new Date(promoData.endDate || '2025-12-31'),
    isActive: true,
    timesUsed: 0,
    usageHistory: []
  };
  
  promoCodes.set(code, promo);
  
  logger.info('Promo code created', { code, type: promo.type, value: promo.value });
  
  return promo;
}

/**
 * List all promo codes (Admin only)
 */
function listPromoCodes(includeInactive = false) {
  const codes = Array.from(promoCodes.values());
  
  if (!includeInactive) {
    return codes.filter(p => p.isActive);
  }
  
  return codes;
}

/**
 * Deactivate promo code (Admin only)
 */
function deactivatePromoCode(code) {
  const upperCode = String(code).trim().toUpperCase();
  const promo = promoCodes.get(upperCode);
  
  if (!promo) {
    throw new Error('Promo code not found');
  }
  
  promo.isActive = false;
  
  logger.info('Promo code deactivated', { code: upperCode });
  
  return promo;
}

/**
 * Get promo code statistics
 */
function getPromoStats(code) {
  const upperCode = String(code).trim().toUpperCase();
  const promo = promoCodes.get(upperCode);
  
  if (!promo) {
    throw new Error('Promo code not found');
  }
  
  const totalDiscount = promo.usageHistory.reduce((sum, u) => sum + u.discount, 0);
  const uniqueUsers = new Set(promo.usageHistory.map(u => u.phone)).size;
  
  return {
    code: promo.code,
    type: promo.type,
    timesUsed: promo.timesUsed,
    uniqueUsers,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    remainingUses: promo.maxUses ? promo.maxUses - promo.timesUsed : 'Unlimited',
    isActive: promo.isActive,
    startDate: promo.startDate,
    endDate: promo.endDate
  };
}

module.exports = {
  validatePromoCode,
  recordPromoUsage,
  createPromoCode,
  listPromoCodes,
  deactivatePromoCode,
  getPromoStats
};
