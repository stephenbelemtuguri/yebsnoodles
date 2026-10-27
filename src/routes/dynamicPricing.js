const express = require('express');
const router = express.Router();
const pricingEngine = require('../services/dynamicPricing');

// Get current pricing for menu items
router.get('/menu-pricing', async (req, res) => {
  try {
    const { weather, inventoryLevel } = req.query;
    const context = {
      weather: weather || 'clear',
      inventoryLevel: inventoryLevel || 'normal',
      time: new Date().getHours()
    };

    // Get active pricing rules
    const activeRules = pricingEngine.getActiveRules();
    
    res.json({
      activeRules: activeRules.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description
      })),
      currentContext: {
        hour: new Date().getHours(),
        day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()],
        weather: context.weather,
        inventoryLevel: context.inventoryLevel
      },
      forecast: pricingEngine.getDailyForecast()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pricing info' });
  }
});

// Calculate price for a specific order
router.post('/calculate', async (req, res) => {
  try {
    const { basePrice, weather, inventoryLevel, orderTotal } = req.body;
    
    const context = {
      weather: weather || 'clear',
      inventoryLevel: inventoryLevel || 'normal',
      orderTotal: orderTotal || basePrice
    };

    const pricing = pricingEngine.calculatePrice(parseFloat(basePrice), context);
    
    res.json({
      basePrice: parseFloat(basePrice),
      finalPrice: pricing.finalPrice,
      adjustments: pricing.adjustments,
      savings: pricing.discounts > 0 ? pricing.discounts : 0,
      surcharges: pricing.surcharges
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate price' });
  }
});

// Get all pricing rules (admin)
router.get('/rules', async (req, res) => {
  try {
    res.json({
      rules: pricingEngine.rules.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        enabled: r.enabled
      })),
      totalRules: pricingEngine.rules.length,
      activeRules: pricingEngine.rules.filter(r => r.enabled).length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pricing rules' });
  }
});

// Toggle a pricing rule (admin)
router.patch('/rules/:ruleId/toggle', async (req, res) => {
  try {
    const { ruleId } = req.params;
    const { enabled } = req.body;
    
    const result = pricingEngine.toggleRule(ruleId, enabled);
    if (!result.success) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    res.json({
      message: `Rule ${enabled ? 'enabled' : 'disabled'}`,
      ruleId,
      enabled
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle rule' });
  }
});

// Get daily pricing forecast
router.get('/forecast', async (req, res) => {
  try {
    const forecast = pricingEngine.getDailyForecast();
    res.json({
      date: new Date().toISOString().split('T')[0],
      forecast
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch forecast' });
  }
});

module.exports = router;
