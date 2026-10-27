const express = require('express');
const router = express.Router();

// In-memory loyalty store
const customerPoints = new Map(); // customerId -> { points, tier, history }
const loyaltyTiers = [
  { name: 'Bronze', minPoints: 0, discount: 0, perks: ['Birthday surprise'] },
  { name: 'Silver', minPoints: 100, discount: 5, perks: ['5% off orders', 'Priority delivery', 'Birthday surprise'] },
  { name: 'Gold', minPoints: 300, discount: 10, perks: ['10% off orders', 'Priority delivery', 'Free delivery on orders > GH₵50', 'Birthday surprise'] },
  { name: 'Platinum', minPoints: 600, discount: 15, perks: ['15% off orders', 'Priority delivery', 'Free delivery always', 'Exclusive menu access', 'Birthday surprise', 'Personal concierge'] }
];

const rewardsCatalog = [
  { id: 'REW-001', name: 'GH₵ 5 Off Next Order', pointsCost: 50, type: 'discount', value: 5 },
  { id: 'REW-002', name: 'GH₵ 10 Off Next Order', pointsCost: 100, type: 'discount', value: 10 },
  { id: 'REW-003', name: 'Free Delivery', pointsCost: 75, type: 'free_delivery', value: 0 },
  { id: 'REW-004', name: 'Free Ghana Spag Veggie', pointsCost: 150, type: 'free_item', value: 30, menuItemId: 'MENU-104' },
  { id: 'REW-005', name: 'GH₵ 20 Off Next Order', pointsCost: 200, type: 'discount', value: 20 },
  { id: 'REW-006', name: 'Free Ghana Spag Chicken', pointsCost: 300, type: 'free_item', value: 30, menuItemId: 'MENU-101' },
  { id: 'REW-007', name: 'Free Ghana Spag Feast', pointsCost: 400, type: 'free_item', value: 40, menuItemId: 'MENU-103' }
];

// Get customer loyalty profile
router.get('/customer/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const profile = customerPoints.get(customerId) || {
      customerId,
      points: 0,
      tier: 'Bronze',
      totalEarned: 0,
      totalRedeemed: 0,
      history: []
    };

    const currentTier = loyaltyTiers.find(t => t.name === profile.tier);
    const nextTier = loyaltyTiers.find(t => t.minPoints > profile.points);
    
    res.json({
      ...profile,
      tierInfo: currentTier,
      nextTier: nextTier ? {
        name: nextTier.name,
        pointsNeeded: nextTier.minPoints - profile.points
      } : null,
      progressToNext: nextTier
        ? Math.round((profile.points - currentTier.minPoints) / (nextTier.minPoints - currentTier.minPoints) * 100)
        : 100
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch loyalty profile' });
  }
});

// Earn points (called after order completion)
router.post('/earn', async (req, res) => {
  try {
    const { customerId, orderId, orderTotal, points } = req.body;
    
    // 1 point per GH₵ 1 spent (default), or custom points
    const earnedPoints = points || Math.floor(orderTotal); // 1:1 ratio
    
    if (!customerPoints.has(customerId)) {
      customerPoints.set(customerId, {
        customerId,
        points: 0,
        tier: 'Bronze',
        totalEarned: 0,
        totalRedeemed: 0,
        history: []
      });
    }

    const profile = customerPoints.get(customerId);
    profile.points += earnedPoints;
    profile.totalEarned += earnedPoints;
    
    // Update tier
    const newTier = loyaltyTiers.slice().reverse().find(t => profile.points >= t.minPoints);
    const oldTier = profile.tier;
    profile.tier = newTier.name;
    
    profile.history.push({
      id: `LH-${Date.now()}`,
      type: 'earned',
      points: earnedPoints,
      orderId,
      orderTotal,
      description: `Earned ${earnedPoints} points from order ${orderId}`,
      timestamp: new Date().toISOString()
    });

    customerPoints.set(customerId, profile);

    res.json({
      message: 'Points earned successfully',
      earnedPoints,
      totalPoints: profile.points,
      tier: profile.tier,
      tierUpgraded: oldTier !== profile.tier,
      previousTier: oldTier !== profile.tier ? oldTier : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to earn points' });
  }
});

// Redeem points for a reward
router.post('/redeem', async (req, res) => {
  try {
    const { customerId, rewardId } = req.body;
    
    const reward = rewardsCatalog.find(r => r.id === rewardId);
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const profile = customerPoints.get(customerId);
    if (!profile) return res.status(404).json({ error: 'Customer loyalty profile not found' });

    if (profile.points < reward.pointsCost) {
      return res.status(400).json({
        error: 'Insufficient points',
        currentPoints: profile.points,
        requiredPoints: reward.pointsCost,
        pointsNeeded: reward.pointsCost - profile.points
      });
    }

    // Deduct points
    profile.points -= reward.pointsCost;
    profile.totalRedeemed += reward.pointsCost;
    
    profile.history.push({
      id: `LH-${Date.now()}`,
      type: 'redeemed',
      points: -reward.pointsCost,
      rewardId,
      rewardName: reward.name,
      description: `Redeemed ${reward.pointsCost} points for: ${reward.name}`,
      timestamp: new Date().toISOString()
    });

    customerPoints.set(customerId, profile);

    // Generate redemption code
    const redemptionCode = `YEBS-RED-${Date.now().toString(36).toUpperCase()}`;

    res.json({
      message: 'Reward redeemed successfully!',
      reward,
      redemptionCode,
      remainingPoints: profile.points,
      newTier: profile.tier
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to redeem points' });
  }
});

// Get rewards catalog
router.get('/rewards', async (req, res) => {
  try {
    const { customerId } = req.query;
    
    const profile = customerId ? customerPoints.get(customerId) : null;
    const currentPoints = profile?.points || 0;

    const rewards = rewardsCatalog.map(reward => ({
      ...reward,
      affordable: currentPoints >= reward.pointsCost,
      pointsNeeded: Math.max(0, reward.pointsCost - currentPoints)
    }));

    res.json({
      rewards,
      customerPoints: currentPoints,
      tiers: loyaltyTiers
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rewards catalog' });
  }
});

// Get loyalty tiers
router.get('/tiers', async (req, res) => {
  res.json(loyaltyTiers);
});

// Get points history
router.get('/customer/:customerId/history', async (req, res) => {
  try {
    const { customerId } = req.params;
    const profile = customerPoints.get(customerId);
    if (!profile) return res.json({ history: [] });

    res.json({
      history: profile.history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
      summary: {
        totalEarned: profile.totalEarned,
        totalRedeemed: profile.totalRedeemed,
        currentBalance: profile.points,
        tier: profile.tier
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch points history' });
  }
});

// Admin: Add bonus points to customer
router.post('/admin/bonus', async (req, res) => {
  try {
    const { customerId, points, reason } = req.body;
    
    if (!customerPoints.has(customerId)) {
      customerPoints.set(customerId, {
        customerId,
        points: 0,
        tier: 'Bronze',
        totalEarned: 0,
        totalRedeemed: 0,
        history: []
      });
    }

    const profile = customerPoints.get(customerId);
    profile.points += parseInt(points);
    profile.totalEarned += parseInt(points);
    
    profile.history.push({
      id: `LH-${Date.now()}`,
      type: 'bonus',
      points: parseInt(points),
      description: `Admin bonus: ${reason || 'Goodwill gesture'}`,
      timestamp: new Date().toISOString()
    });

    customerPoints.set(customerId, profile);

    res.json({
      message: 'Bonus points added',
      addedPoints: points,
      totalPoints: profile.points
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add bonus points' });
  }
});

module.exports = router;
