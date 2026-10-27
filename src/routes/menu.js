const express = require('express');
const router = express.Router();

// In-memory menu store (replace with Prisma + database.json sync)
const menuStore = new Map();
let menuItemIdCounter = 100;

// Seed initial items
const initialMenu = [
  { name: 'Ghana Spag Chicken', price: 30, category: 'spaghetti', available: true, description: 'Spaghetti with chicken, sausage, and egg', image: 'ghana_spag_chicken.jpg' },
  { name: 'Ghana Spag Sausage', price: 30, category: 'spaghetti', available: true, description: 'Spaghetti with sausage, egg, and veggies', image: 'ghana_spag_sausage.jpg' },
  { name: 'Ghana Spag Feast', price: 40, category: 'spaghetti', available: true, description: 'The full package: chicken, sausage, egg, gizzard', image: 'ghana_spag_feast.jpg' },
  { name: 'Ghana Spag Veggie', price: 30, category: 'spaghetti', available: true, description: 'Vegetarian spaghetti with assorted vegetables', image: 'ghana_spag_veggie.jpg' },
  { name: 'Ghana Spag Maggi', price: 25, category: 'spaghetti', available: true, description: 'Classic spaghetti with Maggi seasoning', image: 'ghana_spag_maggi.jpg' }
];

initialMenu.forEach(item => {
  const id = `MENU-${++menuItemIdCounter}`;
  menuStore.set(id, { id, ...item, createdAt: new Date().toISOString(), popularityScore: 0 });
});

// Get all menu items (public)
router.get('/', async (req, res) => {
  try {
    const { category, available } = req.query;
    let items = Array.from(menuStore.values());
    
    if (category) items = items.filter(i => i.category === category);
    if (available !== undefined) items = items.filter(i => i.available === (available === 'true'));
    
    items.sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({
      total: items.length,
      categories: [...new Set(Array.from(menuStore.values()).map(i => i.category))],
      items
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// Get single menu item
router.get('/:itemId', async (req, res) => {
  try {
    const item = menuStore.get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu item' });
  }
});

// Create new menu item (admin)
router.post('/', async (req, res) => {
  try {
    const { name, price, category, description, image, available, costPrice, prepTime } = req.body;
    
    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const item = {
      id: `MENU-${++menuItemIdCounter}`,
      name,
      price: parseFloat(price),
      costPrice: parseFloat(costPrice) || 0,
      category: category || 'spaghetti',
      description: description || '',
      image: image || null,
      available: available !== false,
      prepTime: prepTime || 15, // minutes
      popularityScore: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    menuStore.set(item.id, item);
    res.status(201).json({ message: 'Menu item created', item });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create menu item' });
  }
});

// Update menu item (admin)
router.put('/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = menuStore.get(itemId);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const allowed = ['name', 'price', 'costPrice', 'category', 'description', 'image', 'available', 'prepTime'];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) {
        item[field] = typeof item[field] === 'number' ? parseFloat(req.body[field]) : req.body[field];
      }
    });
    item.updatedAt = new Date().toISOString();
    menuStore.set(itemId, item);

    res.json({ message: 'Menu item updated', item });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

// Toggle availability (admin quick toggle)
router.patch('/:itemId/toggle', async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = menuStore.get(itemId);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });
    
    item.available = !item.available;
    item.updatedAt = new Date().toISOString();
    menuStore.set(itemId, item);
    
    res.json({ message: `${item.name} is now ${item.available ? 'available' : 'unavailable'}`, item });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle availability' });
  }
});

// Delete menu item (admin)
router.delete('/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!menuStore.has(itemId)) return res.status(404).json({ error: 'Menu item not found' });
    
    const item = menuStore.get(itemId);
    menuStore.delete(itemId);
    res.json({ message: 'Menu item deleted', deletedItem: item.name });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete menu item' });
  }
});

// Reorder menu items (admin drag-and-drop)
router.post('/reorder', async (req, res) => {
  try {
    const { orderedIds } = req.body; // array of item IDs in new order
    orderedIds.forEach((id, index) => {
      const item = menuStore.get(id);
      if (item) {
        item.sortOrder = index;
        menuStore.set(id, item);
      }
    });
    res.json({ message: 'Menu order updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reorder menu' });
  }
});

// Get menu analytics
router.get('/analytics/summary', async (req, res) => {
  try {
    const items = Array.from(menuStore.values());
    res.json({
      totalItems: items.length,
      availableItems: items.filter(i => i.available).length,
      unavailableItems: items.filter(i => !i.available).length,
      avgPrice: items.length > 0 ? (items.reduce((s, i) => s + i.price, 0) / items.length).toFixed(2) : '0.00',
      categories: items.reduce((acc, i) => {
        acc[i.category] = (acc[i.category] || 0) + 1;
        return acc;
      }, {}),
      mostPopular: items.sort((a, b) => b.popularityScore - a.popularityScore).slice(0, 5)
        .map(i => ({ id: i.id, name: i.name, popularityScore: i.popularityScore }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu analytics' });
  }
});

module.exports = router;
