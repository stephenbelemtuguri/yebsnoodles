// ═══════════════════════════════════════════════════════════════════════════
// YEBS Noodles - Geocoding Service (Multi-Provider Support)
// ═══════════════════════════════════════════════════════════════════════════
const fetch = require('node-fetch');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Google Maps Geocoding Provider
 */
class GoogleGeocoder {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
  }
  
  async geocode(address) {
    const url = `${this.baseUrl}?address=${encodeURIComponent(address)}&key=${this.apiKey}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        logger.warn('Google Geocoding failed', { address, status: data.status });
        return null;
      }
      
      const result = data.results[0];
      return {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formattedAddress: result.formatted_address,
        placeId: result.place_id,
        provider: 'google'
      };
    } catch (error) {
      logger.error('Google Geocoding error', { address, error: error.message });
      return null;
    }
  }
  
  async reverseGeocode(lat, lng) {
    const url = `${this.baseUrl}?latlng=${lat},${lng}&key=${this.apiKey}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        return null;
      }
      
      const result = data.results[0];
      return {
        address: result.formatted_address,
        placeId: result.place_id,
        components: result.address_components,
        provider: 'google'
      };
    } catch (error) {
      logger.error('Google Reverse Geocoding error', { lat, lng, error: error.message });
      return null;
    }
  }
}

/**
 * Mapbox Geocoding Provider
 */
class MapboxGeocoder {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.baseUrl = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
  }
  
  async geocode(address) {
    const url = `${this.baseUrl}/${encodeURIComponent(address)}.json?access_token=${this.accessToken}&limit=1`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (!data.features || data.features.length === 0) {
        logger.warn('Mapbox Geocoding failed', { address });
        return null;
      }
      
      const feature = data.features[0];
      return {
        lat: feature.center[1],
        lng: feature.center[0],
        formattedAddress: feature.place_name,
        placeId: feature.id,
        provider: 'mapbox'
      };
    } catch (error) {
      logger.error('Mapbox Geocoding error', { address, error: error.message });
      return null;
    }
  }
  
  async reverseGeocode(lat, lng) {
    const url = `${this.baseUrl}/${lng},${lat}.json?access_token=${this.accessToken}&limit=1`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (!data.features || data.features.length === 0) {
        return null;
      }
      
      const feature = data.features[0];
      return {
        address: feature.place_name,
        placeId: feature.id,
        components: feature.context,
        provider: 'mapbox'
      };
    } catch (error) {
      logger.error('Mapbox Reverse Geocoding error', { lat, lng, error: error.message });
      return null;
    }
  }
}

/**
 * Nominatim (OpenStreetMap) Geocoding Provider - Free Fallback
 */
class NominatimGeocoder {
  constructor() {
    this.baseUrl = 'https://nominatim.openstreetmap.org';
  }
  
  async geocode(address) {
    // Add country bias for Ghana
    const query = `${address}, Ghana`;
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'YEBS-Noodles/1.0 (Food Delivery App)'
        }
      });
      const data = await response.json();
      
      if (!data || data.length === 0) {
        logger.warn('Nominatim Geocoding failed', { address });
        return null;
      }
      
      const result = data[0];
      return {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
        formattedAddress: result.display_name,
        placeId: result.place_id,
        provider: 'nominatim'
      };
    } catch (error) {
      logger.error('Nominatim Geocoding error', { address, error: error.message });
      return null;
    }
  }
  
  async reverseGeocode(lat, lng) {
    const url = `${this.baseUrl}/reverse?lat=${lat}&lon=${lng}&format=json`;
    
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'YEBS-Noodles/1.0'
        }
      });
      const data = await response.json();
      
      if (!data || data.error) {
        return null;
      }
      
      return {
        address: data.display_name,
        placeId: data.place_id,
        components: data.address,
        provider: 'nominatim'
      };
    } catch (error) {
      logger.error('Nominatim Reverse Geocoding error', { lat, lng, error: error.message });
      return null;
    }
  }
}

/**
 * Mock Geocoder for Development
 */
class MockGeocoder {
  async geocode(address) {
    logger.info('[MOCK] Geocoding address', { address });
    
    // Return Accra city center coordinates with slight variation
    return {
      lat: 5.5600 + (Math.random() * 0.02 - 0.01),
      lng: -0.2000 + (Math.random() * 0.02 - 0.01),
      formattedAddress: `${address}, Accra, Ghana`,
      placeId: `mock-${Date.now()}`,
      provider: 'mock'
    };
  }
  
  async reverseGeocode(lat, lng) {
    logger.info('[MOCK] Reverse geocoding', { lat, lng });
    
    return {
      address: `Near Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}, Accra, Ghana`,
      placeId: `mock-${Date.now()}`,
      components: {
        city: 'Accra',
        country: 'Ghana'
      },
      provider: 'mock'
    };
  }
}

/**
 * Get appropriate geocoder based on configuration
 */
function getGeocoder() {
  if (config.mock.geocoding) {
    return new MockGeocoder();
  }
  
  const provider = config.googleMaps.geocodingProvider;
  
  switch (provider) {
    case 'google':
      if (!config.googleMaps.apiKey) {
        logger.warn('Google Maps API key not configured, falling back to Nominatim');
        return new NominatimGeocoder();
      }
      return new GoogleGeocoder(config.googleMaps.apiKey);
      
    case 'mapbox':
      if (!config.mapbox.accessToken) {
        logger.warn('Mapbox access token not configured, falling back to Nominatim');
        return new NominatimGeocoder();
      }
      return new MapboxGeocoder(config.mapbox.accessToken);
      
    case 'nominatim':
      return new NominatimGeocoder();
      
    default:
      logger.warn(`Unknown geocoding provider: ${provider}, using Nominatim`);
      return new NominatimGeocoder();
  }
}

/**
 * Public API with caching
 */
const geocodeCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function geocode(address) {
  if (!address || typeof address !== 'string') {
    return null;
  }
  
  // Check cache
  const cacheKey = `geocode:${address.toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug('Geocoding cache hit', { address });
    return cached.result;
  }
  
  // Geocode
  const geocoder = getGeocoder();
  const result = await geocoder.geocode(address);
  
  // Cache result
  if (result) {
    geocodeCache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });
    
    // Cleanup old cache entries (keep max 1000)
    if (geocodeCache.size > 1000) {
      const firstKey = geocodeCache.keys().next().value;
      geocodeCache.delete(firstKey);
    }
  }
  
  return result;
}

async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  
  // Check cache
  const cacheKey = `reverse:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug('Reverse geocoding cache hit', { lat, lng });
    return cached.result;
  }
  
  // Reverse geocode
  const geocoder = getGeocoder();
  const result = await geocoder.reverseGeocode(lat, lng);
  
  // Cache result
  if (result) {
    geocodeCache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });
  }
  
  return result;
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}

module.exports = {
  geocode,
  reverseGeocode,
  calculateDistance,
  getGeocoder
};
