const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// In-memory store for saved receipts (replace with Prisma in production)
// Each saved receipt: { id, customerId, orderId, savedAt, receiptData }
const savedReceipts = new Map();
let receiptIdCounter = 6000;

// Helper: fetch an order from the main database
function loadDatabase() {
  try {
    const dbPath = path.join(__dirname, '..', '..', 'database.json');
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    return { orders: [] };
  }
}

function saveDatabase(db) {
  const dbPath = path.join(__dirname, '..', '..', 'database.json');
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function normalizeOrderId(input) {
  if (!input) return '';
  let s = String(input).toUpperCase().trim();
  if (/^\d+$/.test(s)) return 'YB-' + s.padStart(4, '0');
  return s;
}

// Build a full receipt object from an order
function buildReceiptData(order) {
  const items = (order.items || []).map(item => ({
    name: item.name,
    quantity: item.quantity,
    price: parseFloat(item.price || 0),
    lineTotal: parseFloat(item.price || 0) * (item.quantity || 1)
  }));

  const subtotal = parseFloat(order.subtotal || items.reduce((s, i) => s + i.lineTotal, 0));
  const deliveryFee = parseFloat(order.deliveryFee || 0);
  const total = parseFloat(order.total || (subtotal + deliveryFee));

  let paymentStatusText, paymentStatusColor;
  switch (order.paymentStatus) {
    case 'paid':
      paymentStatusText = 'PAID';
      paymentStatusColor = '#16a34a';
      break;
    case 'review':
      paymentStatusText = 'UNDER REVIEW';
      paymentStatusColor = '#f59e0b';
      break;
    case 'unpaid':
    default:
      paymentStatusText = 'PENDING';
      paymentStatusColor = '#dc2626';
      break;
  }

  let paymentMethodText;
  if (order.paymentMode === 'momo') {
    paymentMethodText = 'MTN Mobile Money';
  } else if (order.paymentMode === 'cash') {
    paymentMethodText = 'Cash on Delivery';
  } else {
    paymentMethodText = order.payment || 'Not specified';
  }

  return {
    // Receipt header
    receiptNumber: `RCP-${order.id}`,
    receiptId: `RCP-${Date.now()}`,
    generatedAt: new Date().toISOString(),

    // Business info
    business: {
      name: 'YEBS Noodles',
      tagline: 'The Standard of Delicacy',
      address: 'Adabraka, Accra, Ghana',
      phone: '+233 55 910 3452',
      hours: 'Daily 6:00 PM - 9:00 PM'
    },

    // Order info
    order: {
      id: order.id,
      date: order.createdAt,
      deliveredAt: order.deliveredAt || null,
      status: order.status || 'pending',
      pickupPin: order.pickupPin || null,
      sessionNumber: order.sessionNumber || null
    },

    // Customer info
    customer: {
      name: order.customer || 'Customer',
      phone: order.phone || 'N/A'
    },

    // Items
    items,

    // Totals
    subtotal,
    deliveryFee,
    total,

    // Payment
    payment: {
      method: paymentMethodText,
      mode: order.paymentMode || 'unknown',
      status: paymentStatusText,
      statusColor: paymentStatusColor,
      statusRaw: order.paymentStatus || 'unpaid',
      reference: order.momoTransactionRef || order.paymentRef || order.id,
      paidAt: order.paidAt || null,
      verificationMethod: order.verificationMethod || null,
      momoSender: order.momoSender || null
    },

    // Delivery info
    delivery: {
      driver: order.driver ? order.driver.name : null,
      driverPhone: order.driver ? order.driver.phone : null,
      vehicle: order.driver ? order.driver.vehicle : null,
      pickupPoint: order.pickupPointName || order.meetingPoint || 'Pickup point to be confirmed'
    }
  };
}

// Generate a printable HTML receipt
function generatePrintableHTML(receipt) {
  const itemsHTML = receipt.items.map(item => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px dashed #e4dfd3;">${item.quantity}× ${item.name}</td>
      <td style="padding:8px 12px; text-align:right; border-bottom:1px dashed #e4dfd3;">GH₵ ${item.lineTotal.toFixed(2)}</td>
    </tr>
  `).join('');

  const paymentBadge = `<span style="display:inline-block; padding:6px 16px; border-radius:999px; font-size:0.85rem; font-weight:800; color:white; background:${receipt.payment.statusColor};">${receipt.payment.status}</span>`;

  const paidInfo = receipt.payment.paidAt
    ? `<div style="margin-top:8px; font-size:0.85rem; color:#6e7971;">Paid on ${new Date(receipt.payment.paidAt).toLocaleString('en-GB')}</div>`
    : '';

  const driverInfo = receipt.delivery.driver
    ? `<div style="margin-top:12px; font-size:0.85rem;"><strong>Driver:</strong> ${receipt.delivery.driver} · ${receipt.delivery.vehicle || ''}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Receipt ${receipt.receiptNumber} - YEBS Noodles</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #fbf8f0; color: #1e2621; padding: 20px; }
    .receipt { max-width: 480px; margin: 0 auto; background: #fffefa; border: 1px solid #e4dfd3; border-radius: 12px; overflow: hidden; box-shadow: 0 12px 36px rgba(18,44,34,0.08); }
    .header { background: #173d30; color: white; padding: 24px; text-align: center; }
    .header h1 { font-family: Georgia, serif; font-size: 1.8rem; margin-bottom: 4px; }
    .header .tagline { font-size: 0.78rem; color: #e9bd68; text-transform: uppercase; letter-spacing: 0.1em; }
    .header .receipt-num { margin-top: 12px; font-family: monospace; font-size: 1.1rem; font-weight: 700; background: rgba(255,255,255,0.12); padding: 4px 12px; border-radius: 6px; display: inline-block; }
    .body { padding: 24px; }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.88rem; }
    .info-label { color: #6e7971; }
    .info-value { font-weight: 700; color: #173d30; text-align: right; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 0.9rem; }
    th { text-align: left; padding: 10px 12px; background: #f7f4ed; color: #173d30; border-bottom: 2px solid #e4dfd3; }
    .totals { margin-top: 16px; padding-top: 16px; border-top: 2px solid #e4dfd3; }
    .total-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 1rem; }
    .grand-total { font-size: 1.4rem; font-weight: 800; color: #173d30; padding-top: 12px; border-top: 2px dashed #e4dfd3; margin-top: 8px; }
    .payment-box { margin-top: 20px; padding: 16px; background: #f9f7f2; border: 1px solid #e4dfd3; border-radius: 8px; }
    .footer { text-align: center; padding: 20px; font-size: 0.78rem; color: #6e7971; border-top: 1px solid #e4dfd3; }
    .divider { height: 1px; background: #e4dfd3; margin: 16px 0; }
    @media print { body { padding: 0; } .receipt { box-shadow: none; border: none; max-width: 100%; } }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="header">
      <h1>YEBS Noodles</h1>
      <div class="tagline">The Standard of Delicacy</div>
      <div class="receipt-num">${receipt.receiptNumber}</div>
    </div>
    <div class="body">
      <div class="info-row"><span class="info-label">Date:</span><span class="info-value">${new Date(receipt.order.date).toLocaleString('en-GB', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}</span></div>
      <div class="info-row"><span class="info-label">Customer:</span><span class="info-value">${receipt.customer.name}</span></div>
      <div class="info-row"><span class="info-label">Phone:</span><span class="info-value">${receipt.customer.phone}</span></div>
      <div class="info-row"><span class="info-label">Order ID:</span><span class="info-value">${receipt.order.id}</span></div>
      ${receipt.order.pickupPin ? `<div class="info-row"><span class="info-label">Pickup PIN:</span><span class="info-value">${receipt.order.pickupPin}</span></div>` : ''}
      ${receipt.delivery.pickupPoint ? `<div class="info-row"><span class="info-label">Pickup Point:</span><span class="info-value">${receipt.delivery.pickupPoint}</span></div>` : ''}
      ${driverInfo}
      <div class="divider"></div>
      <table>
        <thead><tr><th style="text-align:left;">Item</th><th style="text-align:right;">Amount</th></tr></thead>
        <tbody>${itemsHTML}</tbody>
      </table>
      <div class="totals">
        <div class="total-row"><span>Subtotal</span><span>GH₵ ${receipt.subtotal.toFixed(2)}</span></div>
        <div class="total-row"><span>Delivery Fee</span><span>GH₵ ${receipt.deliveryFee.toFixed(2)}</span></div>
        <div class="grand-total"><span>Total</span><span>GH₵ ${receipt.total.toFixed(2)}</span></div>
      </div>
      <div class="payment-box">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong style="color:#173d30;">Payment Method</strong>
            <div style="font-size:0.88rem; margin-top:2px;">${receipt.payment.method}</div>
            <div style="font-size:0.82rem; color:#6e7971; margin-top:4px;">Ref: ${receipt.payment.reference}</div>
          </div>
          ${paymentBadge}
        </div>
        ${paidInfo}
      </div>
      <div class="footer">
        Thank you for choosing YEBS Noodles! 🍜<br>
        ${receipt.business.phone} · ${receipt.business.hours}<br>
        <em>This is a computer-generated receipt and does not require a signature.</em>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ========================================
// ROUTES
// ========================================

// Get receipt for a specific order
router.get('/order/:orderId', async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.orderId);
    const db = loadDatabase();
    const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const receipt = buildReceiptData(order);
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// Get printable HTML receipt (for download/print)
router.get('/order/:orderId/printable', async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.orderId);
    const db = loadDatabase();
    const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);

    if (!order) {
      return res.status(404).send('Order not found');
    }

    const receipt = buildReceiptData(order);
    const html = generatePrintableHTML(receipt);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).send('Failed to generate printable receipt');
  }
});

// Download receipt as HTML file
router.get('/order/:orderId/download', async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.orderId);
    const db = loadDatabase();
    const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const receipt = buildReceiptData(order);
    const html = generatePrintableHTML(receipt);

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="YEBS-Receipt-${orderId}.html"`);
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download receipt' });
  }
});

// Get all receipts for a customer (by phone number or name)
router.get('/customer/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { phone, name } = req.query;

    const db = loadDatabase();
    let customerOrders = db.orders;

    // Filter by phone if provided (most reliable)
    if (phone) {
      const cleanPhone = String(phone).replace(/\s+/g, '');
      customerOrders = customerOrders.filter(o => {
        const orderPhone = String(o.phone || '').replace(/\s+/g, '');
        return orderPhone === cleanPhone || orderPhone.includes(cleanPhone) || cleanPhone.includes(orderPhone);
      });
    } else if (name) {
      customerOrders = customerOrders.filter(o =>
        String(o.customer || '').toLowerCase().includes(String(name).toLowerCase())
      );
    }

    // Build receipts for each order
    const receipts = customerOrders.map(order => {
      const receipt = buildReceiptData(order);

      // Check if this receipt is saved
      const saved = Array.from(savedReceipts.values()).find(
        s => s.orderId === order.id && s.customerId === customerId
      );

      return {
        ...receipt,
        isSaved: !!saved,
        savedReceiptId: saved ? saved.id : null,
        savedAt: saved ? saved.savedAt : null
      };
    });

    // Sort by date descending
    receipts.sort((a, b) => new Date(b.order.date) - new Date(a.order.date));

    res.json({
      total: receipts.length,
      paid: receipts.filter(r => r.payment.statusRaw === 'paid').length,
      pending: receipts.filter(r => r.payment.statusRaw !== 'paid').length,
      totalSpent: receipts
        .filter(r => r.payment.statusRaw === 'paid')
        .reduce((sum, r) => sum + r.total, 0),
      receipts
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer receipts' });
  }
});

// Save a receipt (bookmark it)
router.post('/save', async (req, res) => {
  try {
    const { customerId, orderId } = req.body;

    if (!customerId || !orderId) {
      return res.status(400).json({ error: 'customerId and orderId are required' });
    }

    const normalizedOrderId = normalizeOrderId(orderId);
    const db = loadDatabase();
    const order = db.orders.find(o => String(o.id).toUpperCase() === normalizedOrderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if already saved
    const existing = Array.from(savedReceipts.values()).find(
      s => s.orderId === normalizedOrderId && s.customerId === customerId
    );
    if (existing) {
      return res.status(409).json({ error: 'Receipt already saved', savedReceiptId: existing.id });
    }

    const savedReceipt = {
      id: `SR-${++receiptIdCounter}`,
      customerId,
      orderId: normalizedOrderId,
      receiptData: buildReceiptData(order),
      savedAt: new Date().toISOString()
    };
    savedReceipts.set(savedReceipt.id, savedReceipt);

    res.status(201).json({
      message: 'Receipt saved successfully',
      savedReceipt
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save receipt' });
  }
});

// Unsave / delete a saved receipt
router.delete('/:receiptId', async (req, res) => {
  try {
    const { receiptId } = req.params;
    const { customerId } = req.body;

    const receipt = savedReceipts.get(receiptId);
    if (!receipt) {
      return res.status(404).json({ error: 'Saved receipt not found' });
    }

    // Verify ownership
    if (customerId && receipt.customerId !== customerId) {
      return res.status(403).json({ error: 'You do not have permission to delete this receipt' });
    }

    savedReceipts.delete(receiptId);

    res.json({
      message: 'Receipt deleted successfully',
      deletedReceiptId: receiptId,
      orderId: receipt.orderId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete receipt' });
  }
});

// Get all saved receipts for a customer
router.get('/saved/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerSaved = Array.from(savedReceipts.values())
      .filter(r => r.customerId === customerId)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

    res.json({
      total: customerSaved.length,
      savedReceipts: customerSaved
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch saved receipts' });
  }
});

// Get receipt statistics for a customer
router.get('/stats/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { phone } = req.query;

    const db = loadDatabase();
    let customerOrders = db.orders;

    if (phone) {
      const cleanPhone = String(phone).replace(/\s+/g, '');
      customerOrders = customerOrders.filter(o => {
        const orderPhone = String(o.phone || '').replace(/\s+/g, '');
        return orderPhone === cleanPhone || orderPhone.includes(cleanPhone) || cleanPhone.includes(orderPhone);
      });
    }

    const totalOrders = customerOrders.length;
    const paidOrders = customerOrders.filter(o => o.paymentStatus === 'paid');
    const pendingOrders = customerOrders.filter(o => o.paymentStatus !== 'paid');
    const totalSpent = paidOrders.reduce((s, o) => s + parseFloat(o.total || 0), 0);
    const momoOrders = paidOrders.filter(o => o.paymentMode === 'momo');
    const cashOrders = paidOrders.filter(o => o.paymentMode === 'cash');

    const savedCount = Array.from(savedReceipts.values())
      .filter(r => r.customerId === customerId).length;

    res.json({
      totalOrders,
      paidOrders: paidOrders.length,
      pendingOrders: pendingOrders.length,
      totalSpent: totalSpent.toFixed(2),
      paymentMethods: {
        momo: momoOrders.length,
        cash: cashOrders.length
      },
      savedReceipts: savedCount
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch receipt statistics' });
  }
});

module.exports = router;
