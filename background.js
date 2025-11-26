// This script runs in the background and handles extension tasks.

// Encryption utilities inlined to avoid module loading issues
async function getDerivedKey() {
  const browserInfo = `${navigator.userAgent}-${navigator.language}-${screen.width}x${screen.height}`;
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

// URL validation utilities inlined to avoid module loading issues
const BLOCKED_SCHEMES = ['file', 'javascript', 'data', 'vbscript', 'about'];
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
  if (BLOCKED_SCHEMES.includes(scheme)) {
    return { valid: false, error: `Blocked URL scheme: ${scheme}` };
  }
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

// Store result in cache
const setCachedResult = async (url, result, cacheKey) => {
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
  }
};

/**
 * Checks if a URL is reachable and resolves to the expected domain.
 * This function runs in the background script, which has broader permissions
 * than content scripts, allowing it to bypass CORS restrictions.
 * @param {string} url The URL to check.
 * @returns {Promise<'live' | 'dead' | 'parked'>} The status of the link.
 */
const checkLinkStatus = async (url) => {
  // Check cache first
  const cached = await getCachedResult(url, 'linkStatusCache');
  if (cached) {
    return cached;
  }

  let result;

  // Check if the URL itself is on a parking domain
  try {
    const urlHost = new URL(url).hostname.toLowerCase();
    if (PARKING_DOMAINS.some(domain => urlHost.includes(domain))) {
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
      const corsTimeout = setTimeout(() => corsController.abort(), 10000);

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
      const noCorsTimeout = setTimeout(() => noCorsController.abort(), 10000);

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
        if (finalHost !== originalHost &&
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
    // If HEAD fails, try GET as fallback
    try {
      let fallbackResponse;
      let usedCorsFallback = false;

      try {
        const corsController = new AbortController();
        const corsTimeout = setTimeout(() => corsController.abort(), 8000);

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
        const noCorsTimeout = setTimeout(() => noCorsController.abort(), 8000);

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

          if (finalHost !== originalHost &&
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
      // Both HEAD and GET failed - link is likely dead
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
const BLOCKLIST_UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Blocklist sources - all free, no API keys required
const BLOCKLIST_SOURCES = [
  {
    name: 'URLhaus (Active)',
    // Official abuse.ch list - actively distributing malware URLs (updated every 5 minutes)
    // Using corsproxy.io since abuse.ch doesn't send CORS headers and Firefox MV3 won't bypass
    url: 'https://corsproxy.io/?' + encodeURIComponent('https://urlhaus.abuse.ch/downloads/text/'),
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
      return 'unknown';
    }


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
      return 'unsafe';
    }

    return 'safe';

  } catch (error) {
    console.error(`[Google SB] Error:`, error.message);
    return 'unknown';
  }
};

// Check URL using VirusTotal API
// Get a free API key at: https://www.virustotal.com/gui/my-apikey
// Free tier: 500 requests per day, 4 requests per minute
// API key is stored in chrome.storage.local.virusTotalApiKey
const checkVirusTotal = async (url) => {
  try {
    // Get encrypted API key from storage and decrypt it
    const apiKey = await getDecryptedApiKey('virusTotalApiKey');

    if (!apiKey || apiKey.trim() === '') {
      return 'unknown';
    }


    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    // VirusTotal V3 API - URL scan
    const response = await fetch(
      `https://www.virustotal.com/api/v3/urls`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-apikey': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `url=${encodeURIComponent(url)}`
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[VirusTotal] API error: ${response.status}`);
      return 'unknown';
    }

    const data = await response.json();
    const analysisId = data.data?.id;

    if (!analysisId) {
      console.error(`[VirusTotal] No analysis ID returned`);
      return 'unknown';
    }

    // Wait a moment for analysis to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get analysis results
    const analysisController = new AbortController();
    const analysisTimeout = setTimeout(() => analysisController.abort(), 10000);

    const analysisResponse = await fetch(
      `https://www.virustotal.com/api/v3/analyses/${analysisId}`,
      {
        method: 'GET',
        signal: analysisController.signal,
        headers: {
          'x-apikey': apiKey
        }
      }
    );

    clearTimeout(analysisTimeout);

    if (!analysisResponse.ok) {
      console.error(`[VirusTotal] Analysis fetch error: ${analysisResponse.status}`);
      return 'unknown';
    }

    const analysisData = await analysisResponse.json();
    const stats = analysisData.data?.attributes?.stats;

    if (!stats) {
      console.error(`[VirusTotal] No stats in analysis results`);
      return 'unknown';
    }

    // Check if any engines detected malicious/suspicious content
    const malicious = stats.malicious || 0;
    const suspicious = stats.suspicious || 0;


    // If 2 or more engines flag as malicious, mark as unsafe
    if (malicious >= 2) {
      return 'unsafe';
    }

    // If flagged by 1 engine or suspicious, mark as warning
    if (malicious >= 1 || suspicious >= 2) {
      return 'warning';
    }

    return 'safe';

  } catch (error) {
    console.error(`[VirusTotal] Error:`, error.message);
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
      return 'unknown';
    }

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
      return 'unsafe';
    }

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

    const text = await response.text();
    console.log(`[Blocklist] ${source.name}: ${text.length} bytes downloaded`);

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

    return true;
  } catch (error) {
    console.error(`[Blocklist] Error updating database:`, error);
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
const checkURLSafety = async (url) => {
  // Check cache first
  const cached = await getCachedResult(url, 'safetyStatusCache');
  if (cached) {
    console.log(`[Safety Check] Using cached result for ${url}:`, cached);
    // Handle both old format (string) and new format (object with sources)
    if (typeof cached === 'string') {
      return { status: cached, sources: [] };
    }
    return { status: cached.status, sources: cached.sources || [] };
  }

  console.log(`[Safety Check] Starting safety check for ${url}`);

  let result;

  try {
    // Update database if needed (once per 24 hours)
    const now = Date.now();
    if (now - blocklistLastUpdate > BLOCKLIST_UPDATE_INTERVAL) {
      await updateBlocklistDatabase();
    }

    // If database is empty, try to load it
    if (maliciousUrlsSet.size === 0) {
      const success = await updateBlocklistDatabase();
      if (!success) {
        const resultObj = { status: 'unknown', sources: [] };
        await setCachedResult(url, resultObj, 'safetyStatusCache');
        return resultObj;
      }
    }

    // Normalize URL for lookup (remove protocol, trailing slash, lowercase)
    const normalizedUrl = url.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    // Extract domain (hostname with port, no path)
    const domain = normalizedUrl.split('/')[0];

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

    // Check VirusTotal (continue even if flagged)
    if (hasVTKey) {
      console.log(`[Safety Check] Blocklists say safe, checking VirusTotal...`);
      const vtResult = await checkVirusTotal(url);

      if (vtResult === 'unsafe') {
        console.log(`[Safety Check] VirusTotal flagged URL as unsafe!`);
        finalStatus = 'unsafe'; // Escalate to unsafe
        allSources.push('VirusTotal');
      } else if (vtResult === 'warning') {
        console.log(`[Safety Check] VirusTotal flagged URL as suspicious!`);
        // Only set to warning if not already unsafe
        if (finalStatus !== 'unsafe') {
          finalStatus = 'warning';
        }
        allSources.push('VirusTotal');
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

    checkLinkStatus(safeUrl).then(status => {
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

    checkURLSafety(safeUrl).then(result => {
      // Handle both old cache format (string) and new format (object)
      if (typeof result === 'string') {
        sendResponse({ status: result, sources: [] });
      } else {
        sendResponse({ status: result.status, sources: result.sources || [] });
      }
    });
    return true; // Required to indicate an asynchronous response.
  }

  if (request.action === "getPageContent") {
    fetch(request.url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.text();
      })
      .then(text => sendResponse({ content: text }))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Required for async response
  }

  if (request.action === "openReaderView") {
    const readerUrl = chrome.runtime.getURL(`reader.html?url=${encodeURIComponent(request.url)}`);
    chrome.tabs.create({ url: readerUrl });
    // This message doesn't need a response.
  }

  if (request.action === "openPrintView") {
    const printUrl = chrome.runtime.getURL(`print.html?url=${encodeURIComponent(request.url)}`);
    chrome.tabs.create({ url: printUrl });
    // This message doesn't need a response.
  }
});


// Set up Side Panel to open when clicking the action icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting up side panel behavior:", error));