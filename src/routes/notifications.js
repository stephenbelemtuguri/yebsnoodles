const express = require('express');
const smsService = require('../services/sms');
const router = express.Router();

// In-memory notification store
const notifications = new Map(); // userId -> notifications[]
let notificationIdCounter = 9000;

// Get notifications for a user
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, unreadOnly } = req.query;
    
    let userNotifications = notifications.get(userId) || [];
    
    if (role) userNotifications = userNotifications.filter(n => n.targetRole === role);
    if (unreadOnly === 'true') userNotifications = userNotifications.filter(n => !n.read);
    
    userNotifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const unreadCount = (notifications.get(userId) || []).filter(n => !n.read).length;
    
    res.json({
      notifications: userNotifications,
      total: (notifications.get(userId) || []).length,
      unreadCount
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Create notification
router.post('/', async (req, res) => {
  try {
    const { userId, targetRole, type, title, message, data, sendSms = false, phone } = req.body;
    
    const notification = {
      id: `NOTIF-${++notificationIdCounter}`,
      userId,
      targetRole, // 'customer', 'driver', 'admin'
      type, // 'order_update', 'promo', 'system', 'chat', 'review', 'payout'
      title,
      message,
      data: data || {},
      read: false,
      createdAt: new Date().toISOString()
    };

    if (!notifications.has(userId)) {
      notifications.set(userId, []);
    }
    notifications.get(userId).push(notification);

    // Keep only last 100 notifications per user
    const userNotifs = notifications.get(userId);
    if (userNotifs.length > 100) {
      notifications.set(userId, userNotifs.slice(-100));
    }

    // Optionally send SMS
    let smsResult = null;
    if (sendSms && phone) {
      smsResult = await smsService.send(phone, `${title}: ${message}`);
    }

    res.status(201).json({
      message: 'Notification created',
      notification,
      smsSent: smsResult?.success || false
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

// Mark notification as read
router.patch('/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { userId } = req.body;
    
    const userNotifs = notifications.get(userId) || [];
    const notif = userNotifs.find(n => n.id === notificationId);
    if (!notif) return res.status(404).json({ error: 'Notification not found' });
    
    notif.read = true;
    notif.readAt = new Date().toISOString();
    
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all as read
router.post('/user/:userId/read-all', async (req, res) => {
  try {
    const { userId } = req.params;
    const userNotifs = notifications.get(userId) || [];
    let count = 0;
    
    userNotifs.forEach(n => {
      if (!n.read) {
        n.read = true;
        n.readAt = new Date().toISOString();
        count++;
      }
    });
    
    res.json({ message: `${count} notifications marked as read` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// Delete notification
router.delete('/:notificationId', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { userId } = req.body;
    
    const userNotifs = notifications.get(userId) || [];
    const filtered = userNotifs.filter(n => n.id !== notificationId);
    notifications.set(userId, filtered);
    
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Send bulk notification (admin)
router.post('/bulk', async (req, res) => {
  try {
    const { targetRole, title, message, userIds } = req.body;
    
    let sentCount = 0;
    const userIdList = userIds || [];
    
    for (const userId of userIdList) {
      const notification = {
        id: `NOTIF-${++notificationIdCounter}`,
        userId,
        targetRole,
        type: 'broadcast',
        title,
        message,
        read: false,
        createdAt: new Date().toISOString()
      };
      
      if (!notifications.has(userId)) {
        notifications.set(userId, []);
      }
      notifications.get(userId).push(notification);
      sentCount++;
    }
    
    res.json({
      message: 'Bulk notification sent',
      sentCount,
      targetRole,
      title
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send bulk notification' });
  }
});

// Get notification preferences
router.get('/user/:userId/preferences', async (req, res) => {
  try {
    const { userId } = req.params;
    // Default preferences
    const preferences = {
      userId,
      channels: {
        inApp: true,
        sms: true,
        email: false,
        push: true
      },
      types: {
        order_updates: true,
        promotions: true,
        chat_messages: true,
        reviews: true,
        payout_updates: true,
        system_alerts: true
      },
      quietHours: {
        enabled: false,
        start: '22:00',
        end: '06:00'
      }
    };
    
    res.json(preferences);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// Update notification preferences
router.put('/user/:userId/preferences', async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;
    
    // In production: save to database
    res.json({
      message: 'Preferences updated',
      userId,
      preferences: updates
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

module.exports = router;
