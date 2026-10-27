const express = require('express');
const router = express.Router();

// In-memory referrals store
const referrals = new Map();       // referralId -> referral record
const referralCodes = new Map();    // code -> customerId
let referralCounter = 8000;

// Generate unique referral code for a customer
function generateReferralCode(customerName) {
  const base = customerName.replace(/[^A-Za-z]/g, '').toUpperCase().substring(0, 4) || 'YEBS';
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${base}${random}`;
}

// Get or create referral code for customer
router.get('/customer/:customerId/code', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { customerName } = req.query;

    let existingCode = null;
    referralCodes.forEach((cid, code) => {
      if (cid === customerId) existingCode = code;
    });

    if (existingCode) {
      return res.json({
        referralCode: existingCode,
        referralLink: `https://yebsnoodles.com/?ref=${existingCode}`,
        customerId
      });
    }

    const newCode = generateReferralCode(customerName || 'YEBS');
    referralCodes.set(newCode, customerId);

    res.json({
      referralCode: newCode,
      referralLink: `https://yebsnoodles.com/?ref=${newCode}`,
      customerId,
      isNew: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate referral code' });
  }
});

// Track a referral (when referred customer signs up)
router.post('/track', async (req, res) => {
  try {
    const { referralCode, newCustomerId, newCustomerName, newCustomerPhone } = req.body;

    const referrerId = referralCodes.get(referralCode);
    if (!referrerId) {
      return res.status(404).json({ error: 'Invalid referral code' });
    }

    const referral = {
      id: `REF-${++referralCounter}`,
      referralCode,
      referrerId,
      referredCustomerId: newCustomerId,
      referredCustomerName: newCustomerName,
      referredCustomerPhone: newCustomerPhone,
      status: 'pending', // pending -> qualified -> rewarded
      referrerReward: 50,  // points
      refereeReward: 50,   // points
      createdAt: new Date().toISOString(),
      qualifiedAt: null,
      rewardedAt: null
    };

    referrals.set(referral.id, referral);

    res.status(201).json({
      message: 'Referral tracked successfully',
      referral,
      referrerReward: referral.referrerReward,
      refereeReward: referral.refereeReward
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to track referral' });
  }
});

// Qualify a referral (when referred customer makes first order)
router.post('/:referralId/qualify', async (req, res) => {
  try {
    const { referralId } = req.params;
    const { orderId, orderTotal } = req.body;
    
    const referral = referrals.get(referralId);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });
    if (referral.status !== 'pending') {
      return res.status(400).json({ error: `Referral already ${referral.status}` });
    }

    referral.status = 'qualified';
    referral.qualifiedAt = new Date().toISOString();
    referral.qualifyingOrderId = orderId;
    referral.qualifyingOrderTotal = orderTotal;
    referrals.set(referralId, referral);

    res.json({
      message: 'Referral qualified! Both parties will receive reward points.',
      referral
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to qualify referral' });
  }
});

// Reward both parties (after referral is qualified)
router.post('/:referralId/reward', async (req, res) => {
  try {
    const { referralId } = req.params;
    const referral = referrals.get(referralId);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });
    if (referral.status !== 'qualified') {
      return res.status(400).json({ error: 'Referral not yet qualified' });
    }

    referral.status = 'rewarded';
    referral.rewardedAt = new Date().toISOString();
    referrals.set(referralId, referral);

    // In production: call loyalty service to add points to both customers
    // await loyaltyService.earn(referral.referrerId, referral.referrerReward, 'referral_bonus');
    // await loyaltyService.earn(referral.referredCustomerId, referral.refereeReward, 'referral_bonus');

    res.json({
      message: 'Referral rewards distributed successfully',
      referral,
      referrerReward: referral.referrerReward,
      refereeReward: referral.refereeReward
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to distribute rewards' });
  }
});

// Get referrals made by a customer
router.get('/customer/:customerId/referrals', async (req, res) => {
  try {
    const { customerId } = req.params;
    const customerReferrals = Array.from(referrals.values())
      .filter(r => r.referrerId === customerId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const stats = {
      total: customerReferrals.length,
      pending: customerReferrals.filter(r => r.status === 'pending').length,
      qualified: customerReferrals.filter(r => r.status === 'qualified').length,
      rewarded: customerReferrals.filter(r => r.status === 'rewarded').length,
      totalPointsEarned: customerReferrals
        .filter(r => r.status === 'rewarded')
        .reduce((sum, r) => sum + r.referrerReward, 0)
    };

    res.json({ referrals: customerReferrals, stats });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

// Get referral statistics (admin)
router.get('/stats/overview', async (req, res) => {
  try {
    const allReferrals = Array.from(referrals.values());
    
    res.json({
      totalReferrals: allReferrals.length,
      pending: allReferrals.filter(r => r.status === 'pending').length,
      qualified: allReferrals.filter(r => r.status === 'qualified').length,
      rewarded: allReferrals.filter(r => r.status === 'rewarded').length,
      totalRewardsDistributed: allReferrals
        .filter(r => r.status === 'rewarded')
        .reduce((sum, r) => sum + r.referrerReward + r.refereeReward, 0),
      conversionRate: allReferrals.length > 0
        ? ((allReferrals.filter(r => r.status === 'rewarded').length / allReferrals.length) * 100).toFixed(1) + '%'
        : '0%',
      topReferrers: allReferrals
        .filter(r => r.status === 'rewarded')
        .reduce((acc, r) => {
          acc[r.referrerId] = (acc[r.referrerId] || 0) + 1;
          return acc;
        }, {})
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch referral statistics' });
  }
});

module.exports = router;
