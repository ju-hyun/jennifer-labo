/**
 * JENNIFER OpenAPI (dbmetrics) の呼び出し
 */
import { getJson, isUnauthorized } from '../shared/http.js';
import { API_BASE, BUSINESS_METRICS_API_BASE } from './config.js';
import { showConfigError } from './notice.js';

export async function fetchMetricData(domainId, targetId, targetType, startTime, endTime, intervalMinute, metrics) {
  if (!domainId) {
    console.error('fetchMetricData called without domainId');
    return [];
  }

  let endpoint;
  if (!targetId) {
    endpoint = `${API_BASE}/domain`;
  } else {
    endpoint = targetType === 'instance' ? `${API_BASE}/instance` : BUSINESS_METRICS_API_BASE;
  }

  const url = new URL(endpoint, window.location.origin);

  // Construct params
  url.searchParams.append('domain_id', domainId);

  if (targetId) {
    if (targetType === 'instance') {
      url.searchParams.append('instance_id', targetId);
    } else {
      url.searchParams.append('business_id', targetId);
    }
  }
  url.searchParams.append('time_pattern', 'yyyyMMddHH');
  url.searchParams.append('start_time', startTime);
  url.searchParams.append('end_time', endTime);
  url.searchParams.append('interval_minute', intervalMinute);
  url.searchParams.append('metrics', metrics);

  try {
    const data = await getJson(url);
    return data.result || [];
  } catch (error) {
    if (isUnauthorized(error)) {
      showConfigError('Authentication failed. Please contact the site administrator to check the server-side API token.', 'Unauthorized (401)');
      return [];
    }
    console.warn(`API fetch for ${metrics} failed. URL: ${url.toString()}`, error);
    if (error.name === 'TypeError') {
      console.warn('Network error or CORS issue. If this is a local development environment, ensure the proxy is correctly configured.');
    }
    throw error;
  }
}
