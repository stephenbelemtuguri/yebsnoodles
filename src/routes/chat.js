const express = require('express');
const router = express.Router();

// In-memory message store (replace with Prisma)
const conversations = new Map(); // orderId -> conversation
const messages = new Map();      // messageId -> message
let messageIdCounter = 5000;

// Get conversation for an order
router.get('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const conversation = conversations.get(orderId) || { orderId, messages: [], createdAt: new Date().toISOString() };
    
    res.json({
      orderId,
      participants: conversation.participants || {},
      messages: conversation.messages || [],
      unreadCount: {
        customer: (conversation.messages || []).filter(m => m.senderRole !== 'customer' && !m.readBy?.customer).length,
        driver: (conversation.messages || []).filter(m => m.senderRole !== 'driver' && !m.readBy?.driver).length,
        admin: (conversation.messages || []).filter(m => m.senderRole !== 'admin' && !m.readBy?.admin).length
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Send a message
router.post('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { senderId, senderName, senderRole, message, messageType = 'text', attachmentUrl } = req.body;

    if (!senderId || !senderRole || !message) {
      return res.status(400).json({ error: 'Missing required fields: senderId, senderRole, message' });
    }

    const newMessage = {
      id: `MSG-${++messageIdCounter}`,
      orderId,
      senderId,
      senderName: senderName || 'Unknown',
      senderRole, // 'customer', 'driver', 'admin'
      message,
      messageType, // 'text', 'image', 'location', 'system'
      attachmentUrl: attachmentUrl || null,
      readBy: {
        customer: senderRole === 'customer',
        driver: senderRole === 'driver',
        admin: senderRole === 'admin'
      },
      createdAt: new Date().toISOString()
    };

    // Get or create conversation
    if (!conversations.has(orderId)) {
      conversations.set(orderId, {
        orderId,
        participants: {},
        messages: [],
        createdAt: new Date().toISOString()
      });
    }

    const conversation = conversations.get(orderId);
    conversation.participants[senderRole] = { id: senderId, name: senderName };
    conversation.messages.push(newMessage);
    conversation.lastMessageAt = newMessage.createdAt;
    conversations.set(orderId, conversation);

    messages.set(newMessage.id, newMessage);

    res.status(201).json({
      message: 'Message sent successfully',
      data: newMessage
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Mark messages as read
router.patch('/order/:orderId/read', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { readerRole } = req.body; // 'customer', 'driver', 'admin'
    
    const conversation = conversations.get(orderId);
    if (!conversation) {
      return res.json({ message: 'No conversation found' });
    }

    let updated = 0;
    conversation.messages.forEach(msg => {
      if (!msg.readBy[readerRole] && msg.senderRole !== readerRole) {
        msg.readBy[readerRole] = true;
        updated++;
      }
    });

    conversations.set(orderId, conversation);
    res.json({ message: `${updated} messages marked as read`, updatedCount: updated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Get unread message count for a user
router.get('/unread/:userId/:role', async (req, res) => {
  try {
    const { userId, role } = req.params;
    let totalUnread = 0;
    const orderList = [];

    conversations.forEach((convo, orderId) => {
      const unread = convo.messages.filter(m => !m.readBy[role] && m.senderRole !== role).length;
      if (unread > 0) {
        totalUnread += unread;
        orderList.push({ orderId, unreadCount: unread });
      }
    });

    res.json({ userId, role, totalUnread, conversations: orderList });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// Get all active conversations (admin view)
router.get('/', async (req, res) => {
  try {
    const allConversations = Array.from(conversations.values()).map(c => ({
      orderId: c.orderId,
      participantCount: Object.keys(c.participants).length,
      participants: c.participants,
      messageCount: c.messages.length,
      lastMessage: c.messages[c.messages.length - 1] || null,
      lastMessageAt: c.lastMessageAt,
      unreadForAdmin: c.messages.filter(m => !m.readBy.admin && m.senderRole !== 'admin').length
    }));

    allConversations.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

    res.json({
      total: allConversations.length,
      conversations: allConversations
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Send system message (auto-generated)
router.post('/order/:orderId/system', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { message, event } = req.body; // e.g. "Order status changed to: En Route"

    const systemMessage = {
      id: `MSG-${++messageIdCounter}`,
      orderId,
      senderId: 'SYSTEM',
      senderName: 'YEBS System',
      senderRole: 'admin',
      message,
      messageType: 'system',
      readBy: { customer: false, driver: false, admin: true },
      systemEvent: event,
      createdAt: new Date().toISOString()
    };

    if (!conversations.has(orderId)) {
      conversations.set(orderId, {
        orderId,
        participants: {},
        messages: [],
        createdAt: new Date().toISOString()
      });
    }

    const conversation = conversations.get(orderId);
    conversation.messages.push(systemMessage);
    conversation.lastMessageAt = systemMessage.createdAt;
    conversations.set(orderId, conversation);

    res.status(201).json({ message: 'System message sent', data: systemMessage });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send system message' });
  }
});

module.exports = router;
