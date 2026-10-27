const express = require('express');
const router = express.Router();

// In-memory inventory store
const inventoryStore = new Map(); // itemId -> stock record
const stockMovements = new Map();  // movementId -> movement log
let movementIdCounter = 7000;

// Seed initial inventory
const initialInventory = [
  { ingredient: 'Spaghetti (500g pack)', unit: 'packs', currentStock: 50, minStock: 15, maxStock: 100, costPerUnit: 8.00, supplier: 'Accra Central Wholesale', reorderPoint: 20 },
  { ingredient: 'Chicken Breast (kg)', unit: 'kg', currentStock: 12, minStock: 5, maxStock: 30, costPerUnit: 35.00, supplier: 'Melcom Food Suppliers', reorderPoint: 8 },
  { ingredient: 'Sausages (pack of 10)', unit: 'packs', currentStock: 25, minStock: 8, maxStock: 50, costPerUnit: 15.00, supplier: 'Adabraka Meat Market', reorderPoint: 12 },
  { ingredient: 'Eggs (crate of 30)', unit: 'crates', currentStock: 8, minStock: 3, maxStock: 20, costPerUnit: 25.00, supplier: 'Local Farm Co-op', reorderPoint: 5 },
  { ingredient: 'Vegetable Oil (L)', unit: 'liters', currentStock: 18, minStock: 5, maxStock: 40, costPerUnit: 12.00, supplier: 'Accra Central Wholesale', reorderPoint: 8 },
  { ingredient: 'Onions (kg)', unit: 'kg', currentStock: 10, minStock: 3, maxStock: 25, costPerUnit: 6.00, supplier: 'Adabraka Market', reorderPoint: 5 },
  { ingredient: 'Tomatoes (kg)', unit: 'kg', currentStock: 14, minStock: 4, maxStock: 30, costPerUnit: 10.00, supplier: 'Adabraka Market', reorderPoint: 6 },
  { ingredient: 'Maggi Cubes (pack)', unit: 'packs', currentStock: 30, minStock: 10, maxStock: 60, costPerUnit: 5.00, supplier: 'Melcom Food Suppliers', reorderPoint: 15 },
  { ingredient: 'Gizzard (kg)', unit: 'kg', currentStock: 6, minStock: 2, maxStock: 15, costPerUnit: 30.00, supplier: 'Adabraka Meat Market', reorderPoint: 4 }
];

initialInventory.forEach((item, i) => {
  const id = `INV-${1000 + i}`;
  inventoryStore.set(id, { id, ...item, lastUpdated: new Date().toISOString() });
});

// Get all inventory
router.get('/', async (req, res) => {
  try {
    const items = Array.from(inventoryStore.values());
    const lowStockItems = items.filter(i => i.currentStock <= i.reorderPoint);
    const outOfStockItems = items.filter(i => i.currentStock === 0);
    
    res.json({
      total: items.length,
      lowStockAlerts: lowStockItems.length,
      outOfStock: outOfStockItems.length,
      totalInventoryValue: items.reduce((sum, i) => sum + (i.currentStock * i.costPerUnit), 0).toFixed(2),
      items: items.sort((a, b) => a.currentStock / a.maxStock - b.currentStock / b.maxStock),
      alerts: {
        lowStock: lowStockItems,
        outOfStock: outOfStockItems
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// Get single inventory item
router.get('/:itemId', async (req, res) => {
  try {
    const item = inventoryStore.get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory item' });
  }
});

// Add new inventory item
router.post('/', async (req, res) => {
  try {
    const { ingredient, unit, currentStock, minStock, maxStock, costPerUnit, supplier, reorderPoint } = req.body;
    
    if (!ingredient || !unit || currentStock === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const id = `INV-${1000 + inventoryStore.size + 1}`;
    const item = {
      id,
      ingredient,
      unit,
      currentStock: parseFloat(currentStock),
      minStock: parseFloat(minStock) || 0,
      maxStock: parseFloat(maxStock) || 100,
      costPerUnit: parseFloat(costPerUnit) || 0,
      supplier: supplier || '',
      reorderPoint: parseFloat(reorderPoint) || minStock || 5,
      lastUpdated: new Date().toISOString()
    };
    inventoryStore.set(id, item);
    res.status(201).json({ message: 'Inventory item added', item });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add inventory item' });
  }
});

// Update stock (increase or decrease)
router.patch('/:itemId/stock', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { change, reason, reference } = req.body; // change: +/- number, reason: restock/usage/waste
    
    const item = inventoryStore.get(itemId);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });

    const newStock = parseFloat(item.currentStock) + parseFloat(change);
    if (newStock < 0) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    const movement = {
      id: `MOV-${++movementIdCounter}`,
      itemId,
      ingredient: item.ingredient,
      previousStock: item.currentStock,
      change: parseFloat(change),
      newStock,
      reason: reason || 'adjustment',
      reference: reference || null, // order ID or purchase ref
      timestamp: new Date().toISOString()
    };
    stockMovements.set(movement.id, movement);

    item.currentStock = newStock;
    item.lastUpdated = new Date().toISOString();
    inventoryStore.set(itemId, item);

    // Check if now below reorder point
    const alert = newStock <= item.reorderPoint;

    res.json({
      message: `Stock updated for ${item.ingredient}`,
      item,
      movement,
      lowStockAlert: alert
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// Restock (add stock)
router.post('/:itemId/restock', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { quantity, costPerUnit, supplier } = req.body;
    
    const item = inventoryStore.get(itemId);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });

    const addQty = parseFloat(quantity);
    if (addQty <= 0) return res.status(400).json({ error: 'Quantity must be positive' });

    if (costPerUnit !== undefined) item.costPerUnit = parseFloat(costPerUnit);
    if (supplier) item.supplier = supplier;

    const movement = {
      id: `MOV-${++movementIdCounter}`,
      itemId,
      ingredient: item.ingredient,
      previousStock: item.currentStock,
      change: addQty,
      newStock: item.currentStock + addQty,
      reason: 'restock',
      timestamp: new Date().toISOString()
    };
    stockMovements.set(movement.id, movement);

    item.currentStock += addQty;
    item.lastUpdated = new Date().toISOString();
    inventoryStore.set(itemId, item);

    res.json({
      message: `Restocked ${addQty} ${item.unit} of ${item.ingredient}`,
      item,
      movement
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to restock' });
  }
});

// Get stock movement history
router.get('/movements/history', async (req, res) => {
  try {
    const { itemId, reason, page = 1, limit = 50 } = req.query;
    let movements = Array.from(stockMovements.values());
    
    if (itemId) movements = movements.filter(m => m.itemId === itemId);
    if (reason) movements = movements.filter(m => m.reason === reason);
    
    movements.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const start = (page - 1) * limit;
    const paginated = movements.slice(start, start + parseInt(limit));
    
    res.json({
      movements: paginated,
      total: movements.length,
      page: parseInt(page)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch movement history' });
  }
});

// Get low stock alerts
router.get('/alerts/low-stock', async (req, res) => {
  try {
    const items = Array.from(inventoryStore.values());
    const lowStock = items.filter(i => i.currentStock <= i.reorderPoint);
    const outOfStock = items.filter(i => i.currentStock === 0);
    
    res.json({
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
      lowStock: lowStock.map(i => ({
        id: i.id,
        ingredient: i.ingredient,
        currentStock: i.currentStock,
        unit: i.unit,
        reorderPoint: i.reorderPoint,
        shortage: i.reorderPoint - i.currentStock,
        supplier: i.supplier,
        suggestedOrderQty: Math.max(i.maxStock - i.currentStock, i.reorderPoint * 2)
      })),
      outOfStock: outOfStock.map(i => ({
        id: i.id,
        ingredient: i.ingredient,
        supplier: i.supplier,
        suggestedOrderQty: i.maxStock
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch low stock alerts' });
  }
});

// Generate purchase order
router.post('/purchase-order', async (req, res) => {
  try {
    const { items, supplier } = req.body;
    // items: [{ itemId, quantity }]
    
    const po = {
      id: `PO-${Date.now()}`,
      supplier: supplier || 'Mixed Suppliers',
      items: items.map(({ itemId, quantity }) => {
        const inv = inventoryStore.get(itemId);
        return {
          itemId,
          ingredient: inv.ingredient,
          quantity: parseFloat(quantity),
          unit: inv.unit,
          costPerUnit: inv.costPerUnit,
          totalCost: parseFloat(quantity) * inv.costPerUnit
        };
      }),
      totalCost: 0,
      status: 'draft',
      createdAt: new Date().toISOString()
    };
    po.totalCost = po.items.reduce((sum, i) => sum + i.totalCost, 0);
    
    res.status(201).json({
      message: 'Purchase order created',
      purchaseOrder: po
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
});

module.exports = router;
