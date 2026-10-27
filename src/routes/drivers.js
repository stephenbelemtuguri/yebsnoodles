const express = require('express');
const router = express.Router();

// Get driver earnings
router.get('/:driverId/earnings', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { period = 'week' } = req.query;
    
    // Mock earnings data
    const earningsData = {
      driverId,
      totalEarnings: 3850.50,
      thisWeek: 403.00,
      thisMonth: 1245.00,
      totalDeliveries: 247,
      avgPerDelivery: 15.58,
      pendingPayout: 185.50,
      
      // Weekly earnings breakdown
      weeklyEarnings: [
        { date: '2024-11-18', earnings: 45.50, deliveries: 3 },
        { date: '2024-11-19', earnings: 62.00, deliveries: 4 },
        { date: '2024-11-20', earnings: 38.00, deliveries: 2 },
        { date: '2024-11-21', earnings: 55.50, deliveries: 3 },
        { date: '2024-11-22', earnings: 70.00, deliveries: 5 },
        { date: '2024-11-23', earnings: 85.00, deliveries: 6 },
        { date: '2024-11-24', earnings: 47.00, deliveries: 3 }
      ],
      
      // Payout history
      payouts: [
        {
          id: 'PAY-001',
          amount: 520.50,
          status: 'paid',
          date: '2024-11-15',
          deliveries: 35,
          method: 'MTN MoMo',
          transactionId: 'MM2024111500123'
        },
        {
          id: 'PAY-002',
          amount: 485.00,
          status: 'paid',
          date: '2024-11-08',
          deliveries: 32,
          method: 'MTN MoMo',
          transactionId: 'MM2024110800456'
        },
        {
          id: 'PAY-003',
          amount: 185.50,
          status: 'pending',
          date: '2024-11-22',
          deliveries: 12,
          method: 'MTN MoMo'
        }
      ],
      
      // Recent deliveries
      recentDeliveries: [
        {
          orderId: 'YB-5041',
          date: new Date(),
          earnings: 18.50,
          distance: 3.2,
          duration: 15
        },
        {
          orderId: 'YB-5040',
          date: new Date(Date.now() - 3600000),
          earnings: 15.00,
          distance: 2.8,
          duration: 12
        },
        {
          orderId: 'YB-5039',
          date: new Date(Date.now() - 7200000),
          earnings: 22.00,
          distance: 4.5,
          duration: 18
        },
        {
          orderId: 'YB-5038',
          date: new Date(Date.now() - 10800000),
          earnings: 16.50,
          distance: 3.0,
          duration: 14
        }
      ],
      
      // Performance metrics
      performance: {
        onTimeRate: 95,
        customerRating: 4.8,
        completionRate: 98,
        avgDeliveryTime: 18
      }
    };

    res.json(earningsData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch earnings data' });
  }
});

// Request payout
router.post('/:driverId/payouts', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { amount, method = 'MTN MoMo' } = req.body;
    
    const payout = {
      id: `PAY-${Date.now()}`,
      driverId,
      amount,
      status: 'pending',
      method,
      requestedAt: new Date(),
      estimatedPayoutDate: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    };

    // In production: save to database and initiate payout process
    
    res.status(201).json({
      message: 'Payout request submitted successfully',
      payout
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to request payout' });
  }
});

// Get driver shifts
router.get('/:driverId/shifts', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const shifts = [
      {
        id: 'SHIFT-001',
        driverId,
        date: new Date(),
        startTime: '18:00',
        endTime: '21:00',
        status: 'active',
        deliveries: 5,
        earnings: 75.00
      },
      {
        id: 'SHIFT-002',
        driverId,
        date: new Date(Date.now() - 86400000),
        startTime: '18:00',
        endTime: '21:00',
        status: 'completed',
        deliveries: 8,
        earnings: 120.00
      }
    ];

    res.json(shifts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// Start shift
router.post('/:driverId/shifts/start', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const shift = {
      id: `SHIFT-${Date.now()}`,
      driverId,
      date: new Date(),
      startTime: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      status: 'active'
    };

    res.status(201).json(shift);
  } catch (error) {
    res.status(500).json({ error: 'Failed to start shift' });
  }
});

// End shift
router.post('/:driverId/shifts/:shiftId/end', async (req, res) => {
  try {
    const { shiftId } = req.params;
    
    const shift = {
      id: shiftId,
      endTime: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      status: 'completed',
      updatedAt: new Date()
    };

    res.json(shift);
  } catch (error) {
    res.status(500).json({ error: 'Failed to end shift' });
  }
});

module.exports = router;
