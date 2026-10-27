// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - MTN Mobile Money Integration (Ghana)
// ═══════════════════════════════════════════════════════════════════════════
// Documentation: https://momodeveloper.mtn.com/
const fetch = require('node-fetch');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * MTN MoMo API Client
 */
class MoMoClient {
  constructor() {
    this.baseUrl = config.momo.baseUrl;
    this.subscriptionKey = config.momo.subscriptionKey;
    this.apiKey = config.momo.apiKey;
    this.apiSecret = config.momo.apiSecret;
    this.referenceId = config.momo.referenceId;
    this.environment = config.momo.environment;
    this.accessToken = null;
    this.tokenExpiry = null;
  }
  
  /**
   * Generate API User (Only needed once during setup)
   */
  async createAPIUser() {
    const referenceId = crypto.randomUUID();
    
    const response = await fetch(`${this.baseUrl}/v1_0/apiuser`, {
      method: 'POST',
      headers: {
        'X-Reference-Id': referenceId,
        'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        providerCallbackHost: config.momo.callbackHost
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create API user: ${response.statusText}`);
    }
    
    logger.info('MoMo API User created', { referenceId });
    return { referenceId };
  }
  
  /**
   * Get API Key for created user
   */
  async createAPIKey(referenceId) {
    const response = await fetch(`${this.baseUrl}/v1_0/apiuser/${referenceId}/apikey`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.subscriptionKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create API key: ${response.statusText}`);
    }
    
    const data = await response.json();
    logger.info('MoMo API Key created', { referenceId });
    return data.apiKey;
  }
  
  /**
   * Get OAuth Access Token
   */
  async getAccessToken() {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    
    const credentials = Buffer.from(`${this.referenceId}:${this.apiKey}`).toString('base64');
    
    const response = await fetch(`${this.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': this.subscriptionKey
      }
    });
    
    if (!response.ok) {
      const error = await response.text();
      logger.error('MoMo token request failed', { status: response.status, error });
      throw new Error('Failed to get MoMo access token');
    }
    
    const data = await response.json();
    this.accessToken = data.access_token;
    // Token typically valid for 1 hour, cache for 50 minutes
    this.tokenExpiry = Date.now() + (50 * 60 * 1000);
    
    logger.info('MoMo access token obtained');
    return this.accessToken;
  }
  
  /**
   * Request to Pay (Collections API)
   * Initiates a payment request to customer's phone
   */
  async requestToPay(phone, amount, currency = 'GHS', externalId, payerMessage, payeeNote) {
    const token = await this.getAccessToken();
    const referenceId = crypto.randomUUID();
    
    // Format phone to international format (233XXXXXXXXX)
    const formattedPhone = this.formatPhone(phone);
    
    const payload = {
      amount: amount.toString(),
      currency,
      externalId: externalId || referenceId,
      payer: {
        partyIdType: 'MSISDN',
        partyId: formattedPhone
      },
      payerMessage: payerMessage || `YEBS Noodles Order Payment`,
      payeeNote: payeeNote || `Order ${externalId}`
    };
    
    logger.info('MoMo request to pay initiated', { 
      referenceId, 
      phone: formattedPhone, 
      amount, 
      externalId 
    });
    
    const response = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': this.environment,
        'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.text();
      logger.error('MoMo request to pay failed', { 
        status: response.status, 
        error,
        referenceId,
        phone: formattedPhone
      });
      throw new Error(`Payment request failed: ${response.statusText}`);
    }
    
    return {
      referenceId,
      status: 'PENDING',
      phone: formattedPhone,
      amount,
      currency,
      externalId
    };
  }
  
  /**
   * Get Transaction Status
   */
  async getTransactionStatus(referenceId) {
    const token = await this.getAccessToken();
    
    const response = await fetch(
      `${this.baseUrl}/collection/v1_0/requesttopay/${referenceId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Target-Environment': this.environment,
          'Ocp-Apim-Subscription-Key': this.subscriptionKey
        }
      }
    );
    
    if (!response.ok) {
      logger.error('Failed to get transaction status', { 
        referenceId, 
        status: response.status 
      });
      return null;
    }
    
    const data = await response.json();
    
    logger.info('MoMo transaction status retrieved', { 
      referenceId, 
      status: data.status,
      financialTransactionId: data.financialTransactionId
    });
    
    return {
      referenceId,
      status: data.status, // PENDING, SUCCESSFUL, FAILED
      amount: data.amount,
      currency: data.currency,
      financialTransactionId: data.financialTransactionId,
      externalId: data.externalId,
      payer: data.payer,
      reason: data.reason
    };
  }
  
  /**
   * Get Account Balance
   */
  async getAccountBalance() {
    const token = await this.getAccessToken();
    
    const response = await fetch(`${this.baseUrl}/collection/v1_0/account/balance`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Target-Environment': this.environment,
        'Ocp-Apim-Subscription-Key': this.subscriptionKey
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to get account balance');
    }
    
    const data = await response.json();
    return {
      availableBalance: parseFloat(data.availableBalance),
      currency: data.currency
    };
  }
  
  /**
   * Verify Payment by Transaction Reference
   * This checks if a payment with given transaction ref exists and is successful
   */
  async verifyPaymentByRef(transactionRef, expectedAmount) {
    try {
      // In production, you would query your transaction database
      // or use MoMo's account statement API to verify the transaction
      
      // For now, we'll use the transaction status endpoint
      // assuming transactionRef is the referenceId
      const status = await this.getTransactionStatus(transactionRef);
      
      if (!status) {
        return { verified: false, reason: 'Transaction not found' };
      }
      
      if (status.status !== 'SUCCESSFUL') {
        return { 
          verified: false, 
          reason: `Payment status is ${status.status}`,
          status: status.status
        };
      }
      
      // Verify amount matches
      const paidAmount = parseFloat(status.amount);
      if (Math.abs(paidAmount - expectedAmount) > 0.01) {
        return {
          verified: false,
          reason: `Amount mismatch. Expected ${expectedAmount}, received ${paidAmount}`,
          paidAmount
        };
      }
      
      return {
        verified: true,
        transactionId: status.financialTransactionId,
        amount: paidAmount,
        currency: status.currency,
        payer: status.payer
      };
      
    } catch (error) {
      logger.error('MoMo payment verification failed', { transactionRef, error: error.message });
      return { verified: false, reason: error.message };
    }
  }
  
  /**
   * Format phone number to international format
   */
  formatPhone(phone) {
    // Remove all non-digits
    let cleaned = phone.replace(/\D/g, '');
    
    // If starts with 0, replace with 233 (Ghana country code)
    if (cleaned.startsWith('0')) {
      cleaned = '233' + cleaned.substring(1);
    }
    
    // If doesn't start with 233, add it
    if (!cleaned.startsWith('233')) {
      cleaned = '233' + cleaned;
    }
    
    return cleaned;
  }
}

/**
 * Singleton instance
 */
let momoClient = null;

function getMoMoClient() {
  if (!config.momo.enabled) {
    throw new Error('MTN MoMo is not enabled');
  }
  
  if (!momoClient) {
    momoClient = new MoMoClient();
  }
  
  return momoClient;
}

/**
 * Mock MoMo Client for Development/Testing
 */
class MockMoMoClient {
  async requestToPay(phone, amount, currency, externalId, payerMessage, payeeNote) {
    const referenceId = crypto.randomUUID();
    logger.info('[MOCK] MoMo request to pay', { phone, amount, externalId });
    
    return {
      referenceId,
      status: 'PENDING',
      phone,
      amount,
      currency: currency || 'GHS',
      externalId
    };
  }
  
  async getTransactionStatus(referenceId) {
    logger.info('[MOCK] MoMo transaction status check', { referenceId });
    
    // Simulate successful payment after 5 seconds
    return {
      referenceId,
      status: 'SUCCESSFUL',
      amount: '50.00',
      currency: 'GHS',
      financialTransactionId: `MOCK-${Date.now()}`,
      externalId: referenceId,
      payer: { partyId: '233240000000' }
    };
  }
  
  async verifyPaymentByRef(transactionRef, expectedAmount) {
    logger.info('[MOCK] MoMo payment verification', { transactionRef, expectedAmount });
    
    return {
      verified: true,
      transactionId: `MOCK-${Date.now()}`,
      amount: expectedAmount,
      currency: 'GHS',
      payer: { partyId: '233240000000' }
    };
  }
  
  async getAccountBalance() {
    return {
      availableBalance: 10000.00,
      currency: 'GHS'
    };
  }
}

/**
 * Get appropriate client (real or mock)
 */
function getClient() {
  if (config.mock.momo) {
    return new MockMoMoClient();
  }
  return getMoMoClient();
}

module.exports = {
  getClient,
  MoMoClient,
  MockMoMoClient
};
