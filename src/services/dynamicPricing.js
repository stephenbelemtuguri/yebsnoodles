/**
 * Dynamic Pricing Engine
 * 
 * Adjusts menu prices based on:
 * 1. Demand patterns (peak hours command slight premium)
 * 2. Inventory levels (low stock = higher price, overstock = discount)
 * 3. Time of day (late night surcharge, lunch hour discount)
 * 4. Weather (rainy days = delivery surcharge)
 * 5. Special events (holidays, football match days)
 * 6. Competitor pricing (if available)
 * 
 * Rules are configurable and can be toggled per-rule.
 */

class DynamicPricingEngine {
  constructor() {
    this.rules = [
      {
        id: 'peak_hour_surcharge',
        name: 'Peak Hour Surcharge',
        description: '10% surcharge during peak hours (7-9 PM)',
        enabled: process.env.DYNAMIC_PRICING_PEAK === 'true',
        apply: (context) => {
          const hour = new Date().getHours();
          if (hour >= 19 && hour <= 21) {
            return { type: 'surcharge', percentage: 10, reason: 'Peak hours (7-9 PM)' };
          }
          return null;
        }
      },
      {
        id: 'low_stock_premium',
        name: 'Low Stock Premium',
        description: '15% premium when inventory is low for an ingredient',
        enabled: process.env.DYNAMIC_PRICING_LOW_STOCK === 'true',
        apply: (context) => {
          if (context.inventoryLevel === 'low') {
            return { type: 'surcharge', percentage: 15, reason: 'Low inventory' };
          }
          return null;
        }
      },
      {
        id: 'late_night_surcharge',
        name: 'Late Night Surcharge',
        description: '5% surcharge after 8:30 PM',
        enabled: process.env.DYNAMIC_PRICING_LATE_NIGHT === 'true',
        apply: (context) => {
          const hour = new Date().getHours();
          const minute = new Date().getMinutes();
          if (hour >= 20 && minute >= 30) {
            return { type: 'surcharge', percentage: 5, reason: 'Late night service' };
          }
          return null;
        }
      },
      {
        id: 'happy_hour_discount',
        name: 'Happy Hour Discount',
        description: '10% off during early hours (6-7 PM)',
        enabled: true,
        apply: (context) => {
          const hour = new Date().getHours();
          if (hour === 18) {
            return { type: 'discount', percentage: 10, reason: 'Happy hour special' };
          }
          return null;
        }
      },
      {
        id: 'rainy_day_surcharge',
        name: 'Rainy Day Delivery Surcharge',
        description: 'GH₵ 2 surcharge on rainy days',
        enabled: process.env.DYNAMIC_PRICING_WEATHER === 'true',
        apply: (context) => {
          if (context.weather === 'rainy') {
            return { type: 'fixed_surcharge', amount: 2, reason: 'Rainy day delivery' };
          }
          return null;
        }
      },
      {
        id: 'weekend_special',
        name: 'Weekend Special',
        description: '5% discount on weekends',
        enabled: true,
        apply: (context) => {
          const day = new Date().getDay();
          if (day === 0 || day === 6) {
            return { type: 'discount', percentage: 5, reason: 'Weekend special' };
          }
          return null;
        }
      },
      {
        id: 'bulk_order_discount',
        name: 'Bulk Order Discount',
        description: 'Discount for large orders',
        enabled: true,
        apply: (context) => {
          if (context.orderTotal >= 100) {
            return { type: 'discount', percentage: 8, reason: 'Bulk order discount (GH₵ 100+)' };
          }
          if (context.orderTotal >= 60) {
            return { type: 'discount', percentage: 5, reason: 'Bulk order discount (GH₵ 60+)' };
          }
          return null;
        }
      }
    ];
  }

  /**
   * Calculate dynamic price for an order
   */
  calculatePrice(basePrice, context = {}) {
    const adjustments = [];
    let totalSurcharge = 0;
    let totalDiscount = 0;
    let fixedSurcharge = 0;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      const result = rule.apply(context);
      if (!result) continue;

      if (result.type === 'surcharge') {
        const amount = (basePrice * result.percentage) / 100;
        totalSurcharge += amount;
        adjustments.push({ rule: rule.name, ...result, amount: amount });
      } else if (result.type === 'discount') {
        const amount = (basePrice * result.percentage) / 100;
        totalDiscount += amount;
        adjustments.push({ rule: rule.name, ...result, amount: amount });
      } else if (result.type === 'fixed_surcharge') {
        fixedSurcharge += result.amount;
        adjustments.push({ rule: rule.name, ...result });
      }
    }

    const finalPrice = Math.max(0, basePrice + totalSurcharge - totalDiscount + fixedSurcharge);

    return {
      basePrice,
      surcharges: totalSurcharge + fixedSurcharge,
      discounts: totalDiscount,
      finalPrice: parseFloat(finalPrice.toFixed(2)),
      adjustments,
      appliedRules: adjustments.length
    };
  }

  /**
   * Get current pricing for all menu items
   */
  getMenuPricing(menuItems, context = {}) {
    return menuItems.map(item => {
      const pricing = this.calculatePrice(item.price, context);
      return {
        ...item,
        originalPrice: item.price,
        currentPrice: pricing.finalPrice,
        priceChanged: pricing.finalPrice !== item.price,
        adjustments: pricing.adjustments
      };
    });
  }

  /**
   * Get active rules
   */
  getActiveRules() {
    return this.rules.filter(r => r.enabled);
  }

  /**
   * Toggle a rule
   */
  toggleRule(ruleId, enabled) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      return { success: true, ruleId, enabled };
    }
    return { success: false, error: 'Rule not found' };
  }

  /**
   * Get pricing forecast for the day
   */
  getDailyForecast() {
    const hours = [];
    for (let h = 6; h <= 21; h++) {
      const context = { time: h };
      const samplePrice = this.calculatePrice(30, context); // sample GH₵ 30 item
      hours.push({
        hour: `${h}:00`,
        surchargePercent: samplePrice.adjustments
          .filter(a => a.type === 'surcharge')
          .reduce((sum, a) => sum + a.percentage, 0),
        discountPercent: samplePrice.adjustments
          .filter(a => a.type === 'discount')
          .reduce((sum, a) => sum + a.percentage, 0),
        samplePrice: samplePrice.finalPrice,
        adjustments: samplePrice.adjustments
      });
    }
    return hours;
  }
}

module.exports = new DynamicPricingEngine();
