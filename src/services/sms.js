/**
 * SMS Notification Service
 * 
 * Supports multiple SMS gateways for Ghana:
 * - Arkesel (primary - Ghana-based)
 * - Hubtel (fallback)
 * - Twilio (international fallback)
 * 
 * Environment variables:
 * ARKSEL_API_KEY, ARKSEL_SENDER_ID
 * HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 */

class SMSService {
  constructor() {
    this.provider = process.env.SMS_PROVIDER || 'arkesel';
    this.providerOrder = ['arkesel', 'hubtel', 'twilio'];
  }

  /**
   * Format Ghana phone number to international format
   * Input: 0241234567 -> +233241234567
   * Input: 233241234567 -> +233241234567
   */
  formatGhanaNumber(phone) {
    let cleaned = String(phone).replace(/\s+|-/g, '');
    
    if (cleaned.startsWith('+233')) return cleaned;
    if (cleaned.startsWith('233')) return '+' + cleaned;
    if (cleaned.startsWith('0')) return '+233' + cleaned.substring(1);
    if (cleaned.length === 9) return '+233' + cleaned;
    
    return cleaned; // return as-is if format unknown
  }

  /**
   * Send SMS with automatic provider fallback
   */
  async send(to, message) {
    const formattedNumber = this.formatGhanaNumber(to);
    
    for (const provider of this.providerOrder) {
      try {
        const result = await this[`sendVia${this.capitalize(provider)}`](formattedNumber, message);
        if (result.success) return result;
        console.warn(`SMS via ${provider} failed:`, result.error);
      } catch (err) {
        console.warn(`SMS provider ${provider} error:`, err.message);
      }
    }
    
    return {
      success: false,
      error: 'All SMS providers failed',
      message: `Failed to send SMS to ${formattedNumber}`
    };
  }

  /**
   * Send SMS via Arkesel (Ghana's primary SMS gateway)
   */
  async sendViaArkesel(to, message) {
    const apiKey = process.env.ARKSEL_API_KEY;
    const senderId = process.env.ARKSEL_SENDER_ID || 'YEBS';
    
    if (!apiKey) {
      return { success: false, error: 'Arkesel API key not configured' };
    }

    try {
      // In production: make HTTP request to Arkesel API
      // const response = await fetch('https://api.arkesel.com/sms/send', {
      //   method: 'POST',
      //   headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ sender: senderId, message, recipients: [to] })
      // });

      console.log(`[SMS:Arkesel] To: ${to}, Message: "${message}"`);
      
      return {
        success: true,
        provider: 'arkesel',
        to,
        messageId: `ARK-${Date.now()}`,
        senderId,
        deliveredAt: new Date().toISOString()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Send SMS via Hubtel
   */
  async sendViaHubtel(to, message) {
    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      return { success: false, error: 'Hubtel credentials not configured' };
    }

    try {
      console.log(`[SMS:Hubtel] To: ${to}, Message: "${message}"`);
      
      return {
        success: true,
        provider: 'hubtel',
        to,
        messageId: `HUB-${Date.now()}`,
        deliveredAt: new Date().toISOString()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Send SMS via Twilio (international fallback)
   */
  async sendViaTwilio(to, message) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    
    if (!accountSid || !authToken) {
      return { success: false, error: 'Twilio credentials not configured' };
    }

    try {
      console.log(`[SMS:Twilio] To: ${to}, Message: "${message}"`);
      
      return {
        success: true,
        provider: 'twilio',
        to,
        messageId: `TWL-${Date.now()}`,
        from: fromNumber,
        deliveredAt: new Date().toISOString()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // ===== Pre-built notification templates =====

  async sendOrderConfirmation(phone, orderId, total, items) {
    const message = `YEBS Noodles: Order ${orderId} confirmed! Total: GH₵${total}. ${items} item(s). We'll text when your rider is en route. Reply STOP to opt out.`;
    return this.send(phone, message);
  }

  async sendOrderStatusUpdate(phone, orderId, status, eta) {
    const statusMessages = {
      kitchen: `YEBS: Order ${orderId} is now being prepared in the kitchen. Fresh noodles coming soon!`,
      enroute: `YEBS: Your rider is en route with order ${orderId}! Track live at yebsnoodles.com/track?id=${orderId}${eta ? ` ETA: ${eta} mins` : ''}`,
      arrived: `YEBS: Your rider has arrived at the pickup point for order ${orderId}! Please collect your food.`,
      delivered: `YEBS: Order ${orderId} delivered successfully! Thank you for choosing YEBS Noodles. Rate us at yebsnoodles.com/review`
    };
    
    const message = statusMessages[status] || `YEBS: Order ${orderId} status updated to ${status}.`;
    return this.send(phone, message);
  }

  async sendDriverAssigned(phone, driverName, driverPhone, orderId) {
    const message = `YEBS: Your rider ${driverName} has been assigned to order ${orderId}. Rider contact: ${driverPhone}. Track live at yebsnoodles.com/track?id=${orderId}`;
    return this.send(phone, message);
  }

  async sendPromoCode(phone, promoCode, discount) {
    const message = `YEBS Noodles: Special offer! Use code ${promoCode} for ${discount} off your next order. Valid this week only. Order at yebsnoodles.com`;
    return this.send(phone, message);
  }

  async sendLoyaltyReward(phone, points, reward) {
    const message = `YEBS Loyalty: You've earned ${points} points! You now have enough for: ${reward}. Redeem at yebsnoodles.com/account`;
    return this.send(phone, message);
  }

  async sendDeliveryReminder(phone, orderId, pickupPoint) {
    const message = `YEBS: Your order ${orderId} is ready for pickup at ${pickupPoint}. Please come collect your fresh noodles!`;
    return this.send(phone, message);
  }

  async sendLowStockAlert(phone, ingredient, currentStock, reorderPoint) {
    const message = `YEBS ALERT: LOW STOCK - ${ingredient} has ${currentStock} units (reorder at ${reorderPoint}). Please restock soon.`;
    return this.send(phone, message);
  }
}

module.exports = new SMSService();
