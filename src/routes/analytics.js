const express = require('express');
const router = express.Router();

// Get dashboard analytics
router.get('/dashboard', async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    
    // Mock analytics data
    const analytics = {
      kpis: {
        revenue: 12190.00,
        orders: 188,
        customers: 145,
        aov: 24.85,
        growth: {
          revenue: 12.5,
          orders: 8.3,
          customers: 15.2,
          aov: 3.8
        }
      },
      
      topItems: [
        {
          id: 'ITEM-001',
          name: 'Ghana Spag Chicken',
          quantity: 78,
          revenue: 2340.00,
          percentage: 42
        },
        {
          id: 'ITEM-002',
          name: 'Ghana Spag Sausage',
          quantity: 52,
          revenue: 1560.00,
          percentage: 28
        },
        {
          id: 'ITEM-003',
          name: 'Ghana Spag Feast',
          quantity: 34,
          revenue: 1360.00,
          percentage: 18
        },
        {
          id: 'ITEM-004',
          name: 'Ghana Spag Veggie',
          quantity: 24,
          revenue: 720.00,
          percentage: 12
        }
      ],
      
      recentOrders: [
        {
          orderId: 'YB-5041',
          customer: 'Kwame A.',
          items: '2',
          amount: 48.00,
          status: 'delivered',
          driver: 'Kofi O.',
          time: '12 min ago'
        },
        {
          orderId: 'YB-5040',
          customer: 'Ama B.',
          items: '1',
          amount: 30.00,
          status: 'enroute',
          driver: 'Emmanuel T.',
          time: '18 min ago'
        },
        {
          orderId: 'YB-5039',
          customer: 'Yaw C.',
          items: '3',
          amount: 90.00,
          status: 'kitchen',
          driver: 'Not assigned',
          time: '25 min ago'
        }
      ],
      
      driverPerformance: [
        {
          id: 'DRV-001',
          name: 'Kwame Mensah',
          deliveries: 45,
          onTimeRate: 96,
          avgTime: 16,
          rating: 4.9,
          earnings: 675.00
        },
        {
          id: 'DRV-002',
          name: 'Kofi Owusu',
          deliveries: 38,
          onTimeRate: 94,
          avgTime: 18,
          rating: 4.8,
          earnings: 570.00
        },
        {
          id: 'DRV-003',
          name: 'Emmanuel Tetteh',
          deliveries: 42,
          onTimeRate: 98,
          avgTime: 15,
          rating: 4.9,
          earnings: 630.00
        }
      ],
      
      ordersByStatus: {
        delivered: 145,
        kitchen: 23,
        enroute: 12,
        pending: 8
      },
      
      peakHours: [
        { hour: '18:00', orders: 42 },
        { hour: '19:00', orders: 68 },
        { hour: '20:00', orders: 85 },
        { hour: '21:00', orders: 43 }
      ],
      
      revenueByDay: [
        { date: '2024-11-18', revenue: 1580.00 },
        { date: '2024-11-19', revenue: 2240.00 },
        { date: '2024-11-20', revenue: 1950.00 },
        { date: '2024-11-21', revenue: 2120.00 },
        { date: '2024-11-22', revenue: 2580.00 },
        { date: '2024-11-23', revenue: 3150.00 },
        { date: '2024-11-24', revenue: 1770.00 }
      ]
    };

    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get revenue report
router.get('/revenue', async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    
    // Mock revenue data
    const revenueData = {
      total: 12190.00,
      breakdown: [
        { period: '2024-11-18', amount: 1580.00, orders: 24 },
        { period: '2024-11-19', amount: 2240.00, orders: 35 },
        { period: '2024-11-20', amount: 1950.00, orders: 28 },
        { period: '2024-11-21', amount: 2120.00, orders: 32 },
        { period: '2024-11-22', amount: 2580.00, orders: 38 },
        { period: '2024-11-23', amount: 3150.00, orders: 45 },
        { period: '2024-11-24', amount: 1770.00, orders: 26 }
      ],
      paymentMethods: {
        momo: 10971.00,
        cash: 1219.00
      }
    };

    res.json(revenueData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch revenue report' });
  }
});

// Get customer insights
router.get('/customers', async (req, res) => {
  try {
    const insights = {
      totalCustomers: 145,
      newCustomers: 22,
      returningCustomers: 123,
      retentionRate: 68,
      avgOrdersPerCustomer: 2.4,
      customerLifetimeValue: 84.00,
      
      topCustomers: [
        {
          id: 'CUST-001',
          name: 'Kwame M.',
          orders: 15,
          totalSpent: 450.00,
          avgOrderValue: 30.00
        },
        {
          id: 'CUST-002',
          name: 'Ama B.',
          orders: 12,
          totalSpent: 360.00,
          avgOrderValue: 30.00
        },
        {
          id: 'CUST-003',
          name: 'Yaw C.',
          orders: 10,
          totalSpent: 400.00,
          avgOrderValue: 40.00
        }
      ]
    };

    res.json(insights);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer insights' });
  }
});

// Export analytics data
router.get('/export', async (req, res) => {
  try {
    const { format = 'json', startDate, endDate } = req.query;
    
    // Generate export data
    const exportData = {
      generated: new Date(),
      period: { startDate, endDate },
      summary: {
        totalRevenue: 12190.00,
        totalOrders: 188,
        totalCustomers: 145
      }
      // ... more data
    };

    if (format === 'csv') {
      // Convert to CSV
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=analytics.csv');
      // Send CSV data
      res.send('Order ID,Customer,Amount,Date\n...');
    } else {
      res.json(exportData);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to export analytics' });
  }
});

module.exports = router;
