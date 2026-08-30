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
    /* [ZeroLabs] 2026-06-20 10:50 AM - added: jitter to spread DNS lookups over time */
    this.jitterMs = 0; // Random 0..jitterMs delay before each request
  }

  async run(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      // Stagger request starts so a batch of DNS lookups isn't fired as one wall
      if (this.jitterMs > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * this.jitterMs));
      }
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /* [ZeroLabs] 2026-06-20 10:50 AM - added: live-adjustable cap for settings slider */
  setMax(n) {
    const next = Math.max(1, Math.min(20, Number(n) || this.maxConcurrent));
    const increased = next > this.maxConcurrent;
    this.maxConcurrent = next;
    // If the cap grew, wake enough queued waiters to fill the newly freed slots.
    if (increased) {
      let slots = this.maxConcurrent - this.running;
      while (slots-- > 0) {
        const resolve = this.queue.shift();
        if (!resolve) break;
        resolve();
      }
    }
  }

  /* [ZeroLabs] 2026-06-20 10:50 AM - added: live-adjustable jitter for settings slider */
  setJitter(ms) {
    this.jitterMs = Math.max(0, Math.min(1000, Number(ms) || 0));
  }
}

// Global concurrency limiter for all network requests
/* [ZeroLabs] 2026-06-20 10:35 AM - edited: lower cap to spare home DNS resolver */
// Each link check is a DNS lookup + connection to the bookmark's host. A high
// cap dumps a wall of simultaneous lookups on a local resolver (e.g. AdGuard
// Home) and briefly stalls the whole network. With link+safety each taking a
// slot, a cap of 5 means at most ~10 requests in flight -- gentle on DNS, and
// barely slower since per-request latency, not throughput, is the bottleneck.
const MAX_CONCURRENT_NETWORK = 5; // Default; user-tunable via Settings slider
const networkLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_NETWORK);

/* [ZeroLabs] 2026-06-20 10:50 AM - added: apply saved scan concurrency + jitter on startup */
chrome.storage.local.get(['scanConcurrency', 'scanJitter']).then(({ scanConcurrency, scanJitter }) => {
  if (scanConcurrency) networkLimiter.setMax(scanConcurrency);
  if (scanJitter !== undefined) networkLimiter.setJitter(scanJitter);
}).catch(() => {});

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
            /* [ZeroLabs] 2026-08-28 - added: do not preload what this device will never use */
            // This preload only ever checked staleness, so a device with safety
            // checking switched OFF still downloaded all ten blocklists on every
            // startup - bandwidth spent on data nothing would read.
            if (!(await isSafetyCheckingKnownOn())) {
                console.log('[Startup] Safety checking is not known to be on. Skipping blocklist preload; it loads on demand if a scan needs it.');
            } else if (!isSameDay(now, blocklistLastUpdate)) {
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
    /* [ZeroLabs] 2026-08-28 - added: same gate as the startup preload */
    // An update fires this on every version bump, so on a device with safety
    // checking off it was a guaranteed ten-list download for nothing.
    (async () => {
      if (!(await isSafetyCheckingKnownOn())) {
        console.log(`[Setup] Extension ${details.reason}ed. Safety checking is not known to be on, skipping blocklist preload.`);
        return;
      }
      console.log(`[Setup] Extension ${details.reason}ed. Pre-loading blocklist database...`);
      updateBlocklistDatabase();
    })();
  }
});

// Blocklist sources - all free, no API keys required
const BLOCKLIST_SOURCES = [
  {
    name: 'URLhaus (Active)',
    // Fetched from dedicated GitHub repo (updated daily via GitHub Actions)
    url: 'https://raw.githubusercontent.com/AbsoluteXYZero/urlhaus-list/main/urlhaus-active.txt',
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
    /* [ZeroLabs] 2026-08-17 4:15 PM - edited: jsdelivr 403, repo restructured (see also: Bookmark-Manager-Zero-Firefox/background.js) */
    // Was cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/tif.txt.
    // Two independent breakages: jsDelivr now 403s every path in this repo
    // ("Package size exceeded the configured limit of 150 MB"), and the repo
    // dropped the domains/ directory in favour of wildcard/, with plain domain
    // lists renamed to *-onlydomains.txt. Switched to GitHub raw, which sends
    // Access-Control-Allow-Origin: * and is already used by OISD and FMHY below.
    // medium tier rather than full TIF: 7 MB vs 36.6 MB / 2.06M entries, and
    // every domain is held twice in memory here (maliciousUrlsSet + domainSourceMap).
    name: 'HaGeZi TIF',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt',
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
  },
  {
    name: 'FMHY Filterlist',
    // FMHY unsafe sites list - fake activators, malware distributors, unsafe piracy sites
    url: 'https://raw.githubusercontent.com/fmhy/FMHYFilterlist/main/filterlist-basic-domains.txt',
    format: 'domains' // Plain domain list (one per line)
  },
  {
    name: 'Dandelion Sprout Anti-Malware',
    // Curated anti-malware list - scams, phishing, malware domains
    url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Alternate%20versions%20Anti-Malware%20List/AntiMalwareHosts.txt',
    format: 'hosts' // Hosts file format (127.0.0.1 domain.com)
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

    const urlvoidUrl = `https://www.urlvoid.com/scan/${encodeURIComponent(hostname)}/`;
    let html = null;

    // Try direct fetch first (extensions have elevated privileges)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(urlvoidUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/91.0'
        }
      });

      clearTimeout(timeout);

      if (response.ok) {
        html = await response.text();
        console.log(`[URLVoid Scraping] Direct fetch succeeded for ${hostname}`);
      } else {
        console.log(`[URLVoid Scraping] Direct fetch failed: ${response.status}`);
      }
    } catch (directError) {
      console.log(`[URLVoid Scraping] Direct fetch error: ${directError.message}`);
    }

    // Fallback to CORS proxies if direct fetch failed
    if (!html) {
      console.log(`[URLVoid Scraping] Trying CORS proxy fallback for ${hostname}`);
      const corsProxies = [
        `https://corsproxy.io/?${encodeURIComponent(urlvoidUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(urlvoidUrl)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(urlvoidUrl)}`
      ];

      // Race all proxies in parallel
      const fetchPromises = corsProxies.map(async (proxiedUrl) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const response = await fetch(proxiedUrl, { signal: controller.signal });
          clearTimeout(timeout);

          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.text();
        } catch (error) {
          clearTimeout(timeout);
          throw error;
        }
      });

      try {
        html = await Promise.any(fetchPromises);
        console.log(`[URLVoid Scraping] Proxy fallback succeeded for ${hostname}`);
      } catch (aggregateError) {
        console.log(`[URLVoid Scraping] All proxies failed for ${hostname}`);
        return 'unknown';
      }
    }

    /* [ZeroLabs] 2026-08-28 - fixed: "no report" was being counted as CLEAN */
    // URLVoid answers HTTP 200 with an ordinary-looking "Report Not Found" page
    // for any domain it has never examined. That page contains no "detected"
    // either, so the count below came out zero and the domain was recorded as
    // SAFE - when the truth was that nobody had ever looked at it. A false clean
    // is the one direction a safety check must never fail in.
    //
    // Detected by the page's own marker rather than by size: the same page
    // measures ~12.7KB but that varies, while a real result page is ~36KB.
    if (/Report Not Found/i.test(html)) {
      console.log(`[URLVoid Scraping] ${hostname}: no report - URLVoid has never scanned it`);
      return 'unknown'; // Abstain. 'safe' would be a claim nothing supports.
    }

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

/* [ZeroLabs] 2026-08-28 - added: the blocklists are safety checking's data */
// Absent means on, matching how startBackgroundScan reads this setting, so a
// storage read that comes back empty never silently disables the feature. Only
// an explicit false counts as off.
const isSafetyCheckingEnabled = async () => {
  const { safetyCheckingEnabled } = await chrome.storage.local.get('safetyCheckingEnabled');
  return safetyCheckingEnabled !== false;
};

/* [ZeroLabs] 2026-08-28 - added: the eager preloads must not guess */
// The panel mirrors the real setting into extension storage when it opens, but
// the startup block and onInstalled both run BEFORE any panel exists - on a
// fresh profile, or on the first reload after this fix, the key is simply not
// there yet. Defaulting to "on" there means committing to a ~97 MB download for
// a feature that may well be switched off.
//
// So the eager preloads require an explicit yes and skip on unknown. Nothing is
// lost by skipping: the preload only warms the database, and every path that
// actually NEEDS it (ensureBlocklistReady, startBackgroundScan) fetches it on
// demand and keeps defaulting to on, which is safe because by the time either
// runs the panel has mirrored the real value.
const isSafetyCheckingKnownOn = async () => {
  const { safetyCheckingEnabled } = await chrome.storage.local.get('safetyCheckingEnabled');
  return safetyCheckingEnabled === true;
};

// Download and aggregate all blocklist sources
const updateBlocklistDatabase = async () => {
  // Prevent duplicate loads
  if (blocklistLoading) {
    console.log(`[Blocklist] Already loading, skipping duplicate request`);
    return true;
  }

  blocklistLoading = true;
  let success = false;
  let totalCount = 0;

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
    totalCount = 0;
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

    success = true;
    return true;
  } catch (error) {
    console.error(`[Blocklist] Error updating database:`, error);
    return false;
  } finally {
    // ALWAYS send completion message to prevent UI from getting stuck
    // Even on partial failures, the UI should reset to "Ready"
    chrome.runtime.sendMessage({
      type: 'blocklistComplete',
      domains: maliciousUrlsSet.size,
      totalEntries: success ? totalCount : 0,
      sources: BLOCKLIST_SOURCES.length,
      success: success
    }).catch(() => {});

    blocklistLoading = false;
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
  if (request.action === 'launchWebAuthFlow') {
    chrome.identity.launchWebAuthFlow({ url: request.url, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ responseUrl });
      }
    });
    return true;
  }

  /* [ZeroLabs] 2026-06-20 10:50 AM - added: live update scan concurrency from slider */
  if (request.action === "setScanConcurrency") {
    networkLimiter.setMax(request.value);
    sendResponse({ success: true, value: networkLimiter.maxConcurrent });
    return true;
  }

  /* [ZeroLabs] 2026-06-20 10:50 AM - added: live update scan jitter from slider */
  if (request.action === "setScanJitter") {
    networkLimiter.setJitter(request.value);
    sendResponse({ success: true, value: networkLimiter.jitterMs });
    return true;
  }

  if (request.action === "checkLinkStatus") {
    // Validate URL before checking
    const safeUrl = sanitizeUrl(request.url);
    if (!safeUrl) {
      sendResponse({ status: 'dead' });
      return true;
    }

    const bypassCache = request.bypassCache || false;
    /* [ZeroLabs] 2026-06-20 10:35 AM - edited: route through global limiter (DNS) */
    // Front-end auto-check uses this handler; without the limiter it bypassed the
    // global cap and flooded DNS. Share the same limiter as the background scan.
    networkLimiter.run(() => checkLinkStatus(safeUrl, bypassCache)).then(status => {
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
    /* [ZeroLabs] 2026-06-20 10:35 AM - edited: route through global limiter (DNS) */
    networkLimiter.run(() => checkURLSafety(safeUrl, bypassCache)).then(result => {
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
      /* [ZeroLabs] 2026-08-28 - added: nothing to make ready when safety is off */
      // Answered rather than ignored: callers await this, and a silent skip would
      // leave them waiting. The UI is told the download is over as well, so no
      // listener is left holding a progress message that never resolves.
      if (!(await isSafetyCheckingEnabled())) {
        chrome.runtime.sendMessage({
          type: 'blocklistComplete',
          domains: maliciousUrlsSet.size,
          totalEntries: maliciousUrlsSet.size,
          sources: 0,
          success: true
        }).catch(() => {});
        sendResponse({ ready: true, size: maliciousUrlsSet.size, skipped: true });
        return;
      }

      const now = Date.now();
      if (!isSameDay(now, blocklistLastUpdate) || maliciousUrlsSet.size === 0) {
        console.log('[Blocklist] Ensuring database is up to date (stale or empty)...');
        await updateBlocklistDatabase();
      } else {
        console.log('[Blocklist] Using cached data from today');
        // Send complete message so UI updates properly even when using cache
        chrome.runtime.sendMessage({
          type: 'blocklistComplete',
          domains: maliciousUrlsSet.size,
          totalEntries: maliciousUrlsSet.size,
          sources: BLOCKLIST_SOURCES.length
        }).catch(() => {}); // Ignore if no listeners
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
    /* [ZeroLabs] 2026-08-28 - added: a link-only scan needs no security database */
    // safetyCheckingEnabled is read above and honoured per bookmark further down,
    // but the download in front of them did not consult it - so a link-only scan
    // still paid for all ten lists before checking a single link.
    if (!safetyCheckingEnabled) {
      console.log('[Background Scan] Safety checking is off. Skipping the security database.');
    } else if (!isSameDay(now, blocklistLastUpdate) || maliciousUrlsSet.size === 0) {
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

/* [ZeroLabs] 2026-08-26 11:43 PM - added: background snippet push (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js, Bookmark-Manager-Zero-Firefox/background.js) */
// ============================================================================
// BACKGROUND SNIPPET PUSH
// ============================================================================
// A bookmark added from the browser itself -- the star button, Ctrl+D, the
// native bookmark manager -- fires while the side panel is closed, so the
// panel's listener never saw it and the change sat unsynced until the next time
// the panel happened to be opened. These listeners live in the service worker,
// which the bookmarks events wake on their own, so the push no longer depends on
// the panel being on screen.
//
// Two deliberate limits, both because nobody is watching this one:
//
// 1. Only bookmarks.json is written. bmz-meta.json (Quick Access pins) is left
//    alone. GitLab rewrites only the files named in the request, and the worker
//    has never loaded the pins, so naming that file would blank them.
// 2. The staleness guard here is version equality alone. The panel can fall back
//    to a content diff when the versions disagree; the worker deliberately does
//    not and defers to the panel instead. Skipping a push costs a delay, pushing
//    a stale tree costs somebody else's bookmarks.
//
// setTimeout cannot carry the debounce: an idle worker is torn down and a
// pending timer dies with it. chrome.alarms survives that, and creating an alarm
// under an existing name replaces it, which is exactly the debounce reset.

const SNIPPET_PUSH_ALARM = 'bmz-snippet-push';
const SNIPPET_PUSH_DELAY_MIN = 0.5; // 30s, the shortest alarm Chrome allows
/* [ZeroLabs] 2026-08-27 11:36 AM - added: poll for changes made elsewhere */
// The push is event-driven and needs no interval, but nothing tells us when
// ANOTHER device writes the snippet, so that half has to be asked for. Five
// minutes matches the panel's existing cycle. GitLab's authenticated limit is
// 600 requests a minute, so roughly 24 an hour is not close to anything; the
// reasons not to go faster are abuse detection and waking the worker for a
// question that is almost always answered "nothing changed".
const SNIPPET_POLL_ALARM = 'bmz-snippet-poll';
const SNIPPET_POLL_PERIOD_MIN = 5;
const SNIPPET_MIN_SYNC_INTERVAL_MS = 60000;
const SNIPPET_GITLAB_TIMEOUT_MS = 15000;
const SNIPPET_MAX_PUSH_ATTEMPTS = 3;

async function snippetFetchGitLab(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNIPPET_GITLAB_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`GitLab did not respond within ${Math.round(SNIPPET_GITLAB_TIMEOUT_MS / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors calculateChecksum in sidepanel.js. The excluded fields are the ones
// that change on every write, so the hash covers the bookmarks alone.
async function snippetCalculateChecksum(data) {
  const { checksum, lastModified, version, editLock, ...dataToHash } = data;
  const str = JSON.stringify(dataToHash, Object.keys(dataToHash).sort());
  const buffer = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Mirrors chromeBookmarksToSnippetFormat in sidepanel.js, including promoting
// Bookmarks Menu and Mobile Bookmarks out of Other Bookmarks so the file stays
// in the Firefox-native shape every client reads.
async function snippetTreeToSnippetFormat(chromeTree) {
  const convertNode = (node) => {
    if (node.url) {
      return {
        id: node.id,
        title: node.title,
        url: node.url,
        type: 'bookmark',
        dateAdded: node.dateAdded || Date.now()
      };
    }
    const folder = {
      id: node.id,
      title: node.title || node.name || 'Unnamed Folder',
      name: node.title || node.name || 'Unnamed Folder',
      type: 'folder',
      dateAdded: node.dateAdded || Date.now(),
      children: []
    };
    if (node.children) {
      folder.children = node.children.map(child => convertNode(child));
    }
    return folder;
  };

  const roots = {};
  if (chromeTree[0] && chromeTree[0].children) {
    for (const rootFolder of chromeTree[0].children) {
      const key = rootFolder.id === '1' ? 'bookmark_bar' :
                  rootFolder.id === '2' ? 'other' :
                  rootFolder.id === '3' ? 'mobile' : 'unknown';
      if (key !== 'unknown') {
        roots[key] = convertNode(rootFolder);
      }
    }
  }

  if (roots.other && roots.other.children) {
    const otherChildren = roots.other.children;

    const menuFolderIndex = otherChildren.findIndex(child =>
      child.type === 'folder' && child.title === 'Bookmarks Menu'
    );
    if (menuFolderIndex !== -1) {
      const menuFolder = otherChildren.splice(menuFolderIndex, 1)[0];
      roots.menu = {
        id: 'menu',
        title: 'Bookmarks Menu',
        name: 'Bookmarks Menu',
        type: 'folder',
        dateAdded: menuFolder.dateAdded,
        children: menuFolder.children
      };
    }

    const mobileFolderIndex = otherChildren.findIndex(child =>
      child.type === 'folder' && child.title === 'Mobile Bookmarks'
    );
    if (mobileFolderIndex !== -1) {
      const mobileFolder = otherChildren.splice(mobileFolderIndex, 1)[0];
      roots.mobile = {
        id: 'mobile',
        title: 'Mobile Bookmarks',
        name: 'Mobile Bookmarks',
        type: 'folder',
        dateAdded: mobileFolder.dateAdded,
        children: mobileFolder.children
      };
    }
  }

  if (!roots.menu) {
    roots.menu = {
      id: 'menu',
      title: 'Bookmarks Menu',
      name: 'Bookmarks Menu',
      type: 'folder',
      dateAdded: Date.now(),
      children: []
    };
  }

  const snippetData = {
    version: 1,
    checksum: '',
    lastModified: Date.now(),
    roots: roots
  };

  snippetData.checksum = await snippetCalculateChecksum(snippetData);
  return snippetData;
}

// Everything the push needs, or null when this device is not set up to sync.
// The token is decrypted with the same key derivation the panel uses, which is
// why getDerivedKey is built from values a worker can also see.
async function loadSnippetPushConfig() {
  const stored = await chrome.storage.local.get([
    'bmz_snippet_id',
    'gitlab_token',
    'snippet_local_version',
    'snippet_last_sync'
  ]);

  /* [ZeroLabs] 2026-08-27 12:14 AM - added: say which piece is missing */
  // This returning null used to be indistinguishable from "nothing to do", which
  // made an unattended failure impossible to diagnose from the log alone.
  if (!stored.bmz_snippet_id) {
    console.log('[SnippetPush] No snippet connected on this device');
    return null;
  }
  if (!stored.gitlab_token) {
    console.log('[SnippetPush] No stored GitLab token');
    return null;
  }

  const token = await decryptApiKey(stored.gitlab_token);
  if (!token) {
    console.warn('[SnippetPush] Stored token could not be decrypted in the worker');
    return null;
  }

  return {
    snippetId: stored.bmz_snippet_id,
    token,
    localVersion: Number(stored.snippet_local_version) || 0,
    lastSync: Number(stored.snippet_last_sync) || 0
  };
}

// The panel owns the same flag and reads it on open, so a push skipped while the
// panel was closed still shows up as an amber sync button once it is opened.
async function setSnippetReconcileBadge(needs) {
  try {
    await chrome.storage.local.set({ snippet_needs_reconcile: !!needs });
  } catch (error) {
    console.error('[SnippetPush] Failed to store reconcile flag:', error);
  }

  try {
    await chrome.action.setBadgeText({ text: needs ? '!' : '' });
    if (needs) {
      await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    }
  } catch (error) {
    // Badge unavailable; the stored flag still reaches the panel
  }
}

// Same two-step read the panel does: the snippet API may or may not inline file
// contents, so fall back to the raw endpoint when it does not.
async function readRemoteSnippetBookmarks(config) {
  const headers = {
    'Authorization': `Bearer ${config.token}`,
    'Content-Type': 'application/json'
  };

  const response = await snippetFetchGitLab(
    `https://gitlab.com/api/v4/snippets/${config.snippetId}`,
    { headers }
  );
  if (!response.ok) {
    throw new Error(`Failed to read Snippet: ${response.status}`);
  }

  const snippet = await response.json();
  const bookmarkFile = snippet.files?.find(f =>
    f.path === 'bookmarks.json' || f.file_name === 'bookmarks.json'
  );
  if (!bookmarkFile) {
    throw new Error('Snippet does not contain bookmarks.json');
  }

  let content = bookmarkFile.content;
  if (!content) {
    const fileResponse = await snippetFetchGitLab(
      `https://gitlab.com/api/v4/snippets/${config.snippetId}/files/main/bookmarks.json/raw`,
      { headers }
    );
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch file content: ${fileResponse.status}`);
    }
    content = await fileResponse.text();
  }

  if (!content || content.trim() === '') return null;
  return JSON.parse(content);
}

/* [ZeroLabs] 2026-08-29 - added: a URL is an address, not an identity */
// These maps were keyed on the URL alone, so two bookmarks pointing at the same
// place overwrote each other and the second copy stopped existing as far as sync
// was concerned. A library holding 2911 bookmarks with one duplicate reported
// 2910, and a device rebuilding from the snippet created only one of the pair.
// Nothing ever healed it either: the copy was never seen as missing, so every
// later sync agreed the two sides matched.
//
// The Nth copy of a URL is now keyed "<url>\0#N". The FIRST copy keeps the bare
// URL, so every bookmark that appears once has exactly the key it always had -
// which is what keeps this from re-syncing an entire library on upgrade.
//
// Copies are numbered by sorted location rather than by tree order, so two
// browsers walking their trees in different orders still agree on which copy is
// which, and neither reads the other's copy 1 as a move of its own copy 2.
//
// A NUL cannot appear in a URL, so no real bookmark can collide with a copy key.
// These keys never leave memory: what is stored or pushed is always entry.url.
const SNIPPET_COPY_SEP = '\u0000#';

function snippetKeyUrl(key) {
  const at = key.indexOf(SNIPPET_COPY_SEP);
  return at === -1 ? key : key.slice(0, at);
}

function snippetCopyLocation(entry) {
  return [entry.rootKey].concat(entry.segments || []).join('/') + '/' + (entry.title || '');
}

function keyByUrlCopy(list) {
  const byUrl = new Map();
  list.forEach(entry => {
    if (!byUrl.has(entry.url)) byUrl.set(entry.url, []);
    byUrl.get(entry.url).push(entry);
  });

  const keyed = new Map();
  byUrl.forEach((group, url) => {
    if (group.length === 1) {
      keyed.set(url, group[0]);
      return;
    }
    group.sort((a, b) => snippetCopyLocation(a).localeCompare(snippetCopyLocation(b)));
    group.forEach((entry, i) => {
      keyed.set(i === 0 ? url : `${url}${SNIPPET_COPY_SEP}${i + 1}`, entry);
    });
  });
  return keyed;
}

/* [ZeroLabs] 2026-08-27 2:26 AM - added: what a push would take out of the snippet */
// Additions are safe to send unattended; removals are not. Comparing by URL
// rather than by path means a moved or renamed bookmark still counts as present,
// so only a genuine disappearance holds the push.
/* [ZeroLabs] 2026-08-29 - edited: built from collectSnippetEntries */
// It used to do its own walk, which meant two walks that had to agree about
// which bookmarks exist. Now that a key encodes which copy it is, any drift
// between the two would compare copy 1 here against copy 2 there. Deriving one
// from the other makes disagreement impossible rather than unlikely.
function collectSnippetItems(snippetData) {
  const items = new Map();
  collectSnippetEntries(snippetData).forEach((entry, key) => {
    items.set(key, entry.title);
  });
  return items;
}

/* [ZeroLabs] 2026-08-27 11:36 AM - added: snippet items with the folders they live in */
// collectSnippetItems answers "is this URL present". Creating one locally needs
// to know where it belongs, so this carries the root it sits under and the
// folder names below that root. Roots are handled by KEY rather than by title:
// the snippet names its toolbar root differently depending on which browser
// last wrote it, and the key is the one thing that survives that.
function collectSnippetEntries(snippetData) {
  /* [ZeroLabs] 2026-08-29 - edited: collect first, key afterwards */
  // Keying during the walk is exactly what lost duplicates - the second set()
  // on a URL replaced the first. Collecting into a list keeps every copy, and
  // keying the finished list is what allows copies to be numbered by location
  // instead of by the order the walk happened to reach them.
  const list = [];
  if (!snippetData || !snippetData.roots) return new Map();

  const walk = (node, rootKey, segments) => {
    if (!node) return;
    if (node.url) {
      list.push({ url: node.url, title: node.title || node.url, rootKey, segments });
      return;
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(child => walk(
        child,
        rootKey,
        child.url ? segments : segments.concat(child.title || child.name || 'Unnamed Folder')
      ));
    }
  };

  Object.keys(snippetData.roots).forEach(rootKey => {
    const root = snippetData.roots[rootKey];
    if (!root) return;
    if (Array.isArray(root.children)) {
      root.children.forEach(child => walk(
        child,
        rootKey,
        child.url ? [] : [child.title || child.name || 'Unnamed Folder']
      ));
    }
  });

  return keyByUrlCopy(list);
}

/* [ZeroLabs] 2026-08-27 11:36 AM - added: let the worker place bookmarks itself */
// Until now only the panel could create bookmarks, which is why additions made
// on another device never arrived unless you opened BMZ. Chrome has no separate
// menu root, so the snippet's menu folds into Other Bookmarks under a folder of
// its own name, matching what snippetFormatToChromeBookmarks does in the panel.
function chromeRootForSnippetKey(rootKey) {
  switch (rootKey) {
    case 'bookmark_bar': return { id: '1', prefix: [] };
    case 'other': return { id: '2', prefix: [] };
    case 'menu': return { id: '2', prefix: ['Bookmarks Menu'] };
    case 'mobile': return { id: '3', prefix: [] };
    default: return null;
  }
}

async function resolveOrCreateFolderUnder(parentId, segments) {
  let currentId = parentId;
  for (const segment of segments) {
    const children = await chrome.bookmarks.getChildren(currentId);
    let match = children.find(child => !child.url && child.title === segment);
    if (!match) {
      match = await chrome.bookmarks.create({ parentId: currentId, title: segment });
    }
    currentId = match.id;
  }
  return currentId;
}

async function createSnippetItemsLocally(entries) {
  let created = 0;

  // Shallower folders first, so a parent exists before anything inside it
  const ordered = [...entries].sort((a, b) => a.segments.length - b.segments.length);

  for (const entry of ordered) {
    try {
      const root = chromeRootForSnippetKey(entry.rootKey);
      if (!root) continue;

      const parentId = await resolveOrCreateFolderUnder(root.id, root.prefix.concat(entry.segments));
      await chrome.bookmarks.create({ parentId, title: entry.title, url: entry.url });
      created++;
    } catch (error) {
      // A URL the browser refuses must not take the rest of the sync with it
      console.warn('[SnippetPush] Could not create locally:', entry.url, error.message);
    }
  }

  return created;
}

/* [ZeroLabs] 2026-08-27 11:36 AM - added: remember what this device did (see also: Bookmark-Manager-Zero-Firefox/background.js) */
// A bookmark present here but not in the snippet is either something you just
// added or something another device deleted, and those want opposite answers.
// The bookmarks events say which, and until now the listeners discarded the
// payload. Recording it is what lets an addition sync silently while a deletion
// defers for consent, with no guessing about intent.
//
// Keyed by URL because that is what survives the round trip through the snippet.
// Cleared on every successful sync: once both sides agree, there is nothing left
// for these to explain.
async function recordLocalBookmarkEvent(kind, node) {
  if (!node) return;

  // Deleting a folder fires one event for the folder, never one per bookmark
  // inside it, so the whole subtree has to be walked or those URLs go unrecorded
  // and their deletion looks like it happened somewhere else.
  const urls = [];
  const walk = (n) => {
    if (!n) return;
    if (n.url) urls.push(n.url);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(node);
  if (urls.length === 0) return;

  const key = kind === 'created' ? 'snippet_local_created' : 'snippet_local_deleted';
  const opposite = kind === 'created' ? 'snippet_local_deleted' : 'snippet_local_created';

  try {
    const stored = await chrome.storage.local.get([key, opposite]);
    const list = new Set(stored[key] || []);
    const otherList = new Set(stored[opposite] || []);

    urls.forEach(url => {
      list.add(url);
      // Re-adding something you deleted cancels the deletion, and vice versa, so
      // the two lists can never disagree about the same URL.
      otherList.delete(url);
    });

    await chrome.storage.local.set({
      [key]: Array.from(list).slice(-2000),
      [opposite]: Array.from(otherList)
    });
  } catch (error) {
    console.error('[SnippetPush] Could not record local bookmark event:', error);
  }
}

/* [ZeroLabs] 2026-08-27 1:47 PM - added: record edits, not just creates and deletes */
// A renamed or moved bookmark keeps its URL, so it is invisible to the
// created/deleted lists, and comparing titles alone cannot say WHOSE rename it
// is. Without this, two browsers holding different titles for the same URL each
// see a difference, each push their own, and they revert each other forever.
async function recordLocalBookmarkEdit(id, explicitUrl) {
  try {
    let url = explicitUrl;
    if (!url) {
      // onMoved carries only parent ids, and onChanged only carries the fields
      // that changed, so the URL usually has to be looked up.
      const nodes = await chrome.bookmarks.get(id);
      url = nodes && nodes[0] && nodes[0].url;
    }
    if (!url) return; // Folders are represented by the bookmarks inside them

    const stored = await chrome.storage.local.get('snippet_local_edited');
    const list = new Set(stored.snippet_local_edited || []);
    list.add(url);
    await chrome.storage.local.set({ snippet_local_edited: Array.from(list).slice(-2000) });
  } catch (error) {
    console.error('[SnippetPush] Could not record local edit:', error);
  }
}

async function clearLocalBookmarkEvents() {
  await chrome.storage.local.set({
    snippet_local_created: [],
    snippet_local_deleted: [],
    snippet_local_edited: []
  });
}

/* [ZeroLabs] 2026-08-27 2:02 PM - removed: applyRemoteEditsLocally (moved to: sidepanel.js) */
// Applying someone else's rename overwrites data on this device, so it now
// waits for consent and the panel carries it out, next to the removals it
// already applies on approval.

function scheduleSnippetPush(reason) {
  chrome.storage.local.set({ snippet_push_pending: true }).catch(() => {});
  // Same name replaces the pending alarm, so a burst of edits collapses into one
  // push 30 seconds after the last of them.
  chrome.alarms.create(SNIPPET_PUSH_ALARM, { delayInMinutes: SNIPPET_PUSH_DELAY_MIN });
  console.log(`[SnippetPush] Push scheduled (${reason})`);
}

/* [ZeroLabs] 2026-08-27 11:36 AM - added: the user can switch this off */
// Default on, and only absent-means-on: an explicit false is the only way off,
// so a storage read that comes back empty never silently disables syncing.
async function isBackgroundSyncEnabled() {
  const stored = await chrome.storage.local.get('bmz_auto_sync_enabled');
  return stored.bmz_auto_sync_enabled !== false;
}

async function runSnippetPush() {
  /* [ZeroLabs] 2026-08-27 12:14 AM - edited: log every exit path */
  // Nobody is watching this run, so every way out of it has to leave a trace.
  console.log('[SnippetPush] Running');

  if (!(await isBackgroundSyncEnabled())) {
    console.log('[SnippetPush] Background sync is switched off');
    await chrome.storage.local.set({ snippet_push_pending: false });
    return;
  }

  const config = await loadSnippetPushConfig();
  if (!config) {
    await chrome.storage.local.set({ snippet_push_pending: false, snippet_push_attempts: 0 });
    return;
  }

  if (!navigator.onLine) {
    console.log('[SnippetPush] Offline, retrying after the next alarm');
    chrome.alarms.create(SNIPPET_PUSH_ALARM, { delayInMinutes: SNIPPET_PUSH_DELAY_MIN });
    return;
  }

  // Shared 60 second floor with the panel, both reading the same stored stamp
  const sinceLastSync = Date.now() - config.lastSync;
  if (config.lastSync && sinceLastSync < SNIPPET_MIN_SYNC_INTERVAL_MS) {
    console.log(`[SnippetPush] Last push was ${Math.round(sinceLastSync / 1000)}s ago, deferring`);
    chrome.alarms.create(SNIPPET_PUSH_ALARM, { delayInMinutes: SNIPPET_PUSH_DELAY_MIN });
    return;
  }

  try {
    const remote = await readRemoteSnippetBookmarks(config);
    const remoteVersion = Number(remote?.version) || 0;

    let tree = await chrome.bookmarks.getTree();
    let snippetData = await snippetTreeToSnippetFormat(tree);

    /* [ZeroLabs] 2026-08-27 11:36 AM - edited: four outcomes, not two */
    // Every sync starts as a merge check. What separates a silent sync from a
    // deferral is not the version number but what this device saw you do: a
    // bookmark here that this device watched you create is your addition, one it
    // never saw created came from elsewhere. The version is no longer a gate,
    // which is what stops a stale version number from dead-ending the sync.
    const localItems = collectSnippetItems(snippetData);
    const remoteEntries = collectSnippetEntries(remote);

    const events = await chrome.storage.local.get([
      'snippet_local_created',
      'snippet_local_deleted',
      'snippet_local_edited'
    ]);
    const createdHere = new Set(events.snippet_local_created || []);
    const deletedHere = new Set(events.snippet_local_deleted || []);

    const toAddLocally = [];   // in the snippet, not here, and not deleted here
    const removesFromSnippet = []; // in the snippet, not here, because you deleted it here
    /* [ZeroLabs] 2026-08-29 - edited: the map key is a copy, the URL is not */
    // Attribution stays keyed by URL, because a URL is what survives the round
    // trip through the snippet. That is still the right question to ask of it:
    // "did you delete this link here". Which copy went is answered by the counts
    // on either side, not by the event lists.
    remoteEntries.forEach((entry, key) => {
      if (localItems.has(key)) return;
      if (deletedHere.has(entry.url)) {
        removesFromSnippet.push({ url: entry.url, title: entry.title });
      } else {
        toAddLocally.push(entry);
      }
    });

    const removesFromDevice = []; // here, not in the snippet, and not added here
    let hasLocalAdditions = false;
    localItems.forEach((title, key) => {
      if (remoteEntries.has(key)) return;
      const url = snippetKeyUrl(key);
      if (createdHere.has(url)) {
        hasLocalAdditions = true;
      } else {
        removesFromDevice.push({ url, title });
      }
    });

    /* [ZeroLabs] 2026-08-27 2:02 PM - added: renames and moves, judged before the deferral */
    // A rename or move keeps the URL, so it is invisible to the two loops above
    // and has to be compared separately. Attribution decides what happens, and
    // the two directions are deliberately not symmetric:
    //
    //   edited here     -> you made the change and want it to travel. Push it.
    //   edited          -> the snippet wants to overwrite a name or location on
    //     elsewhere         this device. That is a change to data you may have
    //                       chosen, and nothing here can tell which is wanted,
    //                       so it waits for you exactly as a deletion does.
    //
    // Compared by title and location rather than by checksum on purpose: a
    // Chrome checksum can never equal a Firefox one, because the two name their
    // root folders differently, so a checksum test would report a difference
    // forever and the browsers would push at each other in a loop. Root KEYS
    // (bookmark_bar, menu, other, mobile) and user folder names match on both
    // sides, so this comparison is safe across browsers.
    const editedHere = new Set(events.snippet_local_edited || []);
    const localEntries = collectSnippetEntries(snippetData);
    let hasLocalEdits = false;
    const overwritesOnDevice = [];

    localEntries.forEach((localEntry, key) => {
      const remoteEntry = remoteEntries.get(key);
      if (!remoteEntry) return; // Additions are handled by the loops above

      const movedOrRenamed =
        localEntry.title !== remoteEntry.title ||
        localEntry.rootKey !== remoteEntry.rootKey ||
        localEntry.segments.join('/') !== remoteEntry.segments.join('/');
      if (!movedOrRenamed) return;

      if (editedHere.has(localEntry.url)) {
        hasLocalEdits = true;
      } else {
        // rootKey and segments travel with it so the panel can place the
        // bookmark if you approve, without re-deriving the path from a title.
        overwritesOnDevice.push({
          url: localEntry.url,
          title: localEntry.title,
          remoteTitle: remoteEntry.title,
          localPath: [localEntry.rootKey].concat(localEntry.segments).join('/'),
          remotePath: [remoteEntry.rootKey].concat(remoteEntry.segments).join('/'),
          remoteRootKey: remoteEntry.rootKey,
          remoteSegments: remoteEntry.segments
        });
      }
    });

    /* [ZeroLabs] 2026-08-27 - edited: additions land BEFORE any deferral */
    // This used to sit after the deferral check, which meant a pending deletion
    // suppressed a perfectly safe addition - and worse, approving that deletion
    // then pushed a local tree that had never received it, deleting it from the
    // snippet. Local ABCDF against snippet ABCDE, approving the removal of F,
    // pushed ABCD and destroyed E.
    //
    // Adding is never destructive, so it is never a reason to wait.
    let addedLocally = 0;
    if (toAddLocally.length > 0) {
      addedLocally = await createSnippetItemsLocally(toAddLocally);
      console.log(`[SnippetPush] Added ${addedLocally} item(s) from the snippet to this device`);
      tree = await chrome.bookmarks.getTree();
      snippetData = await snippetTreeToSnippetFormat(tree);
    }

    /* [ZeroLabs] 2026-08-27 - added: the safe additions, for the dialog to list */
    // Additions never need consent and are already applied by this point, but a
    // dialog appearing while bookmarks quietly arrive should account for them.
    // Approve also pushes, so this device's own additions travel with it.
    const entryPath = (e) => [e.rootKey].concat(e.segments).join('/');
    const addedHereItems = toAddLocally.slice(0, 200).map(e => ({
      url: e.url, title: e.title, path: entryPath(e)
    }));
    const pendingPushItems = [];
    localEntries.forEach((entry, key) => {
      if (!remoteEntries.has(key) && createdHere.has(entry.url)) {
        pendingPushItems.push({ url: entry.url, title: entry.title, path: entryPath(entry) });
      }
    });

    // Outcome 4: anything that removes or overwrites on either side waits.
    if (removesFromSnippet.length > 0 || removesFromDevice.length > 0 || overwritesOnDevice.length > 0) {
      await chrome.storage.local.set({
        snippet_push_held: true,
        snippet_push_held_items: removesFromSnippet.slice(0, 200),
        snippet_pull_held_items: removesFromDevice.slice(0, 200),
        snippet_overwrite_held_items: overwritesOnDevice.slice(0, 200),
        snippet_added_here_items: addedHereItems,
        snippet_pending_push_items: pendingPushItems.slice(0, 200),
        snippet_push_pending: false,
        snippet_push_attempts: 0
      });
      await setSnippetReconcileBadge(true);
      console.warn('[SnippetPush] Deferred for consent', {
        wouldRemoveFromSnippet: removesFromSnippet.length,
        wouldRemoveFromDevice: removesFromDevice.length,
        wouldOverwriteOnDevice: overwritesOnDevice.length
      });
      return;
    }

    // Outcome 2 and 3: push when this device has something the snippet lacks.
    // Adopting an edit brings this side to the snippet, so it needs no push
    // either; only changes made here do.
    if (!hasLocalAdditions && addedLocally === 0 && !hasLocalEdits) {
      await chrome.storage.local.set({
        snippet_local_version: remoteVersion,
        snippet_last_sync: Date.now(),
        snippet_push_pending: false,
        snippet_push_attempts: 0,
        snippet_push_held: false,
        snippet_push_held_items: [],
        snippet_pull_held_items: [],
        snippet_overwrite_held_items: []
      });
      await clearLocalBookmarkEvents();
      await setSnippetReconcileBadge(false);
      console.log('[SnippetPush] Already in sync, version recorded as', remoteVersion);
      return;
    }

    const payload = {
      ...snippetData,
      version: remoteVersion + 1,
      checksum: await snippetCalculateChecksum(snippetData),
      lastModified: Date.now()
    };

    const response = await snippetFetchGitLab(
      `https://gitlab.com/api/v4/snippets/${config.snippetId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: [{
            action: 'update',
            file_path: 'bookmarks.json',
            content: JSON.stringify(payload, null, 2)
          }]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to update Snippet: ${response.status}`);
    }

    await chrome.storage.local.set({
      snippet_local_version: remoteVersion + 1,
      snippet_last_sync: Date.now(),
      snippet_push_pending: false,
      snippet_push_attempts: 0,
      /* [ZeroLabs] 2026-08-27 2:26 AM - added: a clean push clears any hold */
      snippet_push_held: false,
      snippet_push_held_items: [],
      snippet_pull_held_items: [],
        snippet_overwrite_held_items: []
    });
    /* [ZeroLabs] 2026-08-27 11:36 AM - added: both sides agree, the records are spent */
    await clearLocalBookmarkEvents();
    await setSnippetReconcileBadge(false);
    console.log('[SnippetPush] Pushed bookmarks.json at version', remoteVersion + 1);
  } catch (error) {
    // A dead token or a missing snippet fails identically every time, so retries
    // are capped rather than left to hammer GitLab until the browser closes.
    const { snippet_push_attempts = 0 } = await chrome.storage.local.get('snippet_push_attempts');
    const attempts = snippet_push_attempts + 1;
    await chrome.storage.local.set({ snippet_push_attempts: attempts });

    console.error(`[SnippetPush] Attempt ${attempts} failed:`, error);

    if (attempts < SNIPPET_MAX_PUSH_ATTEMPTS) {
      chrome.alarms.create(SNIPPET_PUSH_ALARM, { delayInMinutes: SNIPPET_PUSH_DELAY_MIN });
    } else {
      // Give up until the next bookmark change, and say so where it can be seen
      await setSnippetReconcileBadge(true);
      await chrome.storage.local.set({ snippet_push_pending: false, snippet_push_attempts: 0 });
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  /* [ZeroLabs] 2026-08-27 11:36 AM - edited: the poll runs the same reconcile */
  // Both alarms end in the same place. The push alarm is your own change asking
  // to go up; the poll is this device asking whether anything came in.
  if (alarm.name === SNIPPET_PUSH_ALARM || alarm.name === SNIPPET_POLL_ALARM) {
    runSnippetPush();
  }
});

/* [ZeroLabs] 2026-08-27 11:36 AM - added: keep the poll alarm alive */
// Alarms survive a worker teardown but not an uninstall or a browser update, so
// this is re-asserted on both startup events. Creating it under the same name
// replaces it rather than stacking a second one.
function ensureSnippetPollAlarm() {
  chrome.alarms.create(SNIPPET_POLL_ALARM, {
    periodInMinutes: SNIPPET_POLL_PERIOD_MIN,
    delayInMinutes: SNIPPET_POLL_PERIOD_MIN
  });
}

chrome.runtime.onInstalled.addListener(ensureSnippetPollAlarm);
chrome.runtime.onStartup.addListener(ensureSnippetPollAlarm);

/* [ZeroLabs] 2026-08-27 11:36 AM - edited: keep the payload instead of discarding it */
// Registered at the top level so a stopped worker is woken by the event itself.
// onCreated hands over the new node; onRemoved hands over removeInfo.node, which
// is the only moment the deleted bookmark's URL is still knowable.
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  recordLocalBookmarkEvent('created', bookmark);
  scheduleSnippetPush('onCreated');
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  recordLocalBookmarkEvent('deleted', removeInfo && removeInfo.node);
  scheduleSnippetPush('onRemoved');
});

/* [ZeroLabs] 2026-08-27 1:47 PM - edited: an edit is attributable too */
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  recordLocalBookmarkEdit(id, changeInfo && changeInfo.url);
  scheduleSnippetPush('onChanged');
});

chrome.bookmarks.onMoved.addListener((id) => {
  recordLocalBookmarkEdit(id);
  scheduleSnippetPush('onMoved');
});

// A push left pending when the worker was torn down or the browser closed still
// has to happen, and its alarm may have been consumed already.
chrome.runtime.onStartup.addListener(async () => {
  const { snippet_push_pending } = await chrome.storage.local.get('snippet_push_pending');
  if (snippet_push_pending) {
    chrome.alarms.create(SNIPPET_PUSH_ALARM, { delayInMinutes: SNIPPET_PUSH_DELAY_MIN });
  }
});
