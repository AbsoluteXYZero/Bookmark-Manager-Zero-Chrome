// This script runs in the background and handles extension tasks.

// Encryption utilities inlined to avoid module loading issues
async function getDerivedKey() {
  // Use extension ID and browser info for key derivation (works in service workers)
  const extensionId = chrome.runtime.id;
  const browserInfo = `${navigator.userAgent}-${navigator.language}-${extensionId}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(browserInfo);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function decryptApiKey(encrypted) {
  if (!encrypted) return null;
  try {
    const key = await getDerivedKey();
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Decryption failed:', error);
    return null;
  }
}

async function getDecryptedApiKey(keyName) {
  const result = await chrome.storage.local.get(keyName);
  if (result[keyName]) {
    return await decryptApiKey(result[keyName]);
  }
  return null;
}

// Concurrency limiter to prevent overwhelming network with DNS lookups
class ConcurrencyLimiter {
  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Global concurrency limiter for all network requests
// With parallel link+safety checks, actual concurrent requests can be up to 20 (10 bookmarks × 2 checks each)
const networkLimiter = new ConcurrencyLimiter(10);

// URL validation utilities inlined to avoid module loading issues
const BLOCKED_SCHEMES = ['file', 'javascript', 'data', 'vbscript'];
const PRIVILEGED_SCHEMES = ['chrome', 'chrome-extension'];
const PRIVATE_IP_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^::1$/, /^fe80:/i, /^fc00:/i, /^fd00:/i, /^localhost$/i
];

function validateUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, error: 'Invalid URL: empty or not a string' };
  }
  let url;
  try {
    url = new URL(urlString.trim());
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();

  // Allow privileged schemes (browser internal pages, extensions, etc.)
  if (PRIVILEGED_SCHEMES.includes(scheme)) {
    return { valid: true, url: url.href, privileged: true };
  }

  // Block dangerous schemes
  if (BLOCKED_SCHEMES.includes(scheme)) {
    return { valid: false, error: `Blocked URL scheme: ${scheme}` };
  }

  // Only allow HTTP/HTTPS for regular URLs
  if (scheme !== 'http' && scheme !== 'https') {
    return { valid: false, error: `Only HTTP and HTTPS URLs are allowed` };
  }

  const hostname = url.hostname.toLowerCase();
  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(hostname)) {
      return { valid: false, error: 'Private/internal IP addresses are not allowed' };
    }
  }
  if (url.username || url.password) {
    return { valid: false, error: 'URLs with credentials are not allowed' };
  }
  return { valid: true, url: url.href };
}

function sanitizeUrl(urlString) {
  const validation = validateUrl(urlString);
  if (!validation.valid) {
    console.warn(`URL validation failed: ${validation.error}`);
    return null;
  }
  return validation.url;
}

const PARKING_DOMAINS = [
  // Major registrars with parking
  'hugedomains.com',
  'godaddy.com',
  'namecheap.com',
  'namesilo.com',
  'porkbun.com',
  'dynadot.com',
  'epik.com',
  // Domain marketplaces
  'sedo.com',
  'dan.com',
  'afternic.com',
  'domainmarket.com',
  'uniregistry.com',
  'squadhelp.com',
  'brandbucket.com',
  'undeveloped.com',
  'atom.com',
  // Parking services
  'bodis.com',
  'parkingcrew.net',
  'parkingcrew.com',
  'above.com',
  'sedoparking.com',
];

// Trusted domains that should never be flagged as unsafe by local blocklists
// These are well-known, trusted platforms that may have false positives in URLhaus/blocklists
// API-based scanners (Google, Yandex, VirusTotal) are NOT affected by this allow-list
const TRUSTED_DOMAINS = [
  'archive.org',
  'github.io',
  'githubusercontent.com',
  'github.com',
  'gitlab.com',
  'gitlab.io',
  'docs.google.com',
  'sites.google.com',
  'drive.google.com',
];

// Domains that should never be flagged as "parked" (for link status checking)
// These are legitimate hosting platforms, not parking services
const PARKING_EXEMPTIONS = [
  'github.io',
  'github.com',
  'githubusercontent.com',
  'gitlab.io',
  'gitlab.com',
  'pages.dev', // Cloudflare Pages
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
];

// Helper function to check if a domain matches the trusted list (supports subdomains)
function isTrustedDomain(hostname) {
  if (!hostname) return false;

  const lowerHost = hostname.toLowerCase();

  for (const trustedDomain of TRUSTED_DOMAINS) {
    // Exact match
    if (lowerHost === trustedDomain) {
      return true;
    }
    // Subdomain match (e.g., "user.github.io" matches "github.io")
    if (lowerHost.endsWith('.' + trustedDomain)) {
      return true;
    }
  }

  return false;
}

// Helper function to check if a domain should be exempt from parking detection
function isParkingExempt(hostname) {
  if (!hostname) return false;

  const lowerHost = hostname.toLowerCase();

  for (const exemptDomain of PARKING_EXEMPTIONS) {
    // Exact match
    if (lowerHost === exemptDomain) {
      return true;
    }
    // Subdomain match (e.g., "user.github.io" matches "github.io")
    if (lowerHost.endsWith('.' + exemptDomain)) {
      return true;
    }
  }

  return false;
}

// Cache for link and safety checks (7 days TTL)
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

// Get cached result if valid
const getCachedResult = async (url, cacheKey) => {
  try {
    const cache = await chrome.storage.local.get(cacheKey);
    if (cache[cacheKey]) {
      const cached = cache[cacheKey][url];
      if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return cached.result;
      }
    }
  } catch (e) {
    console.warn('Cache read error:', e);
  }
  return null;
};

// Store result in cache (with mutex to prevent race conditions)
const cacheMutex = {};
const setCachedResult = async (url, result, cacheKey) => {
  // Wait for any pending write to the same cache to complete
  while (cacheMutex[cacheKey]) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  cacheMutex[cacheKey] = true;

  try {
    const cache = await chrome.storage.local.get(cacheKey);
    const cacheData = cache[cacheKey] || {};
    cacheData[url] = {
      result,
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ [cacheKey]: cacheData });
  } catch (e) {
    console.warn('Cache write error:', e);
  } finally {
    cacheMutex[cacheKey] = false;
  }
};

/**
 * Check if a URL uses a privileged scheme that shouldn't be scanned (Chrome-specific)
 * @param {string} url The URL to check
 * @returns {object|null} Object with type and label if privileged, null otherwise
 */
function isPrivilegedUrl(url) {
  try {
    const urlObj = new URL(url);
    const scheme = urlObj.protocol.replace(':', '').toLowerCase();

    // Chrome browser internal pages (chrome:// only, about: works in Chrome)
    if (scheme === 'chrome') {
      return { type: 'browser-internal', label: 'Browser internal page' };
    }

    // Extension pages
    if (scheme === 'chrome-extension') {
      return { type: 'extension', label: 'Extension page' };
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Checks if a URL is reachable and resolves to the expected domain.
 * This function runs in the background script, which has broader permissions
 * than content scripts, allowing it to bypass CORS restrictions.
 * @param {string} url The URL to check.
 * @returns {Promise<'live' | 'dead' | 'parked'>} The status of the link.
 */
const checkLinkStatus = async (url, bypassCache = false) => {
  // Check if this is a privileged URL that should not be scanned
  const privilegedInfo = isPrivilegedUrl(url);
  if (privilegedInfo) {
    console.log(`[Link Check] Privileged URL detected: ${privilegedInfo.label}`);
    // Cache the result so it persists after side panel reload
    console.log(`[Link Check] Caching privileged URL result for: ${url}`);
    await setCachedResult(url, 'live', 'linkStatusCache');
    console.log(`[Link Check] Privileged URL cached successfully`);
    return 'live'; // Privileged URLs are always considered "live"
  }
  // Check cache first (unless bypassed for rescan)
  if (!bypassCache) {
    const cached = await getCachedResult(url, 'linkStatusCache');
    if (cached) {
      return cached;
    }
  } else {
    console.log(`[Link Check] Bypassing cache for rescan of ${url}`);
  }

  let result;

  // Check if the URL itself is on a parking domain
  try {
    const urlHost = new URL(url).hostname.toLowerCase();
    // Skip parking check for exempt hosting platforms
    if (!isParkingExempt(urlHost) && PARKING_DOMAINS.some(domain => urlHost.includes(domain))) {
      result = 'parked';
      await setCachedResult(url, result, 'linkStatusCache');
      return result;
    }
  } catch (e) {
    // Invalid URL, continue with fetch attempt
  }

  try {
    // Try fetch with cors mode first to get redirect info
    // Fall back to no-cors if CORS blocks us
    let response;
    let usedCors = false;

    try {
      const corsController = new AbortController();
      const corsTimeout = setTimeout(() => corsController.abort(), 5000);

      response = await fetch(url, {
        method: 'HEAD',
        signal: corsController.signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow'
      });
      clearTimeout(corsTimeout);
      usedCors = true;
    } catch (corsError) {
      // CORS blocked, try no-cors mode with fresh controller
      const noCorsController = new AbortController();
      const noCorsTimeout = setTimeout(() => noCorsController.abort(), 5000);

      response = await fetch(url, {
        method: 'HEAD',
        signal: noCorsController.signal,
        mode: 'no-cors',
        credentials: 'omit',
        redirect: 'follow'
      });
      clearTimeout(noCorsTimeout);
    }

    // Check if redirected to a parking domain (only works with cors mode)
    if (usedCors && response.url) {
      try {
        const finalHost = new URL(response.url).hostname.toLowerCase();
        const originalHost = new URL(url).hostname.toLowerCase();

        // Only flag if redirected to a DIFFERENT domain that's a known parking service
        // Skip parking check for exempt hosting platforms
        if (finalHost !== originalHost &&
            !isParkingExempt(finalHost) &&
            PARKING_DOMAINS.some(domain => finalHost.includes(domain))) {
          result = 'parked';
          await setCachedResult(url, result, 'linkStatusCache');
          return result;
        }
      } catch (e) {
        // URL parsing failed, continue with live status
      }

      // Check response status (only available in cors mode)
      // 404, 410, 451 indicate the content is gone
      if (response.status === 404 || response.status === 410 || response.status === 451) {
        result = 'dead';
        await setCachedResult(url, result, 'linkStatusCache');
        return result;
      }
    }

    // Site is reachable and not parked
    result = 'live';
    await setCachedResult(url, result, 'linkStatusCache');
    return result;

  } catch (error) {
    // If timeout or abort, mark as live (slow server) and skip GET fallback
    if (error.name === 'AbortError') {
      console.log(`[Link Check] Timeout for ${url}, marking as live (slow server)`);
      result = 'live';
      await setCachedResult(url, result, 'linkStatusCache');
      return result;
    }

    // If HEAD fails for other reasons, try GET as fallback
    try {
      let fallbackResponse;
      let usedCorsFallback = false;

      try {
        const corsController = new AbortController();
        const corsTimeout = setTimeout(() => corsController.abort(), 5000);

        fallbackResponse = await fetch(url, {
          method: 'GET',
          signal: corsController.signal,
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow'
        });
        clearTimeout(corsTimeout);
        usedCorsFallback = true;
      } catch (corsError) {
        // CORS blocked, try no-cors mode with fresh controller
        const noCorsController = new AbortController();
        const noCorsTimeout = setTimeout(() => noCorsController.abort(), 5000);

        fallbackResponse = await fetch(url, {
          method: 'GET',
          signal: noCorsController.signal,
          mode: 'no-cors',
          credentials: 'omit',
          redirect: 'follow'
        });
        clearTimeout(noCorsTimeout);
      }

      // Check if redirected to a parking domain (only works with cors mode)
      if (usedCorsFallback && fallbackResponse.url) {
        try {
          const finalHost = new URL(fallbackResponse.url).hostname.toLowerCase();
          const originalHost = new URL(url).hostname.toLowerCase();

          // Skip parking check for exempt hosting platforms
          if (finalHost !== originalHost &&
              !isParkingExempt(finalHost) &&
              PARKING_DOMAINS.some(domain => finalHost.includes(domain))) {
            result = 'parked';
            await setCachedResult(url, result, 'linkStatusCache');
            return result;
          }
        } catch (e) {
          // URL parsing failed, continue with live status
        }

        // Check response status (only available in cors mode)
        // 404, 410, 451 indicate the content is gone
        if (fallbackResponse.status === 404 || fallbackResponse.status === 410 || fallbackResponse.status === 451) {
          result = 'dead';
          await setCachedResult(url, result, 'linkStatusCache');
          return result;
        }
      }

      result = 'live';
      await setCachedResult(url, result, 'linkStatusCache');
      return result;
    } catch (fallbackError) {
      // If GET also timed out, mark as live (slow server)
      if (fallbackError.name === 'AbortError') {
        console.log(`[Link Check] GET fallback also timed out for ${url}, marking as live (slow server)`);
        result = 'live';
        await setCachedResult(url, result, 'linkStatusCache');
        return result;
      }

      // Both HEAD and GET failed for other reasons - link is likely dead
      console.warn('Link check failed for:', url, fallbackError.message);
      result = 'dead';
      await setCachedResult(url, result, 'linkStatusCache');
      return result;
    }
  }
};

// Malicious URL/domain database (aggregated from multiple sources)
let maliciousUrlsSet = new Set();
let domainSourceMap = new Map(); // Track which source(s) flagged each domain
let domainOnlyMap = new Map(); // Map of domain:port -> sources (for entries with paths like "1.2.3.4:80/malware")
let blocklistLastUpdate = 0;
let blocklistLoading = false; // Flag to prevent duplicate loads

// Helper to check if two timestamps are on the same calendar day.
function isSameDay(timestamp1, timestamp2) {
    if (!timestamp1 || !timestamp2 || timestamp1 === 0 || timestamp2 === 0) return false;
    const d1 = new Date(timestamp1);
    const d2 = new Date(timestamp2);
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
}

// On startup, load the last update timestamp from storage and update if stale.
(async () => {
    try {
        const result = await chrome.storage.local.get(['blocklistLastUpdate']);
        if (result.blocklistLastUpdate) {
            blocklistLastUpdate = result.blocklistLastUpdate;
            console.log(`[Blocklist] Loaded last update timestamp from storage: ${new Date(blocklistLastUpdate).toISOString()}`);

            const now = Date.now();
            if (!isSameDay(now, blocklistLastUpdate)) {
                console.log('[Startup] Blocklist is stale on startup. Pre-loading in background...');
                updateBlocklistDatabase(); // Run in background
            }
        } else {
            console.log('[Blocklist] No last update timestamp found. Will load on first scan or install.');
        }
    } catch (e) {
        console.error('[Blocklist] Error loading last update timestamp:', e);
    }
})();

// On install/update, force a blocklist download.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.log(`[Setup] Extension ${details.reason}ed. Pre-loading blocklist database...`);
    // Don't need to await, let it run in the background
    updateBlocklistDatabase();
  }
});

// Blocklist sources - all free, no API keys required
const BLOCKLIST_SOURCES = [
  {
    name: 'URLhaus (Active)',
    // Official abuse.ch list - actively distributing malware URLs (updated every 5 minutes)
    // Using cors-anywhere alternative proxy
    url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent('https://urlhaus.abuse.ch/downloads/text/'),
    format: 'urlhaus_text' // Full URLs with paths
  },
  {
    name: 'URLhaus (Historical)',
    // Using GitLab Pages CDN mirror with CORS support (updates every 12 hours from abuse.ch)
    url: 'https://curbengh.github.io/malware-filter/urlhaus-filter.txt',
    format: 'domains' // Domain list (one per line)
  },
  {
    name: 'BlockList Project (Malware)',
    url: 'https://blocklistproject.github.io/Lists/malware.txt',
    format: 'hosts' // Hosts file format (0.0.0.0 domain.com)
  },
  {
    name: 'BlockList Project (Phishing)',
    url: 'https://blocklistproject.github.io/Lists/phishing.txt',
    format: 'hosts'
  },
  {
    name: 'BlockList Project (Scam)',
    url: 'https://blocklistproject.github.io/Lists/scam.txt',
    format: 'hosts'
  },
  {
    name: 'HaGeZi TIF',
    url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/tif.txt',
    format: 'domains' // Plain domain list (one per line)
  },
  {
    name: 'Phishing-Filter',
    url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt',
    format: 'hosts'
  },
  {
    name: 'OISD Big',
    // Using GitHub mirror to avoid CORS issues with oisd.nl direct download
    url: 'https://raw.githubusercontent.com/sjhgvr/oisd/refs/heads/main/domainswild2_big.txt',
    format: 'domains' // Wildcard domains format
  }
];

// Check URL using Google Safe Browsing API (fallback/redundancy check)
// Get a free API key at: https://developers.google.com/safe-browsing/v4/get-started
// Free tier: 10,000 requests per day
// API key is stored in chrome.storage.local.googleSafeBrowsingApiKey
const checkGoogleSafeBrowsing = async (url) => {
  try {
    // Get encrypted API key from storage and decrypt it
    const apiKey = await getDecryptedApiKey('googleSafeBrowsingApiKey');

    if (!apiKey || apiKey.trim() === '') {
      console.log(`[Google SB] No API key configured, skipping check`);
      return 'unknown';
    }

    console.log(`[Google SB] Starting check for ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client: {
            clientId: 'bookmark-manager-zero',
            clientVersion: chrome.runtime.getManifest().version
          },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[Google SB] API error: ${response.status}`);
      return 'unknown';
    }

    const data = await response.json();

    // If matches found, URL is unsafe
    if (data.matches && data.matches.length > 0) {
      console.log(`[Google SB] Result: UNSAFE (${data.matches.length} threats found)`);
      return 'unsafe';
    }

    console.log(`[Google SB] Result: SAFE`);
    return 'safe';

  } catch (error) {
    console.error(`[Google SB] Error:`, error.message);
    return 'unknown';
  }
};

// Check VirusTotal by scraping public web page (no API key needed)
// This always runs on every bookmark scan
// WARNING: For personal use only. May violate VirusTotal ToS if distributed.
const checkURLVoidScraping = async (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    console.log(`[URLVoid Scraping] Checking ${hostname}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const urlvoidUrl = `https://www.urlvoid.com/scan/${encodeURIComponent(hostname)}/`;
    const response = await fetch(urlvoidUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/91.0'
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[URLVoid Scraping] Failed to fetch URLVoid for ${hostname}: ${response.status}`);
      return 'unknown';
    }

    const html = await response.text();

    const detectedPattern = /detected/gi;
    const detectedMatches = html.match(detectedPattern) || [];
    const detectedCount = detectedMatches.length;

    console.log(`[URLVoid Scraping] ${hostname} - Detected: ${detectedCount}`);

    if (detectedCount >= 2) {
      return 'unsafe'; // 2 or more scanners detected malicious
    } else if (detectedCount === 1) {
      return 'warning'; // 1 scanner detected suspicious
    } else {
      return 'safe'; // No detections
    }

  } catch (error) {
    console.log(`[URLVoid Scraping] Error:`, error.message);
    return 'unknown';
  }
};

// Check URL using VirusTotal API
// Get a free API key at: https://www.virustotal.com/gui/my-apikey
// Free tier: 500 requests per day, 4 requests per minute
// API key is stored in chrome.storage.local.virusTotalApiKey
let virusTotalRateLimited = false;
const checkVirusTotal = async (url) => {
  try {
    const apiKey = await getDecryptedApiKey('virusTotalApiKey');

    if (!apiKey || apiKey.trim() === '') {
      console.log(`[VirusTotal API] No API key configured, skipping`);
      return 'unknown';
    }

    if (virusTotalRateLimited) {
      console.log(`[VirusTotal API] Rate limited, skipping check for ${url}`);
      return 'unknown';
    }

    console.log(`[VirusTotal API] Starting check for ${url}`);

    const urlId = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const reportController = new AbortController();
    const reportTimeout = setTimeout(() => reportController.abort(), 8000);

    const reportResponse = await fetch(
      `https://www.virustotal.com/api/v3/urls/${urlId}`,
      {
        method: 'GET',
        signal: reportController.signal,
        headers: { 'x-apikey': apiKey }
      }
    );

    clearTimeout(reportTimeout);

    if (!reportResponse.ok) {
      if (reportResponse.status === 429) {
        virusTotalRateLimited = true;
        console.log(`[VirusTotal API] Rate limit hit, will skip remaining checks`);
      }
      return 'unknown';
    }

    const reportData = await reportResponse.json();
    const stats = reportData.data?.attributes?.last_analysis_stats;

    if (!stats) {
      console.log(`[VirusTotal API] No stats available`);
      return 'unknown';
    }

    const malicious = stats.malicious || 0;
    const suspicious = stats.suspicious || 0;

    console.log(`[VirusTotal API] Analysis - Malicious: ${malicious}, Suspicious: ${suspicious}`);

    if (malicious >= 2) {
      console.log(`[VirusTotal API] Result: UNSAFE`);
      return 'unsafe';
    }

    if (malicious >= 1 || suspicious >= 2) {
      console.log(`[VirusTotal API] Result: WARNING`);
      return 'warning';
    }

    console.log(`[VirusTotal API] Result: SAFE`);
    return 'safe';

  } catch (error) {
    console.error(`[VirusTotal API] Error:`, error.message);
    return 'unknown';
  }
};

// Check URL using Yandex Safe Browsing API
// Register at: https://yandex.com/dev/
// Free tier: 100,000 requests per day
// API key is stored in chrome.storage.local.yandexApiKey
const checkYandexSafeBrowsing = async (url) => {
  try {
    // Get encrypted API key from storage and decrypt it
    const apiKey = await getDecryptedApiKey('yandexApiKey');

    if (!apiKey || apiKey.trim() === '') {
      console.log(`[Yandex SB] No API key configured, skipping check`);
      return 'unknown';
    }

    console.log(`[Yandex SB] Starting check for ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(
      `https://sba.yandex.net/v4/threatMatches:find?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[Yandex SB] API error: ${response.status}`);
      return 'unknown';
    }

    const data = await response.json();

    // If matches found, URL is unsafe
    if (data.matches && data.matches.length > 0) {
      console.log(`[Yandex SB] Result: UNSAFE (${data.matches.length} threats found)`);
      return 'unsafe';
    }

    console.log(`[Yandex SB] Result: SAFE`);
    return 'safe';

  } catch (error) {
    console.error(`[Yandex SB] Error:`, error.message);
    return 'unknown';
  }
};

// Parse different blocklist formats
const parseBlocklistLine = (line, format) => {
  const trimmed = line.trim();

  // Skip empty lines and comments (# for most lists, ! for adblock-style lists)
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
    return null;
  }

  let domain = null;

  if (format === 'hosts') {
    // Hosts file format: "0.0.0.0 domain.com" or "127.0.0.1 domain.com"
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      domain = parts[1]; // Second part is the domain
    }
  } else if (format === 'urlhaus_text') {
    // URLhaus text format: full URLs like "http://malicious.com/path/file.exe"
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        const urlObj = new URL(trimmed);
        domain = urlObj.hostname.toLowerCase();
      } catch {
        return null; // Invalid URL, skip
      }
    } else {
      return null; // Not a valid URL format
    }
  } else if (format === 'urlhaus') {
    // URLhaus format: plain URLs/domains
    domain = trimmed;
  } else if (format === 'domains') {
    // Plain domain list format
    domain = trimmed;
  } else {
    // Default: assume plain domain
    domain = trimmed;
  }

  if (!domain) {
    return null;
  }

  // Normalize: lowercase, remove protocol, remove trailing slash, remove wildcard prefix
  const normalized = domain.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/^\*\./, ''); // Remove wildcard prefix for OISD format

  // Skip localhost and invalid entries
  if (normalized === 'localhost' || normalized.startsWith('127.') || normalized.startsWith('0.0.0.0')) {
    return null;
  }

  return normalized;
};

// Download from a single blocklist source
const downloadBlocklistSource = async (source) => {
  try {
    console.log(`[Blocklist] Downloading ${source.name}...`);

    // Use fetch API for better CORS handling in extensions
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    const response = await fetch(source.url, {
      method: 'GET',
      signal: controller.signal,
      mode: 'cors', // Use CORS mode but extensions can bypass via host_permissions
      cache: 'no-store',
      credentials: 'omit'
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`[Blocklist] ${source.name} failed: HTTP ${response.status}`);
      return { domains: [], count: 0 };
    }

    let text = await response.text();
    console.log(`[Blocklist] ${source.name}: ${text.length} bytes downloaded`);

    // Check if response is JSON-wrapped (some proxies do this)
    try {
      const jsonData = JSON.parse(text);
      if (jsonData.contents) {
        text = jsonData.contents;
      } else if (jsonData.data) {
        text = jsonData.data;
      }
    } catch (e) {
      // Not JSON, use text as-is
    }

    const lines = text.split('\n');
    const domains = [];

    for (const line of lines) {
      const normalized = parseBlocklistLine(line, source.format);
      if (normalized) {
        domains.push(normalized);
      }
    }

    console.log(`[Blocklist] ${source.name}: ${domains.length} domains loaded`);
    return { domains, count: domains.length };

  } catch (error) {
    console.error(`[Blocklist] ${source.name} error:`, error.message);
    return { domains: [], count: 0 };
  }
};

// Download and aggregate all blocklist sources
const updateBlocklistDatabase = async () => {
  // Prevent duplicate loads
  if (blocklistLoading) {
    console.log(`[Blocklist] Already loading, skipping duplicate request`);
    return true;
  }

  blocklistLoading = true;

  try {
    console.log(`[Blocklist] Starting update from ${BLOCKLIST_SOURCES.length} sources...`);

    // Notify UI that blocklist download is starting
    chrome.runtime.sendMessage({
      type: 'blocklistProgress',
      current: 0,
      total: BLOCKLIST_SOURCES.length,
      status: 'starting'
    }).catch(() => {}); // Ignore if no listeners

    // Clear existing data
    maliciousUrlsSet.clear();
    domainSourceMap.clear();

    // Download sources sequentially to report progress
    const results = [];
    for (let i = 0; i < BLOCKLIST_SOURCES.length; i++) {
      const source = BLOCKLIST_SOURCES[i];

      // Notify UI of current download
      chrome.runtime.sendMessage({
        type: 'blocklistProgress',
        current: i + 1,
        total: BLOCKLIST_SOURCES.length,
        sourceName: source.name,
        status: 'downloading'
      }).catch(() => {});

      const result = await downloadBlocklistSource(source);
      results.push(result);
    }

    // Combine all domains into the Set and track sources
    let totalCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const sourceName = BLOCKLIST_SOURCES[i].name;

      for (const domain of result.domains) {
        maliciousUrlsSet.add(domain);

        // Track which source(s) flagged this domain
        if (domainSourceMap.has(domain)) {
          // Use a Set to avoid duplicates when same domain appears multiple times in one blocklist
          const sources = domainSourceMap.get(domain);
          if (!sources.includes(sourceName)) {
            sources.push(sourceName);
          }
        } else {
          domainSourceMap.set(domain, [sourceName]);
        }

        // Build domain-only index for fast lookups (handles entries with paths like "1.2.3.4:80/malware")
        const domainPart = domain.split('/')[0]; // Extract domain:port before any path
        if (domainPart !== domain) { // Only index if there's a path component
          if (domainOnlyMap.has(domainPart)) {
            const sources = domainOnlyMap.get(domainPart);
            if (!sources.includes(sourceName)) {
              sources.push(sourceName);
            }
          } else {
            domainOnlyMap.set(domainPart, [sourceName]);
          }
        }
      }
      totalCount += result.count;
    }

    blocklistLastUpdate = Date.now();

    console.log(`[Blocklist] ✓ Database updated: ${maliciousUrlsSet.size} unique domains from ${totalCount} total entries`);
    const sourceNames = BLOCKLIST_SOURCES.map(s => s.name).join(', ');
    console.log(`[Blocklist] Sources: ${sourceNames}`);

    // Store update timestamp
    await chrome.storage.local.set({
      blocklistLastUpdate: blocklistLastUpdate
    });

    // Notify UI that blocklist download is complete
    chrome.runtime.sendMessage({
      type: 'blocklistComplete',
      domains: maliciousUrlsSet.size,
      totalEntries: totalCount,
      sources: BLOCKLIST_SOURCES.length
    }).catch(() => {});

    blocklistLoading = false;
    return true;
  } catch (error) {
    console.error(`[Blocklist] Error updating database:`, error);
    blocklistLoading = false;
    return false;
  }
};

// Check for suspicious URL patterns that aren't necessarily malicious but warrant caution
const checkSuspiciousPatterns = async (url, domain) => {
  const patterns = [];

  // 1. Check for HTTP-only (no encryption)
  if (url.toLowerCase().startsWith('http://')) {
    // Check if it redirects to HTTPS
    let redirectsToHttps = false;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'follow'
      });
      clearTimeout(timeoutId);

      // Check if final URL is HTTPS
      if (response.url && response.url.toLowerCase().startsWith('https://')) {
        redirectsToHttps = true;
      }
    } catch (e) {
      // Couldn't check redirect, assume no redirect
      console.log(`[Suspicious Patterns] Could not check redirect for ${url}:`, e.message);
    }

    if (redirectsToHttps) {
      patterns.push('HTTP Only (redirects to HTTPS)');
    } else {
      patterns.push('HTTP Only (Unencrypted)');
    }
  }

  // 2. Check for known URL shorteners
  const urlShorteners = [
    'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
    'adf.ly', 'bl.ink', 'lnkd.in', 'short.link', 'cutt.ly', 'rebrand.ly',
    'tiny.cc', 'rb.gy', 'clck.ru', 'shorturl.at', 'v.gd'
  ];

  const domainWithoutPort = domain.split(':')[0];
  if (urlShorteners.includes(domainWithoutPort)) {
    patterns.push('URL Shortener');
  }

  // 3. Check for suspicious TLDs (commonly abused)
  const suspiciousTlds = [
    '.xyz', '.top', '.tk', '.ml', '.ga', '.cf', '.gq', '.pw', '.cc', '.ws',
    '.info', '.biz', '.club', '.click', '.link', '.download', '.stream',
    '.loan', '.win', '.bid', '.trade', '.racing', '.party', '.review',
    '.science', '.work', '.date', '.faith', '.cricket', '.accountant'
  ];

  for (const tld of suspiciousTlds) {
    if (domainWithoutPort.endsWith(tld)) {
      patterns.push('Suspicious TLD');
      break;
    }
  }

  // 4. Check for IP addresses instead of domain names
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
  const ipv6Pattern = /^\[?([0-9a-f:]+)\]?(:\d+)?$/i;

  if (ipv4Pattern.test(domainWithoutPort) || ipv6Pattern.test(domainWithoutPort)) {
    patterns.push('IP Address');
  }

  return patterns;
};

// Check URL safety using aggregated blocklist database
const checkURLSafety = async (url, bypassCache = false) => {
  // Check if this is a privileged URL that should not be scanned
  const privilegedInfo = isPrivilegedUrl(url);
  if (privilegedInfo) {
    console.log(`[Safety Check] Privileged URL detected: ${privilegedInfo.label}`);
    // Cache the result so it persists after side panel reload
    const result = { status: 'safe', sources: [privilegedInfo.label + ' (not scanned)'] };
    console.log(`[Safety Check] Caching privileged URL result for: ${url}`, result);
    await setCachedResult(url, result, 'safetyStatusCache');
    console.log(`[Safety Check] Privileged URL cached successfully`);
    return result;
  }

  // Check cache first (unless bypassed for rescan)
  if (!bypassCache) {
    const cached = await getCachedResult(url, 'safetyStatusCache');
    if (cached) {
      console.log(`[Safety Check] Using cached result for ${url}:`, cached);
      // Handle both old format (string) and new format (object with sources)
      if (typeof cached === 'string') {
        return { status: cached, sources: [] };
      }
      return { status: cached.status, sources: cached.sources || [] };
    }
  } else {
    console.log(`[Safety Check] Bypassing cache for rescan of ${url}`);
  }

  console.log(`[Safety Check] Starting safety check for ${url}`);

  let result;

  try {
    // Quick check: if database is empty, return unknown (don't block scanning)
    // The background scan will ensure the database is loaded before starting
    if (maliciousUrlsSet.size === 0) {
      console.log(`[Blocklist] Database not loaded yet, skipping blocklist check for ${url}`);
      // Continue with API-based checks below, don't return early
    }

    // Normalize URL for lookup (remove protocol, trailing slash, lowercase)
    const normalizedUrl = url.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    // Extract domain (hostname with port, no path)
    const domain = normalizedUrl.split('/')[0];

    // Extract hostname without port for trusted domain check
    const hostname = domain.split(':')[0];

    // Check if domain is in trusted allow-list (bypass blocklist checks only)
    if (isTrustedDomain(hostname)) {
      console.log(`[Safety Check] Domain ${hostname} is in trusted allow-list, skipping local blocklist checks`);

      // Skip blocklist checks but continue with API-based scanners and suspicious pattern detection
      let finalStatus = 'safe';
      let allSources = [];

      // Check API-based scanners if configured
      const storage = await chrome.storage.local.get(['googleSafeBrowsingApiKey', 'yandexApiKey', 'virusTotalApiKey']);
      const hasGoogleKey = storage.googleSafeBrowsingApiKey && storage.googleSafeBrowsingApiKey.trim() !== '';
      const hasYandexKey = storage.yandexApiKey && storage.yandexApiKey.trim() !== '';
      const hasVTKey = storage.virusTotalApiKey && storage.virusTotalApiKey.trim() !== '';

      // Check Google Safe Browsing
      if (hasGoogleKey) {
        console.log(`[Safety Check] Checking Google Safe Browsing for trusted domain...`);
        const googleResult = await checkGoogleSafeBrowsing(url);
        if (googleResult === 'unsafe') {
          finalStatus = 'unsafe';
          allSources.push('Google Safe Browsing');
        }
      }

      // Check Yandex Safe Browsing
      if (hasYandexKey) {
        console.log(`[Safety Check] Checking Yandex Safe Browsing for trusted domain...`);
        const yandexResult = await checkYandexSafeBrowsing(url);
        if (yandexResult === 'unsafe') {
          finalStatus = 'unsafe';
          allSources.push('Yandex Safe Browsing');
        }
      }

      // Check URLVoid Scraping (always runs, no API key needed)
      console.log(`[Safety Check] Checking URLVoid scraping for trusted domain...`);
      const vtScrapingResult = await checkURLVoidScraping(url);
      if (vtScrapingResult === 'unsafe') {
        finalStatus = 'unsafe';
        allSources.push('URLVoid');
      } else if (vtScrapingResult === 'warning' && finalStatus !== 'unsafe') {
        finalStatus = 'warning';
        allSources.push('URLVoid');
      }

      // Check VirusTotal API (optional, requires API key)
      const vtApiKey = await getDecryptedApiKey('virusTotalApiKey');
      if (vtApiKey) {
        console.log(`[Safety Check] Checking VirusTotal API for trusted domain...`);
        const vtApiResult = await checkVirusTotal(url);
        if (vtApiResult === 'unsafe') {
          finalStatus = 'unsafe';
          if (!allSources.includes('VirusTotal')) {
            allSources.push('VirusTotal');
          }
        } else if (vtApiResult === 'warning' && finalStatus !== 'unsafe') {
          finalStatus = 'warning';
          if (!allSources.includes('VirusTotal')) {
            allSources.push('VirusTotal');
          }
        }
      }

      // Check for suspicious patterns
      const suspiciousPatterns = await checkSuspiciousPatterns(url, domain);
      if (suspiciousPatterns.length > 0 && finalStatus !== 'unsafe') {
        finalStatus = 'warning';
        allSources.push(...suspiciousPatterns);
      }

      const resultObj = { status: finalStatus, sources: allSources };
      console.log(`[Safety Check] Final result for trusted domain ${url}: ${resultObj.status}`);
      await setCachedResult(url, resultObj, 'safetyStatusCache');
      return resultObj;
    }

    // Only check blocklist if database is loaded (don't block scanning waiting for it)
    if (maliciousUrlsSet.size > 0) {
      console.log(`[Blocklist] Checking full URL: ${normalizedUrl}`);
      console.log(`[Blocklist] Checking domain: ${domain}`);

      // Check if full URL is in the malicious set
      if (maliciousUrlsSet.has(normalizedUrl)) {
        const sources = domainSourceMap.get(normalizedUrl) || [];
        console.log(`[Blocklist] ⚠️ Full URL found in malicious database!`);
        console.log(`[Blocklist] Detected by: ${sources.join(', ')}`);
        const resultObj = { status: 'unsafe', sources };
        console.log(`[Safety Check] Final result for ${url}: ${resultObj.status}`);
        await setCachedResult(url, resultObj, 'safetyStatusCache');
        return resultObj;
      }

      // Also check if just the domain is flagged (entire domain compromised)
      if (maliciousUrlsSet.has(domain)) {
        const sources = domainSourceMap.get(domain) || [];
        console.log(`[Blocklist] ⚠️ Domain found in malicious database!`);
        console.log(`[Blocklist] Detected by: ${sources.join(', ')}`);
        const resultObj = { status: 'unsafe', sources };
        console.log(`[Safety Check] Final result for ${url}: ${resultObj.status}`);
        await setCachedResult(url, resultObj, 'safetyStatusCache');
        return resultObj;
      }

      // Check if domain:port appears in domainOnlyMap (for IP:port cases where blocklist has paths)
      // Example: If blocklist has "61.163.146.63:34343/i", catch "61.163.146.63:34343/bin.sh"
      if (domainOnlyMap.has(domain)) {
        const sources = domainOnlyMap.get(domain);
        console.log(`[Blocklist] ⚠️ Domain:port found in malicious database (via path-based entry)!`);
        console.log(`[Blocklist] Detected by: ${sources.join(', ')}`);
        const resultObj = { status: 'unsafe', sources };
        console.log(`[Safety Check] Final result for ${url}: ${resultObj.status}`);
        await setCachedResult(url, resultObj, 'safetyStatusCache');
        return resultObj;
      }

      console.log(`[Blocklist] ✓ Neither full URL nor domain found in malicious database`);
    }

    // Continue scanning through ALL layers and aggregate findings
    // Priority: unsafe > warning > safe
    let finalStatus = 'safe';
    let allSources = [];

    // Blocklists say safe - check Google Safe Browsing, Yandex, and VirusTotal as redundancy if API keys are configured
    const storage = await chrome.storage.local.get(['googleSafeBrowsingApiKey', 'yandexApiKey', 'virusTotalApiKey']);
    const hasGoogleKey = storage.googleSafeBrowsingApiKey && storage.googleSafeBrowsingApiKey.trim() !== '';
    const hasYandexKey = storage.yandexApiKey && storage.yandexApiKey.trim() !== '';
    const hasVTKey = storage.virusTotalApiKey && storage.virusTotalApiKey.trim() !== '';

    // Check Google Safe Browsing (continue even if flagged)
    if (hasGoogleKey) {
      console.log(`[Safety Check] Blocklists say safe, checking Google Safe Browsing as redundancy...`);
      const googleResult = await checkGoogleSafeBrowsing(url);

      if (googleResult === 'unsafe') {
        console.log(`[Safety Check] Google Safe Browsing flagged URL as unsafe!`);
        finalStatus = 'unsafe'; // Escalate to unsafe
        allSources.push('Google Safe Browsing');
      }
    }

    // Check Yandex Safe Browsing (continue even if flagged)
    if (hasYandexKey) {
      console.log(`[Safety Check] Blocklists say safe, checking Yandex Safe Browsing as redundancy...`);
      const yandexResult = await checkYandexSafeBrowsing(url);

      if (yandexResult === 'unsafe') {
        console.log(`[Safety Check] Yandex Safe Browsing flagged URL as unsafe!`);
        finalStatus = 'unsafe'; // Escalate to unsafe
        allSources.push('Yandex Safe Browsing');
      }
    }

    // Check URLVoid Scraping (always runs, no API key needed)
    console.log(`[Safety Check] Blocklists say safe, checking URLVoid scraping...`);
    const vtScrapingResult = await checkURLVoidScraping(url);
    if (vtScrapingResult === 'unsafe') {
      console.log(`[Safety Check] URLVoid scraping flagged URL as unsafe!`);
      finalStatus = 'unsafe';
      allSources.push('URLVoid');
    } else if (vtScrapingResult === 'warning' && finalStatus !== 'unsafe') {
      console.log(`[Safety Check] URLVoid scraping flagged URL as suspicious!`);
      finalStatus = 'warning';
      allSources.push('URLVoid');
    }

    // Check VirusTotal API (optional, requires API key)
    const vtApiKey = await getDecryptedApiKey('virusTotalApiKey');
    if (vtApiKey) {
      console.log(`[Safety Check] Checking VirusTotal API...`);
      const vtApiResult = await checkVirusTotal(url);
      if (vtApiResult === 'unsafe') {
        console.log(`[Safety Check] VirusTotal API flagged URL as unsafe!`);
        finalStatus = 'unsafe';
        if (!allSources.includes('VirusTotal')) {
          allSources.push('VirusTotal');
        }
      } else if (vtApiResult === 'warning') {
        console.log(`[Safety Check] VirusTotal API flagged URL as suspicious!`);
        if (finalStatus !== 'unsafe') {
          finalStatus = 'warning';
        }
        if (!allSources.includes('VirusTotal')) {
          allSources.push('VirusTotal');
        }
      }
    }

    // Check for suspicious patterns (always check, even if already flagged)
    const suspiciousPatterns = await checkSuspiciousPatterns(url, domain);
    if (suspiciousPatterns.length > 0) {
      console.log(`[Safety Check] Suspicious patterns detected: ${suspiciousPatterns.join(', ')}`);
      // Only set to warning if not already unsafe
      if (finalStatus !== 'unsafe') {
        finalStatus = 'warning';
      }
      allSources.push(...suspiciousPatterns);
    }

    // Return aggregated result with all sources
    const resultObj = { status: finalStatus, sources: allSources };
    console.log(`[Safety Check] Final result for ${url}: ${resultObj.status} (sources: ${allSources.join(', ')})`);
    await setCachedResult(url, resultObj, 'safetyStatusCache');
    return resultObj;

  } catch (error) {
    console.error(`[Blocklist] Error checking URL safety:`, error);
    const resultObj = { status: 'unknown', sources: [] };
    await setCachedResult(url, resultObj, 'safetyStatusCache');
    return resultObj;
  }
};

// Listen for messages from the frontend
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkLinkStatus") {
    // Validate URL before checking
    const safeUrl = sanitizeUrl(request.url);
    if (!safeUrl) {
      sendResponse({ status: 'dead' });
      return true;
    }

    const bypassCache = request.bypassCache || false;
    checkLinkStatus(safeUrl, bypassCache).then(status => {
      sendResponse({ status });
    });
    return true; // Required to indicate an asynchronous response.
  }

  if (request.action === "checkURLSafety") {
    // Validate URL before checking
    const safeUrl = sanitizeUrl(request.url);
    if (!safeUrl) {
      sendResponse({ status: 'unsafe', sources: ['Invalid URL'] });
      return true;
    }

    const bypassCache = request.bypassCache || false;
    checkURLSafety(safeUrl, bypassCache).then(result => {
      // Handle both old cache format (string) and new format (object)
      if (typeof result === 'string') {
        sendResponse({ status: result, sources: [] });
      } else {
        sendResponse({ status: result.status, sources: result.sources || [] });
      }
    });
    return true; // Required to indicate an asynchronous response.
  }

  // Background scan control
  if (request.action === "startBackgroundScan") {
    startBackgroundScan({
      bookmarksToScan: request.bookmarks,
      bypassCache: request.bypassCache
    }).then(result => {
      sendResponse(result);
    });
    return true; // Required for async response
  }

  if (request.action === "stopBackgroundScan") {
    const result = stopBackgroundScan();
    sendResponse(result);
    return true;
  }

  if (request.action === "getBackgroundScanStatus") {
    const status = getBackgroundScanStatus();
    sendResponse(status);
    return true;
  }

  if (request.action === "isBlocklistLoading") {
    sendResponse({ isLoading: blocklistLoading });
    return true;
  }

  if (request.action === "waitForBlocklist") {
    // Wait for blocklist to finish loading
    const checkInterval = setInterval(() => {
      if (!blocklistLoading) {
        clearInterval(checkInterval);
        sendResponse({ ready: true });
      }
    }, 500);
    return true; // Required for async response
  }

  if (request.action === "ensureBlocklistReady") {
    // Trigger blocklist update if needed, then wait for it to be ready
    (async () => {
      const now = Date.now();
      if (!isSameDay(now, blocklistLastUpdate) || maliciousUrlsSet.size === 0) {
        console.log('[Blocklist] Ensuring database is up to date (stale or empty)...');
        await updateBlocklistDatabase();
      }

      // Wait for any ongoing load to complete
      if (blocklistLoading) {
        await new Promise(resolve => {
          const checkInterval = setInterval(() => {
            if (!blocklistLoading) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 500);
        });
      }

      sendResponse({ ready: true, size: maliciousUrlsSet.size });
    })();
    return true; // Required for async response
  }
});


// Background scanning state
let backgroundScanState = {
  isScanning: false,
  isCancelled: false,
  totalBookmarks: 0,
  scannedCount: 0,
  bookmarksQueue: [],
  checkedBookmarks: new Set()
};

// Get all bookmarks recursively
async function getAllBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const bookmarks = [];

  function traverse(nodes) {
    nodes.forEach(node => {
      if (node.url) {
        bookmarks.push(node);
      }
      if (node.children) {
        traverse(node.children);
      }
    });
  }

  traverse(tree);
  return bookmarks;
}

// Start background scanning
async function startBackgroundScan(options = {}) {
  const { bookmarksToScan, bypassCache = false } = options;

  if (backgroundScanState.isScanning) {
    console.log('[Background Scan] Already scanning');
    return { success: false, message: 'Scan already in progress' };
  }

  // Reset rate limiting for new scan
  virusTotalRateLimited = false;
  console.log('[VirusTotal] Rate limit reset for new scan');

  try {
    // Get user settings
    const settings = await chrome.storage.local.get(['linkCheckingEnabled', 'safetyCheckingEnabled']);
    const linkCheckingEnabled = settings.linkCheckingEnabled !== false;
    const safetyCheckingEnabled = settings.safetyCheckingEnabled !== false;

    if (!linkCheckingEnabled && !safetyCheckingEnabled) {
      console.log('[Background Scan] Both checking types disabled');
      return { success: false, message: 'Link and safety checking are both disabled' };
    }

    if (bypassCache) {
        console.log('[Background Scan] Bypassing cache for rescan');
        await chrome.storage.local.remove(['linkStatusCache', 'safetyStatusCache']);
    }

    // Ensure blocklist database is ready (triggers update if needed, then waits for completion)
    // This prevents all bookmarks from getting 'unknown' safety status
    const now = Date.now();
    if (!isSameDay(now, blocklistLastUpdate) || maliciousUrlsSet.size === 0) {
      console.log('[Background Scan] Ensuring blocklist database is up to date (stale or empty)...');
      chrome.runtime.sendMessage({
        type: 'scanStatus',
        message: 'Loading security database...'
      }).catch(() => {});

      await updateBlocklistDatabase();
    }

    // Wait for any ongoing blocklist load to complete
    if (blocklistLoading) {
      console.log('[Background Scan] Waiting for blocklist to finish loading...');
      chrome.runtime.sendMessage({
        type: 'scanStatus',
        message: 'Waiting for security database to load...'
      }).catch(() => {});

      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!blocklistLoading) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);
      });

      console.log('[Background Scan] Blocklist ready');
    }

    // Get bookmarks to scan
    const bookmarks = bookmarksToScan || await getAllBookmarks();

    console.log(`[Background Scan] Starting scan of ${bookmarks.length} bookmarks`);

    // Initialize scan state
    backgroundScanState = {
      isScanning: true,
      isCancelled: false,
      totalBookmarks: bookmarks.length,
      scannedCount: 0,
      bookmarksQueue: bookmarks,
      checkedBookmarks: new Set(),
      linkCheckingEnabled,
      safetyCheckingEnabled,
      bypassCache
    };

    // Notify UI that scan has started
    chrome.runtime.sendMessage({
      type: 'scanStarted',
      total: bookmarks.length
    }).catch(() => {}); // Ignore if no listeners

    // Start processing the queue
    processBackgroundScanQueue();

    return { success: true, total: bookmarks.length };
  } catch (error) {
    console.error('[Background Scan] Error starting scan:', error);
    backgroundScanState.isScanning = false;
    return { success: false, message: error.message };
  }
}

// Performance optimization: Batch results to reduce main thread messages
let pendingResults = [];
let batchTimer = null;

function queueResult(result) {
  if (result) {
    pendingResults.push(result);
  }

  // Clear existing timer
  if (batchTimer) {
    clearTimeout(batchTimer);
  }

  const BATCH_SIZE = 10;
  const BATCH_TIMEOUT = 500; // ms

  // Send batch after a delay or when the batch is full
  if (pendingResults.length >= BATCH_SIZE || backgroundScanState.bookmarksQueue.length === 0) {
    if (pendingResults.length > 0) {
      chrome.runtime.sendMessage({
        type: 'scanBatchComplete',
        results: pendingResults
      }).catch(() => {});
      pendingResults = [];
    }
  } else {
    batchTimer = setTimeout(() => {
      if (pendingResults.length > 0) {
        chrome.runtime.sendMessage({
          type: 'scanBatchComplete',
          results: pendingResults
        }).catch(() => {});
        pendingResults = [];
      }
    }, BATCH_TIMEOUT);
  }
}

// Process the background scan queue in batches
async function processBackgroundScanQueue() {
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 100;

  while (backgroundScanState.bookmarksQueue.length > 0 && !backgroundScanState.isCancelled) {
    // Get next batch
    const batch = backgroundScanState.bookmarksQueue.splice(0, BATCH_SIZE);

    // Process batch in parallel
    const checkPromises = batch.map(async (bookmark) => {
      try {
        if (backgroundScanState.checkedBookmarks.has(bookmark.id)) {
          return null;
        }

        backgroundScanState.checkedBookmarks.add(bookmark.id);

        const result = {
          id: bookmark.id,
          url: bookmark.url,
          title: bookmark.title
        };

        // Check link status and safety status in parallel with concurrency limiting
        // Each check gets its own slot in the limiter for true parallelism
        console.log(`[Scan] Starting check for: ${bookmark.title} (${backgroundScanState.scannedCount + 1}/${backgroundScanState.totalBookmarks})`);

        const checks = [];

        // Check link status
        if (backgroundScanState.linkCheckingEnabled) {
          checks.push(
            networkLimiter.run(async () => {
              result.linkStatus = await checkLinkStatus(bookmark.url, backgroundScanState.bypassCache);
            })
          );
        }

        // Check safety status
        if (backgroundScanState.safetyCheckingEnabled) {
          checks.push(
            networkLimiter.run(async () => {
              const safetyResult = await checkURLSafety(bookmark.url, backgroundScanState.bypassCache);
              result.safetyStatus = safetyResult.status;
              result.safetySources = safetyResult.sources;
            })
          );
        }

        // Wait for both to complete
        await Promise.all(checks);

        console.log(`[Scan] Completed check for: ${bookmark.title}`);

        backgroundScanState.scannedCount++;

        // Send progress update after each bookmark
        chrome.runtime.sendMessage({
          type: 'scanProgress',
          scanned: backgroundScanState.scannedCount,
          total: backgroundScanState.totalBookmarks,
        }).catch(() => {});

        // Instead of sending message here, queue the result
        queueResult(result);

        return result;
      } catch (error) {
        console.error(`[Background Scan] Error checking bookmark ${bookmark.id}:`, error);
        backgroundScanState.scannedCount++;

        // Send progress update after each bookmark (even on error)
        chrome.runtime.sendMessage({
          type: 'scanProgress',
          scanned: backgroundScanState.scannedCount,
          total: backgroundScanState.totalBookmarks,
        }).catch(() => {});

        const errorResult = {
          id: bookmark.id,
          url: bookmark.url,
          title: bookmark.title,
          linkStatus: 'dead',
          safetyStatus: 'unknown',
          safetySources: []
        };
        queueResult(errorResult);
        return errorResult;
      }
    });

    await Promise.all(checkPromises);

    // Wait before next batch
    if (backgroundScanState.bookmarksQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  // Final flush for any remaining results
  queueResult(null);

  // Scan complete or cancelled
  const wasCancelled = backgroundScanState.isCancelled;

  console.log(`[Background Scan] ${wasCancelled ? 'Cancelled' : 'Complete'} - Scanned ${backgroundScanState.scannedCount}/${backgroundScanState.totalBookmarks}`);

  // Notify UI
  chrome.runtime.sendMessage({
    type: wasCancelled ? 'scanCancelled' : 'scanComplete',
    scanned: backgroundScanState.scannedCount,
    total: backgroundScanState.totalBookmarks
  }).catch(() => {});

  // Reset state
  backgroundScanState.isScanning = false;
  backgroundScanState.isCancelled = false;
  backgroundScanState.bookmarksQueue = [];
}

// Stop background scanning
function stopBackgroundScan() {
  if (!backgroundScanState.isScanning) {
    return { success: false, message: 'No scan in progress' };
  }

  console.log('[Background Scan] Cancelling scan...');
  backgroundScanState.isCancelled = true;

  return { success: true };
}

// Get current scan status
function getBackgroundScanStatus() {
  return {
    isScanning: backgroundScanState.isScanning,
    scanned: backgroundScanState.scannedCount,
    total: backgroundScanState.totalBookmarks
  };
}

// Set up Side Panel to open when clicking the action icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting up side panel behavior:", error));
