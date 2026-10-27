const express = require('express');
const router = express.Router();

// Mock database - replace with actual Prisma queries
const mockCustomers = new Map();
const mockOrders = new Map();
const mockAddresses = new Map();

// Get customer profile
router.get('/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Mock customer data
    const customer = {
      id: customerId,
      name: 'Kwame Mensah',
      phone: '0541234567',
      email: 'kwame@example.com',
      loyaltyPoints: 150,
      totalOrders: 12,
      createdAt: new Date('2024-01-15')
    };

    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer profile' });
  }
});

// Get customer order history
router.get('/:customerId/orders', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Mock order history
    const orders = [
      {
        orderId: 'YB-5041',
        customerId,
        items: [
          { name: 'Ghana Spag Chicken', quantity: 2, price: 30.00 },
          { name: 'Ghana Spag Sausage', quantity: 1, price: 30.00 }
        ],
        total: 60.00,
        status: 'delivered',
        createdAt: new Date('2024-11-20T18:30:00'),
        deliveredAt: new Date('2024-11-20T19:05:00')
      },
      {
        orderId: 'YB-5012',
        customerId,
        items: [
          { name: 'Ghana Spag Feast', quantity: 1, price: 40.00 }
        ],
        total: 40.00,
        status: 'delivered',
        createdAt: new Date('2024-11-15T19:00:00'),
        deliveredAt: new Date('2024-11-15T19:35:00')
      },
      {
        orderId: 'YB-4987',
        customerId,
        items: [
          { name: 'Ghana Spag Veggie', quantity: 3, price: 30.00 }
        ],
        total: 90.00,
        status: 'delivered',
        createdAt: new Date('2024-11-10T20:15:00'),
        deliveredAt: new Date('2024-11-10T20:50:00')
      }
    ];

    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch order history' });
  }
});

// Get saved addresses
router.get('/:customerId/addresses', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Mock saved addresses
    const addresses = [
      {
        id: 'ADDR-001',
        customerId,
        label: '🏠 Home',
        address: 'Circle Odo Rice Junction, Accra',
        latitude: 5.5717,
        longitude: -0.2073,
        isDefault: true
      },
      {
        id: 'ADDR-002',
        customerId,
        label: '💼 Office',
        address: 'Adabraka Police Station Bus Stop, Accra',
        latitude: 5.5725,
        longitude: -0.2125,
        isDefault: false
      }
    ];

    res.json(addresses);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch saved addresses' });
  }
});

// Add new address
router.post('/:customerId/addresses', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { label, address, latitude, longitude, isDefault } = req.body;
    
    const newAddress = {
      id: `ADDR-${Date.now()}`,
      customerId,
      label,
      address,
      latitude,
      longitude,
      isDefault: isDefault || false,
      createdAt: new Date()
    };

    // In production: save to database
    mockAddresses.set(newAddress.id, newAddress);

    res.status(201).json(newAddress);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add address' });
  }
});

// Update address
router.put('/:customerId/addresses/:addressId', async (req, res) => {
  try {
    const { addressId } = req.params;
    const updates = req.body;
    
    // In production: update in database
    const address = mockAddresses.get(addressId);
    if (!address) {
      return res.status(404).json({ error: 'Address not found' });
    }

    Object.assign(address, updates);
    mockAddresses.set(addressId, address);

    res.json(address);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update address' });
  }
});

// Delete address
router.delete('/:customerId/addresses/:addressId', async (req, res) => {
  try {
    const { addressId } = req.params;
    
    // In production: delete from database
    const deleted = mockAddresses.delete(addressId);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Address not found' });
    }

    res.json({ message: 'Address deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

// Update customer profile
router.put('/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { name, phone, email } = req.body;
    
    // In production: update in database
    const updatedCustomer = {
      id: customerId,
      name,
      phone,
      email,
      updatedAt: new Date()
    };

    res.json(updatedCustomer);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
