const express = require('express');
const router = express.Router();

// In-memory store (replace with Prisma in production)
const reviewsStore = new Map();
let reviewIdCounter = 1000;

// Get reviews for a menu item
router.get('/menu/:menuItemId', async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const allReviews = Array.from(reviewsStore.values())
      .filter(r => r.menuItemId === menuItemId && r.status === 'published');

    const avgRating = allReviews.length > 0
      ? (allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length).toFixed(1)
      : '0.0';

    res.json({
      menuItemId,
      averageRating: parseFloat(avgRating),
      totalReviews: allReviews.length,
      ratingBreakdown: {
        5: allReviews.filter(r => r.rating === 5).length,
        4: allReviews.filter(r => r.rating === 4).length,
        3: allReviews.filter(r => r.rating === 3).length,
        2: allReviews.filter(r => r.rating === 2).length,
        1: allReviews.filter(r => r.rating === 1).length
      },
      reviews: allReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// Get reviews by a customer
router.get('/customer/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const customerReviews = Array.from(reviewsStore.values())
      .filter(r => r.customerId === customerId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(customerReviews);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer reviews' });
  }
});

// Create a review
router.post('/', async (req, res) => {
  try {
    const { orderId, customerId, customerName, menuItemId, menuItemName, rating, comment, photos } = req.body;

    // Validation
    if (!customerId || !menuItemId || !rating) {
      return res.status(400).json({ error: 'Missing required fields: customerId, menuItemId, rating' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    // Check if already reviewed this order
    const existing = Array.from(reviewsStore.values())
      .find(r => r.orderId === orderId && r.menuItemId === menuItemId);
    if (existing) {
      return res.status(409).json({ error: 'You have already reviewed this item from this order' });
    }

    const review = {
      id: `REV-${++reviewIdCounter}`,
      orderId,
      customerId,
      customerName: customerName || 'Anonymous',
      menuItemId,
      menuItemName,
      rating: parseInt(rating),
      comment: comment || '',
      photos: photos || [],
      status: 'published',
      helpfulCount: 0,
      adminReply: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    reviewsStore.set(review.id, review);

    res.status(201).json({
      message: 'Review submitted successfully',
      review
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// Mark review as helpful
router.post('/:reviewId/helpful', async (req, res) => {
  try {
    const { reviewId } = req.params;
    const review = reviewsStore.get(reviewId);
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }
    review.helpfulCount = (review.helpfulCount || 0) + 1;
    reviewsStore.set(reviewId, review);
    res.json({ helpfulCount: review.helpfulCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark review as helpful' });
  }
});

// Admin reply to review
router.post('/:reviewId/reply', async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { reply, adminName } = req.body;
    const review = reviewsStore.get(reviewId);
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }
    review.adminReply = {
      text: reply,
      author: adminName || 'YEBS Management',
      repliedAt: new Date().toISOString()
    };
    reviewsStore.set(reviewId, review);
    res.json({ message: 'Reply added successfully', review });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add reply' });
  }
});

// Get all reviews (admin)
router.get('/', async (req, res) => {
  try {
    const { status, rating, page = 1, limit = 20 } = req.query;
    let allReviews = Array.from(reviewsStore.values());

    if (status) allReviews = allReviews.filter(r => r.status === status);
    if (rating) allReviews = allReviews.filter(r => r.rating === parseInt(rating));

    allReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const start = (page - 1) * limit;
    const paginated = allReviews.slice(start, start + parseInt(limit));

    res.json({
      reviews: paginated,
      total: allReviews.length,
      page: parseInt(page),
      totalPages: Math.ceil(allReviews.length / limit),
      averageRating: allReviews.length > 0
        ? (allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length).toFixed(2)
        : '0.00'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// Flag a review (hide)
router.patch('/:reviewId/status', async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { status } = req.body; // 'published', 'hidden', 'flagged'
    const review = reviewsStore.get(reviewId);
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }
    review.status = status;
    reviewsStore.set(reviewId, review);
    res.json({ message: `Review status updated to ${status}`, review });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update review status' });
  }
});

module.exports = router;
