// Bookmark Manager Zero - Side Panel Script
// Connects to Chrome native bookmarks API

// ============================================================================
// VERSION - Single source of truth from manifest.json
// ============================================================================
const APP_VERSION = chrome.runtime.getManifest().version;

// ============================================================================
// FIRST-TIME SETUP CARD
// ============================================================================
let hasSeenSetupCard = true; // Default to true, will be loaded from storage

// Load setup card flag from storage
async function loadSetupCardFlag() {
  try {
    const result = await chrome.storage.local.get(['hasSeenSetupCard']);
    hasSeenSetupCard = result.hasSeenSetupCard || false;
  } catch (error) {
    console.error('Error loading setup card flag:', error);
    hasSeenSetupCard = false;
  }
}

// Mark setup card as seen
async function dismissSetupCard() {
  hasSeenSetupCard = true;
  try {
    await chrome.storage.local.set({ hasSeenSetupCard: true });
    renderBookmarks(); // Re-render to remove the card
  } catch (error) {
    console.error('Error saving setup card flag:', error);
  }
}

// ============================================================================
// GLOBAL ERROR BOUNDARY
// ============================================================================

// Toast DOM elements
let successToast;
let successMessage;
let successDismiss;
let errorToast;
let errorTitle;
let errorMessage;
let errorReload;
let errorDismiss;

// Error log storage (keep last 50 errors)
const MAX_ERROR_LOGS = 50;

// Initialize toast elements after DOM loads
function initErrorToast() {
  // Success toast
  successToast = document.getElementById('successToast');
  successMessage = document.getElementById('successMessage');
  successDismiss = document.getElementById('successDismiss');

  if (successDismiss) {
    successDismiss.addEventListener('click', () => {
      hideSuccessToast();
    });
  }

  // Error toast
  errorToast = document.getElementById('errorToast');
  errorTitle = document.getElementById('errorTitle');
  errorMessage = document.getElementById('errorMessage');
  errorReload = document.getElementById('errorReload');
  errorDismiss = document.getElementById('errorDismiss');

  if (errorReload) {
    errorReload.addEventListener('click', () => {
      location.reload();
    });
  }

  if (errorDismiss) {
    errorDismiss.addEventListener('click', () => {
      hideErrorToast();
    });
  }
}

// Show error toast notification
function showErrorToast(title, message) {
  if (!errorToast) return;

  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorToast.classList.remove('hidden');

  // Auto-hide after 10 seconds
  setTimeout(() => {
    hideErrorToast();
  }, 10000);
}

// Hide error toast
function hideErrorToast() {
  if (errorToast) {
    errorToast.classList.add('hidden');
  }
}

// Show success toast notification
function showSuccessToast(message) {
  if (!successToast) return;

  successMessage.textContent = message;
  successToast.classList.remove('hidden');

  // Auto-hide after 5 seconds
  setTimeout(() => {
    hideSuccessToast();
  }, 5000);
}

// Hide success toast
function hideSuccessToast() {
  if (successToast) {
    successToast.classList.add('hidden');
  }
}

// General toast notification
function showToast(message, type = 'success') {
  if (type === 'error') {
    showErrorToast('Error', message);
  } else {
    showSuccessToast(message);
  }
}

// Log error to browser storage
async function logError(error, context = '') {
  try {
    const errorLog = {
      timestamp: Date.now(),
      message: error.message || String(error),
      stack: error.stack || '',
      context: context,
      userAgent: navigator.userAgent,
      url: window.location.href
    };

    // Get existing error logs
    const result = await chrome.storage.local.get('errorLogs');
    let errorLogs = result.errorLogs || [];

    // Add new error
    errorLogs.unshift(errorLog);

    // Keep only last 50 errors
    if (errorLogs.length > MAX_ERROR_LOGS) {
      errorLogs = errorLogs.slice(0, MAX_ERROR_LOGS);
    }

    // Save to storage
    await chrome.storage.local.set({ errorLogs });
    console.error(`[Error Logged] ${context}:`, error);
  } catch (storageError) {
    console.error('Failed to log error to storage:', storageError);
  }
}

// Global error handler for synchronous errors
window.addEventListener('error', async (event) => {
  const error = event.error || new Error(event.message);

  console.error('Global error caught:', error);

  // Log error to storage
  await logError(error, 'Global Error');

  // Show user-friendly error message
  showErrorToast(
    'Unexpected Error',
    error.message || 'An unexpected error occurred. The extension will continue to work, but some features may not function correctly.'
  );

  // Prevent default browser error handling
  event.preventDefault();
});

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', async (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));

  console.error('Unhandled promise rejection:', error);

  // Log error to storage
  await logError(error, 'Unhandled Promise Rejection');

  // Show user-friendly error message
  showErrorToast(
    'Promise Error',
    error.message || 'An operation failed unexpectedly. Please try again.'
  );

  // Prevent default browser error handling
  event.preventDefault();
});

// Initialize error toast when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initErrorToast);
} else {
  initErrorToast();
}

// ============================================================================
// PRIVATE BROWSING MODE DETECTION & HANDLING
// ============================================================================

// Detect if we're in private/incognito mode
// Chrome doesn't have extension.inIncognitoContext in service workers, so we default to false
const isPrivateMode = false;

// Session-only storage for private mode (cleared when window closes)
const privateSessionStorage = new Map();

// Privacy-respecting storage wrapper
const safeStorage = {
  async get(keys) {
    if (isPrivateMode) {
      // In private mode, use session storage only
      if (typeof keys === 'string') {
        return { [keys]: privateSessionStorage.get(keys) };
      } else if (Array.isArray(keys)) {
        const result = {};
        keys.forEach(key => {
          result[key] = privateSessionStorage.get(key);
        });
        return result;
      }
      return {};
    }
    // Normal mode: use chrome.storage.local
    return await chrome.storage.local.get(keys);
  },

  async set(items) {
    if (isPrivateMode) {
      // In private mode, store in session storage only (memory)
      Object.entries(items).forEach(([key, value]) => {
        privateSessionStorage.set(key, value);
      });
      return;
    }
    // Normal mode: use chrome.storage.local
    return await chrome.storage.local.set(items);
  },

  async remove(keys) {
    if (isPrivateMode) {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      keysArray.forEach(key => privateSessionStorage.delete(key));
      return;
    }
    return await chrome.storage.local.remove(keys);
  }
};

// Show private mode indicator in UI
function showPrivateModeIndicator() {
  if (!isPrivateMode) return;

  const header = document.querySelector('.header');
  if (!header) return;

  const indicator = document.createElement('div');
  indicator.className = 'private-mode-indicator';
  indicator.innerHTML = `
    <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" style="vertical-align: middle; margin-right: 4px;">
      <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
    </svg>
    <span style="font-size: 11px; font-weight: 500;">Private Mode</span>
  `;
  indicator.style.cssText = `
    display: flex;
    align-items: center;
    padding: 4px 12px;
    background: var(--md-sys-color-secondary-container, rgba(208, 188, 255, 0.2));
    color: var(--md-sys-color-on-secondary-container, #d0bcff);
    border-radius: 12px;
    font-size: 11px;
    margin-left: 8px;
  `;
  indicator.title = 'Private browsing mode: No data will be saved to disk';

  // Insert after logo
  const logo = header.querySelector('.logo');
  if (logo && logo.parentElement) {
    logo.parentElement.insertBefore(indicator, logo.nextSibling);
  }
}

// Note: Chrome doesn't require private mode error logging wrapper
// The logError function defined earlier handles all error logging

// ============================================================================
// ENCRYPTION UTILITIES
// ============================================================================

// Encryption utilities inlined to avoid module loading issues
async function getDerivedKey() {
  // Use extension ID and browser info for key derivation (consistent with background.js)
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

async function encryptApiKey(plaintext) {
  if (!plaintext) return null;
  try {
    const key = await getDerivedKey();
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch (error) {
    console.error('Encryption failed:', error);
    return null;
  }
}

// ============================================================================
// SHARED UTILITY FUNCTIONS (used by GitLab Snippets)
// ============================================================================

// Calculate SHA-256 checksum
async function calculateChecksum(data) {
  const { checksum, lastModified, version, editLock, ...dataToHash } = data;
  const str = JSON.stringify(dataToHash, Object.keys(dataToHash).sort());
  const buffer = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Convert Chrome bookmarks to Snippet format
async function chromeBookmarksToSnippetFormat(chromeTree) {
  const convertNode = (node) => {
    if (node.url) {
      // Bookmark
      return {
        id: node.id,
        title: node.title,
        url: node.url,
        type: 'bookmark',
        dateAdded: node.dateAdded || Date.now()
      };
    } else {
      // Folder
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
    }
  };

  // Chrome bookmark structure has a root with children
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

  // Add empty menu folder for compatibility with website/Firefox
  // Chrome doesn't have a native "Bookmarks Menu" folder
  roots.menu = {
    id: 'menu',
    title: 'Bookmarks Menu',
    name: 'Bookmarks Menu',
    type: 'folder',
    dateAdded: Date.now(),
    children: []
  };

  const snippetData = {
    version: 1,
    checksum: '',
    lastModified: Date.now(),
    roots: roots
  };

  snippetData.checksum = await calculateChecksum(snippetData);
  return snippetData;
}



// ============================================================================
// GitLab Snippet Functions
// ============================================================================

// GitLab Snippet global variables
let snippetToken = null;
let snippetId = null;
let snippetSyncInterval = null;
let snippetLastSyncTime = 0;
let snippetIsSyncing = false;
let snippetLocalVersion = 0;
let snippetPushDebounceTimer = null;
let snippetMinSyncInterval = 60000; // Minimum 60 seconds between syncs to avoid abuse detection

// Encrypt and store GitLab token
async function storeSnippetToken(token) {
  const encrypted = await encryptApiKey(token);
  await chrome.storage.local.set({ gitlab_token: encrypted });
  snippetToken = token;
  console.log('GitLab token stored securely');
}

// Retrieve and decrypt GitLab token
async function loadSnippetToken() {
  const result = await chrome.storage.local.get(['gitlab_token']);
  if (!result.gitlab_token) return null;
  snippetToken = await decryptApiKey(result.gitlab_token);
  return snippetToken;
}

// Clear GitLab token
async function clearSnippetToken() {
  await chrome.storage.local.remove(['gitlab_token']);
  snippetToken = null;
  console.log('GitLab token cleared');
}

// Get GitLab API headers
function getSnippetHeaders() {
  if (!snippetToken) {
    throw new Error('No GitLab token available');
  }
  return {
    'Authorization': `Bearer ${snippetToken}`,
    'Content-Type': 'application/json'
  };
}

// Validate GitLab token
async function validateSnippetToken() {
  try {
    const response = await fetch('https://gitlab.com/api/v4/user', {
      headers: getSnippetHeaders()
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status}`);
    }
    const user = await response.json();
    console.log('GitLab token validated for user:', user.username);
    return user;
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}

// Get all user's snippets
async function getAllSnippets() {
  try {
    const response = await fetch('https://gitlab.com/api/v4/snippets', {
      headers: getSnippetHeaders()
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch snippets: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch snippets:', error);
    throw error;
  }
}

// Find bookmark snippet
async function findBookmarkSnippet() {
  try {
    const snippets = await getAllSnippets();
    const bookmarkSnippet = snippets.find(s =>
      s.title?.includes('BMZ') ||
      s.title?.includes('Bookmark Manager Zero') ||
      s.file_name === 'bookmarks.json'
    );
    if (bookmarkSnippet) {
      console.log('Found bookmark Snippet:', bookmarkSnippet.id);
      return bookmarkSnippet.id;
    }
    return null;
  } catch (error) {
    console.error('Failed to find bookmark Snippet:', error);
    throw error;
  }
}

// Create new bookmark snippet
async function createBookmarkSnippet(bookmarkTree = null) {
  try {
    let tree = bookmarkTree;

    // If no tree provided, get current Chrome bookmarks
    if (!tree) {
      const chromeTree = await chrome.bookmarks.getTree();
      tree = await chromeBookmarksToSnippetFormat(chromeTree);
    }

    const response = await fetch('https://gitlab.com/api/v4/snippets', {
      method: 'POST',
      headers: getSnippetHeaders(),
      body: JSON.stringify({
        title: 'BMZ Bookmarks - Managed by Bookmark Manager Zero',
        visibility: 'private',
        files: [
          {
            file_path: 'bookmarks.json',
            content: JSON.stringify(tree, null, 2)
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create Snippet: ${response.status} - ${errorText}`);
    }

    const snippet = await response.json();
    snippetId = snippet.id;
    await chrome.storage.local.set({ bmz_snippet_id: snippetId });
    console.log('Created bookmark Snippet:', snippetId);
    return snippet.id;
  } catch (error) {
    console.error('Failed to create bookmark Snippet:', error);
    throw error;
  }
}

// Read bookmarks from snippet
async function readBookmarksFromSnippet(id = null) {
  const useId = id || snippetId;
  if (!useId) {
    throw new Error('No Snippet ID provided');
  }

  try {
    const response = await fetch(`https://gitlab.com/api/v4/snippets/${useId}`, {
      headers: getSnippetHeaders()
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Bookmark Snippet not found');
      }
      throw new Error(`Failed to read Snippet: ${response.status}`);
    }

    const snippet = await response.json();

    // GitLab snippets have a 'files' array
    const bookmarkFile = snippet.files?.find(f =>
      f.path === 'bookmarks.json' || f.file_name === 'bookmarks.json'
    );
    if (!bookmarkFile) {
      throw new Error('Snippet does not contain bookmarks.json');
    }

    // Get file content
    let content = bookmarkFile.content;

    // If content is not in the response, fetch it using the raw endpoint
    if (!content) {
      const fileResponse = await fetch(
        `https://gitlab.com/api/v4/snippets/${useId}/files/main/bookmarks.json/raw`,
        { headers: getSnippetHeaders() }
      );
      if (!fileResponse.ok) {
        throw new Error(`Failed to fetch file content: ${fileResponse.status}`);
      }
      content = await fileResponse.text();
    }

    // If content is empty or just whitespace, return empty structure
    if (!content || content.trim() === '') {
      console.log('Snippet file is empty, returning empty bookmark structure');
      return {
        version: 1,
        checksum: '',
        lastModified: Date.now(),
        roots: {
          bookmark_bar: { id: '1', title: 'Bookmarks Toolbar', name: 'Bookmarks Toolbar', type: 'folder', dateAdded: Date.now(), children: [] },
          menu: { id: '2', title: 'Bookmarks Menu', name: 'Bookmarks Menu', type: 'folder', dateAdded: Date.now(), children: [] },
          other: { id: '3', title: 'Other Bookmarks', name: 'Other Bookmarks', type: 'folder', dateAdded: Date.now(), children: [] },
          mobile: { id: '4', title: 'Mobile Bookmarks', name: 'Mobile Bookmarks', type: 'folder', dateAdded: Date.now(), children: [] }
        }
      };
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to read bookmarks from Snippet:', error);
    throw error;
  }
}

// Update bookmarks in snippet
async function updateBookmarksInSnippet(bookmarkTree, version = null) {
  if (!snippetId) {
    throw new Error('No Snippet ID provided');
  }

  try {
    const dataWithMeta = {
      ...bookmarkTree,
      version: version !== null ? version : (bookmarkTree.version || 1) + 1,
      checksum: await calculateChecksum(bookmarkTree),
      lastModified: Date.now()
    };

    const response = await fetch(`https://gitlab.com/api/v4/snippets/${snippetId}`, {
      method: 'PUT',
      headers: getSnippetHeaders(),
      body: JSON.stringify({
        files: [
          {
            action: 'update',
            file_path: 'bookmarks.json',
            content: JSON.stringify(dataWithMeta, null, 2)
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update Snippet: ${response.status} - ${errorText}`);
    }

    console.log('Updated bookmarks in Snippet:', snippetId);
    return await response.json();
  } catch (error) {
    console.error('Failed to update bookmarks in Snippet:', error);
    throw error;
  }
}

// ============================================================================
// End of GitLab Snippet Functions
// ============================================================================

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

async function storeEncryptedApiKey(keyName, apiKey) {
  const encrypted = await encryptApiKey(apiKey);
  if (encrypted) {
    await safeStorage.set({ [keyName]: encrypted });
    return true;
  }
  return false;
}

async function getDecryptedApiKey(keyName) {
  const result = await safeStorage.get(keyName);
  if (result[keyName]) {
    return await decryptApiKey(result[keyName]);
  }
  return null;
}



// ============================================================================
// GitLab Snippet Sync Dialog (mirrors Snippet sync dialog)
// ============================================================================

// Open GitLab Snippet sync dialog
async function openSnippetSyncDialog() {
  // Check if already authenticated
  await loadSnippetToken();

  const modal = document.createElement('div');
  modal.id = 'snippetSyncModal';
  modal.className = 'modal';
  modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background: var(--md-sys-color-surface, #1e1e1e); padding: 24px; border-radius: 12px; max-width: 500px; width: 90%; color: var(--md-sys-color-on-surface, #e0e0e0);';

  if (snippetToken) {
    // Already authenticated - show sync options
    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px;">GitLab Snippet Sync</h2>
      <p style="margin: 0 0 20px 0; color: var(--md-sys-color-on-surface-variant, #aaa);">
        ${snippetId ? 'Connected to Snippet: <code style="font-size: 11px;">' + snippetId + '</code>' : 'Not connected to any Snippet'}
      </p>
      <div style="display: flex; flex-direction: column; gap: 12px;">
        ${snippetId ? `
          <button id="syncFromSnippet" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-primary, #818cf8); color: var(--md-sys-color-on-primary, #fff); cursor: pointer; font-size: 14px;">
            ⬇️ Sync from Snippet to Browser
          </button>
          <button id="syncToSnippet" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-tertiary-container, #2a2a2a); color: var(--md-sys-color-on-tertiary-container, #d0bcff); cursor: pointer; font-size: 14px;">
            ⬆️ Sync from Browser to Snippet
          </button>
          <hr style="border: none; border-top: 1px solid var(--md-sys-color-outline, #444); margin: 8px 0;">
        ` : ''}
        <button id="createNewSnippet" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-secondary-container, #2a2a2a); color: var(--md-sys-color-on-secondary-container, #d0bcff); cursor: pointer; font-size: 14px;">
          Create New Snippet with Current Bookmarks
        </button>
        <button id="selectExistingSnippet" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-secondary-container, #2a2a2a); color: var(--md-sys-color-on-secondary-container, #d0bcff); cursor: pointer; font-size: 14px;">
          Select Existing Snippet
        </button>
        <button id="disconnectSnippet" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-error-container, #3b1a1a); color: var(--md-sys-color-on-error-container, #f9dedc); cursor: pointer; font-size: 14px;">
          Disconnect & Remove Token
        </button>
        <button id="cancelSnippetDialog" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; font-size: 14px;">
          Cancel
        </button>
      </div>
    `;
  } else {
    // Not authenticated - show login
    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px;">GitLab Snippet Sync Setup</h2>
      <p style="margin: 0 0 16px 0; color: var(--md-sys-color-on-surface-variant, #aaa); font-size: 14px;">
        To enable Snippet sync, you need a GitLab Personal Access Token with 'api' permissions.
      </p>
      <a href="https://gitlab.com/-/profile/personal_access_tokens?name=Bookmark+Manager+Zero&scopes=api" target="_blank" style="display: inline-block; margin-bottom: 16px; padding: 8px 16px; background: var(--md-sys-color-secondary-container, #2a2a2a); color: var(--md-sys-color-on-secondary-container, #d0bcff); text-decoration: none; border-radius: 8px; font-size: 13px;">
        Create Token on GitLab →
      </a>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 8px; font-size: 14px;">Personal Access Token:</label>
        <input type="password" id="gitlabTokenInput" placeholder="glpat-xxxxxxxxxxxx" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline, #444); background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface, #e0e0e0); font-size: 14px; box-sizing: border-box;">
      </div>
      <div style="display: flex; gap: 12px;">
        <button id="saveSnippetToken" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-primary, #818cf8); color: var(--md-sys-color-on-primary, #fff); cursor: pointer; font-size: 14px;">
          Save & Continue
        </button>
        <button id="cancelSnippetDialog" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; font-size: 14px;">
          Cancel
        </button>
      </div>
    `;
  }

  modal.appendChild(dialog);
  document.body.appendChild(modal);

  // Event listeners
  const cancelBtn = dialog.querySelector('#cancelSnippetDialog');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => modal.remove());
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  if (snippetToken) {
    // Authenticated state event listeners
    const syncFromSnippetBtn = dialog.querySelector('#syncFromSnippet');
    if (syncFromSnippetBtn) {
      syncFromSnippetBtn.addEventListener('click', async () => {
        modal.remove();
        await syncFromSnippet();
      });
    }

    const syncToSnippetBtn = dialog.querySelector('#syncToSnippet');
    if (syncToSnippetBtn) {
      syncToSnippetBtn.addEventListener('click', async () => {
        modal.remove();
        await syncToSnippet();
      });
    }

    const createNewBtn = dialog.querySelector('#createNewSnippet');
    if (createNewBtn) {
      createNewBtn.addEventListener('click', async () => {
        modal.remove();
        await handleCreateNewSnippet();
      });
    }

    const selectExistingBtn = dialog.querySelector('#selectExistingSnippet');
    if (selectExistingBtn) {
      selectExistingBtn.addEventListener('click', async () => {
        modal.remove();
        await handleSelectExistingSnippet();
      });
    }

    const disconnectBtn = dialog.querySelector('#disconnectSnippet');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        if (confirm('Are you sure you want to disconnect and remove your GitLab token?')) {
          stopSnippetAutoSync();
          await clearSnippetToken();
          await chrome.storage.local.remove(['bmz_snippet_id']);
          snippetId = null;
          modal.remove();
          showToast('GitLab token removed');
        }
      });
    }
  } else {
    // Not authenticated state event listeners
    const saveBtn = dialog.querySelector('#saveSnippetToken');
    const tokenInput = dialog.querySelector('#gitlabTokenInput');

    if (saveBtn && tokenInput) {
      saveBtn.addEventListener('click', async () => {
        const token = tokenInput.value.trim();
        if (!token) {
          showToast('Please enter a valid token', 'error');
          return;
        }

        // Store token temporarily to validate
        snippetToken = token;

        // Validate token
        const user = await validateSnippetToken();
        if (!user) {
          snippetToken = null;
          showToast('Invalid token. Please check and try again.', 'error');
          return;
        }

        // Store token securely
        await storeSnippetToken(token);
        showToast(`Authenticated as ${user.username}`);
        updateGitLabButtonIcon();
        modal.remove();

        // Open sync options
        await openSnippetSyncDialog();
      });

      tokenInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          saveBtn.click();
        }
      });

      // Auto-focus token input
      setTimeout(() => tokenInput.focus(), 100);
    }
  }
}

// Handle creating a new Snippet with current bookmarks
async function handleCreateNewSnippet() {
  try {
    showToast('Creating Snippet with current bookmarks...');

    const chromeTree = await chrome.bookmarks.getTree();
    const snippetData = await chromeBookmarksToSnippetFormat(chromeTree);
    const newSnippetId = await createBookmarkSnippet(snippetData);

    snippetId = newSnippetId;
    await chrome.storage.local.set({ bmz_snippet_id: snippetId });
    updateGitLabButtonIcon();

    showToast('Snippet created successfully!');
  } catch (error) {
    console.error('Failed to create Snippet:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

// Handle selecting an existing Snippet
async function handleSelectExistingSnippet() {
  try {
    showToast('Loading your Snippets...');
    const snippets = await getAllSnippets();

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background: var(--md-sys-color-surface, #1e1e1e); padding: 24px; border-radius: 12px; max-width: 600px; width: 90%; max-height: 80%; overflow-y: auto; color: var(--md-sys-color-on-surface, #e0e0e0);';

    let snippetList = '<h2 style="margin: 0 0 16px 0; font-size: 20px;">Select a Snippet</h2>';

    if (snippets.length === 0) {
      snippetList += '<p style="color: var(--md-sys-color-on-surface-variant, #aaa);">No Snippets found. Create a new one instead.</p>';
    } else {
      snippetList += '<div style="display: flex; flex-direction: column; gap: 8px;">';
      snippets.forEach(snippet => {
        const isBMZ = snippet.title?.includes('BMZ') || snippet.title?.includes('Bookmark Manager Zero');
        snippetList += `
          <button class="select-snippet-btn" data-snippet-id="${snippet.id}" style="padding: 12px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline, #444); background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface, #e0e0e0); cursor: pointer; text-align: left; font-size: 13px;">
            <div style="font-weight: 500; margin-bottom: 4px;">${snippet.title || 'Untitled Snippet'} ${isBMZ ? '<span style="color: var(--md-sys-color-primary, #818cf8);">[BMZ]</span>' : ''}</div>
            <div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant, #aaa);">Visibility: ${snippet.visibility}</div>
            <div style="font-size: 10px; color: var(--md-sys-color-on-surface-variant, #888); margin-top: 4px;">ID: ${snippet.id}</div>
          </button>
        `;
      });
      snippetList += '</div>';
    }

    snippetList += `
      <button id="cancelSelectSnippet" style="margin-top: 16px; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; width: 100%;">
        Cancel
      </button>
    `;

    dialog.innerHTML = snippetList;
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Event listeners
    const selectBtns = dialog.querySelectorAll('.select-snippet-btn');
    selectBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const selectedSnippetId = btn.dataset.snippetId;
        snippetId = selectedSnippetId;
        await chrome.storage.local.set({ bmz_snippet_id: snippetId });
        updateGitLabButtonIcon();
        modal.remove();
        showToast('Snippet connected: ' + snippetId);
      });
    });

    const cancelBtn = dialog.querySelector('#cancelSelectSnippet');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => modal.remove());
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  } catch (error) {
    console.error('Failed to load Snippets:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

// Sync from Snippet to Chrome bookmarks (mirrors syncFromSnippet)
async function syncFromSnippet() {
  if (!snippetId) {
    showToast('No Snippet connected', 'error');
    return;
  }

  try {
    showToast('Checking for Snippet updates...');

    const remoteData = await readBookmarksFromSnippet(snippetId);
    const localTree = await chrome.bookmarks.getTree();

    // Convert remote snippet format to Chrome format for proper comparison
    const remoteTreeAsChromeFormat = snippetFormatToChromeBookmarks(remoteData);

    const diff = calculateBookmarkDiff(localTree[0], remoteTreeAsChromeFormat[0]);
    const hasChanges = diff.added.length + diff.removed.length + diff.moved.length + diff.modified.length > 0;

    if (!hasChanges) {
      showToast('No changes detected. Bookmarks are in sync.');
      return;
    }

    // Show diff dialog (reuse the snippet diff dialog with snippet data)
    await showSyncDiffDialog(diff, remoteData);
  } catch (error) {
    console.error('Sync from Snippet failed:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

// Sync from Chrome bookmarks to Snippet (mirrors syncToSnippet)
async function syncToSnippet() {
  if (!snippetId) {
    showToast('No Snippet connected', 'error');
    return;
  }

  try {
    showToast('Syncing to Snippet...');

    const chromeTree = await chrome.bookmarks.getTree();
    const snippetData = await chromeBookmarksToSnippetFormat(chromeTree);

    await updateBookmarksInSnippet(snippetData);

    // Update local version tracking
    snippetLocalVersion = (snippetData.version || 1);
    await chrome.storage.local.set({ snippet_local_version: snippetLocalVersion });

    showToast('Synced to Snippet successfully!');
  } catch (error) {
    console.error('Sync to Snippet failed:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

// Start auto-syncing Snippet every 10 minutes
function startSnippetAutoSync() {
  if (snippetSyncInterval) {
    clearInterval(snippetSyncInterval);
  }

  const syncInterval = 10 * 60 * 1000;

  snippetSyncInterval = setInterval(async () => {
    if (!snippetId || !snippetToken || !navigator.onLine) {
      return;
    }

    try {
      console.log('[Snippet AutoSync] Running auto-sync...');
      await syncFromSnippet();
    } catch (error) {
      console.error('[Snippet AutoSync] Auto-sync failed:', error);
    }
  }, syncInterval);

  console.log('[Snippet AutoSync] Auto-sync enabled (10-minute interval)');
}

// Stop auto-syncing Snippet
function stopSnippetAutoSync() {
  if (snippetSyncInterval) {
    clearInterval(snippetSyncInterval);
    snippetSyncInterval = null;
    console.log('[Snippet AutoSync] Auto-sync disabled');
  }
}

// Debounced push sync to Snippet (triggered by local bookmark changes)
// Waits 30 seconds after last change to batch multiple edits and avoid rate limiting
// Respects 60-second minimum between consecutive syncs
function markSnippetChanges() {
  if (!snippetId || !snippetToken || !navigator.onLine) {
    return;
  }

  if (snippetPushDebounceTimer) {
    clearTimeout(snippetPushDebounceTimer);
  }

  snippetPushDebounceTimer = setTimeout(async () => {
    const now = Date.now();
    const timeSinceLastSync = now - snippetLastSyncTime;

    if (timeSinceLastSync < snippetMinSyncInterval) {
      const delayMs = snippetMinSyncInterval - timeSinceLastSync;
      console.log('[SnippetPushSync] Rate limit: waiting', delayMs, 'ms before next sync');
      snippetPushDebounceTimer = setTimeout(markSnippetChanges, delayMs);
      return;
    }

    try {
      console.log('[SnippetPushSync] Syncing local changes to Snippet...');
      await syncToSnippet();
    } catch (error) {
      console.error('[SnippetPushSync] Failed to sync:', error);
      // Retry after 5 seconds
      setTimeout(() => {
        if (snippetId && snippetToken && navigator.onLine) {
          console.log('[SnippetPushSync] Retrying sync after 5 seconds...');
          syncToSnippet().catch(err => {
            console.error('[SnippetPushSync] Retry failed:', err);
          });
        }
      }, 5000);
    }
  }, 30000); // Wait 30 seconds after last change to batch multiple edits
}

// Show GitLab disconnect dialog
function updateGitLabButtonIcon() {
  const gitlabBtnIcon = document.getElementById('gitlabBtnIcon');
  if (!gitlabBtnIcon) return;

  if (snippetToken && snippetId) {
    gitlabBtnIcon.innerHTML = '<path d="M13 3H6c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h7v-2H6V5h7V3zm5.6 5.4l-4.6-4.6-.7.7L17 8h-6v1h6l-3.7 3.7.7.7 4.6-4.6-.7-.7z"/>';
  } else {
    gitlabBtnIcon.innerHTML = '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>';
  }
}

function showGitLabDisconnectDialog() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background: var(--md-sys-color-surface, #1e1e1e); padding: 24px; border-radius: 12px; max-width: 400px; width: 90%; color: var(--md-sys-color-on-surface, #e0e0e0);';

  dialog.innerHTML = `
    <h2 style="margin: 0 0 16px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;">
      <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
        <path d="M23.6 7.2L20.2 1.4c-.4-.6-1.1-1-1.8-1-.7 0-1.4.4-1.8 1L14 7.2h-4L7.4 1.4C7 .8 6.3.4 5.6.4S4.2.8 3.8 1.4L.4 7.2c-.4.6-.4 1.4 0 2l3.4 5.8c.4.6 1.1 1 1.8 1 .7 0 1.4-.4 1.8-1L10 9.8h4l2.6 5.4c.4.6 1.1 1 1.8 1 .7 0 1.4-.4 1.8-1l3.4-5.8c.4-.6.4-1.4 0-2zm-6.8 2.6L12 4.4l-4.8 5.4h9.6z"/>
      </svg>
      GitLab Account
    </h2>
    <p style="margin: 0 0 20px 0; font-size: 14px; color: var(--md-sys-color-on-surface-variant, #aaa);">
      You are connected to GitLab. Would you like to disconnect your account?
    </p>
    <div style="display: flex; gap: 12px;">
      <button id="cancelGitLabDisconnect" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; font-size: 14px;">
        Cancel
      </button>
      <button id="confirmGitLabDisconnect" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-error, #f44336); color: var(--md-sys-color-on-error, #fff); cursor: pointer; font-size: 14px;">
        Disconnect
      </button>
    </div>
  `;

  modal.appendChild(dialog);
  document.body.appendChild(modal);

  dialog.querySelector('#cancelGitLabDisconnect').addEventListener('click', () => {
    modal.remove();
  });

  dialog.querySelector('#confirmGitLabDisconnect').addEventListener('click', async () => {
    modal.remove();
    stopSnippetAutoSync();
    await clearSnippetToken();
    await chrome.storage.local.remove(['bmz_snippet_id']);
    snippetId = null;
    updateGitLabButtonIcon();
    showToast('GitLab account disconnected');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// Calculate diff between local and remote bookmark trees
function calculateBookmarkDiff(localTree, remoteTree) {
  const diff = {
    added: [],
    removed: [],
    moved: [],
    modified: []
  };

  // Create ID maps for quick lookup
  const localMap = new Map();
  const remoteMap = new Map();

  // Recursively map all items by ID
  const mapItems = (node, map, parentPath = '') => {
    const path = parentPath ? `${parentPath}/${node.title || node.id}` : (node.title || node.id);
    map.set(node.id, { node, path, parentId: node.parentId || null });
    if (node.children) {
      node.children.forEach(child => mapItems(child, map, path));
    }
  };

  // Map local tree (Chrome bookmark structure)
  if (localTree && localTree.children) {
    localTree.children.forEach(root => mapItems(root, localMap));
  }

  // Map remote tree (Snippet structure with roots OR Chrome structure with children)
  if (remoteTree) {
    if (remoteTree.roots) {
      Object.values(remoteTree.roots).forEach(root => {
        if (root) mapItems(root, remoteMap);
      });
    } else if (remoteTree.children) {
      remoteTree.children.forEach(root => mapItems(root, remoteMap));
    }
  }

  // Find added (in remote but not in local)
  remoteMap.forEach((remoteItem, id) => {
    if (!localMap.has(id)) {
      diff.added.push({
        id: remoteItem.node.id,
        title: remoteItem.node.title,
        path: remoteItem.path,
        type: remoteItem.node.type || (remoteItem.node.url ? 'bookmark' : 'folder'),
        url: remoteItem.node.url
      });
    }
  });

  // Find removed (in local but not in remote)
  localMap.forEach((localItem, id) => {
    if (!remoteMap.has(id)) {
      diff.removed.push({
        id: localItem.node.id,
        title: localItem.node.title,
        path: localItem.path,
        type: localItem.node.url ? 'bookmark' : 'folder',
        url: localItem.node.url
      });
    }
  });

  // Find moved/modified (in both but different)
  localMap.forEach((localItem, id) => {
    const remoteItem = remoteMap.get(id);
    if (remoteItem) {
      const localNode = localItem.node;
      const remoteNode = remoteItem.node;

      // Check if moved (different parent)
      if (localItem.parentId !== remoteItem.parentId) {
        diff.moved.push({
          id,
          title: localNode.title,
          from: localItem.path,
          to: remoteItem.path,
          type: localNode.url ? 'bookmark' : 'folder'
        });
      }

      // Check if modified (different title or URL), ignoring case-only title differences
      const titleDiffers = localNode.title?.toLowerCase() !== remoteNode.title?.toLowerCase();
      const urlDiffers = localNode.url !== remoteNode.url;
      if (titleDiffers || urlDiffers) {
        diff.modified.push({
          id,
          oldTitle: localNode.title,
          newTitle: remoteNode.title,
          oldUrl: localNode.url,
          newUrl: remoteNode.url,
          path: remoteItem.path,
          type: localNode.url ? 'bookmark' : 'folder'
        });
      }
    }
  });

  return diff;
}

// Convert Snippet format to Chrome bookmarks structure
function snippetFormatToChromeBookmarks(snippetData) {
  const convertNode = (node, parentId = null) => {
    if (node.type === 'bookmark' || node.url) {
      return {
        id: node.id,
        title: node.title,
        url: node.url,
        parentId: parentId,
        dateAdded: node.dateAdded || Date.now()
      };
    } else {
      // Folder
      const folder = {
        id: node.id,
        title: node.title || node.name || 'Unnamed Folder',
        parentId: parentId,
        dateAdded: node.dateAdded || Date.now(),
        children: []
      };
      if (node.children && node.children.length > 0) {
        folder.children = node.children.map(child => convertNode(child, node.id));
      }
      return folder;
    }
  };

  // Convert roots back to Chrome structure
  const chromeRoots = [];
  if (snippetData.roots) {
    if (snippetData.roots.bookmark_bar) {
      chromeRoots.push(convertNode({ ...snippetData.roots.bookmark_bar, id: '1' }, '0'));
    }

    // Merge "menu" and "other" folders into Chrome's "Other Bookmarks" (ID='2')
    // Chrome doesn't have a separate "Bookmarks Menu" folder like Firefox
    const otherFolder = {
      id: '2',
      title: 'Other Bookmarks',
      name: 'Other Bookmarks',
      type: 'folder',
      dateAdded: Date.now(),
      children: []
    };

    // Add "Other Bookmarks" children first
    if (snippetData.roots.other && snippetData.roots.other.children) {
      otherFolder.children.push(...snippetData.roots.other.children);
    }

    // Add "Bookmarks Menu" children in a subfolder to keep them organized
    if (snippetData.roots.menu && snippetData.roots.menu.children && snippetData.roots.menu.children.length > 0) {
      otherFolder.children.push({
        id: 'menu_imported',
        title: 'Bookmarks Menu (imported)',
        name: 'Bookmarks Menu (imported)',
        type: 'folder',
        dateAdded: Date.now(),
        children: snippetData.roots.menu.children
      });
    }

    chromeRoots.push(convertNode(otherFolder, '0'));

    if (snippetData.roots.mobile) {
      chromeRoots.push(convertNode({ ...snippetData.roots.mobile, id: '3' }, '0'));
    }
  }

  return [{
    id: '0',
    title: '',
    children: chromeRoots
  }];
}

// Apply remote changes to local Chrome bookmarks
async function applyRemoteChangesToChrome(remoteSnippetData) {
  // This is a DESTRUCTIVE operation - it will override local bookmarks
  // Show double confirmation dialog
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 10000; display: flex; align-items: center; justify-content: center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background: var(--md-sys-color-error-container, #3b1a1a); padding: 24px; border-radius: 12px; max-width: 500px; width: 90%; color: var(--md-sys-color-on-error-container, #f9dedc); border: 2px solid var(--md-sys-color-error, #f44336);';

    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; color: var(--md-sys-color-error, #f44336);">
        ⚠️ WARNING: This Will Override Your Native Browser Bookmarks
      </h2>
      <p style="margin: 0 0 16px 0; font-size: 14px;">
        This action will <strong>permanently replace</strong> your current Chrome bookmarks with the data from the Snippet.
      </p>
      <p style="margin: 0 0 20px 0; font-size: 14px; font-weight: 500;">
        Are you absolutely sure you want to proceed?
      </p>
      <div style="display: flex; gap: 12px;">
        <button id="cancelOverride" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface, #1e1e1e); color: var(--md-sys-color-on-surface, #e0e0e0); cursor: pointer; font-size: 14px;">
          Cancel
        </button>
        <button id="confirmOverride" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-error, #f44336); color: var(--md-sys-color-on-error, #fff); cursor: pointer; font-size: 14px; font-weight: 500;">
          Yes, Override My Bookmarks
        </button>
      </div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    dialog.querySelector('#cancelOverride').addEventListener('click', () => {
      modal.remove();
      resolve(false);
    });

    dialog.querySelector('#confirmOverride').addEventListener('click', async () => {
      modal.remove();

      // Second confirmation
      const confirmed = confirm(
        'FINAL CONFIRMATION: This will permanently delete all your current Chrome bookmarks and replace them with the Snippet data. This cannot be undone. Click OK to proceed.'
      );

      if (!confirmed) {
        resolve(false);
        return;
      }

      try {
        showToast('Syncing from Snippet... This may take a moment.');

        // Get current bookmark tree
        const currentTree = await chrome.bookmarks.getTree();

        // Remove all existing bookmarks (except roots)
        if (currentTree[0] && currentTree[0].children) {
          for (const root of currentTree[0].children) {
            if (root.children) {
              for (const child of root.children) {
                await chrome.bookmarks.removeTree(child.id);
              }
            }
          }
        }

        // Add new bookmarks from Snippet
        const createNodes = async (nodes, parentId) => {
          for (const node of nodes) {
            if (node.url) {
              // Create bookmark
              await chrome.bookmarks.create({
                parentId: parentId,
                title: node.title,
                url: node.url
              });
            } else if (node.children) {
              // Create folder
              const newFolder = await chrome.bookmarks.create({
                parentId: parentId,
                title: node.title
              });
              await createNodes(node.children, newFolder.id);
            }
          }
        };

        // Recreate bookmark structure from Snippet
        if (remoteSnippetData.roots) {
          if (remoteSnippetData.roots.bookmark_bar && remoteSnippetData.roots.bookmark_bar.children) {
            await createNodes(remoteSnippetData.roots.bookmark_bar.children, '1');
          }

          // Create "Other Bookmarks" folder (ID='2')
          if (remoteSnippetData.roots.other && remoteSnippetData.roots.other.children) {
            await createNodes(remoteSnippetData.roots.other.children, '2');
          }

          // Import "Bookmarks Menu" into "Other Bookmarks" as a subfolder
          // Chrome doesn't have a native "Bookmarks Menu" folder like Firefox
          if (remoteSnippetData.roots.menu && remoteSnippetData.roots.menu.children && remoteSnippetData.roots.menu.children.length > 0) {
            const menuFolder = await chrome.bookmarks.create({
              parentId: '2',
              title: 'Bookmarks Menu (imported)'
            });
            await createNodes(remoteSnippetData.roots.menu.children, menuFolder.id);
          }

          if (remoteSnippetData.roots.mobile && remoteSnippetData.roots.mobile.children) {
            await createNodes(remoteSnippetData.roots.mobile.children, '3');
          }
        }

        // Update local version tracking
        snippetLocalVersion = remoteSnippetData.version || 1;
        await chrome.storage.local.set({ snippet_local_version: snippetLocalVersion });

        showToast('Bookmarks synced successfully!');
        resolve(true);

        // Reload the bookmark view
        await loadBookmarks();
        renderBookmarks();
      } catch (error) {
        console.error('Failed to apply remote changes:', error);
        showToast(`Error: ${error.message}`, 'error');
        resolve(false);
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
        resolve(false);
      }
    });
  });
}

// Show sync diff dialog
async function showSyncDiffDialog(diff, remoteSnippetData) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background: var(--md-sys-color-surface, #1e1e1e); padding: 24px; border-radius: 12px; max-width: 700px; width: 90%; max-height: 80%; overflow-y: auto; color: var(--md-sys-color-on-surface, #e0e0e0);';

  const hasChanges = diff.added.length + diff.removed.length + diff.moved.length + diff.modified.length > 0;

  let content = '<h2 style="margin: 0 0 16px 0; font-size: 20px;">Snippet Sync Changes</h2>';

  if (!hasChanges) {
    content += '<p style="color: var(--md-sys-color-on-surface-variant, #aaa);">No changes detected. Your local bookmarks match the Snippet.</p>';
  } else {
    // Summary
    content += '<div style="margin-bottom: 20px; padding: 16px; background: var(--md-sys-color-surface-variant, #2a2a2a); border-radius: 8px;">';
    content += '<h3 style="margin: 0 0 12px 0; font-size: 16px;">Summary</h3>';
    if (diff.added.length > 0) content += `<div style="margin-bottom: 4px; color: #4caf50;">✓ ${diff.added.length} item(s) to add</div>`;
    if (diff.removed.length > 0) content += `<div style="margin-bottom: 4px; color: #f44336;">✗ ${diff.removed.length} item(s) to remove</div>`;
    if (diff.moved.length > 0) content += `<div style="margin-bottom: 4px; color: #ff9800;">➜ ${diff.moved.length} item(s) to move</div>`;
    if (diff.modified.length > 0) content += `<div style="color: #2196f3;">✎ ${diff.modified.length} item(s) to modify</div>`;
    content += '</div>';

    // Detailed changes
    if (diff.added.length > 0) {
      content += '<div style="margin-bottom: 20px;"><h3 style="margin: 0 0 12px 0; font-size: 16px; color: #4caf50;">Added</h3>';
      diff.added.forEach(item => {
        content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(76, 175, 80, 0.1); border-left: 3px solid #4caf50; border-radius: 4px;">
          <div style="font-weight: 500;">${item.title || 'Untitled'}</div>
          <div style="font-size: 12px; color: #aaa;">${item.path}</div>
          ${item.url ? `<div style="font-size: 11px; color: #888; margin-top: 4px;">${item.url}</div>` : ''}
        </div>`;
      });
      content += '</div>';
    }

    if (diff.removed.length > 0) {
      content += '<div style="margin-bottom: 20px;"><h3 style="margin: 0 0 12px 0; font-size: 16px; color: #f44336;">Removed</h3>';
      diff.removed.forEach(item => {
        content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(244, 67, 54, 0.1); border-left: 3px solid #f44336; border-radius: 4px;">
          <div style="font-weight: 500;">${item.title || 'Untitled'}</div>
          <div style="font-size: 12px; color: #aaa;">${item.path}</div>
          ${item.url ? `<div style="font-size: 11px; color: #888; margin-top: 4px;">${item.url}</div>` : ''}
        </div>`;
      });
      content += '</div>';
    }

    if (diff.moved.length > 0) {
      content += '<div style="margin-bottom: 20px;"><h3 style="margin: 0 0 12px 0; font-size: 16px; color: #ff9800;">Moved</h3>';
      diff.moved.forEach(item => {
        content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(255, 152, 0, 0.1); border-left: 3px solid #ff9800; border-radius: 4px;">
          <div style="font-weight: 500;">${item.title || 'Untitled'}</div>
          <div style="font-size: 12px; color: #aaa;">From: ${item.from}</div>
          <div style="font-size: 12px; color: #aaa;">To: ${item.to}</div>
        </div>`;
      });
      content += '</div>';
    }

    if (diff.modified.length > 0) {
      content += '<div style="margin-bottom: 20px;"><h3 style="margin: 0 0 12px 0; font-size: 16px; color: #2196f3;">Modified</h3>';
      diff.modified.forEach(item => {
        content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(33, 150, 243, 0.1); border-left: 3px solid #2196f3; border-radius: 4px;">
          <div style="font-weight: 500;">${item.oldTitle || 'Untitled'} → ${item.newTitle || 'Untitled'}</div>
          <div style="font-size: 12px; color: #aaa;">${item.path}</div>
          ${item.oldUrl !== item.newUrl ? `<div style="font-size: 11px; color: #888; margin-top: 4px;">URL: ${item.oldUrl} → ${item.newUrl}</div>` : ''}
        </div>`;
      });
      content += '</div>';
    }
  }

  content += `
    <div style="display: flex; gap: 12px; margin-top: 20px;">
      ${hasChanges ? `
        <button id="applyRemoteChanges" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-error, #f44336); color: var(--md-sys-color-on-error, #fff); cursor: pointer; font-size: 14px;">
          Apply Changes to Local Bookmarks
        </button>
      ` : ''}
      <button id="closeDiffDialog" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; font-size: 14px;">
        Close
      </button>
    </div>
  `;

  dialog.innerHTML = content;
  modal.appendChild(dialog);
  document.body.appendChild(modal);

  const applyBtn = dialog.querySelector('#applyRemoteChanges');
  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      modal.remove();
      await applyRemoteChangesToChrome(remoteSnippetData);
    });
  }

  dialog.querySelector('#closeDiffDialog').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}



// ============================================================================
// CHANGELOG UTILITIES
// ============================================================================

const MAX_CHANGELOG_ENTRIES = 1000;

async function addChangelogEntry(type, itemType, title, url = null, details = {}) {
  try {
    const result = await chrome.storage.local.get('changelogEntries');
    let changelogEntries = result.changelogEntries || [];

    const entry = {
      id: Date.now(),
      type, // 'create', 'update', 'move', 'delete'
      itemType, // 'bookmark', 'folder'
      timestamp: Date.now(),
      title,
      url,
      details
    };

    changelogEntries.unshift(entry);

    if (changelogEntries.length > MAX_CHANGELOG_ENTRIES) {
      changelogEntries = changelogEntries.slice(0, MAX_CHANGELOG_ENTRIES);
    }

    await chrome.storage.local.set({ changelogEntries });
  } catch (error) {
    console.error('[Changelog] Failed to add entry:', error);
  }
}

async function getFolderPath(itemId) {
  try {
    const parents = [];
    let currentId = itemId;

    while (currentId) {
      const items = await chrome.bookmarks.get(currentId);
      if (!items || items.length === 0) break;

      const item = items[0];
      if (!item.parentId) break;

      const parentItems = await chrome.bookmarks.get(item.parentId);
      if (!parentItems || parentItems.length === 0) break;

      const parent = parentItems[0];
      if (!parent.title) break;

      parents.unshift(parent.title);
      currentId = parent.parentId;
    }

    return parents.join(' > ') || 'Root';
  } catch (error) {
    return 'Unknown';
  }
}

async function getChangelogEntries() {
  try {
    const result = await chrome.storage.local.get('changelogEntries');
    return result.changelogEntries || [];
  } catch (error) {
    console.error('[Changelog] Failed to get entries:', error);
    return [];
  }
}

async function clearChangelog() {
  try {
    await chrome.storage.local.set({ changelogEntries: [] });
  } catch (error) {
    console.error('[Changelog] Failed to clear entries:', error);
  }
}

// Focus trap utility for modal accessibility
let previouslyFocusedElement = null;
let focusTrapListener = null;

function trapFocus(modal) {
  // Store the element that had focus before modal opened
  previouslyFocusedElement = document.activeElement;

  // Get all focusable elements in modal
  const getFocusableElements = () => {
    return Array.from(modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
    ));
  };

  // Focus first element
  const focusableElements = getFocusableElements();
  if (focusableElements.length > 0) {
    focusableElements[0].focus();
  }

  // Remove previous listener if exists
  if (focusTrapListener) {
    document.removeEventListener('keydown', focusTrapListener);
  }

  // Add focus trap listener
  focusTrapListener = (e) => {
    if (e.key !== 'Tab') return;

    const focusableElements = getFocusableElements();
    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      // Shift + Tab: moving backwards
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      }
    } else {
      // Tab: moving forwards
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  };

  document.addEventListener('keydown', focusTrapListener);
}

function releaseFocusTrap() {
  // Remove focus trap listener
  if (focusTrapListener) {
    document.removeEventListener('keydown', focusTrapListener);
    focusTrapListener = null;
  }

  // Restore focus to previously focused element
  if (previouslyFocusedElement && previouslyFocusedElement.focus) {
    previouslyFocusedElement.focus();
    previouslyFocusedElement = null;
  }
}

// Check if running in preview mode (no extension API available)
// Check for chrome.bookmarks which is only available in extensions with bookmarks permission
const isPreviewMode = !chrome?.bookmarks;

// State
let bookmarkTree = [];
let searchTerm = '';
let activeFilters = [];
let expandedFolders = new Set();
let folderScanTimestamps = {}; // Track when each folder was last scanned
const FOLDER_SCAN_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
let theme = 'enhanced-blue';
let viewMode = 'list';
let displayOptions = {
  title: true,
  url: true,
  liveStatus: true,
  safetyStatus: true,
  preview: true,
  favicon: true
};
let currentEditItem = null;
let zoomLevel = 80;
let fontSize = 100; // Font size for bookmark/folder text (70-150%)
let guiScale = 100; // GUI scale for header/toolbar/menus
let checkedBookmarks = new Set(); // Track which bookmarks have been checked to prevent infinite loops
let scanCancelled = false; // Flag to cancel ongoing scans
let linkCheckingEnabled = true; // Toggle for link checking
let safetyCheckingEnabled = true; // Toggle for safety checking
let whitelistedUrls = new Set(); // URLs whitelisted by user
let safetyHistory = {}; // Track safety status changes over time {url: [{timestamp, status, sources}]}
let selectedBookmarkIndex = -1; // Currently selected bookmark for keyboard navigation
let visibleBookmarks = []; // Flat list of visible bookmarks for keyboard navigation
let multiSelectMode = false; // Toggle for multi-select mode
let selectedItems = new Set(); // IDs of selected bookmarks/folders

// ============================================================================
// CENTRALIZED STATUS MANAGEMENT
// ============================================================================

// Track active operations to prevent race conditions
let activeOperations = new Set(); // Set of active operation IDs
let operationDetails = new Map(); // Map of operation ID to details

// Centralized function to set scanning status
function setScanningStatus(operationId, message) {
  activeOperations.add(operationId);
  operationDetails.set(operationId, message);

  // Update UI
  if (scanStatusBar) scanStatusBar.classList.add('scanning');
  if (scanProgress) scanProgress.textContent = message;

  console.log(`[Status] Started: ${operationId} - "${message}"`);
}

// Centralized function to clear scanning status for a specific operation
function clearScanningStatus(operationId) {
  if (activeOperations.has(operationId)) {
    activeOperations.delete(operationId);
    operationDetails.delete(operationId);

    console.log(`[Status] Completed: ${operationId}`);

    // Update UI immediately after clearing operation
    updateStatusBar();

    console.log(`[Status] ${activeOperations.size} operations remaining`);
  }
}

// Separate function to update status bar UI
function updateStatusBar() {
  if (activeOperations.size === 0) {
    // No active operations - reset to "Ready"
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    if (scanProgress) scanProgress.textContent = 'Ready';
    console.log(`[Status] All operations complete - Status reset to "Ready"`);
  } else {
    // Show the most recent active operation
    if (scanStatusBar) scanStatusBar.classList.add('scanning');
    const remainingOps = Array.from(activeOperations);
    const currentOp = remainingOps[remainingOps.length - 1]; // Show the most recent
    const currentMessage = operationDetails.get(currentOp);
    if (scanProgress) scanProgress.textContent = currentMessage;
    console.log(`[Status] ${remainingOps.length} operations still active - Current: "${currentMessage}"`);
  }
}

// Enhanced function to ensure status bar is properly reset when all operations complete
function ensureStatusBarReady() {
  // Check if there are any active operations
  if (activeOperations.size === 0) {
    // Force reset to "Ready" state
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    if (scanProgress) scanProgress.textContent = 'Ready';
    console.log(`[Status] Forced reset to "Ready" state`);
  }
}

// Track open menus to preserve state across re-renders
let openMenuBookmarkId = null;

// Track which bookmarks have loaded previews (persists across re-renders)
let loadedPreviews = new Set();

// Undo system state
let undoData = null;
let undoTimer = null;
let undoCountdown = null;

// DOM Elements
const bookmarkList = document.getElementById('bookmarkList');
const searchInput = document.getElementById('searchInput');
const filterToggle = document.getElementById('filterToggle');
const filterBar = document.getElementById('filterBar');
const displayToggle = document.getElementById('displayToggle');
const displayBar = document.getElementById('displayBar');
const qrCodeBtn = document.getElementById('qrCodeBtn');
const themeBtn = document.getElementById('themeBtn');
const headerCollapseBtn = document.getElementById('headerCollapseBtn');
const collapsibleHeader = document.getElementById('collapsibleHeader');
const themeMenu = document.getElementById('themeMenu');
const viewBtn = document.getElementById('viewBtn');
const viewMenu = document.getElementById('viewMenu');
const zoomBtn = document.getElementById('zoomBtn');
const zoomMenu = document.getElementById('zoomMenu');
const zoomSlider = document.getElementById('zoomSlider');
const zoomValue = document.getElementById('zoomValue');
const fontSizeSlider = document.getElementById('fontSizeSlider');
const fontSizeValue = document.getElementById('fontSizeValue');
const gitlabBtn = document.getElementById('gitlabBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const openInTabBtn = document.getElementById('openInTabBtn');
const exportBookmarksBtn = document.getElementById('exportBookmarksBtn');
const viewChangelogBtn = document.getElementById('viewChangelogBtn');
const clearChangelogBtn = document.getElementById('clearChangelogBtn');
const closeExtensionBtn = document.getElementById('closeExtensionBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const autoClearCacheSelect = document.getElementById('autoClearCache');
const defaultFolderSelect = document.getElementById('defaultFolderSelect');
const rescanAllBtn = document.getElementById('rescanAllBtn');
const setApiKeyBtn = document.getElementById('setApiKeyBtn');
const accentColorPicker = document.getElementById('accentColorPicker');
const doneAccentColorBtn = document.getElementById('doneAccentColor');
const resetAccentColorBtn = document.getElementById('resetAccentColor');
const containerOpacity = document.getElementById('containerOpacity');
const containerOpacityValue = document.getElementById('containerOpacityValue');
const textColorPicker = document.getElementById('textColorPicker');
const doneTextColorBtn = document.getElementById('doneTextColor');
const resetTextColor = document.getElementById('resetTextColor');
const backgroundImagePicker = document.getElementById('backgroundImagePicker');
const chooseBackgroundImageBtn = document.getElementById('chooseBackgroundImage');
const removeBackgroundImageBtn = document.getElementById('removeBackgroundImage');
const backgroundOpacitySlider = document.getElementById('backgroundOpacity');
const backgroundBlurSlider = document.getElementById('backgroundBlur');
const opacityValue = document.getElementById('opacityValue');
const blurValue = document.getElementById('blurValue');
const backgroundSizeSelect = document.getElementById('backgroundSize');
const repositionBackgroundBtn = document.getElementById('repositionBackground');
const backgroundScaleSlider = document.getElementById('backgroundScale');
const scaleValue = document.getElementById('scaleValue');
const dragModeOverlay = document.getElementById('dragModeOverlay');
const closeDragModeBtn = document.getElementById('closeDragModeBtn');
const guiScaleSelect = document.getElementById('guiScaleSelect');

// Add hover effects to Exit & Save button (CSP-compliant)
closeDragModeBtn.addEventListener('mouseover', () => {
  closeDragModeBtn.style.background = 'rgba(255, 255, 255, 0.3)';
});
closeDragModeBtn.addEventListener('mouseout', () => {
  closeDragModeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
});

// Scan status bar DOM elements
const scanStatusBar = document.getElementById('scanStatusBar');
const scanProgress = document.getElementById('scanProgress');
const totalCount = document.getElementById('totalCount');

// Undo toast DOM elements
const undoToast = document.getElementById('undoToast');
const undoMessage = document.getElementById('undoMessage');
const undoButton = document.getElementById('undoButton');
const undoCountdownEl = document.getElementById('undoCountdown');
const undoDismiss = document.getElementById('undoDismiss');

// Load folder scan timestamps from storage
async function loadFolderScanTimestamps() {
  if (isPreviewMode) return;

  try {
    const result = await chrome.storage.local.get('folderScanTimestamps');
    if (result.folderScanTimestamps) {
      folderScanTimestamps = result.folderScanTimestamps;
      console.log(`[Folder Scan Cache] Loaded timestamps for ${Object.keys(folderScanTimestamps).length} folders`);
    }
  } catch (error) {
    console.error('[Folder Scan Cache] Error loading timestamps:', error);
  }
}

// Save folder scan timestamp for a folder
async function saveFolderScanTimestamp(folderId) {
  if (isPreviewMode) return;

  try {
    folderScanTimestamps[folderId] = Date.now();
    await chrome.storage.local.set({ folderScanTimestamps });
    console.log(`[Folder Scan Cache] Saved timestamp for folder ${folderId}`);
  } catch (error) {
    console.error('[Folder Scan Cache] Error saving timestamp:', error);
  }
}

// Check if folder needs scanning (never scanned OR >7 days old)
function shouldScanFolder(folderId) {
  const lastScan = folderScanTimestamps[folderId];
  if (!lastScan) return true; // Never scanned

  const now = Date.now();
  const elapsed = now - lastScan;
  return elapsed > FOLDER_SCAN_CACHE_DURATION; // >7 days
}

// Sync UI with ongoing background scan status
async function syncBackgroundScanStatus() {
  if (isPreviewMode) return;

  try {
    const status = await chrome.runtime.sendMessage({ action: 'getBackgroundScanStatus' });

    if (status.isScanning) {
      console.log(`[Background Scan] Syncing UI - ${status.scanned}/${status.total}`);

      // Update progress text
      if (scanProgress) {
        scanProgress.textContent = `Scanning: ${status.scanned}/${status.total}`;
      }

      // Show stop button, hide rescan button
      const stopBtn = document.getElementById('stopScanBtn');
      const rescanBtn = document.getElementById('rescanAllBtn');
      if (stopBtn) stopBtn.style.display = 'flex';
      if (rescanBtn) rescanBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('Error syncing background scan status:', error);
  }
}

//// Setup listener for blocklist download and background scan progress messages from background script
function setupBlocklistProgressListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'blocklistProgress') {
      // Update status bar with download progress using centralized system
      if (message.status === 'starting') {
        setScanningStatus('blocklist-download', 'Downloading blocklists...');
      } else if (message.status === 'downloading') {
        setScanningStatus('blocklist-download', `Downloading blocklists... (${message.current}/${message.total})`);
      }
      console.log(`[Blocklist Progress] ${message.current}/${message.total}${message.sourceName ? ` - ${message.sourceName}` : ''}`);
    } else if (message.type === 'blocklistComplete') {
      // Clear blocklist download operation
      clearScanningStatus('blocklist-download');

      console.log(`[Blocklist Complete] ${message.domains.toLocaleString()} unique domains from ${message.totalEntries.toLocaleString()} entries (${message.sources} sources)`);
    }
    // Background scan messages
    else if (message.type === 'scanStarted') {
      console.log(`[Background Scan] Started - ${message.total} bookmarks`);
      setScanningStatus('background-scan', `Scanning: 0/${message.total}`);

      // Show stop button, hide rescan button
      const stopBtn = document.getElementById('stopScanBtn');
      const rescanBtn = document.getElementById('rescanAllBtn');
      if (stopBtn) stopBtn.style.display = 'flex';
      if (rescanBtn) rescanBtn.style.display = 'none';
    } else if (message.type === 'scanProgress') {
      // Update progress in status bar using centralized system
      setScanningStatus('background-scan', `Scanning: ${message.scanned}/${message.total}`);

    } else if (message.type === 'scanBatchComplete') {
      // Process a batch of results
      const results = message.results || [];
      console.log(`[Background Scan] Received batch of ${results.length} results.`);
      results.forEach(result => {
        const updates = {};
        if (result.linkStatus) {
          updates.linkStatus = result.linkStatus;
        }
        if (result.safetyStatus) {
          updates.safetyStatus = result.safetyStatus;
          updates.safetySources = result.safetySources || [];
        }
        updateBookmarkInTree(result.id, updates);
      });
      
      // Re-render after processing the batch
      renderBookmarks();

    } else if (message.type === 'scanComplete') {
      console.log(`[Background Scan] Complete - ${message.scanned}/${message.total} bookmarks scanned`);
      clearScanningStatus('background-scan');

      // Show rescan button, hide stop button
      const stopBtn = document.getElementById('stopScanBtn');
      const rescanBtn = document.getElementById('rescanAllBtn');
      if (stopBtn) stopBtn.style.display = 'none';
      if (rescanBtn) rescanBtn.style.display = 'flex';
    } else if (message.type === 'scanCancelled') {
      console.log(`[Background Scan] Cancelled - ${message.scanned}/${message.total} bookmarks scanned`);
      clearScanningStatus('background-scan');

      // Show rescan button, hide stop button
      const stopBtn = document.getElementById('stopScanBtn');
      const rescanBtn = document.getElementById('rescanAllBtn');
      if (stopBtn) stopBtn.style.display = 'none';
      if (rescanBtn) rescanBtn.style.display = 'flex';
    }
  });
}

// Initialize
async function init() {
  // Force update logo title to bypass cache
  const logoTitle = document.querySelector('.logo-title');
  const logoSubtitle = document.querySelector('.logo-subtitle');
  if (logoTitle) logoTitle.innerHTML = `Bookmark Manager Zero • <span style="color: var(--md-sys-color-primary); font-weight: 500; font-size: 11px;">v${APP_VERSION}</span>`;
  if (logoSubtitle) logoSubtitle.textContent = 'A modern interface for your native bookmarks';

  // Force update filter button icon
  const filterToggle = document.getElementById('filterToggle');
  if (filterToggle) {
    filterToggle.innerHTML = `
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
        <path d="M4.25,5.61C6.27,8.2,10,13,10,13v6c0,0.55,0.45,1,1,1h2c0.55,0,1-0.45,1-1v-6c0,0,3.72-4.8,5.74-7.39 C20.25,4.95,19.78,4,18.95,4H5.04C4.21,4,3.74,4.95,4.25,5.61z"/>
      </svg>
    `;
    filterToggle.title = 'Filters';
  }

  // Show private mode indicator if in incognito/private browsing
  showPrivateModeIndicator();

  loadTheme();
  loadView();
  loadZoom();
  loadFontSize();
  loadGuiScale();
  loadCheckingSettings();
  await loadSetupCardFlag();
  await loadWhitelist();
  await loadSafetyHistory();
  await loadFolderScanTimestamps();
  await loadAutoClearSetting();
  await loadSnippetToken();
  const snippetIdResult = await chrome.storage.local.get(['bmz_snippet_id', 'snippet_local_version', 'snippet_last_sync']);
  if (snippetIdResult.bmz_snippet_id) {
    snippetId = snippetIdResult.bmz_snippet_id;
  }
  if (snippetIdResult.snippet_local_version) {
    snippetLocalVersion = snippetIdResult.snippet_local_version;
  }
  if (snippetIdResult.snippet_last_sync) {
    snippetLastSyncTime = snippetIdResult.snippet_last_sync;
  }

  updateGitLabButtonIcon();

  await loadBookmarks();
  cleanupSafetyHistory(); // Clean up stale entries on sidebar load
  await restoreCachedBookmarkStatuses();
  populateDefaultFolderSelect();
  await expandToDefaultFolder();
  setupEventListeners();
  setupBlocklistProgressListener();
  renderBookmarks();

  // Check if background scan is in progress and sync UI
  await syncBackgroundScanStatus();

  // Automatically check bookmark statuses after initial render
  autoCheckBookmarkStatuses();
}

// Load and apply auto-clear cache setting
async function loadAutoClearSetting() {
  if (isPreviewMode) {
    return;
  }

  try {
    const result = await safeStorage.get('autoClearCacheDays');
    const autoClearDays = result.autoClearCacheDays || '7';

    // Set the select value
    if (autoClearCacheSelect) {
      autoClearCacheSelect.value = autoClearDays;
    }

    // Check if we need to run auto-clear
    if (autoClearDays !== 'never') {
      const lastClearResult = await safeStorage.get('lastCacheClear');
      const lastClear = lastClearResult.lastCacheClear || 0;
      const timeSinceLastClear = Date.now() - lastClear;
      const clearInterval = 24 * 60 * 60 * 1000; // Check once per day

      // Run auto-clear if it's been more than a day since last check
      if (timeSinceLastClear > clearInterval) {
        await clearOldCacheEntries(autoClearDays);
      }
    }
  } catch (error) {
    console.error('Error loading auto-clear setting:', error);
  }
}

// Load theme preference
function loadTheme() {
  if (isPreviewMode) {
    theme = 'enhanced-blue';
    applyTheme();
    return;
  }

  safeStorage.get('theme').then(result => {
    theme = result.theme || 'enhanced-blue';
    applyTheme();

    // Update dropdown to match loaded theme
    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      themeSelect.value = theme;
    }
  });
}

// Store current custom accent color globally
let currentCustomAccentColor = null;

// Apply custom accent color (global function so it can be called from applyTheme)
function applyCustomAccentColor(color) {
  currentCustomAccentColor = color;
  // Convert hex to RGB for variations
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  // Create lighter container color (add 80 to each channel, cap at 255)
  const containerR = Math.min(255, r + 80);
  const containerG = Math.min(255, g + 80);
  const containerB = Math.min(255, b + 80);
  const containerColor = `#${containerR.toString(16).padStart(2, '0')}${containerG.toString(16).padStart(2, '0')}${containerB.toString(16).padStart(2, '0')}`;

  // Remove existing custom accent style if it exists
  let styleTag = document.getElementById('custom-accent-style');
  if (styleTag) {
    styleTag.remove();
  }

  // Inject a style tag with higher specificity selectors
  styleTag = document.createElement('style');
  styleTag.id = 'custom-accent-style';
  styleTag.textContent = `
    /* Use @layer to ensure these rules take priority */
    @layer custom-accent {
      html:root {
        --md-sys-color-primary: ${color} !important;
        --md-sys-color-primary-container: ${containerColor} !important;
        --md-sys-color-secondary: ${color} !important;
      }
      html body.light,
      html body.blue-dark,
      html body.dark,
      html body.enhanced-blue,
      html body.enhanced-light,
      html body.enhanced-dark,
      html body.enhanced-gray,
      html body.tinted {
        --md-sys-color-primary: ${color} !important;
        --md-sys-color-primary-container: ${containerColor} !important;
        --md-sys-color-secondary: ${color} !important;
      }
      /* Directly override border-left on folder-children */
      .folder-children {
        border-left: 2px solid ${color} !important;
      }
    }
  `;
  // Append to body instead of head for later cascade position
  if (document.body) {
    document.body.appendChild(styleTag);
  } else {
    document.head.appendChild(styleTag);
  }

  // Directly update all existing .folder-children elements
  // This bypasses CSS variable resolution issues
  document.querySelectorAll('.folder-children').forEach(element => {
    element.style.setProperty('border-left-color', color, 'important');
  });
}

// Set up MutationObserver to apply custom color to new folder-children elements
if (typeof window.folderChildrenObserver === 'undefined') {
  window.folderChildrenObserver = new MutationObserver((mutations) => {
    if (!currentCustomAccentColor) return;

    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) { // Element node
          // Check if the node itself is folder-children
          if (node.classList && node.classList.contains('folder-children')) {
            node.style.setProperty('border-left-color', currentCustomAccentColor, 'important');
          }
          // Check descendants
          if (node.querySelectorAll) {
            node.querySelectorAll('.folder-children').forEach(element => {
              element.style.setProperty('border-left-color', currentCustomAccentColor, 'important');
            });
          }
        }
      });

      // Also check for class changes (when .show is added)
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const target = mutation.target;
        if (target.classList && target.classList.contains('folder-children')) {
          target.style.setProperty('border-left-color', currentCustomAccentColor, 'important');
        }
      }
    });
  });

  // Start observing
  window.folderChildrenObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
}

// Apply theme
function applyTheme() {
  // Remove all theme classes
  document.body.classList.remove('dark', 'light', 'blue-dark',
    'enhanced-blue', 'enhanced-light', 'enhanced-dark', 'enhanced-gray',
    'tinted');

  // CRITICAL FIX: Clear tint-related inline styles when switching away from tinted theme
  if (theme !== 'tinted') {
    // Remove inline style modifications from tinted theme
    document.body.style.removeProperty('--md-sys-color-surface');
    document.documentElement.style.removeProperty('--tint-hue');
    document.documentElement.style.removeProperty('--tint-saturation');
    document.documentElement.style.removeProperty('--header-background');
    document.documentElement.style.removeProperty('--footer-background');
  }

  // Add current theme class
  document.body.classList.add(theme);

  // Update tint controls visibility
  updateTintControlsVisibility();

  // Load tint settings if tinted theme
  if (theme === 'tinted') {
    loadTintSettings();
  }

  // Reapply custom accent color if one is saved
  const savedColor = localStorage.getItem('customAccentColor');
  if (savedColor) {
    applyCustomAccentColor(savedColor);
  }
}

// Update tint controls visibility
function updateTintControlsVisibility() {
  const tintControls = document.getElementById('tintControls');
  if (tintControls) {
    if (theme === 'tinted') {
      tintControls.style.display = 'block';
    } else {
      tintControls.style.display = 'none';
    }
  }
}

// Apply tint settings
function applyTintSettings(hue, saturation) {
  if (theme !== 'tinted') return;

  document.documentElement.style.setProperty('--tint-hue', hue);
  document.documentElement.style.setProperty('--tint-saturation', `${saturation}%`);

  // Calculate luminance-balanced background
  const lightness = saturation > 50 ? 65 : 70;
  const bgColor = `hsla(${hue}, ${saturation}%, ${lightness}%, 0.72)`;
  document.body.style.setProperty('--md-sys-color-surface', bgColor);

  // Update header and footer backgrounds
  const headerFooterLightness = saturation > 50 ? 70 : 75;
  const headerFooterColor = `hsla(${hue}, ${saturation}%, ${headerFooterLightness}%, 0.85)`;
  document.documentElement.style.setProperty('--header-background', headerFooterColor);
  document.documentElement.style.setProperty('--footer-background', headerFooterColor);

  // Save to storage
  if (!isPreviewMode) {
    safeStorage.set({
      tintHue: hue,
      tintSaturation: saturation
    });
  }
}

// Load tint settings
function loadTintSettings() {
  safeStorage.get(['tintHue', 'tintSaturation']).then(result => {
    const hue = result.tintHue || 220;
    const saturation = result.tintSaturation || 30;

    const hueInput = document.getElementById('tintHue');
    const saturationInput = document.getElementById('tintSaturation');
    const hueValue = document.getElementById('hueValue');
    const saturationValue = document.getElementById('saturationValue');

    if (hueInput) hueInput.value = hue;
    if (saturationInput) saturationInput.value = saturation;
    if (hueValue) hueValue.textContent = `${hue}°`;
    if (saturationValue) saturationValue.textContent = `${saturation}%`;

    applyTintSettings(hue, saturation);
  });
}

// Set theme
function setTheme(newTheme) {
  theme = newTheme;
  applyTheme();
  if (!isPreviewMode) {
    safeStorage.set({ theme });
  }
}

// Load view preference
function loadView() {
  if (isPreviewMode) {
    viewMode = 'list';
    applyView();
    return;
  }

  safeStorage.get('viewMode').then(result => {
    viewMode = result.viewMode || 'list';
    applyView();
  });
}

// Apply view
function applyView() {
  // Remove all view classes
  bookmarkList.classList.remove('grid-view', 'grid-2', 'grid-3', 'grid-4', 'grid-5', 'grid-6');

  // Add current view classes
  if (viewMode !== 'list') {
    bookmarkList.classList.add('grid-view', viewMode);
  }
}

// Set view
function setView(newView) {
  viewMode = newView;
  applyView();
  if (!isPreviewMode) {
    safeStorage.set({ viewMode });
  }
}

// Load zoom preference
function loadZoom() {
  if (isPreviewMode) {
    zoomLevel = 80;
    applyZoom();
    return;
  }

  safeStorage.get('zoomLevel').then(result => {
    zoomLevel = result.zoomLevel || 80;
    applyZoom();
    updateZoomDisplay();
    // Initialize slider progress bar
    if (zoomSlider) {
      const progress = ((zoomLevel - 50) / (200 - 50)) * 100;
      zoomSlider.style.setProperty('--zoom-progress', `${progress}%`);
    }
  });
}

// Load GUI scale preference
function loadGuiScale() {
  const savedScale = localStorage.getItem('guiScale');
  guiScale = savedScale ? parseInt(savedScale) : 100;
  applyGuiScale();
  if (guiScaleSelect) {
    guiScaleSelect.value = guiScale;
  }
}

// Apply GUI scale to header, toolbar, filters, and status bar
function applyGuiScale() {
  const scaleFactor = guiScale / 100;

  // Target elements: header, search, toolbar, filters, display options, status bar
  const header = document.querySelector('.header');
  const collapsibleHeader = document.getElementById('collapsibleHeader');
  const filterBar = document.getElementById('filterBar');
  const displayBar = document.getElementById('displayBar');
  const scanStatusBar = document.querySelector('.scan-status-bar');

  // Use CSS zoom property for proper scaling of all elements (text, spacing, borders, etc.)
  if (header) header.style.zoom = scaleFactor;
  if (collapsibleHeader) collapsibleHeader.style.zoom = scaleFactor;
  if (filterBar) filterBar.style.zoom = scaleFactor;
  if (displayBar) displayBar.style.zoom = scaleFactor;
  if (scanStatusBar) scanStatusBar.style.zoom = scaleFactor;
}

// Load checking settings from localStorage
function loadCheckingSettings() {
  const savedLinkChecking = localStorage.getItem('linkCheckingEnabled');
  const savedSafetyChecking = localStorage.getItem('safetyCheckingEnabled');

  // Default to true if not set
  linkCheckingEnabled = savedLinkChecking !== null ? savedLinkChecking === 'true' : true;
  safetyCheckingEnabled = savedSafetyChecking !== null ? savedSafetyChecking === 'true' : true;

  // Update checkbox states
  const linkCheckbox = document.getElementById('enableLinkChecking');
  const safetyCheckbox = document.getElementById('enableSafetyChecking');
  if (linkCheckbox) linkCheckbox.checked = linkCheckingEnabled;
  if (safetyCheckbox) safetyCheckbox.checked = safetyCheckingEnabled;
}

// Apply zoom
function applyZoom() {
  const zoomFactor = zoomLevel / 100;
  // Use CSS zoom instead of transform scale - it actually changes layout size
  // This prevents the gap issue that transform: scale() causes
  bookmarkList.style.zoom = zoomFactor;
  // Reset any previous transform-based zoom
  bookmarkList.style.transform = '';
  bookmarkList.style.width = '';
}

// Set zoom
function setZoom(newZoom) {
  zoomLevel = newZoom;
  applyZoom();
  updateZoomDisplay();
  if (!isPreviewMode) {
    safeStorage.set({ zoomLevel });
  }
}

// ============================================================================
// PROVIDER SWITCHING (GitLab)
// ============================================================================



// Update zoom display
function updateZoomDisplay() {
  if (zoomSlider) {
    zoomSlider.value = zoomLevel;
    // Update the slider track fill color
    const progress = ((zoomLevel - 50) / (200 - 50)) * 100;
    zoomSlider.style.setProperty('--zoom-progress', `${progress}%`);
  }
  if (zoomValue) zoomValue.textContent = `${zoomLevel}%`;
}

// Apply font size
function applyFontSize() {
  const fontSizeFactor = fontSize / 100;
  document.documentElement.style.setProperty('--font-size-scale', fontSizeFactor);
}

// Set font size
function setFontSize(newSize) {
  fontSize = newSize;
  applyFontSize();
  updateFontSizeDisplay();
  if (!isPreviewMode) {
    safeStorage.set({ fontSize });
  }
}

// Update font size display
function updateFontSizeDisplay() {
  if (fontSizeSlider) {
    fontSizeSlider.value = fontSize;
    // Update the slider track fill color
    const progress = ((fontSize - 70) / (150 - 70)) * 100;
    fontSizeSlider.style.setProperty('--zoom-progress', `${progress}%`);
  }
  if (fontSizeValue) fontSizeValue.textContent = `${fontSize}%`;
}

// Load font size preference
function loadFontSize() {
  if (isPreviewMode) {
    fontSize = 100;
    applyFontSize();
    return;
  }

  safeStorage.get('fontSize').then(result => {
    fontSize = result.fontSize || 100;
    applyFontSize();
    updateFontSizeDisplay();
  });
}
// Load bookmarks from Chrome API
async function loadBookmarks() {
  if (isPreviewMode) {
    // Use mock data for preview
    bookmarkTree = getMockBookmarks();
    return;
  }

  try {
    // Save current status data before reloading
    const statusMap = new Map();
    const saveStatuses = (nodes) => {
      nodes.forEach(node => {
        if (node.id && (node.linkStatus || node.safetyStatus)) {
          statusMap.set(node.id, {
            linkStatus: node.linkStatus,
            safetyStatus: node.safetyStatus,
            safetySources: node.safetySources
          });
        }
        if (node.children) {
          saveStatuses(node.children);
        }
      });
    };
    saveStatuses(bookmarkTree);

    const tree = await chrome.bookmarks.getTree();
    // Chrome returns root with children, we want the actual bookmark folders
    bookmarkTree = tree[0].children || [];

    // Restore status data to reloaded bookmarks
    const restoreStatuses = (nodes) => {
      return nodes.map(node => {
        const savedStatus = statusMap.get(node.id);
        if (savedStatus) {
          node = { ...node, ...savedStatus };
        }
        if (node.children) {
          node.children = restoreStatuses(node.children);
        }
        return node;
      });
    };
    bookmarkTree = restoreStatuses(bookmarkTree);

    // Clear checked bookmarks when loading fresh data
    checkedBookmarks.clear();

    // Update total bookmark count in status bar
    updateTotalBookmarkCount();
  } catch (error) {
    console.error('Error loading bookmarks:', error);
    showError('Failed to load bookmarks');
  }
}

// Helper function to validate cache entries
function isValidCache(cached) {
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  return cached && (Date.now() - cached.timestamp < CACHE_TTL);
}

// Restore cached bookmark statuses from persistent storage
async function restoreCachedBookmarkStatuses() {
  try {
    // Load both caches from storage
    const result = await safeStorage.get(['linkStatusCache', 'safetyStatusCache']);
    const linkCache = result.linkStatusCache || {};
    const safetyCache = result.safetyStatusCache || {};

    let restored = 0;

    // Recursively traverse bookmark tree
    function restoreStatuses(nodes) {
      nodes.forEach(node => {
        if (node.url) {
          // Check if URL is whitelisted (takes priority over cache)
          try {
            const hostname = new URL(node.url).hostname;
            if (whitelistedUrls.has(hostname)) {
              node.safetyStatus = 'safe';
              node.safetySources = ['Whitelisted by user'];
              node.linkStatus = node.linkStatus || 'unknown'; // Keep existing link status if present
              restored++;
            }
          } catch (e) {
            // Invalid URL, skip whitelist check
          }

          // Check link status cache (only if not already set by whitelist)
          if (!node.linkStatus) {
            const linkCached = linkCache[node.url];
            if (linkCached && isValidCache(linkCached)) {
              node.linkStatus = linkCached.result;
              restored++;
            }
          }

          // Check safety status cache (only if not whitelisted)
          if (!node.safetyStatus) {
            const safetyCached = safetyCache[node.url];
            if (safetyCached && isValidCache(safetyCached)) {
              node.safetyStatus = safetyCached.result?.status || safetyCached.result;
              node.safetySources = safetyCached.result?.sources || [];
              restored++;
            }
          }
        }

        if (node.children) {
          restoreStatuses(node.children);
        }
      });
    }

    restoreStatuses(bookmarkTree);
    console.log(`[Cache Restore] Restored ${restored} cached status indicators`);
  } catch (error) {
    console.error('[Cache Restore] Error restoring cached statuses:', error);
  }
}

// Populate default folder select dropdown
function populateDefaultFolderSelect() {
  if (!defaultFolderSelect) return;

  // Clear existing options except the root option
  defaultFolderSelect.innerHTML = '<option value="">Root (All Bookmarks)</option>';

  // Recursively collect all folders
  const folders = [];
  function collectFolders(nodes, depth = 0) {
    nodes.forEach(node => {
      if (node.children) {
        const indent = '  '.repeat(depth);
        folders.push({
          id: node.id,
          title: indent + (node.title || 'Unnamed Folder'),
          depth: depth
        });
        collectFolders(node.children, depth + 1);
      }
    });
  }

  collectFolders(bookmarkTree);

  // Add folders to select
  folders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.title;
    defaultFolderSelect.appendChild(option);
  });

  // Load saved default folder
  const savedDefaultFolder = localStorage.getItem('defaultStartFolder');
  if (savedDefaultFolder) {
    defaultFolderSelect.value = savedDefaultFolder;
  }
}

// Expand to default folder on load
async function expandToDefaultFolder() {
  const defaultFolderId = localStorage.getItem('defaultStartFolder');
  if (!defaultFolderId) return;

  // Find the path to this folder (all parent folders)
  const pathToFolder = [];
  function findPath(nodes, targetId, path = []) {
    for (const node of nodes) {
      if (node.id === targetId) {
        return [...path, node.id];
      }
      if (node.children) {
        const found = findPath(node.children, targetId, [...path, node.id]);
        if (found) return found;
      }
    }
    return null;
  }

  const path = findPath(bookmarkTree, defaultFolderId);
  if (path) {
    // Expand all folders in the path
    path.forEach(folderId => {
      expandedFolders.add(folderId);
    });
  }
}

// Update total bookmark count in status bar
function updateTotalBookmarkCount() {
  if (!totalCount) return;

  let count = 0;
  function countBookmarksRecursive(nodes) {
    if (!nodes) return;
    nodes.forEach(node => {
      if (node.url) {
        count++;
      }
      if (node.children) {
        countBookmarksRecursive(node.children);
      }
    });
  }

  countBookmarksRecursive(bookmarkTree);
  totalCount.textContent = count + ' bookmark' + (count !== 1 ? 's' : '');
}

// Scan ALL bookmarks regardless of folder expansion (used by rescan button)
async function scanAllBookmarksForced() {
  // Skip if both checking types are disabled
  if (!linkCheckingEnabled && !safetyCheckingEnabled) {
    return;
  }

  const bookmarksToCheck = [];

  // Traverse tree to find ALL bookmarks regardless of folder state or check status
  function traverseAll(nodes) {
    nodes.forEach(node => {
      // Check all bookmarks regardless of folder expansion or previous check status
      if (node.url && !checkedBookmarks.has(node.id)) {
        bookmarksToCheck.push(node);
      }
      // Always traverse children
      if (node.children) {
        traverseAll(node.children);
      }
    });
  }

  traverseAll(bookmarkTree);

  if (bookmarksToCheck.length === 0) {
    if (scanProgress) scanProgress.textContent = 'Ready';
    return;
  }

  console.log(`Rescanning ALL ${bookmarksToCheck.length} bookmarks in batches...`);

  // Mark these bookmarks as being checked
  bookmarksToCheck.forEach(item => checkedBookmarks.add(item.id));

  // Add scanning class and show stop button, hide rescan button
  if (scanStatusBar) scanStatusBar.classList.add('scanning');
  const stopBtn = document.getElementById('stopScanBtn');
  const rescanBtn = document.getElementById('rescanAllBtn');
  if (stopBtn) stopBtn.style.display = 'flex';
  if (rescanBtn) rescanBtn.style.display = 'none';

  // Process bookmarks in batches
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 300;

  // Update status bar
  const totalToScan = bookmarksToCheck.length;
  let scannedCount = 0;
  scanCancelled = false; // Reset the cancel flag
  if (scanProgress) setTimeout(() => scanProgress.textContent = `Scanning: 0/${totalToScan}`, 0);

  for (let i = 0; i < bookmarksToCheck.length; i += BATCH_SIZE) {
    if (scanCancelled) {
      console.log('Scan cancelled by user');
      break;
    }

    const batch = bookmarksToCheck.slice(i, i + BATCH_SIZE);

    // Check each bookmark in the batch in parallel
    const checkPromises = batch.map(async (node) => {
      try {
        const result = { id: node.id };

        if (linkCheckingEnabled) {
          result.linkStatus = await checkLinkStatus(node.url, true); // Bypass cache for rescan
        }

        if (safetyCheckingEnabled) {
          const safetyResult = await checkSafetyStatus(node.url, true); // Bypass cache for rescan
          result.safetyStatus = safetyResult.status;
          result.safetySources = safetyResult.sources;
        }

        return result;
      } catch (error) {
        console.error(`Error checking bookmark ${node.id} (${node.url}):`, error);
        const errorResult = { id: node.id };
        if (linkCheckingEnabled) errorResult.linkStatus = 'dead';
        if (safetyCheckingEnabled) {
          errorResult.safetyStatus = 'unknown';
          errorResult.safetySources = [];
        }
        return errorResult;
      }
    });

    const results = await Promise.all(checkPromises);

    // Update results for this batch (update data only)
    results.forEach((result) => {
      updateBookmarkInTree(result.id, {
        linkStatus: result.linkStatus,
        safetyStatus: result.safetyStatus,
        safetySources: result.safetySources || []
      });
    });

    scannedCount += results.length;
    if (scanProgress) setTimeout(() => scanProgress.textContent = `Scanning: ${scannedCount}/${totalToScan}`, 0);

    if (i + BATCH_SIZE < bookmarksToCheck.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  renderBookmarks();
  if (scanProgress) setTimeout(() => scanProgress.textContent = scanCancelled ? 'Scan stopped' : 'Scan complete', 0);
  if (scanStatusBar) scanStatusBar.classList.remove('scanning');

  // Hide stop button, show rescan button
  if (stopBtn) stopBtn.style.display = 'none';
  if (rescanBtn) rescanBtn.style.display = 'flex';

  // Clear checkedBookmarks to free memory after scan completes
  checkedBookmarks.clear();

  // Reset status to "Ready" after 2 seconds
  setTimeout(() => {
    if (scanProgress) setTimeout(() => scanProgress.textContent = 'Ready', 0);
  }, 2000);

  console.log(`Finished rescanning ${bookmarksToCheck.length} bookmarks`);
}

// Automatically check bookmark statuses for unchecked bookmarks
// Uses rate limiting to prevent browser overload
async function autoCheckBookmarkStatuses() {
  // Skip if both checking types are disabled
  if (!linkCheckingEnabled && !safetyCheckingEnabled) {
    return;
  }

  const bookmarksToCheck = [];

  // Traverse tree to find unchecked bookmarks (only in root or expanded folders)
  function traverse(nodes, parentExpanded = true) {
    nodes.forEach(node => {
      // Only check bookmarks if parent is expanded (or at root level)
      // Include bookmarks with 'unknown' status (e.g., after rescan)
      if (parentExpanded && node.url && (!node.linkStatus || node.linkStatus === 'unknown') && !checkedBookmarks.has(node.id)) {
        bookmarksToCheck.push(node);
      }
      // For folders, only traverse children if folder is expanded
      if (node.children) {
        const isFolderExpanded = expandedFolders.has(node.id);
        traverse(node.children, isFolderExpanded);
      }
    });
  }

  traverse(bookmarkTree, true);

  if (bookmarksToCheck.length === 0) return;

  // Update status bar to show scanning using centralized system
  const totalToScan = bookmarksToCheck.length;
  setScanningStatus('auto-check', `Scanning: 0/${totalToScan}`);

  // Mark these bookmarks as being checked to prevent re-checking
  bookmarksToCheck.forEach(item => checkedBookmarks.add(item.id));

  // Process bookmarks in batches to prevent browser overload
  const BATCH_SIZE = 10; // Check 10 bookmarks at a time
  const BATCH_DELAY = 1000; // 1 second delay between batches
  let scannedCount = 0;

  for (let i = 0; i < bookmarksToCheck.length; i += BATCH_SIZE) {
    // Check if scan was cancelled
    if (scanCancelled) {
      return;
    }

    const batch = bookmarksToCheck.slice(i, i + BATCH_SIZE);

    // Set batch to checking status (update data only, don't render yet)
    batch.forEach(item => {
      const updates = {};
      if (linkCheckingEnabled) updates.linkStatus = 'checking';
      if (safetyCheckingEnabled) updates.safetyStatus = 'checking';
      updateBookmarkInTree(item.id, updates);
    });

    // Check this batch - conditionally check link status and/or safety based on settings
    const checkPromises = batch.map(async (item) => {
      try {
        const result = { id: item.id };

        if (linkCheckingEnabled) {
          result.linkStatus = await checkLinkStatus(item.url);
        }

        if (safetyCheckingEnabled) {
          const safetyResult = await checkSafetyStatus(item.url);
          result.safetyStatus = safetyResult.status;
          result.safetySources = safetyResult.sources;
        }

        return result;
      } catch (error) {
        console.error(`Error checking bookmark ${item.id} (${item.url}):`, error);
        const errorResult = { id: item.id };
        if (linkCheckingEnabled) errorResult.linkStatus = 'dead';
        if (safetyCheckingEnabled) {
          errorResult.safetyStatus = 'unknown';
          errorResult.safetySources = [];
        }
        return errorResult;
      }
    });

    const results = await Promise.all(checkPromises);

    // Update results for this batch (update data only, don't render yet)
    results.forEach(result => {
      updateBookmarkInTree(result.id, {
        linkStatus: result.linkStatus,
        safetyStatus: result.safetyStatus,
        safetySources: result.safetySources
      });
    });

    // Update progress in status bar
    scannedCount += batch.length;
    if (scanProgress) setTimeout(() => scanProgress.textContent = 'Scanning: ' + scannedCount + '/' + totalToScan, 0);

    // Wait before processing next batch (except for the last batch)
    if (i + BATCH_SIZE < bookmarksToCheck.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  // Render once at the end of all batches
  renderBookmarks();

  // Update status bar to show completion
  if (scanProgress) setTimeout(() => scanProgress.textContent = 'Ready', 0);
  if (scanStatusBar) scanStatusBar.classList.remove('scanning');

  // Clear checkedBookmarks to free memory after scan completes
  checkedBookmarks.clear();

}

// Mock bookmark data for preview mode
function getMockBookmarks() {
  return [
    {
      id: '1',
      title: 'Bookmarks Toolbar',
      type: 'folder',
      children: [
        {
          id: '2',
          title: 'GitHub',
          url: 'https://github.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '3',
          title: 'Stack Overflow',
          url: 'https://stackoverflow.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        }
      ]
    },
    {
      id: '4',
      title: 'Development',
      type: 'folder',
      children: [
        {
          id: '5',
          title: 'MDN Web Docs',
          url: 'https://developer.mozilla.org',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '6',
          title: 'CSS Tricks',
          url: 'https://css-tricks.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '7',
          title: 'Can I Use',
          url: 'https://caniuse.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '8',
          title: 'JavaScript Info',
          url: 'https://javascript.info',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        }
      ]
    },
    {
      id: '9',
      title: 'News & Media',
      type: 'folder',
      children: [
        {
          id: '10',
          title: 'Hacker News',
          url: 'https://news.ycombinator.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '11',
          title: 'The Verge',
          url: 'https://theverge.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '20',
          title: 'GitHub (Duplicate)',
          url: 'https://github.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '21',
          title: 'Google Search',
          url: 'https://www.google.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        }
      ]
    },
    {
      id: '12',
      title: 'Design Resources',
      type: 'folder',
      children: [
        {
          id: '13',
          title: 'Dribbble',
          url: 'https://dribbble.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '14',
          title: 'Figma',
          url: 'https://figma.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '15',
          title: 'Material Design',
          url: 'https://material.io',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '22',
          title: 'MDN Docs (Duplicate)',
          url: 'https://developer.mozilla.org',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '23',
          title: 'Google',
          url: 'https://www.google.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        }
      ]
    },
    {
      id: '24',
      title: 'Favorites',
      type: 'folder',
      children: [
        {
          id: '25',
          title: 'GitHub - My Favorite',
          url: 'https://github.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '26',
          title: 'Google Homepage',
          url: 'https://www.google.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        },
        {
          id: '27',
          title: 'Stack Overflow Q&A',
          url: 'https://stackoverflow.com',
          type: 'bookmark',
          linkStatus: 'live',
          safetyStatus: 'safe'
        }
      ]
    },
    {
      id: '16',
      title: 'Suspicious Site Example',
      url: 'https://suspicious-example.com',
      type: 'bookmark',
      linkStatus: 'live',
      safetyStatus: 'warning'
    },
    {
      id: '17',
      title: 'Dead Link Example',
      url: 'https://dead-link-example-404.com',
      type: 'bookmark',
      linkStatus: 'dead',
      safetyStatus: 'unknown'
    },
    {
      id: '18',
      title: 'Parked Domain Example',
      url: 'https://parked-domain-example.com',
      type: 'bookmark',
      linkStatus: 'parked',
      safetyStatus: 'unknown'
    },
    {
      id: '19',
      title: 'Malicious Site Example',
      url: 'https://dangerous-example.com',
      type: 'bookmark',
      linkStatus: 'live',
      safetyStatus: 'unsafe'
    }
  ];
}

/**
 * Open a URL using the most appropriate method based on the URL scheme.
 * For privileged schemes (about:, chrome:, chrome-extension:, etc.), use anchor click.
 * For regular HTTP(S) URLs, use browser tab APIs for better control.
 */
async function openBookmarkUrl(url, openInNewTab = false) {
  try {
    const urlObj = new URL(url);
    const scheme = urlObj.protocol.replace(':', '').toLowerCase();

    // List of privileged schemes that Chrome blocks from extensions
    const blockedSchemes = ['chrome', 'chrome-extension'];

    if (blockedSchemes.includes(scheme)) {
      // Chrome security blocks extensions from opening chrome:// URLs
      // Copy to clipboard and notify user
      try {
        await navigator.clipboard.writeText(url);
        alert(`Chrome security prevents extensions from opening ${scheme}: URLs.\n\nThe URL has been copied to your clipboard:\n${url}\n\nPlease paste it into the address bar manually.`);
      } catch (clipboardError) {
        alert(`Chrome security prevents extensions from opening ${scheme}: URLs.\n\nPlease copy and paste this URL manually:\n${url}`);
      }
      return;
    }

    // List of other privileged schemes that may work with window.open
    const privilegedSchemes = ['about', 'view-source', 'jar', 'resource'];

    if (privilegedSchemes.includes(scheme)) {
      // Try window.open for other privileged URLs
      window.open(url, '_blank');
    } else {
      // Use browser APIs for regular URLs (better control)
      if (openInNewTab) {
        chrome.tabs.create({ url: url });
      } else {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, { url: url });
        } else {
          chrome.tabs.create({ url: url });
        }
      }
    }
  } catch (error) {
    console.error('Failed to open URL:', url, error);
    // Fallback: try window.open anyway
    try {
      window.open(url, '_blank');
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      alert(`Unable to open URL: ${url}\n\nPlease copy and paste it into the address bar manually.`);
    }
  }
}

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

// Render bookmarks
function renderBookmarks() {
  // Update total bookmark count in status bar
  updateTotalBookmarkCount();

  const filtered = filterAndSearchBookmarks(bookmarkTree);

  if (filtered.length === 0) {
    bookmarkList.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-on-surface-variant);">
        <div style="font-size: 48px; margin-bottom: 12px; opacity: 0.5;">🔍</div>
        <div style="font-size: 14px;">No bookmarks found</div>
      </div>
    `;
    return;
  }

  bookmarkList.innerHTML = '';

  // Show first-time setup card if user hasn't seen it
  if (!hasSeenSetupCard) {
    const setupCard = document.createElement('div');
    setupCard.className = 'setup-card';
    setupCard.innerHTML = `
      <div class="setup-card-header">🎆 Welcome to Bookmark Manager Zero! 🎆</div>
      <div class="setup-card-subheader">Your bookmarks are already here!</div>
      <button class="setup-card-scan-btn" id="setupScanBtn">🔍 Scan All Bookmarks Now</button>
      <div class="setup-card-info">
        Bookmarks auto-scan when you expand folders (every 7 days). Progress appears in the status bar below.
        You'll be alerted if safe bookmarks turn malicious.
      </div>
      <div class="setup-card-disclaimer">
        <strong>Note:</strong> Scanning relies on community-submitted threat lists and automated link validation.
        This may produce false positive/negative results. Use Bookmark Manager Zero as a helpful safety tool,
        not a security guarantee.
      </div>
      <button class="setup-card-dismiss-btn" id="setupDismissBtn">Got it, don't show this again</button>
    `;
    bookmarkList.appendChild(setupCard);

    // Add event listeners
    setTimeout(() => {
      const scanBtn = document.getElementById('setupScanBtn');
      const dismissBtn = document.getElementById('setupDismissBtn');

      if (scanBtn) {
        scanBtn.addEventListener('click', async () => {
          await dismissSetupCard();
          // Trigger full scan directly
          await rescanAllBookmarks();
        });
      }

      if (dismissBtn) {
        dismissBtn.addEventListener('click', dismissSetupCard);
      }
    }, 0);
  }

  renderNodes(filtered, bookmarkList);

  // Restore open menu state if menu was open before re-render
  if (openMenuBookmarkId) {
    // Use setTimeout to ensure DOM is fully rendered
    setTimeout(() => {
      const bookmarkDiv = document.querySelector(`[data-bookmark-id="${openMenuBookmarkId}"], [data-folder-id="${openMenuBookmarkId}"]`);
      if (bookmarkDiv) {
        const menu = bookmarkDiv.querySelector('.bookmark-actions');
        if (menu) {
          menu.classList.add('show');
        }
      }
    }, 0);
  }

  // Add a drop zone at the end of the root to allow dropping items there
  const dropZone = document.createElement('div');
  dropZone.className = 'root-drop-zone';
  dropZone.dataset.id = 'root-end';
  dropZone.style.minHeight = '40px';
  dropZone.style.marginTop = '12px';

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropZone.classList.add('drop-active');
  });

  dropZone.addEventListener('dragleave', (e) => {
    // Only remove class if we're actually leaving the drop zone
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drop-active');
    }
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drop-active');

    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDropToRoot(draggedId);
  });

  bookmarkList.appendChild(dropZone);
}

// Create a drop zone element that fills the gap between items
function createDropZone(parentId, targetIndex) {
  const dropZone = document.createElement('div');
  dropZone.className = 'inter-item-drop-zone';
  dropZone.dataset.parentId = parentId;
  dropZone.dataset.targetIndex = targetIndex;

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    dropZone.classList.add('drop-zone-active');
  });

  dropZone.addEventListener('dragleave', (e) => {
    // Only remove class if we're actually leaving the drop zone, not moving to a child
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drop-zone-active');
    }
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drop-zone-active');

    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDropToPosition(draggedId, parentId, targetIndex);
  });

  return dropZone;
}

// Recursively render bookmark nodes with drop zones between them
function renderNodes(nodes, container, parentId = '0') {
  const isRootLevel = (parentId === '0');

  nodes.forEach((node, index) => {
    // Add the actual item
    if (node.children) {
      container.appendChild(createFolderElement(node));
    } else if (node.url) {
      container.appendChild(createBookmarkElement(node));
    }

    // Add a drop zone after this item
    // For root level: Don't add after the last item (root-drop-zone handles that)
    // For folders: Always add drop zone after each item for consistent spacing
    const isLastItem = (index === nodes.length - 1);
    if (!isLastItem || !isRootLevel) {
      const dropZone = createDropZone(parentId, index + 1);
      container.appendChild(dropZone);
    }
  });
}

// Get status icon HTML based on link status
function getStatusDotHtml(linkStatus, url) {
  // Check if privileged URL
  const privilegedInfo = isPrivilegedUrl(url);
  if (privilegedInfo && linkStatus === 'live') {
    const privilegedTooltip = `Link Status: ${privilegedInfo.label}\n\nThis is a ${privilegedInfo.label.toLowerCase()}`;
    const escapedTooltip = privilegedTooltip.replace(/"/g, '&quot;');
    return `
      <span class="status-icon status-live clickable-status" title="${escapedTooltip}" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `;
  }

  const tooltips = {
    'live': 'Link Status: Live\n\n✓ Link is live and accessible\n✓ Returns successful HTTP response',
    'dead': 'Link Status: Dead\n\n✗ Link is dead or unreachable\n✗ Error, timeout, or connection failed',
    'parked': 'Link Status: Parked\n\n⚠ Domain is parked\n⚠ Redirects to domain parking service',
    'checking': 'Link Status: Checking\n\nChecking link status...',
    'unknown': 'Link Status: Unknown\n\nStatus has not been checked yet'
  };

  const tooltip = tooltips[linkStatus] || tooltips['unknown'];
  const escapedTooltip = tooltip.replace(/"/g, '&quot;');

  const statusIcons = {
    'live': `
      <span class="status-icon status-live clickable-status" title="Link is live and accessible
Returns successful HTTP response" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `,
    'dead': `
      <span class="status-icon status-dead clickable-status" title="Link is dead or unreachable
Error, timeout, or connection failed" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `,
    'parked': `
      <span class="status-icon status-parked clickable-status" title="Domain is parked
Redirects to domain parking service" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" viewBox="0 0 24 24">
          <g fill="currentColor">
            <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
          </g>
          <g fill="#eab308">
            <circle cx="18" cy="6" r="5"/>
            <text x="18" y="9.5" text-anchor="middle" font-size="10" font-weight="bold" fill="white">!</text>
          </g>
        </svg>
      </span>
    `,
    'checking': `
      <span class="status-icon status-checking clickable-status" title="Checking link status..." data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `,
    'unknown': `
      <span class="status-icon status-unknown clickable-status" title="Status unknown" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `
  };

  return statusIcons[linkStatus] || statusIcons['unknown'];
}

// Get shield indicator HTML based on safety status
function getShieldHtml(safetyStatus, url, safetySources = []) {
  const encodedUrl = encodeURIComponent(url);

  // Check if privileged URL
  const privilegedInfo = isPrivilegedUrl(url);
  if (privilegedInfo && safetyStatus === 'safe') {
    // Check if sources indicate this is privileged
    const isPrivilegedSource = safetySources && safetySources.length > 0 &&
                                safetySources[0].includes('not scanned');
    if (isPrivilegedSource) {
      const privilegedMessage = `Security Check: ${privilegedInfo.label}\n\n✓ ${privilegedInfo.label}\n✓ Not scanned (trusted browser page)`;
      const escapedMessage = privilegedMessage.replace(/"/g, '&quot;');
      return `
        <span class="shield-indicator shield-safe clickable-status" title="${escapedMessage}" data-url="${encodedUrl}" data-status-message="${escapedMessage}">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1Z"/>
          </svg>
        </span>
      `;
    }
  }

  // Check if bookmark is whitelisted
  const isWhitelisted = safetySources && safetySources.includes('Whitelisted by user');

  // Build sources text for unsafe tooltip
  const sourcesText = safetySources && safetySources.length > 0
    ? `\n⛔ Detected by: ${safetySources.join(', ')}`
    : '';

  // Build warning text from actual sources
  const warningText = safetySources && safetySources.length > 0
    ? safetySources.map(source => `⚠ ${source}`).join('\n')
    : '⚠ Suspicious pattern detected';

  // Build full messages for click popup
  const messages = {
    'safe': 'Security Check: Safe\n\n✓ Not found in malware databases\n✓ Passed URLhaus + BlockList checks',
    'whitelisted': 'Security Check: Whitelisted\n\n✓ Manually trusted by user\n✓ Bypasses security checks',
    'warning': `Security Check: Warning\n\n${warningText}`,
    'unsafe': `Security Check: UNSAFE\n\n⛔ Malicious domain detected!${sourcesText}\n⛔ DO NOT VISIT - Exercise extreme caution!`,
    'checking': 'Security Check: Analyzing\n\nChecking URL security patterns...',
    'unknown': 'Security Check: Unknown\n\nUnable to determine safety status\nNot in whitelist or blacklist'
  };

  const message = isWhitelisted ? messages['whitelisted'] : (messages[safetyStatus] || messages['unknown']);
  const escapedMessage = message.replace(/"/g, '&quot;');

  const shieldSvgs = {
    'safe': `
      <span class="shield-indicator shield-safe clickable-status" title="Security Check: Safe
✓ Not found in malware databases
✓ Passed URLhaus + BlockList checks" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.18L16.59,7.59L18,9L10,17Z"/>
        </svg>
      </span>
    `,
    'whitelisted': `
      <span class="shield-indicator shield-whitelisted clickable-status" title="Security Check: Whitelisted
✓ Manually trusted by user
✓ Bypasses security checks" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.18L16.59,7.59L18,9L10,17Z"/>
        </svg>
      </span>
    `,
    'warning': `
      <span class="shield-indicator shield-warning clickable-status" title="Security Check: Warning
${warningText}" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M13,7H11V13H13V7M13,17H11V15H13V17Z"/>
        </svg>
      </span>
    `,
    'unsafe': `
      <span class="shield-indicator shield-unsafe clickable-status" title="Security Check: UNSAFE
⛔ Malicious domain detected!${sourcesText}
⛔ DO NOT VISIT - Exercise extreme caution!" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7C13.1,7 14,7.9 14,9V10.5L15.5,10.5C16.3,10.5 17,11.2 17,12V16C17,16.8 16.3,17.5 15.5,17.5H8.5C7.7,17.5 7,16.8 7,16V12C7,11.2 7.7,10.5 8.5,10.5H10V9C10,7.9 10.9,7 12,7M12,8.2C11.2,8.2 10.8,8.7 10.8,9V10.5H13.2V9C13.2,8.7 12.8,8.2 12,8.2Z"/>
        </svg>
      </span>
    `,
    'checking': `
      <span class="shield-indicator shield-scanning clickable-status" title="Security Check: Analyzing
Checking URL security patterns..." data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1Z"/>
        </svg>
      </span>
    `,
    'unknown': `
      <span class="shield-indicator shield-unknown clickable-status" title="Security Check: Unknown
Unable to determine safety status
Not in whitelist or blacklist" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12.5,7V12.5H11V7H12.5M12.5,14V15.5H11V14H12.5Z"/>
        </svg>
      </span>
    `
  };

  return isWhitelisted ? shieldSvgs['whitelisted'] : (shieldSvgs[safetyStatus] || shieldSvgs['unknown']);
}

// Create folder element
function createFolderElement(folder) {
  const folderDiv = document.createElement('div');
  folderDiv.className = 'folder-item';
  folderDiv.dataset.id = folder.id;
  // Don't make the entire folderDiv draggable - only the header will be draggable

  const isExpanded = expandedFolders.has(folder.id);
  const childCount = countBookmarks(folder);

  const folderTitle = folder.title || 'Unnamed Folder';

  folderDiv.innerHTML = `
    <div class="folder-header" draggable="true" role="button" aria-expanded="${isExpanded}" aria-label="${escapeHtml(folderTitle)} folder with ${childCount} items">
      ${multiSelectMode ? `<input type="checkbox" class="item-checkbox" data-id="${folder.id}" ${selectedItems.has(folder.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(folderTitle)} folder">` : ''}
      <div class="folder-toggle ${isExpanded ? 'expanded' : ''}" aria-hidden="true"></div>
      <div class="folder-icon-container" aria-hidden="true">
        <svg class="folder-icon-outline" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 7C3 5.89543 3.89543 5 5 5H9L11 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
        </svg>
        <div class="folder-count" data-digits="${childCount.toString().length}">${childCount}</div>
      </div>
      <div class="folder-title">${escapeHtml(folderTitle)}</div>
      <button class="bookmark-menu-btn folder-menu-btn" aria-label="More actions for ${escapeHtml(folderTitle)} folder" aria-haspopup="true" aria-expanded="false">⋮</button>
      <div class="bookmark-actions">
        <button class="action-btn" data-action="rescan-folder">
          <span class="icon">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/>
            </svg>
          </span>
          <span>Rescan Bookmarks in Folder</span>
        </button>
        <button class="action-btn" data-action="add-bookmark">
          <span class="icon">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
            </svg>
          </span>
          <span>Add Bookmark Here</span>
        </button>
        <button class="action-btn" data-action="add-subfolder">
          <span class="icon">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
              <path d="M13,19V13H19V11H13V5H11V11H5V13H11V19H13M20,18H22V20H2V18H4V10A2,2 0 0,1 6,8H10V6A2,2 0 0,1 12,4H16A2,2 0 0,1 18,6V8H20A2,2 0 0,1 22,10V18M18,10H6V18H18V10M16,6H12V8H16V6Z"/>
            </svg>
          </span>
          <span>Add Subfolder Here</span>
        </button>
        <button class="action-btn" data-action="rename">
          <span class="icon">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
            </svg>
          </span>
          <span>Rename</span>
        </button>
        <button class="action-btn danger" data-action="delete">
          <span class="icon">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
            </svg>
          </span>
          <span>Delete</span>
        </button>
      </div>
    </div>
    <div class="folder-children ${isExpanded ? 'show' : ''}" style="border-left: 2px solid #818cf8 !important;"></div>
  `;

  // Add click handler for folder toggle
  const header = folderDiv.querySelector('.folder-header');
  const menuBtn = header.querySelector('.folder-menu-btn');
  const actionsMenu = header.querySelector('.bookmark-actions');

  header.addEventListener('click', (e) => {
    // Don't toggle if clicking menu button, menu items, or checkbox
    if (e.target.closest('.folder-menu-btn') ||
        e.target.closest('.bookmark-actions') ||
        e.target.closest('.item-checkbox')) {
      return;
    }
    // In multi-select mode, don't toggle folder
    if (multiSelectMode) {
      return;
    }
    toggleFolder(folder.id, folderDiv);
  });

  // Add menu button handler
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFolderMenu(folderDiv);
  });

  // Add right-click context menu support for folder
  folderDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFolderMenu(folderDiv);
  });

  // Add action button handlers
  actionsMenu.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      await handleFolderAction(action, folder);
      closeAllMenus();
    });
  });

  // Drag and drop handlers for folders (attach to header, not entire folderDiv)
  header.addEventListener('dragstart', (e) => {
    e.stopPropagation(); // Prevent event from bubbling to parent folders
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', folder.id);
    e.dataTransfer.setData('itemType', 'folder');
    folderDiv.style.opacity = '0.5';
  });

  header.addEventListener('dragend', () => {
    folderDiv.style.opacity = '1';
    removeAllDropIndicators();
  });

  // Attach dragover/drop to header only, not entire folderDiv
  // This prevents intercepting drag events for bookmarks/subfolders within this folder
  header.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation(); // Don't let this bubble to parent folders
    e.dataTransfer.dropEffect = 'move';
    handleDragOver(e, folderDiv);
  });

  header.addEventListener('dragleave', (e) => {
    if (!header.contains(e.relatedTarget)) {
      removeDropIndicator(folderDiv);
    }
  });

  header.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Read drop state BEFORE clearing indicators
    const dropBefore = folderDiv.classList.contains('drop-before');
    const dropAfter = folderDiv.classList.contains('drop-after');
    const dropInto = folderDiv.classList.contains('drop-into');

    removeAllDropIndicators();

    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDrop(draggedId, folder.id, folderDiv, { dropBefore, dropAfter, dropInto });
  });

  // Render children if expanded
  if (isExpanded && folder.children) {
    const childContainer = folderDiv.querySelector('.folder-children');
    renderNodes(folder.children, childContainer, folder.id);
  }

  return folderDiv;
}

// Create bookmark element
function createBookmarkElement(bookmark) {
  const bookmarkDiv = document.createElement('div');
  bookmarkDiv.className = 'bookmark-item';
  if (!displayOptions.preview) {
    bookmarkDiv.classList.add('no-preview');
  }
  bookmarkDiv.dataset.id = bookmark.id;
  bookmarkDiv.draggable = true;

  // Get link status (default to unknown)
  const linkStatus = bookmark.linkStatus || 'unknown';
  const safetyStatus = bookmark.safetyStatus || 'unknown';
  const safetySources = bookmark.safetySources || [];

  // Build status indicators HTML based on display options
  let statusIndicatorsHtml = '';
  if (displayOptions.safetyStatus) {
    statusIndicatorsHtml += getShieldHtml(safetyStatus, bookmark.url, safetySources);
  }
  if (displayOptions.liveStatus) {
    statusIndicatorsHtml += getStatusDotHtml(linkStatus, bookmark.url);
  }

  // Also build separate shield and chainlink for grid view
  let shieldHtml = '';
  if (displayOptions.safetyStatus) {
    shieldHtml = getShieldHtml(safetyStatus, bookmark.url, safetySources);
  }

  let linkStatusHtml = '';
  if (displayOptions.liveStatus) {
    linkStatusHtml = getStatusDotHtml(linkStatus, bookmark.url);
  }

  // Build favicon HTML based on display options
  let faviconHtml = '';
  if (displayOptions.favicon && bookmark.url) {
    const faviconUrl = getFaviconUrl(bookmark.url);
    if (faviconUrl) {
      faviconHtml = `<img class="bookmark-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.style.display='none'" />`;
    }
  }

  // Build bookmark info HTML based on display options
  let bookmarkInfoHtml = '';
  if (displayOptions.title) {
    bookmarkInfoHtml += `<div class="bookmark-title" title="${escapeHtml(bookmark.url)}">${escapeHtml(bookmark.title || bookmark.url)}</div>`;
  }
  if (displayOptions.url) {
    bookmarkInfoHtml += `<div class="bookmark-url" title="${escapeHtml(bookmark.url)}">${escapeHtml(new URL(bookmark.url).hostname)}</div>`;
  }

  const bookmarkTitle = bookmark.title || bookmark.url;

  bookmarkDiv.innerHTML = `
    ${multiSelectMode ? `<input type="checkbox" class="item-checkbox" data-id="${bookmark.id}" ${selectedItems.has(bookmark.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(bookmarkTitle)}">` : ''}
    <div class="status-indicators">
      ${statusIndicatorsHtml}
    </div>
    ${faviconHtml}
    <div class="bookmark-top-row">
      ${shieldHtml}
      ${faviconHtml}
      ${linkStatusHtml}
    </div>
    <div class="bookmark-info">
      ${bookmarkInfoHtml}
    </div>
    <button class="bookmark-menu-btn" aria-label="More actions for ${escapeHtml(bookmarkTitle)}" aria-haspopup="true" aria-expanded="false">⋮</button>
    <div class="bookmark-actions">
      <button class="action-btn" data-action="open">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
          </svg>
        </span>
        <span>Open</span>
      </button>
      <button class="action-btn" data-action="open-new-tab">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z"/>
          </svg>
        </span>
        <span>Open in New Tab</span>
      </button>
      <button class="action-btn" data-action="open-new-window">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19,19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M13.96,12.29L11.21,15.83L9.25,13.47L6.5,17H17.5L13.96,12.29Z"/>
          </svg>
        </span>
        <span>Open in New Window</span>
      </button>
      <button class="action-btn" data-action="reader-view">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M21,4H3A2,2 0 0,0 1,6V19A2,2 0 0,0 3,21H21A2,2 0 0,0 23,19V6A2,2 0 0,0 21,4M3,19V6H11V19H3M21,19H13V6H21V19M14,9.5H20V11H14V9.5M14,12H20V13.5H14V12M14,14.5H20V16H14V14.5Z"/>
          </svg>
        </span>
        <span>Open with Textise</span>
      </button>
      <button class="action-btn" data-action="save-pdf">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20M10.1,11.4C10.08,11.44 9.81,13.16 8,16.09C8,16.09 4.5,17.91 5.33,19.27C6,20.35 7.65,19.23 9.07,16.59C9.07,16.59 10.89,15.95 13.31,15.77C13.31,15.77 17.17,17.5 17.7,15.66C18.22,13.8 14.64,14.22 14,14.41C14,14.41 12,13.06 11.5,11.2C11.5,11.2 12.64,7.25 10.89,7.3C9.14,7.35 9.8,10.43 10.1,11.4M10.91,12.44C10.94,12.45 11.38,13.65 12.8,14.9C12.8,14.9 10.47,15.36 9.41,15.8C9.41,15.8 10.41,14.07 10.91,12.44M14.84,15.16C15.42,15 17,14.91 16.88,15.45C16.78,15.97 14.88,15.23 14.84,15.16M10.58,10.34C10.58,10.34 9.7,8.24 10.38,8.23C11.07,8.22 10.88,10.05 10.58,10.34Z"/>
          </svg>
        </span>
        <span>Save Page as PDF</span>
      </button>
      <button class="action-btn" data-action="recheck">
        <span class="icon">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </span>
        <span>Recheck Security Status</span>
      </button>
      <button class="action-btn" data-action="whitelist">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.17L16.59,7.58L18,9L10,17Z"/>
          </svg>
        </span>
        <span>Whitelist (Trust Site)</span>
      </button>
      <button class="action-btn" data-action="virustotal">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A3,3 0 0,1 15,8A3,3 0 0,1 12,11A3,3 0 0,1 9,8A3,3 0 0,1 12,5M17.13,17C15.92,18.85 14.11,20.24 12,20.92C9.89,20.24 8.08,18.85 6.87,17C6.53,16.5 6.24,16 6,15.47C6,13.82 8.71,12.47 12,12.47C15.29,12.47 18,13.79 18,15.47C17.76,16 17.47,16.5 17.13,17Z"/>
          </svg>
        </span>
        <span>Check on VirusTotal</span>
      </button>
      <button class="action-btn" data-action="qr-code">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3,11H11V3H3M5,5H9V9H5M13,3V11H21V3M19,9H15V5H19M3,21H11V13H3M5,15H9V19H5M19,19V21H21V19M13,13H15V15H13M15,15H17V17H15M17,17H19V19H17M19,13V15H21V13M13,21H15V19H13M15,19H17V21H15Z"/>
          </svg>
        </span>
        <span>Generate QR Code</span>
      </button>
      <button class="action-btn" data-action="wayback-save">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/>
          </svg>
        </span>
        <span>Save to Wayback Machine</span>
      </button>
      <button class="action-btn" data-action="wayback-browse">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M16.59,7.58L10,14.17L7.41,11.59L6,13L10,17L18,9L16.59,7.58Z"/>
          </svg>
        </span>
        <span>Browse Wayback Snapshots</span>
      </button>
      <button class="action-btn" data-action="copy-url">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/>
          </svg>
        </span>
        <span>Copy URL</span>
      </button>
      <button class="action-btn" data-action="edit">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
          </svg>
        </span>
        <span>Edit</span>
      </button>
      <button class="action-btn danger" data-action="delete">
        <span class="icon">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
          </svg>
        </span>
        <span>Delete</span>
      </button>
    </div>
    <div class="bookmark-preview-container">
      <div class="preview-loading">Loading...</div>
      <img class="preview-image" alt="Preview" data-url="${escapeHtml(bookmark.url)}" />
    </div>
  `;

  // Add click handler for bookmark (open in current tab)
  bookmarkDiv.addEventListener('click', (e) => {
    // Don't open if clicking on menu, actions, preview, status indicators, or checkbox
    if (e.target.closest('.bookmark-menu-btn') ||
        e.target.closest('.bookmark-actions') ||
        e.target.closest('.bookmark-preview-container') ||
        e.target.closest('.status-indicators') ||
        e.target.closest('.bookmark-top-row') ||
        e.target.closest('.item-checkbox')) {
      return;
    }
    // Don't open if in multi-select mode
    if (multiSelectMode) {
      return;
    }
    // Open in active tab
    if (isPreviewMode) {
      openBookmarkUrl(bookmark.url, true);
    } else {
      openBookmarkUrl(bookmark.url, false);
    }
  });

  // Add menu toggle handler
  const menuBtn = bookmarkDiv.querySelector('.bookmark-menu-btn');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookmarkMenu(bookmarkDiv);
  });

  // Add right-click context menu support
  bookmarkDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleBookmarkMenu(bookmarkDiv);
  });

  // Add action handlers
  const actions = bookmarkDiv.querySelectorAll('.action-btn');
  actions.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleBookmarkAction(btn.dataset.action, bookmark);
      closeAllMenus();
    });
  });

  // Drag and drop handlers
  bookmarkDiv.addEventListener('dragstart', (e) => {
    e.stopPropagation(); // Prevent event from bubbling to parent folders
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', bookmark.id);
    e.dataTransfer.setData('itemType', 'bookmark');
    bookmarkDiv.style.opacity = '0.5';
  });

  bookmarkDiv.addEventListener('dragend', () => {
    bookmarkDiv.style.opacity = '1';
    removeAllDropIndicators();
  });

  bookmarkDiv.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation(); // Don't let this bubble to parent folder header
    e.dataTransfer.dropEffect = 'move';
    handleDragOver(e, bookmarkDiv);
  });

  bookmarkDiv.addEventListener('dragleave', (e) => {
    if (!bookmarkDiv.contains(e.relatedTarget)) {
      removeDropIndicator(bookmarkDiv);
    }
  });

  bookmarkDiv.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Read drop state BEFORE clearing indicators
    const dropBefore = bookmarkDiv.classList.contains('drop-before');
    const dropAfter = bookmarkDiv.classList.contains('drop-after');

    removeAllDropIndicators();

    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDrop(draggedId, bookmark.id, bookmarkDiv, { dropBefore, dropAfter, dropInto: false });
  });

  // Preview hover handler - load image on first hover (only if preview is enabled)
  if (displayOptions.preview) {
    const previewContainer = bookmarkDiv.querySelector('.bookmark-preview-container');
    const previewImage = bookmarkDiv.querySelector('.preview-image');
    const previewLoading = bookmarkDiv.querySelector('.preview-loading');

    // Check if preview was already loaded using global state
    // Always use URL as the key for consistency
    const previewKey = bookmark.url;
    const previewAlreadyLoaded = loadedPreviews.has(previewKey);

    // If preview was already loaded, set the image src immediately
    if (previewAlreadyLoaded && bookmark.url) {
      const previewUrl = getPreviewUrl(bookmark.url);
      if (previewUrl) {
        previewImage.src = previewUrl;
        previewImage.classList.add('loaded');
        previewLoading.style.display = 'none';
      }
    }

    // Prevent all interactions with preview (clicks, drags, context menu)
    previewContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    previewContainer.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    previewContainer.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    previewImage.addEventListener('dragstart', (e) => {
      e.preventDefault();
    });

    // Preview popup on hover
    previewImage.addEventListener('mouseenter', (e) => {
      showPreviewPopup(previewImage, e);
    });

    previewImage.addEventListener('mouseleave', () => {
      hidePreviewPopup();
    });

    bookmarkDiv.addEventListener('mouseenter', () => {
      if (!loadedPreviews.has(previewKey) && bookmark.url) {
        const previewUrl = getPreviewUrl(bookmark.url);

        if (previewUrl) {
          previewLoading.style.display = 'flex';
          previewLoading.textContent = 'Loading...';

          previewImage.onload = () => {
            previewLoading.style.display = 'none';
            previewImage.classList.add('loaded');
            loadedPreviews.add(previewKey); // Mark as loaded in global state
          };

          previewImage.onerror = () => {
            previewLoading.textContent = 'No preview';
            loadedPreviews.add(previewKey); // Mark as loaded even on error
          };

          previewImage.src = previewUrl;
        } else {
          previewLoading.textContent = 'No preview';
          loadedPreviews.add(previewKey); // Mark as loaded
        }
      }
    });
  }

  return bookmarkDiv;
}

// Get preview URL for a bookmark
function getPreviewUrl(url) {
  // Using WordPress mshots service (same as React webapp)
  try {
    const encodedUrl = encodeURIComponent(url);
    return `https://s.wordpress.com/mshots/v1/${encodedUrl}?w=320&h=180`;
  } catch (error) {
    console.error('Error generating preview URL:', error);
    return '';
  }
}

// Preview popup handling
let previewPopup = null;
let previewPopupEnabled = true; // Will be loaded from settings

// Create preview popup element
function createPreviewPopup() {
  if (!previewPopup) {
    previewPopup = document.createElement('div');
    previewPopup.className = 'preview-popup';
    previewPopup.innerHTML = '<img alt="Preview" />';
    document.body.appendChild(previewPopup);
  }
  return previewPopup;
}

// Show preview popup
function showPreviewPopup(previewImage, mouseEvent) {
  if (!previewPopupEnabled || !previewImage.classList.contains('loaded')) {
    return;
  }

  const popup = createPreviewPopup();
  const popupImg = popup.querySelector('img');

  // Get the bookmark URL from the preview image's data attribute
  const bookmarkUrl = previewImage.dataset.url;

  // Load high-quality preview (800x600 instead of 320x180)
  try {
    const encodedUrl = encodeURIComponent(bookmarkUrl);
    popupImg.src = `https://s.wordpress.com/mshots/v1/${encodedUrl}?w=800&h=600`;
  } catch (error) {
    console.error('Error loading high-quality preview:', error);
    popupImg.src = previewImage.src; // Fallback to low-res
  }

  // Position the popup with smart positioning
  const sidebar = document.body;
  const sidebarRect = sidebar.getBoundingClientRect();
  const header = document.querySelector('.header');
  const statusBar = document.querySelector('.scan-status-bar');

  // Get the bookmark element that contains the preview image
  const bookmarkElement = previewImage.closest('.bookmark-item, .folder-item');
  const bookmarkRect = bookmarkElement ? bookmarkElement.getBoundingClientRect() : null;

  // Calculate available space
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const statusBarTop = statusBar ? statusBar.getBoundingClientRect().top : sidebarRect.bottom;

  // Set max width to 90% of sidebar minus margins
  const maxWidth = sidebarRect.width * 0.9;
  popup.style.maxWidth = `${maxWidth}px`;

  // Show popup to calculate dimensions
  popup.classList.add('show');

  // Wait for image to load dimensions
  if (popupImg.complete) {
    positionPopup();
  } else {
    popupImg.onload = positionPopup;
  }

  function positionPopup() {
    const popupRect = popup.getBoundingClientRect();

    // Center horizontally in sidebar
    const left = sidebarRect.left + (sidebarRect.width - popupRect.width) / 2;

    // Position vertically - above or below bookmark to avoid covering it
    let top;
    if (bookmarkRect) {
      // Calculate space above and below the bookmark
      const spaceAbove = bookmarkRect.top - headerBottom - 20;
      const spaceBelow = statusBarTop - bookmarkRect.bottom - 20;

      // Try to position below first, then above if not enough space
      if (spaceBelow >= popupRect.height) {
        // Position below bookmark
        top = bookmarkRect.bottom + 10;
      } else if (spaceAbove >= popupRect.height) {
        // Position above bookmark
        top = bookmarkRect.top - popupRect.height - 10;
      } else {
        // Not enough space either way, use the side with more space
        if (spaceBelow > spaceAbove) {
          top = bookmarkRect.bottom + 10;
          // Might extend past status bar, but that's okay
        } else {
          top = Math.max(headerBottom + 20, bookmarkRect.top - popupRect.height - 10);
        }
      }
    } else {
      // Fallback: center on mouse position
      top = mouseEvent.clientY - popupRect.height / 2;
      const minTop = headerBottom + 20;
      const maxTop = statusBarTop - popupRect.height - 20;
      top = Math.max(minTop, Math.min(top, maxTop));
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }
}

// Hide preview popup
function hidePreviewPopup() {
  if (previewPopup) {
    previewPopup.classList.remove('show');
  }
}

// QR Code popup handling (local generation, privacy-focused)
let qrCodePopup = null;

// Create QR code popup element
function createQRCodePopup() {
  if (!qrCodePopup) {
    qrCodePopup = document.createElement('div');
    qrCodePopup.className = 'qr-popup';
    qrCodePopup.innerHTML = `
      <div class="qr-popup-content">
        <button class="qr-close-btn" aria-label="Close">&times;</button>
        <div class="qr-container"></div>
        <input type="text" class="qr-url-input" placeholder="Enter URL..." />
      </div>
    `;
    document.body.appendChild(qrCodePopup);

    // Add click handler for close button
    const closeBtn = qrCodePopup.querySelector('.qr-close-btn');
    closeBtn.addEventListener('click', hideQRCodePopup);

    // Close on backdrop click
    qrCodePopup.addEventListener('click', (e) => {
      if (e.target === qrCodePopup) {
        hideQRCodePopup();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && qrCodePopup && qrCodePopup.classList.contains('show')) {
        hideQRCodePopup();
      }
    });
  }
  return qrCodePopup;
}

// Show QR code popup with locally generated QR code
function showQRCodePopup(url) {
  const popup = createQRCodePopup();
  const qrContainer = popup.querySelector('.qr-container');
  const qrUrlInput = popup.querySelector('.qr-url-input');

  // Set the initial URL in the input
  qrUrlInput.value = url;

  // Function to generate/regenerate QR code
  function generateQR(text) {
    // Clear previous QR code
    qrContainer.innerHTML = '';

    // Generate QR code locally using qrcode-lib.js
    try {
      new QRCode(qrContainer, {
        text: text,
        width: 280,
        height: 280,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (error) {
      console.error('Error generating QR code:', error);
      qrContainer.innerHTML = '<div style="padding: 20px;">Error generating QR code</div>';
    }
  }

  // Generate initial QR code
  generateQR(url);

  // Regenerate QR code on input change
  qrUrlInput.addEventListener('input', (e) => {
    const newUrl = e.target.value;
    if (newUrl.trim()) {
      generateQR(newUrl);
    }
  });

  // Show popup
  popup.classList.add('show');
}

// Hide QR code popup
function hideQRCodePopup() {
  if (qrCodePopup) {
    qrCodePopup.classList.remove('show');
  }
}

// Load preview popup setting
async function loadPreviewPopupSetting() {
  try {
    const result = await chrome.storage.local.get(['previewPopupEnabled']);
    if (result.previewPopupEnabled !== undefined) {
      previewPopupEnabled = result.previewPopupEnabled;
      // Update checkbox state
      const checkbox = document.getElementById('displayPreviewPopup');
      if (checkbox) {
        checkbox.checked = previewPopupEnabled;
      }
    }
  } catch (error) {
    console.error('Error loading preview popup setting:', error);
  }
}

// Initialize preview popup setting
loadPreviewPopupSetting();

// Drag and drop helper functions
function handleDragOver(e, targetElement) {
  const rect = targetElement.getBoundingClientRect();
  const height = rect.height;
  const y = e.clientY - rect.top;

  // For folders, support dropping INTO them (middle third) or before/after (top/bottom thirds)
  const isFolderItem = targetElement.classList.contains('folder-item');

  removeAllDropIndicators();

  if (isFolderItem) {
    // Divide folder into three zones: top 20%, middle 60%, bottom 20%
    // Smaller before/after zones make drop-into more prominent
    if (y < height * 0.2) {
      targetElement.classList.add('drop-before');
    } else if (y > height * 0.8) {
      targetElement.classList.add('drop-after');
    } else {
      // Middle zone - drop INTO the folder
      targetElement.classList.add('drop-into');
    }
  } else {
    // For bookmarks, use 50/50 split for equal drop zones
    // Top half = drop before, bottom half = drop after
    if (y < height * 0.5) {
      targetElement.classList.add('drop-before');
    } else {
      targetElement.classList.add('drop-after');
    }
  }
}

function removeDropIndicator(element) {
  element.classList.remove('drop-before', 'drop-after', 'drop-into');
}

function removeAllDropIndicators() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(el => {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

async function handleDropToRoot(draggedId) {
  // Drop at the end of root (after all root items)
  const draggedItem = findBookmarkById(bookmarkTree, draggedId);
  if (!draggedItem) {
    console.error('Could not find dragged item');
    return;
  }

  if (isPreviewMode) {

    // Get dragged item's current position
    const draggedParent = findParentById(bookmarkTree, draggedId);

    // Remove item from its current location
    if (draggedParent) {
      draggedParent.children = draggedParent.children.filter(child => child.id !== draggedId);
    } else {
      bookmarkTree = bookmarkTree.filter(item => item.id !== draggedId);
    }

    // Add to end of root
    bookmarkTree.push(draggedItem);

    // Re-render to show the changes
    renderBookmarks();
    return;
  }

  try {
    // Get item details before moving
    const items = await chrome.bookmarks.get(draggedId);
    const item = items[0];
    const oldParentPath = item.parentId ? await getFolderPath(item.parentId) : 'Root';

    // Move to root at the last position
    await chrome.bookmarks.move(draggedId, {
      parentId: undefined,
      index: bookmarkTree.length
    });

    // Add to changelog
    const itemType = item.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, item.title, item.url || null, {
      fromFolder: oldParentPath,
      toFolder: 'Root'
    });

    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving to root:', error);
    alert('Failed to move item');
  }
}

async function handleDropToPosition(draggedId, targetParentId, targetIndex) {
  const draggedItem = findBookmarkById(bookmarkTree, draggedId);
  if (!draggedItem) {
    console.error('Could not find dragged item');
    return;
  }

  if (isPreviewMode) {

    // Get dragged item's current position
    const draggedParent = findParentById(bookmarkTree, draggedId);
    let draggedIndex = -1;

    // Remove item from its current location
    if (draggedParent) {
      draggedIndex = draggedParent.children.findIndex(child => child.id === draggedId);
      draggedParent.children = draggedParent.children.filter(child => child.id !== draggedId);
    } else {
      draggedIndex = bookmarkTree.findIndex(item => item.id === draggedId);
      bookmarkTree = bookmarkTree.filter(item => item.id !== draggedId);
    }

    // Adjust target index if moving within same parent and from earlier position
    let adjustedIndex = targetIndex;
    const isSameParent = (draggedParent?.id || '0') === targetParentId;
    if (isSameParent && draggedIndex < targetIndex) {
      adjustedIndex = targetIndex - 1;
    }

    // Insert item at the new location
    if (targetParentId === '0') {
      bookmarkTree.splice(adjustedIndex, 0, draggedItem);
    } else {
      const targetParent = findBookmarkById(bookmarkTree, targetParentId);
      if (targetParent && targetParent.children) {
        targetParent.children.splice(adjustedIndex, 0, draggedItem);
      }
    }

    // Re-render to show the changes
    renderBookmarks();
    return;
  }

  try {
    // Get item details before moving
    const items = await chrome.bookmarks.get(draggedId);
    const item = items[0];
    const oldParentPath = item.parentId ? await getFolderPath(item.parentId) : 'Root';

    await chrome.bookmarks.move(draggedId, {
      parentId: targetParentId === '0' ? undefined : targetParentId,
      index: targetIndex
    });

    // Add to changelog
    const newParentPath = targetParentId === '0' ? 'Root' : await getFolderPath(targetParentId);
    const itemType = item.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, item.title, item.url || null, {
      fromFolder: oldParentPath,
      toFolder: newParentPath
    });

    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving to position:', error);
    alert('Failed to move item');
  }
}

async function handleDrop(draggedId, targetId, targetElement, dropState) {
  if (draggedId === targetId) return; // Can't drop on itself

  try {
    // Get the position to drop (before, after, or into target)
    const dropBefore = dropState.dropBefore;
    const dropInto = dropState.dropInto;

    // Find the dragged and target items in the tree
    const draggedItem = findBookmarkById(bookmarkTree, draggedId);
    const targetItem = findBookmarkById(bookmarkTree, targetId);

    if (!draggedItem || !targetItem) {
      console.error('Could not find dragged or target item');
      return;
    }

    // Determine the parent and index based on drop type
    let targetParentId;
    let targetIndex;

    if (dropInto && targetItem.children) {
      // Dropping INTO a folder - item becomes child at index 0
      targetParentId = targetItem.id;
      targetIndex = 0;
    } else {
      // Dropping BEFORE or AFTER - item goes next to target in target's parent
      const targetParent = findParentById(bookmarkTree, targetId);
      targetParentId = targetParent ? targetParent.id : undefined;

      // Get target's index in its parent
      if (targetParent) {
        targetIndex = targetParent.children.findIndex(child => child.id === targetId);
      } else {
        targetIndex = bookmarkTree.findIndex(item => item.id === targetId);
      }

      // Calculate new index based on drop position
      targetIndex = dropBefore ? targetIndex : targetIndex + 1;
    }

    // Check if dropping a folder into itself or its descendants (prevent invalid moves)
    if (draggedItem.children && targetParentId) {
      let currentParent = findBookmarkById(bookmarkTree, targetParentId);
      while (currentParent) {
        if (currentParent.id === draggedId) {
          return;
        }
        currentParent = findParentById(bookmarkTree, currentParent.id);
      }
    }

    const newIndex = targetIndex;

    if (isPreviewMode) {
      // In preview mode, actually move the item in the mock tree
      const dropType = dropInto ? 'into' : (dropBefore ? 'before' : 'after');

      // Get dragged item's current position
      const draggedParent = findParentById(bookmarkTree, draggedId);
      const draggedParentId = draggedParent ? draggedParent.id : undefined;

      let draggedIndex;
      if (draggedParent) {
        draggedIndex = draggedParent.children.findIndex(child => child.id === draggedId);
      } else {
        draggedIndex = bookmarkTree.findIndex(item => item.id === draggedId);
      }

      // Check if moving within same parent
      const isSameParent = draggedParentId === targetParentId;

      // Adjust newIndex if moving within same parent and moving forward
      let adjustedIndex = newIndex;
      if (isSameParent && !dropInto && newIndex > draggedIndex) {
        adjustedIndex = newIndex - 1;
      }

      // Remove item from its current location
      if (draggedParent) {
        draggedParent.children = draggedParent.children.filter(child => child.id !== draggedId);
      } else {
        bookmarkTree = bookmarkTree.filter(item => item.id !== draggedId);
      }

      // Insert item at new location
      const newParent = targetParentId ? findBookmarkById(bookmarkTree, targetParentId) : null;
      if (newParent) {
        if (!newParent.children) newParent.children = [];
        newParent.children.splice(adjustedIndex, 0, draggedItem);
      } else {
        bookmarkTree.splice(adjustedIndex, 0, draggedItem);
      }

      // Re-render to show the changes
      renderBookmarks();
      return;
    }

    // Get item details before moving
    const items = await chrome.bookmarks.get(draggedId);
    const item = items[0];
    const oldParentPath = item.parentId ? await getFolderPath(item.parentId) : 'Root';

    // Move the bookmark using Chrome API
    await chrome.bookmarks.move(draggedId, {
      parentId: targetParentId,
      index: newIndex
    });

    // Add to changelog
    const newParentPath = targetParentId ? await getFolderPath(targetParentId) : 'Root';
    const itemType = item.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, item.title, item.url || null, {
      fromFolder: oldParentPath,
      toFolder: newParentPath
    });

    // Reload and re-render
    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving bookmark:', error);
    alert('Failed to move item');
  }
}
// Helper function to find parent of bookmark by ID
function findParentById(nodes, childId, parent = null) {
  for (const node of nodes) {
    if (node.id === childId) return parent;
    if (node.children) {
      const found = findParentById(node.children, childId, node);
      if (found) return found;
    }
  }
  return null;
}

// Toggle folder expanded state
function toggleFolder(folderId, folderElement) {
  const isExpanded = expandedFolders.has(folderId);

  if (isExpanded) {
    expandedFolders.delete(folderId);
  } else {
    expandedFolders.add(folderId);
    // When expanding a folder, check its bookmarks only if cache expired (>7 days) or never scanned
    if (shouldScanFolder(folderId)) {
      console.log(`[Folder Scan Cache] Folder ${folderId} needs scanning (cache expired or never scanned)`);
      setTimeout(() => {
        autoCheckBookmarkStatuses();
        // Save timestamp after successful scan
        saveFolderScanTimestamp(folderId);
      }, 100);
    } else {
      const lastScan = folderScanTimestamps[folderId];
      const daysAgo = Math.floor((Date.now() - lastScan) / (24 * 60 * 60 * 1000));
      console.log(`[Folder Scan Cache] Folder ${folderId} already scanned ${daysAgo} day(s) ago, skipping`);
    }
  }

  // Re-render to reflect changes
  renderBookmarks();
}

// Toggle bookmark menu
function toggleBookmarkMenu(bookmarkDiv) {
  const menu = bookmarkDiv.querySelector('.bookmark-actions');
  const isOpen = menu.classList.contains('show');
  const bookmarkId = bookmarkDiv.dataset.bookmarkId;

  // Close all other menus
  closeAllMenus();

  // Toggle this menu
  if (!isOpen) {
    menu.classList.add('show');
    openMenuBookmarkId = bookmarkId; // Track which menu is open

    // Reposition menu if it overflows viewport
    repositionMenuIfNeeded(menu, bookmarkDiv);
  } else {
    openMenuBookmarkId = null;
  }
}

// Toggle folder menu
function toggleFolderMenu(folderDiv) {
  const menu = folderDiv.querySelector('.bookmark-actions');
  const isOpen = menu.classList.contains('show');
  const folderId = folderDiv.dataset.folderId;

  // Close all other menus
  closeAllMenus();

  // Toggle this menu
  if (!isOpen) {
    menu.classList.add('show');
    openMenuBookmarkId = folderId; // Track which menu is open

    // Reposition menu if it overflows viewport
    repositionMenuIfNeeded(menu, folderDiv);
  } else {
    openMenuBookmarkId = null;
  }
}

// Reposition menu if it would overflow the viewport
function repositionMenuIfNeeded(menu, parentElement) {
  // Use requestAnimationFrame to ensure menu is rendered before measuring
  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const parentRect = parentElement.getBoundingClientRect();
    const menuHeight = menuRect.height;

    // Get toolbar/header height to avoid positioning menus behind it
    const header = document.querySelector('.header');
    const collapsibleHeader = document.getElementById('collapsibleHeader');
    let headerBottom = 0;
    if (header) headerBottom = header.getBoundingClientRect().bottom;
    if (collapsibleHeader) {
      const collapsibleRect = collapsibleHeader.getBoundingClientRect();
      headerBottom = Math.max(headerBottom, collapsibleRect.bottom);
    }

    // Calculate available space above and below the parent element
    // spaceAbove should exclude the header/toolbar area
    const spaceAbove = parentRect.top - headerBottom;
    const spaceBelow = viewportHeight - parentRect.bottom;

    // Reset styles
    menu.style.maxHeight = '';
    menu.style.overflowY = '';

    // Determine positioning
    let positionAbove = false;
    let needsConstraint = false;
    let constrainedHeight = 0;

    if (menuHeight <= spaceBelow) {
      // Fits below - use default positioning
      positionAbove = false;
    } else if (menuHeight <= spaceAbove) {
      // Fits above - position menu above
      positionAbove = true;
    } else if (spaceBelow >= spaceAbove) {
      // More space below - constrain height
      positionAbove = false;
      needsConstraint = true;
      constrainedHeight = Math.max(spaceBelow - 16, 100);
    } else {
      // More space above - constrain height
      positionAbove = true;
      needsConstraint = true;
      constrainedHeight = Math.max(spaceAbove - 16, 100);
    }

    // Apply positioning
    if (positionAbove) {
      menu.style.top = 'auto';
      menu.style.bottom = '100%';
      menu.style.marginTop = '0';
      menu.style.marginBottom = '4px';
    } else {
      menu.style.top = '100%';
      menu.style.bottom = 'auto';
      menu.style.marginTop = '4px';
      menu.style.marginBottom = '0';
    }

    // Apply height constraint if needed
    if (needsConstraint) {
      menu.style.maxHeight = `${constrainedHeight}px`;
      menu.style.overflowY = 'auto';
    }

    // Final safety check - ensure menu is within viewport after positioning
    requestAnimationFrame(() => {
      const finalRect = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth;

      // Check if menu extends beyond top of viewport (header area)
      if (finalRect.top < headerBottom) {
        const overflow = headerBottom - finalRect.top;
        const currentMaxHeight = parseInt(menu.style.maxHeight) || finalRect.height;
        menu.style.maxHeight = `${Math.max(currentMaxHeight - overflow - 16, 100)}px`;
        menu.style.overflowY = 'auto';
        // Also adjust top position to be below header
        if (positionAbove) {
          menu.style.top = `${headerBottom + 16}px`;
          menu.style.bottom = 'auto';
          menu.style.position = 'fixed';
        }
      }

      // Check if menu extends beyond bottom of viewport
      if (finalRect.bottom > viewportHeight) {
        const overflow = finalRect.bottom - viewportHeight;
        const currentMaxHeight = parseInt(menu.style.maxHeight) || finalRect.height;
        menu.style.maxHeight = `${Math.max(currentMaxHeight - overflow - 16, 100)}px`;
        menu.style.overflowY = 'auto';
      }

      // Check horizontal overflow - menu extends beyond right edge
      if (finalRect.right > viewportWidth - 16) {
        // Menu is too far right, align to right edge of parent
        menu.style.left = 'auto';
        menu.style.right = '0';
      }

      // Check horizontal overflow - menu extends beyond left edge
      if (finalRect.left < 16) {
        // Menu is too far left, align to left edge of parent
        menu.style.left = '0';
        menu.style.right = 'auto';
      }

      // Constrain menu width if it's wider than viewport
      if (finalRect.width > viewportWidth - 32) {
        menu.style.maxWidth = `${viewportWidth - 32}px`;
        menu.style.left = '16px';
        menu.style.right = 'auto';
      }
    });
  });
}

// Handle folder actions
async function handleFolderAction(action, folder) {
  switch (action) {
    case 'add-bookmark':
      // Open add bookmark modal with this folder pre-selected
      await openAddBookmarkModal();
      // Pre-select this folder
      const folderSelect = document.getElementById('newBookmarkFolder');
      if (folderSelect) {
        folderSelect.value = folder.id;
      }
      break;

    case 'add-subfolder':
      // Open add folder modal with this folder pre-selected as parent
      openAddFolderModal();
      // Pre-select this folder as parent
      const parentSelect = document.getElementById('newFolderParent');
      if (parentSelect) {
        parentSelect.value = folder.id;
      }
      break;

    case 'rename':
      openEditModal(folder, true);
      break;

    case 'delete':
      // SAFETY: Enhanced confirmation showing number of items to be deleted
      const itemCount = await countFolderItems(folder.id);
      const warningMessage = itemCount > 0
        ? `⚠ Delete folder "${folder.title}" and ALL ${itemCount} item(s) inside?\n\nThis action cannot be undone!`
        : `Delete empty folder "${folder.title}"?`;

      if (confirm(warningMessage)) {
        await deleteFolder(folder.id);
      }
      break;

    case 'rescan-folder':
      await rescanFolder(folder.id, folder.title);
      break;
  }
}

// SAFETY: Count total items in a folder (recursive)
async function countFolderItems(folderId) {
  if (isPreviewMode) {
    // Count items in mock data
    const folder = findFolderById(folderId, bookmarkTree);
    if (!folder || !folder.children) return 0;

    let count = 0;
    const countRecursive = (items) => {
      for (const item of items) {
        count++;
        if (item.children) {
          countRecursive(item.children);
        }
      }
    };
    countRecursive(folder.children);
    return count;
  }

  try {
    const subtree = await chrome.bookmarks.getSubTree(folderId);
    if (!subtree[0] || !subtree[0].children) return 0;

    let count = 0;
    const countRecursive = (items) => {
      for (const item of items) {
        count++;
        if (item.children) {
          countRecursive(item.children);
        }
      }
    };
    countRecursive(subtree[0].children);
    return count;
  } catch (error) {
    console.error('Error counting folder items:', error);
    return 0;
  }
}

// Helper to find folder by ID in mock data
function findFolderById(id, items) {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findFolderById(id, item.children);
      if (found) return found;
    }
  }
  return null;
}

// Delete folder
async function deleteFolder(id) {
  if (isPreviewMode) {
    // Find folder in mock data
    const findAndRemove = (items, parentArray = null, parentIndex = -1) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.id === id) {
          // Found it! Store data for undo (deep copy to preserve children)
          const folderData = JSON.parse(JSON.stringify(item));
          folderData.parentArray = parentArray;
          folderData.parentIndex = i;

          // Remove from array
          items.splice(i, 1);

          // Show undo toast
          showUndoToast({
            type: 'folder',
            data: folderData,
            message: `Folder "${item.title || 'Untitled'}" deleted`,
            isPreview: true
          });

          renderBookmarks();
          return true;
        }

        if (item.children) {
          if (findAndRemove(item.children, item.children, i)) {
            return true;
          }
        }
      }
      return false;
    };

    findAndRemove(bookmarkTree);
    return;
  }

  // SAFETY: Prevent deletion of Chrome's built-in bookmark folders
  const protectedFolderIds = ['0', '1', '2'];
  if (protectedFolderIds.includes(id)) {
    alert('⚠ Cannot delete built-in Chrome bookmark folders (Bookmarks Bar, Other Bookmarks).\n\nThis is a safety feature to protect your bookmark structure.');
    return;
  }

  try {
    // Get folder details before deleting for undo functionality
    const folderInfo = await chrome.bookmarks.getSubTree(id);
    const folder = folderInfo[0];

    // Delete the folder
    await chrome.bookmarks.removeTree(id);

    // Add to changelog
    await addChangelogEntry('delete', 'folder', folder.title || 'Untitled', null);

    // Show undo toast
    showUndoToast({
      type: 'folder',
      data: folder,
      message: `Folder "${folder.title || 'Untitled'}" deleted`
    });

    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error deleting folder:', error);
    alert('Failed to delete folder');
  }
}

// Rescan all bookmarks in a folder and its subfolders by delegating to the background service
async function rescanFolder(folderId, folderTitle) {
  try {
    console.log(`[Folder Rescan] Starting rescan for folder: ${folderTitle} (${folderId})`);

    // Get all bookmarks recursively from this folder
    const bookmarks = [];
    const collectBookmarks = async (nodeId) => {
      const nodes = await chrome.bookmarks.getChildren(nodeId);
      for (const node of nodes) {
        if (node.url) {
          bookmarks.push(node);
        } else if (!node.url) {
          // If it doesn't have a URL, it's a folder - recurse into it
          await collectBookmarks(node.id);
        }
      }
    };

    await collectBookmarks(folderId);

    if (bookmarks.length === 0) {
      alert(`Folder "${folderTitle}" contains no bookmarks to scan.`);
      return;
    }

    console.log(`[Folder Rescan] Found ${bookmarks.length} bookmark(s) in folder "${folderTitle}"`);

    // Show confirmation
    const confirmMessage = `Rescan ${bookmarks.length} bookmark(s) in "${folderTitle}" and its subfolders?\n\nThis will check link status and security for all bookmarks.`;
    if (!confirm(confirmMessage)) {
      return;
    }

    // Delegate the entire scan to the background script
    console.log(`[Folder Rescan] Delegating scan of ${bookmarks.length} bookmarks to background script.`);
    await chrome.runtime.sendMessage({
      action: 'startBackgroundScan',
      bookmarks: bookmarks,
      bypassCache: true
    });

    // The UI will now be updated by the same message listeners used for a full background scan
    // ('scanStarted', 'scanBatchComplete', 'scanProgress', 'scanComplete')

  } catch (error) {
    console.error('[Folder Rescan] Error:', error);
    alert(`Failed to rescan folder: ${error.message}`);
    // Ensure status bar is reset on error
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    if (scanProgress) scanProgress.textContent = 'Ready';
  }
}

// Undo System Functions

// Show undo toast with countdown
function showUndoToast(options) {
  // Clear any existing undo data and timers
  hideUndoToast();

  // Store the undo data
  undoData = options;

  // Update message
  undoMessage.textContent = options.message;

  // Show the toast
  undoToast.classList.remove('hidden');

  // Start countdown
  let countdown = 5;
  undoCountdownEl.textContent = countdown;

  undoCountdown = setInterval(() => {
    countdown--;
    undoCountdownEl.textContent = countdown;

    if (countdown <= 0) {
      hideUndoToast();
    }
  }, 1000);

  // Auto-hide after 5 seconds
  undoTimer = setTimeout(() => {
    hideUndoToast();
  }, 5000);
}

// Hide undo toast and clear timers
function hideUndoToast() {
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }

  if (undoCountdown) {
    clearInterval(undoCountdown);
    undoCountdown = null;
  }

  undoToast.classList.add('hidden');
  undoData = null;
}

// Undo the last deletion
async function performUndo() {
  if (!undoData) return;

  const { type, data, isPreview } = undoData;

  try {
    if (isPreview) {
      // Preview mode: restore to mock data
      if (type === 'bookmark') {
        // Restore bookmark to its parent array
        if (data.parentArray) {
          data.parentArray.splice(data.parentIndex, 0, {
            id: data.id,
            title: data.title,
            url: data.url
          });
        }
      } else if (type === 'folder') {
        // Restore folder with all children
        if (data.parentArray) {
          const folderToRestore = JSON.parse(JSON.stringify(data));
          delete folderToRestore.parentArray;
          delete folderToRestore.parentIndex;
          data.parentArray.splice(data.parentIndex, 0, folderToRestore);
        }
      }

      renderBookmarks();
      hideUndoToast();
    } else {
      // Real extension mode
      if (type === 'bookmark') {
        // Restore bookmark
        await chrome.bookmarks.create({
          title: data.title,
          url: data.url,
          parentId: data.parentId,
          index: data.index
        });
      } else if (type === 'folder') {
        // Restore folder and its contents recursively
        await restoreFolderRecursive(data, data.parentId, data.index);
      }

      // Reload and hide toast
      await loadBookmarks();
      renderBookmarks();
      hideUndoToast();

    }
  } catch (error) {
    console.error('Error during undo:', error);
    alert('Failed to undo deletion');
    hideUndoToast();
  }
}

// Recursively restore a folder and all its contents
async function restoreFolderRecursive(folderData, parentId, index) {
  // Create the folder
  const newFolder = await chrome.bookmarks.create({
    title: folderData.title,
    parentId: parentId,
    index: index
  });

  // Restore children if any
  if (folderData.children && folderData.children.length > 0) {
    for (let i = 0; i < folderData.children.length; i++) {
      const child = folderData.children[i];
      if (child.url) {
        // It's a bookmark
        await chrome.bookmarks.create({
          title: child.title,
          url: child.url,
          parentId: newFolder.id,
          index: i
        });
      } else {
        // It's a folder
        await restoreFolderRecursive(child, newFolder.id, i);
      }
    }
  }
}

// Position fixed dropdown menu relative to button
function positionFixedDropdown(dropdown, button) {
  if (!dropdown || !button) return;

  requestAnimationFrame(() => {
    const buttonRect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Reset positioning
    dropdown.style.left = '';
    dropdown.style.right = '';
    dropdown.style.top = '';
    dropdown.style.bottom = '';
    dropdown.style.maxWidth = `${viewportWidth - 32}px`;

    // Position below button, aligned to right edge of button
    let top = buttonRect.bottom + 4;
    let right = viewportWidth - buttonRect.right;

    // Check if menu would go off bottom of screen
    dropdown.style.visibility = 'hidden';
    dropdown.style.display = 'block';
    const menuHeight = dropdown.offsetHeight;
    dropdown.style.visibility = '';
    dropdown.style.display = '';

    if (top + menuHeight > viewportHeight - 16) {
      // Show above button instead
      top = buttonRect.top - menuHeight - 4;
      if (top < 16) {
        // Not enough space above either, position below button with scrolling
        // Ensure button remains visible and clickable
        top = buttonRect.bottom + 4;
        const availableHeight = viewportHeight - top - 16;
        dropdown.style.maxHeight = `${Math.max(availableHeight, 150)}px`;
        dropdown.style.overflowY = 'auto';
      }
    }

    // Apply positioning
    dropdown.style.top = `${top}px`;
    dropdown.style.right = `${right}px`;

    // Check if menu extends beyond left edge
    const menuLeft = viewportWidth - right - dropdown.offsetWidth;
    if (menuLeft < 16) {
      dropdown.style.left = '16px';
      dropdown.style.right = '16px';
    }
  });
}

// Adjust dropdown position to prevent overflow (for absolute positioned menus)
function adjustDropdownPosition(dropdown) {
  if (!dropdown) return;

  // Reset any previous adjustments
  dropdown.style.left = '';
  dropdown.style.right = '';
  dropdown.style.transform = '';
  dropdown.style.top = '';
  dropdown.style.bottom = '';
  dropdown.style.marginTop = '';
  dropdown.style.marginBottom = '';
  dropdown.style.maxWidth = '';

  // Wait for next frame to ensure menu is visible and has dimensions
  requestAnimationFrame(() => {
    const rect = dropdown.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Constrain menu width to viewport
    if (rect.width > viewportWidth - 32) {
      dropdown.style.maxWidth = `${viewportWidth - 32}px`;
    }

    // Check horizontal overflow
    if (rect.right > viewportWidth) {
      // Menu extends beyond right edge - align to right with padding
      dropdown.style.right = '16px';
      dropdown.style.left = 'auto';
      dropdown.style.transform = '';
    } else if (rect.left < 0) {
      // Menu extends beyond left edge - align to left with padding
      dropdown.style.left = '16px';
      dropdown.style.right = 'auto';
    }

    // Check vertical overflow
    if (rect.bottom > viewportHeight - 16) {
      // Menu extends beyond bottom edge - show above button instead
      dropdown.style.top = 'auto';
      dropdown.style.bottom = '100%';
      dropdown.style.marginBottom = '4px';
      dropdown.style.marginTop = '0';
    }
  });
}

// Close all open menus
function closeAllMenus() {
  openMenuBookmarkId = null; // Clear tracked menu state
  document.querySelectorAll('.bookmark-actions.show').forEach(menu => {
    menu.classList.remove('show');
    // Reset positioning styles
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.marginTop = '';
    menu.style.marginBottom = '';
    menu.style.maxHeight = '';
    menu.style.maxWidth = '';
    menu.style.overflowY = '';
    menu.style.position = '';
  });
  settingsMenu.classList.remove('show');
  themeMenu.classList.remove('show');
  viewMenu.classList.remove('show');
  zoomMenu.classList.remove('show');
}

// Check link status using background script
async function checkLinkStatus(url, bypassCache = false) {
  if (isPreviewMode) {
    // Simulate checking in preview mode
    return new Promise(resolve => {
      setTimeout(() => {
        // Random status for demo
        const statuses = ['live', 'live', 'live', 'dead'];
        resolve(statuses[Math.floor(Math.random() * statuses.length)]);
      }, 500);
    });
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'checkLinkStatus',
      url: url,
      bypassCache: bypassCache
    });
    return response.status || 'unknown';
  } catch (error) {
    console.error('Error checking link status:', error);
    return 'unknown';
  }
}

// Check URL safety with heuristic-based security check
// Uses pattern matching and domain reputation checks
// Checks for: HTTPS, suspicious patterns, URL shorteners, known safe domains
async function checkSafetyStatus(url, bypassCache = false) {
  // Check if URL is whitelisted
  try {
    const hostname = new URL(url).hostname;
    if (whitelistedUrls.has(hostname)) {
      const result = { status: 'safe', sources: ['Whitelisted by user'] };
      trackSafetyChange(url, result.status, result.sources);
      return result;
    }
  } catch (error) {
    console.error('Error parsing URL for whitelist check:', error);
  }

  if (isPreviewMode) {
    // Simulate checking in preview mode
    return new Promise(resolve => {
      setTimeout(() => {
        // Mostly safe, some warnings, rare unsafe for demo
        const statuses = ['safe', 'safe', 'safe', 'safe', 'warning', 'unsafe'];
        resolve(statuses[Math.floor(Math.random() * statuses.length)]);
      }, 800);
    });
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'checkURLSafety',
      url: url,
      bypassCache: bypassCache
    });
    const result = {
      status: response.status || 'unknown',
      sources: response.sources || []
    };
    // Track status change
    trackSafetyChange(url, result.status, result.sources);
    return result;
  } catch (error) {
    console.error('Error checking URL safety:', error);
    return { status: 'unknown', sources: [] };
  }
}

// Recheck bookmark status (link + safety)
async function recheckBookmarkStatus(bookmarkId) {
  // Find the bookmark in the tree
  const bookmark = findBookmarkById(bookmarkTree, bookmarkId);
  if (!bookmark || !bookmark.url) return;

  // Skip if both checking types are disabled
  if (!linkCheckingEnabled && !safetyCheckingEnabled) {
    alert('Both link checking and safety checking are disabled.\n\nEnable at least one in Settings to recheck bookmark status.');
    return;
  }

  if (isPreviewMode) {
    alert('🔄 Rechecking bookmark status...\n\nIn the real extension, this would check:\n• Link status (live/dead/parked)\n• Security analysis (heuristic-based threat detection)');
    return;
  }

  // Update bookmark to show checking status based on enabled settings
  const checkingUpdates = {};
  if (linkCheckingEnabled) checkingUpdates.linkStatus = 'checking';
  if (safetyCheckingEnabled) checkingUpdates.safetyStatus = 'checking';
  updateBookmarkInTree(bookmarkId, checkingUpdates);
  renderBookmarks();

  // Perform checks based on enabled settings
  const results = {};

  if (linkCheckingEnabled) {
    results.linkStatus = await checkLinkStatus(bookmark.url, true); // Bypass cache for rescan
  }

  if (safetyCheckingEnabled) {
    const safetyStatusResult = await checkSafetyStatus(bookmark.url, true); // Bypass cache for rescan
    results.safetyStatus = safetyStatusResult.status;
    results.safetySources = safetyStatusResult.sources;
  }

  // Update bookmark with results
  updateBookmarkInTree(bookmarkId, results);
  renderBookmarks();
}

// Find bookmark by ID in tree
function findBookmarkById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findBookmarkById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Update bookmark in tree
function updateBookmarkInTree(bookmarkId, updates) {
  const updateNode = (nodes) => {
    return nodes.map(node => {
      if (node.id === bookmarkId) {
        return { ...node, ...updates };
      }
      if (node.children) {
        return { ...node, children: updateNode(node.children) };
      }
      return node;
    });
  };
  bookmarkTree = updateNode(bookmarkTree);
}

// Update status indicators in DOM for a specific bookmark (without full re-render)
function updateBookmarkStatusInDOM(bookmarkId, linkStatus, safetyStatus, safetySources, url) {
  const bookmarkElement = document.querySelector(`.bookmark-item[data-id="${bookmarkId}"]`);
  if (!bookmarkElement) return;

  const statusIndicators = bookmarkElement.querySelector('.status-indicators');
  if (!statusIndicators) return;

  // Rebuild the status indicators HTML
  // Shield (safety) on top, chain (link status) below
  let statusIndicatorsHtml = '';
  if (displayOptions.safetyStatus && safetyStatus) {
    statusIndicatorsHtml += getShieldHtml(safetyStatus, url, safetySources);
  }
  if (displayOptions.liveStatus && linkStatus) {
    statusIndicatorsHtml += getStatusDotHtml(linkStatus, url);
  }

  statusIndicators.innerHTML = statusIndicatorsHtml;

// FORCE IMMEDIATE DOM REFLOW to ensure visual update and prevent race condition
statusIndicators.offsetHeight; // Trigger layout calculation

// Additional safeguard: force style recalculation on the parent element
bookmarkElement.style.display = 'flex';
bookmarkElement.offsetHeight; // Force complete reflow
bookmarkElement.style.display = '';
}

// Whitelist a bookmark (trust it regardless of safety checks)
async function whitelistBookmark(bookmark) {
  if (!bookmark || !bookmark.url) return;

  const hostname = new URL(bookmark.url).hostname;

  if (whitelistedUrls.has(hostname)) {
    const remove = confirm(`"${hostname}" is already whitelisted.\n\nDo you want to remove it from the whitelist?`);
    if (remove) {
      whitelistedUrls.delete(hostname);
      await saveWhitelist();
      alert(`Removed "${hostname}" from whitelist.\n\nIt will be scanned normally on next check.`);
      // Recheck the bookmark
      await recheckBookmarkStatus(bookmark.id);
    }
  } else {
    const confirm_add = confirm(`Add "${hostname}" to whitelist?\n\nWhitelisted sites are marked as safe regardless of security scan results.\n\nOnly whitelist sites you trust completely.`);
    if (confirm_add) {
      whitelistedUrls.add(hostname);
      await saveWhitelist();
      // Update safety status to safe
      updateBookmarkInTree(bookmark.id, {
        safetyStatus: 'safe',
        safetySources: ['Whitelisted by user']
      });
      renderBookmarks();
      alert(`"${hostname}" added to whitelist.\n\nAll bookmarks from this site will be marked as safe.`);
    }
  }
}

// Save whitelist to storage
async function saveWhitelist() {
  if (isPreviewMode) return;
  try {
    await safeStorage.set({
      whitelistedUrls: Array.from(whitelistedUrls)
    });
  } catch (error) {
    console.error('Failed to save whitelist:', error);
  }
}

// Load whitelist from storage
async function loadWhitelist() {
  if (isPreviewMode) return;
  try {
    const result = await safeStorage.get('whitelistedUrls');
    if (result.whitelistedUrls && Array.isArray(result.whitelistedUrls)) {
      whitelistedUrls = new Set(result.whitelistedUrls);
    }
  } catch (error) {
    console.error('Failed to load whitelist:', error);
  }
}

// Save safety history to storage
async function saveSafetyHistory() {
  if (isPreviewMode) return;
  try {
    await safeStorage.set({ safetyHistory });
  } catch (error) {
    console.error('Failed to save safety history:', error);
  }
}

// Load safety history from storage
async function loadSafetyHistory() {
  if (isPreviewMode) return;
  try {
    const result = await safeStorage.get('safetyHistory');
    if (result.safetyHistory) {
      safetyHistory = result.safetyHistory;
    }
  } catch (error) {
    console.error('Failed to load safety history:', error);
  }
}

// Clean up safetyHistory to remove entries for URLs no longer in bookmarks
function cleanupSafetyHistory() {
  if (isPreviewMode || !bookmarkTree || bookmarkTree.length === 0) return;

  // Collect all current bookmark URLs
  const currentUrls = new Set();
  const collectUrls = (nodes) => {
    nodes.forEach(node => {
      if (node.url) {
        currentUrls.add(node.url);
      }
      if (node.children) {
        collectUrls(node.children);
      }
    });
  };
  collectUrls(bookmarkTree);

  // Remove history entries for URLs that no longer exist in bookmarks
  const historyUrls = Object.keys(safetyHistory);
  let removedCount = 0;
  historyUrls.forEach(url => {
    if (!currentUrls.has(url)) {
      delete safetyHistory[url];
      removedCount++;
    }
  });

  if (removedCount > 0) {
    console.log(`[Memory Cleanup] Removed ${removedCount} stale entries from safetyHistory`);
    saveSafetyHistory(); // Persist the cleanup
  }
}

// Track safety status change and alert if degraded
function trackSafetyChange(url, newStatus, sources) {
  if (!url) return;

  const timestamp = Date.now();

  // Initialize history for this URL if needed
  if (!safetyHistory[url]) {
    safetyHistory[url] = [];
  }

  const history = safetyHistory[url];
  const lastStatus = history.length > 0 ? history[history.length - 1].status : null;

  // Only track if status has actually changed
  if (lastStatus === newStatus) {
    return; // No change, skip adding duplicate entry
  }

  // Add new entry only when status changes
  history.push({ timestamp, status: newStatus, sources });

  // Keep only last 10 entries per URL
  if (history.length > 10) {
    history.shift();
  }

  // Alert if status degraded from safe to unsafe/suspicious
  if (lastStatus === 'safe' && (newStatus === 'unsafe' || newStatus === 'suspicious')) {
    const hostname = new URL(url).hostname;
    console.warn(`⚠️ Security alert: ${hostname} changed from safe to ${newStatus}`);

    // Show alert to user
    setTimeout(() => {
      const message = `⚠️ SECURITY ALERT\n\n"${hostname}" was previously marked as SAFE but is now flagged as ${newStatus.toUpperCase()}!\n\nSources: ${sources.join(', ')}\n\nPlease verify this site before visiting.`;
      alert(message);
    }, 100);
  }

  // Save history only when status changes
  saveSafetyHistory();
}

// Handle bookmark actions
async function handleBookmarkAction(action, bookmark) {
  switch (action) {
    case 'open':
      // Open in active tab
      if (isPreviewMode) {
        window.open(bookmark.url, '_blank');
      } else {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, { url: bookmark.url });
        } else {
          chrome.tabs.create({ url: bookmark.url });
        }
      }
      break;

    case 'open-new-tab':
      openBookmarkUrl(bookmark.url, true);
      break;

    case 'open-new-window':
      // Open in new window
      if (isPreviewMode) {
        window.open(bookmark.url, '_blank', 'noopener,noreferrer');
      } else {
        chrome.windows.create({ url: bookmark.url });
      }
      break;

    case 'reader-view':
      // Open in text-only view using Textise
      const textiseUrl = `https://www.textise.net/showText.aspx?strURL=${encodeURIComponent(bookmark.url)}`;
      if (isPreviewMode) {
        window.open(textiseUrl, '_blank');
      } else {
        chrome.tabs.create({ url: textiseUrl });
      }
      break;

    case 'save-pdf':
      // Save page as PDF - Chrome doesn't have saveAsPDF, so we show instructions
      window.open(bookmark.url, '_blank');
      setTimeout(() => {
        alert('Page opened in a new tab. To save as PDF:\n\n1. Wait for the page to load\n2. Press Ctrl+P (or Cmd+P on Mac)\n3. Select "Save as PDF" as the destination\n4. Click "Save"');
      }, 500);
      break;

    case 'edit':
      editBookmark(bookmark);
      break;

    case 'recheck':
      await recheckBookmarkStatus(bookmark.id);
      break;

    case 'whitelist':
      await whitelistBookmark(bookmark);
      break;

    case 'virustotal':
      // Extract domain from URL and open VirusTotal search
      try {
        const domain = new URL(bookmark.url).hostname;
        const vtUrl = `https://www.virustotal.com/gui/search/${domain}`;
        if (isPreviewMode) {
          window.open(vtUrl, '_blank');
        } else {
          chrome.tabs.create({ url: vtUrl });
        }
      } catch (error) {
        console.error('Error opening VirusTotal:', error);
        alert('Failed to open VirusTotal. Invalid URL.');
      }
      break;

    case 'qr-code':
      // Generate and show QR code for bookmark URL (local, privacy-focused)
      showQRCodePopup(bookmark.url);
      break;

    case 'wayback-save':
      // Save to Wayback Machine - open the save page with URL pre-filled
      {
        // Wayback's save page doesn't accept URL in path, so we copy URL first
        // and open their save page where user can paste and submit
        try {
          await navigator.clipboard.writeText(bookmark.url);
          const waybackSaveUrl = 'https://web.archive.org/save';
          if (isPreviewMode) {
            window.open(waybackSaveUrl, '_blank');
          } else {
            chrome.tabs.create({ url: waybackSaveUrl });
          }
          // Brief notification that URL was copied
          setTimeout(() => {
            alert(`URL copied to clipboard!\n\n"${bookmark.url}"\n\nPaste it into the Wayback Machine save page that just opened.`);
          }, 100);
        } catch (error) {
          console.error('Error copying URL:', error);
          // Fallback: just open the save page
          const waybackSaveUrl = 'https://web.archive.org/save';
          if (isPreviewMode) {
            window.open(waybackSaveUrl, '_blank');
          } else {
            chrome.tabs.create({ url: waybackSaveUrl });
          }
        }
      }
      break;

    case 'wayback-browse':
      // Browse Wayback Machine snapshots
      {
        const waybackBrowseUrl = `https://web.archive.org/web/*/${bookmark.url}`;
        if (isPreviewMode) {
          window.open(waybackBrowseUrl, '_blank');
        } else {
          chrome.tabs.create({ url: waybackBrowseUrl });
        }
      }
      break;

    case 'copy-url':
      // Copy URL to clipboard
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(bookmark.url);
          // Show brief success feedback
          // Optional: Could show a toast notification here
        } else {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = bookmark.url;
          textArea.style.position = 'fixed';
          textArea.style.left = '-999999px';
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }
      } catch (error) {
        console.error('Error copying URL:', error);
        alert('Failed to copy URL to clipboard.');
      }
      break;

    case 'edit':
      openEditModal(bookmark, false);
      break;

    case 'delete':
      if (confirm(`Delete "${bookmark.title}"?`)) {
        await deleteBookmark(bookmark.id);
      }
      break;
  }
}

// Open edit modal
function openEditModal(item, isFolder = false) {
  currentEditItem = item;

  const modal = document.getElementById('editModal');
  const modalTitle = document.getElementById('editModalTitle');
  const editTitle = document.getElementById('editTitle');
  const editUrl = document.getElementById('editUrl');
  const editUrlGroup = document.getElementById('editUrlGroup');

  // Set modal title
  modalTitle.textContent = isFolder ? 'Rename Folder' : 'Edit Bookmark';

  // Populate fields
  editTitle.value = item.title || '';

  if (isFolder) {
    // Hide URL field for folders
    editUrlGroup.style.display = 'none';
  } else {
    // Show URL field for bookmarks
    editUrlGroup.style.display = 'block';
    editUrl.value = item.url || '';
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close edit modal
function closeEditModal() {
  const modal = document.getElementById('editModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
  currentEditItem = null;
}

// Save edit modal
async function saveEditModal() {
  if (!currentEditItem) return;

  const editTitle = document.getElementById('editTitle');
  const editUrl = document.getElementById('editUrl');

  const isFolder = !currentEditItem.url;
  const updates = { title: editTitle.value };

  if (!isFolder) {
    let url = editUrl.value.trim();
    // Add https:// if no protocol is specified
    if (url && !url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)) {
      url = 'https://' + url;
    }
    updates.url = url;
  }

  if (isPreviewMode) {
    alert('✓ In preview mode. In the real extension, this would update the ' + (isFolder ? 'folder' : 'bookmark') + '.');
    closeEditModal();
    return;
  }

  try {
    const oldTitle = currentEditItem.title;
    const oldUrl = currentEditItem.url;

    await chrome.bookmarks.update(currentEditItem.id, updates);

    // Add to changelog if title changed
    if (updates.title !== oldTitle) {
      await addChangelogEntry(
        'update',
        isFolder ? 'folder' : 'bookmark',
        updates.title,
        isFolder ? null : (updates.url || oldUrl),
        { oldTitle, newTitle: updates.title }
      );
    }

    await loadBookmarks();
    renderBookmarks();
    closeEditModal();
  } catch (error) {
    console.error('Error updating:', error);
    alert('Failed to update ' + (isFolder ? 'folder' : 'bookmark'));
  }
}

// Edit bookmark (legacy wrapper)
async function editBookmark(bookmark) {
  openEditModal(bookmark, false);
}

// Delete bookmark
async function deleteBookmark(id) {
  if (isPreviewMode) {
    // Find bookmark in mock data
    const findAndRemove = (items, parentArray = null, parentIndex = -1) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.id === id) {
          // Found it! Store data for undo
          const bookmarkData = { ...item, parentArray, parentIndex: i };

          // Remove from array
          items.splice(i, 1);

          // Show undo toast
          showUndoToast({
            type: 'bookmark',
            data: bookmarkData,
            message: `Bookmark "${item.title || 'Untitled'}" deleted`,
            isPreview: true
          });

          renderBookmarks();
          return true;
        }

        if (item.children) {
          if (findAndRemove(item.children, item.children, i)) {
            return true;
          }
        }
      }
      return false;
    };

    findAndRemove(bookmarkTree);
    return;
  }

  try {
    // Get bookmark details before deleting for undo functionality
    const bookmarks = await chrome.bookmarks.get(id);
    const bookmark = bookmarks[0];

    // Delete the bookmark
    await chrome.bookmarks.remove(id);

    // Add to changelog
    await addChangelogEntry('delete', 'bookmark', bookmark.title || 'Untitled', bookmark.url);

    // Show undo toast
    showUndoToast({
      type: 'bookmark',
      data: bookmark,
      message: `Bookmark "${bookmark.title || 'Untitled'}" deleted`
    });

    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error deleting bookmark:', error);
    alert('Failed to delete bookmark');
  }
}

// Build folder list for dropdowns
function buildFolderList(nodes, indent = 0) {
  const folders = [];
  for (const node of nodes) {
    if (node.children) {
      folders.push({
        id: node.id,
        title: '  '.repeat(indent) + (node.title || 'Unnamed Folder'),
        indent
      });
      folders.push(...buildFolderList(node.children, indent + 1));
    }
  }
  return folders;
}

// Populate folder dropdown
function populateFolderDropdown(selectElement, sortAlphabetically = false) {
  let folders = buildFolderList(bookmarkTree);

  // Sort alphabetically if requested
  if (sortAlphabetically) {
    folders.sort((a, b) => {
      // Remove indentation for comparison
      const titleA = a.title.trim().toLowerCase();
      const titleB = b.title.trim().toLowerCase();
      return titleA.localeCompare(titleB);
    });
  }

  selectElement.innerHTML = '<option value="">Root</option>';
  folders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.title;
    selectElement.appendChild(option);
  });
}

// Open add bookmark modal
async function openAddBookmarkModal() {
  const modal = document.getElementById('addBookmarkModal');
  const titleInput = document.getElementById('newBookmarkTitle');
  const urlInput = document.getElementById('newBookmarkUrl');
  const folderSelect = document.getElementById('newBookmarkFolder');

  // Try to get the current active tab to pre-populate fields
  if (!isPreviewMode) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length > 0) {
        const currentTab = tabs[0];
        titleInput.value = currentTab.title || '';
        urlInput.value = currentTab.url || '';
      } else {
        titleInput.value = '';
        urlInput.value = '';
      }
    } catch (error) {
      console.error('Error getting current tab:', error);
      titleInput.value = '';
      urlInput.value = '';
    }
  } else {
    // Preview mode: show example data
    titleInput.value = 'Current Tab Title';
    urlInput.value = 'https://example.com/current-page';
  }

  // Load sort preference and populate dropdown
  const sortCheckbox = document.getElementById('sortBookmarkFoldersAlpha');
  const sortPref = localStorage.getItem('sortFoldersAlphabetically') === 'true';
  sortCheckbox.checked = sortPref;
  populateFolderDropdown(folderSelect, sortPref);

  // Set default folder - prefer last used, then Bookmarks Menu, then first available
  const lastUsedFolder = localStorage.getItem('lastBookmarkFolder');
  if (lastUsedFolder && folderSelect.querySelector(`option[value="${lastUsedFolder}"]`)) {
    folderSelect.value = lastUsedFolder;
  } else {
    // Find Bookmarks Menu folder (usually has 'menu' in the ID)
    const menuOption = Array.from(folderSelect.options).find(opt =>
      opt.value.includes('menu') || opt.textContent.toLowerCase().includes('bookmarks menu')
    );
    if (menuOption) {
      folderSelect.value = menuOption.value;
    } else if (folderSelect.options.length > 1) {
      // Fallback to first non-root option
      folderSelect.selectedIndex = 1;
    }
  }

  // Add event listener for sort checkbox
  sortCheckbox.addEventListener('change', (e) => {
    const sortAlpha = e.target.checked;
    localStorage.setItem('sortFoldersAlphabetically', sortAlpha);
    populateFolderDropdown(folderSelect, sortAlpha);
  });

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
  // Select all text in title for easy editing
  titleInput.select();
}

// Close add bookmark modal
function closeAddBookmarkModal() {
  const modal = document.getElementById('addBookmarkModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Save new bookmark
async function saveNewBookmark() {
  const title = document.getElementById('newBookmarkTitle').value;
  let url = document.getElementById('newBookmarkUrl').value.trim();
  const parentId = document.getElementById('newBookmarkFolder').value || undefined;

  if (!url) {
    alert('Please enter a URL');
    return;
  }

  // Add https:// if no protocol is specified
  if (!url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)) {
    url = 'https://' + url;
  }

  // Check if trying to create bookmark at root level
  if (!parentId) {
    alert('Chrome does not allow creating bookmarks at the root level. Please select a parent folder (Bookmarks Bar, Other Bookmarks, or any existing folder/subfolder) to create your bookmark in.');
    return;
  }

  if (isPreviewMode) {
    alert('✓ In preview mode. In the real extension, this would create a new bookmark.');
    closeAddBookmarkModal();
    return;
  }

  try {
    // SAFETY: Check for duplicate bookmarks to prevent accidental duplication
    const existingBookmarks = await chrome.bookmarks.search({ url });
    if (existingBookmarks.length > 0) {
      const duplicateInfo = existingBookmarks.map(b => `  • "${b.title}" in folder ${b.parentId}`).join('\n');
      const confirmed = confirm(
        `⚠ Warning: This URL already exists in your bookmarks:\n\n${duplicateInfo}\n\nDo you want to create a duplicate bookmark anyway?`
      );
      if (!confirmed) {
        closeAddBookmarkModal();
        return;
      }
    }

    const newBookmark = await chrome.bookmarks.create({
      title: title || url,
      url,
      parentId
    });

    // Add to changelog
    const folderPath = parentId ? await getFolderPath(parentId) : 'Root';
    await addChangelogEntry('create', 'bookmark', title || url, url, { folderPath });

    // Remember the selected folder for next time
    if (parentId) {
      localStorage.setItem('lastBookmarkFolder', parentId);
    }

    await loadBookmarks();
    renderBookmarks();
    closeAddBookmarkModal();
  } catch (error) {
    console.error('Error creating bookmark:', error);
    alert('Failed to create bookmark');
  }
}

// Open add folder modal
function openAddFolderModal() {
  const modal = document.getElementById('addFolderModal');
  const nameInput = document.getElementById('newFolderName');
  const parentSelect = document.getElementById('newFolderParent');

  nameInput.value = '';

  // Load sort preference and populate dropdown
  const sortCheckbox = document.getElementById('sortFolderParentsAlpha');
  const sortPref = localStorage.getItem('sortFoldersAlphabetically') === 'true';
  sortCheckbox.checked = sortPref;
  populateFolderDropdown(parentSelect, sortPref);

  // Set default folder - prefer last used, then Bookmarks Menu, then first available
  const lastUsedParent = localStorage.getItem('lastFolderParent');
  if (lastUsedParent && parentSelect.querySelector(`option[value="${lastUsedParent}"]`)) {
    parentSelect.value = lastUsedParent;
  } else {
    // Find Bookmarks Menu folder (usually has 'menu' in the ID)
    const menuOption = Array.from(parentSelect.options).find(opt =>
      opt.value.includes('menu') || opt.textContent.toLowerCase().includes('bookmarks menu')
    );
    if (menuOption) {
      parentSelect.value = menuOption.value;
    } else if (parentSelect.options.length > 1) {
      // Fallback to first non-root option
      parentSelect.selectedIndex = 1;
    }
  }

  // Add event listener for sort checkbox
  sortCheckbox.addEventListener('change', (e) => {
    const sortAlpha = e.target.checked;
    localStorage.setItem('sortFoldersAlphabetically', sortAlpha);
    populateFolderDropdown(parentSelect, sortAlpha);
  });

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close add folder modal
function closeAddFolderModal() {
  const modal = document.getElementById('addFolderModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Save new folder
async function saveNewFolder() {
  const title = document.getElementById('newFolderName').value;
  const parentId = document.getElementById('newFolderParent').value || undefined;

  if (!title) {
    alert('Please enter a folder name');
    return;
  }

  // Check if trying to create folder at root level
  if (!parentId) {
    alert('Chrome does not allow creating folders at the root level. Please select a parent folder (Bookmarks Bar, Other Bookmarks, or any existing folder/subfolder) to create your folder in.');
    return;
  }

  if (isPreviewMode) {
    alert('✓ In preview mode. In the real extension, this would create a new folder.');
    closeAddFolderModal();
    return;
  }

  try {
    // Chrome creates a folder when no url is provided
    const newFolder = await chrome.bookmarks.create({
      title,
      parentId
    });

    // Add to changelog
    const folderPath = parentId ? await getFolderPath(parentId) : 'Root';
    await addChangelogEntry('create', 'folder', title, null, { folderPath });

    // Remember the selected parent folder for next time
    if (parentId) {
      localStorage.setItem('lastFolderParent', parentId);
    }

    await loadBookmarks();
    renderBookmarks();
    closeAddFolderModal();
  } catch (error) {
    console.error('Error creating folder:', error);
    alert('Failed to create folder');
  }
}

// Legacy function wrappers for compatibility
async function createNewBookmark() {
  openAddBookmarkModal();
}

async function createNewFolder() {
  openAddFolderModal();
}

// Filter and search bookmarks
function filterAndSearchBookmarks(nodes) {
  return nodes.reduce((acc, node) => {
    if (node.children) {
      // It's a folder
      const filteredChildren = filterAndSearchBookmarks(node.children);
      if (filteredChildren.length > 0 || (!searchTerm && activeFilters.length === 0)) {
        acc.push({
          ...node,
          children: filteredChildren
        });
      }
    } else if (node.url) {
      // It's a bookmark
      if (matchesSearch(node) && matchesFilter(node)) {
        acc.push(node);
      }
    }
    return acc;
  }, []);
}

// Check if bookmark matches search
function matchesSearch(bookmark) {
  if (!searchTerm) return true;

  const term = searchTerm.toLowerCase();
  return (
    (bookmark.title && bookmark.title.toLowerCase().includes(term)) ||
    (bookmark.url && bookmark.url.toLowerCase().includes(term))
  );
}

// Check if bookmark matches filter
function matchesFilter(bookmark) {
  if (activeFilters.length === 0) return true;

  const linkStatus = bookmark.linkStatus || 'unknown';
  const safetyStatus = bookmark.safetyStatus || 'unknown';
  const safetySources = bookmark.safetySources || [];
  const isWhitelisted = safetySources.includes('Whitelisted by user');

  // Separate filters by category
  const linkFilters = activeFilters.filter(f => ['live', 'parked', 'dead'].includes(f));
  const safetyFilters = activeFilters.filter(f => ['safe', 'suspicious', 'unsafe', 'trusted'].includes(f));

  // Check link status (OR within category)
  let matchesLink = true;
  if (linkFilters.length > 0) {
    matchesLink = linkFilters.some(filter => {
      switch (filter) {
        case 'live': return linkStatus === 'live';
        case 'parked': return linkStatus === 'parked';
        case 'dead': return linkStatus === 'dead';
        default: return false;
      }
    });
  }

  // Check safety status (OR within category)
  let matchesSafety = true;
  if (safetyFilters.length > 0) {
    matchesSafety = safetyFilters.some(filter => {
      switch (filter) {
        case 'safe': return safetyStatus === 'safe' && !isWhitelisted;
        case 'suspicious': return safetyStatus === 'warning';
        case 'unsafe': return safetyStatus === 'unsafe';
        case 'trusted': return isWhitelisted;
        default: return false;
      }
    });
  }

  // AND between categories
  return matchesLink && matchesSafety;
}

// Count bookmarks in folder
function countBookmarks(folder) {
  if (!folder.children) return 0;

  return folder.children.reduce((count, child) => {
    if (child.children) {
      return count + countBookmarks(child);
    } else if (child.url) {
      return count + 1;
    }
    return count;
  }, 0);
}

// Get favicon URL
function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
  } catch {
    return '';
  }
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show error message
function showError(message) {
  bookmarkList.innerHTML = `
    <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-error);">
      <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
      <div style="font-size: 14px;">${escapeHtml(message)}</div>
    </div>
  `;
}

// Open extension in new tab
async function openInNewTab() {
  if (isPreviewMode) {
    alert('🗗 In the Chrome extension, this would open Bookmark Manager Zero in a new tab for a full-page view.');
    return;
  }

  try {
    // Get the extension's URL for the sidebar page
    const extensionUrl = chrome.runtime.getURL('sidepanel.html');
    // Open it in a new tab
    await chrome.tabs.create({ url: extensionUrl });
  } catch (error) {
    console.error('Error opening in new tab:', error);
    alert('Failed to open in new tab');
  }
}

// Convert bookmark tree to HTML format
function bookmarksToHTML(bookmarkNodes, indent = 0) {
  let html = '';
  const indentStr = '    '.repeat(indent);

  for (const node of bookmarkNodes) {
    if (node.url) {
      // It's a bookmark
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : '';
      html += `${indentStr}<DT><A HREF="${node.url}"${addDate ? ` ADD_DATE="${addDate}"` : ''}>${node.title || node.url}</A>\n`;
    } else if (node.children) {
      // It's a folder
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : '';
      html += `${indentStr}<DT><H3${addDate ? ` ADD_DATE="${addDate}"` : ''}>${node.title || 'Untitled Folder'}</H3>\n`;
      html += `${indentStr}<DL><p>\n`;
      html += bookmarksToHTML(node.children, indent + 1);
      html += `${indentStr}</DL><p>\n`;
    }
  }

  return html;
}

// Generate complete HTML bookmark file
function generateBookmarkHTML(bookmarkTree) {
  const timestamp = new Date().toISOString();
  const date = new Date();

  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  // Process the bookmark tree
  // Chrome bookmark tree has a root node, we want to export its children
  if (bookmarkTree && bookmarkTree.length > 0) {
    const root = bookmarkTree[0];
    if (root.children) {
      html += bookmarksToHTML(root.children, 1);
    }
  }

  html += `</DL><p>\n`;

  return html;
}

// SAFETY: Export bookmarks as JSON or HTML backup
async function exportBookmarks() {
  try {
    // Ask user for format preference
    const format = confirm(
      'Choose export format:\n\n' +
      'OK = HTML (compatible with all browsers)\n' +
      'Cancel = JSON (Chrome native format)\n\n' +
      'HTML format can be imported into any browser.\n' +
      'JSON format preserves all Chrome bookmark metadata.'
    ) ? 'html' : 'json';

    let data;

    if (isPreviewMode) {
      // Export mock data in preview mode
      data = bookmarkTree;
    } else {
      // Export actual bookmarks
      const tree = await chrome.bookmarks.getTree();
      data = tree;
    }

    // Generate filename with timestamp
    const date = new Date().toISOString().split('T')[0];
    let filename, blob, url;

    if (format === 'html') {
      // Create HTML file
      const html = generateBookmarkHTML(data);
      blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      url = URL.createObjectURL(blob);
      filename = `bookmarks-${date}.html`;
    } else {
      // Create JSON file
      const json = JSON.stringify(data, null, 2);
      blob = new Blob([json], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      filename = `bookmarks-backup-${date}.json`;
    }

    // Create download link and trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (format === 'html') {
      alert(
        `✓ Bookmarks exported as HTML!\n\n` +
        `File: ${filename}\n\n` +
        `This file can be imported into:\n` +
        `• Chrome/Edge: Bookmarks → Bookmark manager → ⋮ → Import bookmarks\n` +
        `• Any browser that supports Netscape bookmark format`
      );
    } else {
      alert(
        `✓ Bookmarks exported as JSON!\n\n` +
        `File: ${filename}\n\n` +
        `This backup can be imported back into Chrome via:\n` +
        `Bookmarks → Bookmark manager → ⋮ → Import bookmarks`
      );
    }
  } catch (error) {
    console.error('Error exporting bookmarks:', error);
    alert('Failed to export bookmarks. Please try again.');
  }
}

// DUPLICATE DETECTION: Find and manage duplicate bookmarks
async function findDuplicates() {
  try {
    let allBookmarks = [];

    if (isPreviewMode) {
      // Use mock data in preview mode
      allBookmarks = getAllBookmarksFlat(bookmarkTree);
    } else {
      // Get all bookmarks from Chrome
      const tree = await chrome.bookmarks.getTree();
      allBookmarks = getAllBookmarksFlat(tree);
    }

    // Group bookmarks by URL
    const urlMap = new Map();
    for (const bookmark of allBookmarks) {
      if (bookmark.url) { // Only process bookmarks (not folders)
        if (!urlMap.has(bookmark.url)) {
          urlMap.set(bookmark.url, []);
        }
        urlMap.get(bookmark.url).push(bookmark);
      }
    }

    // Find duplicates (URLs with more than one bookmark)
    const duplicates = [];
    for (const [url, bookmarks] of urlMap.entries()) {
      if (bookmarks.length > 1) {
        duplicates.push({ url, bookmarks });
      }
    }

    if (duplicates.length === 0) {
      alert('✓ No duplicate bookmarks found!\n\nAll your bookmarks have unique URLs.');
      return;
    }

    // Show duplicates modal
    showDuplicatesModal(duplicates);

  } catch (error) {
    console.error('Error finding duplicates:', error);
    alert('Failed to scan for duplicates. Please try again.');
  }
}

// Helper: Get all bookmarks from tree (recursive, flattened)
function getAllBookmarksFlat(tree, parentPath = '') {
  let bookmarks = [];

  const processNode = (node, path) => {
    if (node.url) {
      // It's a bookmark
      bookmarks.push({
        ...node,
        parentPath: path
      });
    }
    if (node.children) {
      // It's a folder - process children
      const newPath = path ? `${path} > ${node.title || 'Untitled'}` : node.title || 'Root';
      for (const child of node.children) {
        processNode(child, newPath);
      }
    }
  };

  if (Array.isArray(tree)) {
    for (const node of tree) {
      processNode(node, parentPath);
    }
  } else {
    processNode(tree, parentPath);
  }

  return bookmarks;
}

// Global storage for current duplicates data
let currentDuplicates = [];

// Show duplicates modal
function showDuplicatesModal(duplicates) {
  const modal = document.getElementById('duplicatesModal');
  const content = document.getElementById('duplicatesContent');

  // Store duplicates for later use in deletion check
  currentDuplicates = duplicates;

  // Build HTML for duplicates
  let html = `
    <div style="margin-bottom: 8px;">
      <p style="font-size: 11px;"><strong>Found ${duplicates.length} URL(s) with duplicates (${duplicates.reduce((sum, d) => sum + d.bookmarks.length, 0)} total bookmarks)</strong></p>
      <p style="color: #666; font-size: 9px;">Select the bookmarks you want to delete:</p>
    </div>
  `;

  for (const duplicate of duplicates) {
    html += `
      <div style="margin-bottom: 10px; padding: 8px; background: rgba(59, 130, 246, 0.05); border-radius: 4px; border: 1px solid rgba(59, 130, 246, 0.2);">
        <div style="margin-bottom: 6px; font-size: 9px;">
          <strong style="color: #1e40af;">URL:</strong>
          <a href="${duplicate.url}" target="_blank" style="color: #2563eb; text-decoration: none; word-break: break-all; font-size: 9px;">${duplicate.url}</a>
        </div>
        <div style="margin-left: 8px;">
    `;

    for (const bookmark of duplicate.bookmarks) {
      html += `
        <div style="margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
          <input type="checkbox"
                 id="dup-${bookmark.id}"
                 data-bookmark-id="${bookmark.id}"
                 data-url="${duplicate.url}"
                 class="duplicate-checkbox"
                 style="cursor: pointer; width: 10px; height: 10px;">
          <label for="dup-${bookmark.id}" style="cursor: pointer; flex: 1; font-size: 9px;">
            <span style="font-weight: 500;">${bookmark.title || 'Untitled'}</span>
            <span style="color: #666; font-size: 8px;"> - in ${bookmark.parentPath || 'Root'}</span>
          </label>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  content.innerHTML = html;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close duplicates modal
function closeDuplicatesModal() {
  const modal = document.getElementById('duplicatesModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Delete selected duplicates
async function deleteSelectedDuplicates() {
  const checkboxes = document.querySelectorAll('.duplicate-checkbox:checked');

  if (checkboxes.length === 0) {
    alert('Please select at least one bookmark to delete.');
    return;
  }

  const confirmed = confirm(`⚠ Delete ${checkboxes.length} selected bookmark(s)?\n\nThis action cannot be undone!`);
  if (!confirmed) return;

  // Check if user is deleting ALL copies of any URL
  const selectedIds = new Set(Array.from(checkboxes).map(cb => cb.dataset.bookmarkId));
  const urlsWithAllCopiesSelected = [];

  for (const duplicate of currentDuplicates) {
    const allIdsForThisUrl = duplicate.bookmarks.map(b => b.id);
    const allSelected = allIdsForThisUrl.every(id => selectedIds.has(id));

    if (allSelected) {
      urlsWithAllCopiesSelected.push(duplicate.url);
    }
  }

  // Second warning if deleting all copies of any URL
  if (urlsWithAllCopiesSelected.length > 0) {
    const urlList = urlsWithAllCopiesSelected.map(url => `  • ${url}`).join('\n');
    const finalWarning = confirm(
      `⚠️ WARNING! YOU ARE ABOUT TO DELETE ALL COPIES OF THE FOLLOWING BOOKMARK(S):\n\n${urlList}\n\nTHERE WILL BE NO REMAINING COPIES OF THESE BOOKMARKS!\n\nARE YOU ABSOLUTELY SURE YOU WANT TO CONTINUE?`
    );

    if (!finalWarning) return;
  }

  if (isPreviewMode) {
    // Get IDs to delete
    const idsToDelete = Array.from(checkboxes).map(cb => cb.dataset.bookmarkId);

    // Remove bookmarks from the mock data tree
    const removeBookmarkFromTree = (tree, idToRemove) => {
      for (let i = 0; i < tree.length; i++) {
        const node = tree[i];

        // Check if this is a folder with children
        if (node.children) {
          // Filter out the bookmark if it's in this folder's children
          node.children = node.children.filter(child => child.id !== idToRemove);
          // Recursively check nested folders
          removeBookmarkFromTree(node.children, idToRemove);
        }
      }
    };

    // Remove each selected bookmark
    for (const id of idsToDelete) {
      removeBookmarkFromTree(bookmarkTree, id);
    }

    // Re-render the UI
    renderBookmarks();

    // Close modal and show success
    closeDuplicatesModal();
    alert(`✓ Successfully deleted ${checkboxes.length} bookmark(s) from preview!`);
    return;
  }

  try {
    let successCount = 0;
    let failCount = 0;

    for (const checkbox of checkboxes) {
      const bookmarkId = checkbox.dataset.bookmarkId;
      try {
        await chrome.bookmarks.remove(bookmarkId);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete bookmark ${bookmarkId}:`, error);
        failCount++;
      }
    }

    // Reload bookmarks
    await loadBookmarks();
    renderBookmarks();

    // Close modal and show result
    closeDuplicatesModal();

    if (failCount === 0) {
      alert(`✓ Successfully deleted ${successCount} bookmark(s)!`);
    } else {
      alert(`⚠ Deleted ${successCount} bookmark(s).\n${failCount} failed to delete.`);
    }

  } catch (error) {
    console.error('Error deleting duplicates:', error);
    alert('An error occurred while deleting bookmarks.');
  }
}

// ============================================================================
// CHANGELOG MODAL
// ============================================================================

// Open changelog modal
async function openChangelogModal() {
  const modal = document.getElementById('changelogModal');
  const changelogContent = document.getElementById('changelogContent');

  const entries = await getChangelogEntries();

  if (entries.length === 0) {
    changelogContent.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-on-surface-variant);">
        <svg width="64" height="64" fill="currentColor" viewBox="0 0 24 24" style="opacity: 0.3; margin-bottom: 16px;">
          <path d="M13.5,8H12V13L16.28,15.54L17,14.33L13.5,12.25V8M13,3A9,9 0 0,0 4,12H1L4.96,16.03L9,12H6A7,7 0 0,1 13,5A7,7 0 0,1 20,12A7,7 0 0,1 13,19C11.07,19 9.32,18.21 8.06,16.94L6.64,18.36C8.27,20 10.5,21 13,21A9,9 0 0,0 22,12A9,9 0 0,0 13,3Z"/>
        </svg>
        <div style="font-size: 16px; font-weight: 500; margin-bottom: 8px;">No Changes Yet</div>
        <div style="font-size: 13px;">Your bookmark changes will appear here</div>
      </div>
    `;
  } else {
    let html = '';

    entries.forEach(entry => {
      const date = new Date(entry.timestamp);
      const timeAgo = getTimeAgo(date);

      let iconColor;
      if (entry.type === 'create') iconColor = '#10b981';
      else if (entry.type === 'delete') iconColor = '#ef4444';
      else if (entry.type === 'move') iconColor = '#3b82f6';
      else iconColor = '#f59e0b';

      // SVG icons for operation types
      let icon;
      if (entry.type === 'create') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>`;
      } else if (entry.type === 'delete') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z"/></svg>`;
      } else if (entry.type === 'move') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M14,18L12.6,16.6L15.2,14H4V12H15.2L12.6,9.4L14,8L19,13L14,18M20,6H10A2,2 0 0,0 8,8V11H10V8H20V20H10V17H8V20A2,2 0 0,0 10,22H20A2,2 0 0,0 22,20V8A2,2 0 0,0 20,6Z"/></svg>`;
      } else {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
      }

      // SVG icons for item types
      let itemIcon;
      if (entry.itemType === 'folder') {
        itemIcon = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="color: var(--md-sys-color-primary);"><path d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/></svg>`;
      } else {
        itemIcon = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="color: var(--md-sys-color-secondary);"><path d="M17,3H7A2,2 0 0,0 5,5V21L12,18L19,21V5C19,3.89 18.1,3 17,3Z"/></svg>`;
      }

      let detailsHtml = '';
      if (entry.details) {
        if (entry.details.oldTitle && entry.details.newTitle) {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Renamed from: ${entry.details.oldTitle}</div>`;
        } else if (entry.details.fromFolder && entry.details.toFolder) {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Moved from: ${entry.details.fromFolder} → ${entry.details.toFolder}</div>`;
        } else if (entry.details.folderPath) {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Location: ${entry.details.folderPath}</div>`;
        }
      }

      const urlHtml = entry.url ? `<div class="changelog-url" data-url="${entry.url}" style="font-size: 11px; color: var(--md-sys-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; text-decoration: underline;" title="Click to copy: ${entry.url}">${entry.url}</div>` : '';

      html += `
        <div style="padding: 12px; background: var(--md-sys-color-surface-variant); border-radius: 8px; border-left: 3px solid ${iconColor};">
          <div style="display: flex; align-items: start; gap: 8px;">
            <div style="font-size: 20px; flex-shrink: 0;">${icon}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                <span style="font-size: 14px;">${itemIcon}</span>
                <span style="font-size: 13px; font-weight: 600; color: var(--md-sys-color-on-surface);">${entry.title || 'Untitled'}</span>
              </div>
              ${urlHtml}
              ${detailsHtml}
              <div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 6px; opacity: 0.7;">${timeAgo}</div>
            </div>
          </div>
        </div>
      `;
    });

    changelogContent.innerHTML = html;

    // Add click handlers to URLs for copying to clipboard
    const urlElements = changelogContent.querySelectorAll('.changelog-url');
    urlElements.forEach(urlEl => {
      urlEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = urlEl.getAttribute('data-url');
        try {
          await navigator.clipboard.writeText(url);
          const originalText = urlEl.textContent;
          const originalColor = urlEl.style.color;
          urlEl.textContent = '✓ Copied!';
          urlEl.style.color = '#10b981';
          setTimeout(() => {
            urlEl.textContent = originalText;
            urlEl.style.color = originalColor;
          }, 1500);
        } catch (error) {
          console.error('Failed to copy URL:', error);
          alert('Failed to copy URL to clipboard');
        }
      });
    });
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close changelog modal
function closeChangelogModal() {
  const modal = document.getElementById('changelogModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Helper function to convert timestamp to human-readable "time ago"
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
    { label: 'second', seconds: 1 }
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count !== 1 ? 's' : ''} ago`;
    }
  }

  return 'just now';
}

// View error logs
async function viewErrorLogs() {
  try {
    const result = await safeStorage.get('errorLogs');
    const errorLogs = result.errorLogs || [];

    if (errorLogs.length === 0) {
      alert('No error logs found. The extension is working smoothly!');
      return;
    }

    // Format error logs for display
    let logText = `ERROR LOGS (${errorLogs.length} total)\n`;
    logText += '='.repeat(60) + '\n\n';

    errorLogs.forEach((log, index) => {
      const date = new Date(log.timestamp);
      logText += `#${index + 1} - ${date.toLocaleString()}\n`;
      logText += `Context: ${log.context}\n`;
      logText += `Message: ${log.message}\n`;
      if (log.stack) {
        logText += `Stack: ${log.stack.split('\n')[0]}\n`;
      }
      logText += '-'.repeat(60) + '\n\n';
    });

    // Show in a prompt to allow copying
    const action = confirm(
      `Found ${errorLogs.length} error log(s).\n\n` +
      `Click OK to view in console, or Cancel to clear logs.`
    );

    if (action) {
      alert('Error logs have been printed to the browser console. Press F12 to view.');
    } else {
      // Clear logs
      const confirmClear = confirm('Are you sure you want to clear all error logs?');
      if (confirmClear) {
        await safeStorage.remove('errorLogs');
        alert('Error logs cleared successfully.');
      }
    }
  } catch (error) {
    console.error('Error viewing logs:', error);
    alert('Failed to load error logs.');
  }
}

// Close extension
async function closeExtension() {
  if (isPreviewMode) {
    alert('✕ In the Chrome extension, this would close the side panel or tab.');
    return;
  }

  try {
    // Check if we're running in a side panel or a tab
    const currentTab = await chrome.tabs.getCurrent();

    if (currentTab && currentTab.id) {
      // We're in a tab, so close the tab
      await chrome.tabs.remove(currentTab.id);
    } else {
      // We're in a side panel, just close the window
      window.close();
    }
  } catch (error) {
    console.error('Error closing extension:', error);
    // Fallback: just try to close the window
    window.close();
  }
}

// Clear cache for link status and safety checks
// Calculate cache size in KB
async function calculateCacheSize() {
  if (isPreviewMode) {
    return 0;
  }

  try {
    const result = await safeStorage.get(['linkStatusCache', 'safetyStatusCache', 'whitelistedUrls', 'safetyHistory']);

    // Calculate size by stringifying the data
    let totalSize = 0;
    if (result.linkStatusCache) {
      totalSize += JSON.stringify(result.linkStatusCache).length;
    }
    if (result.safetyStatusCache) {
      totalSize += JSON.stringify(result.safetyStatusCache).length;
    }
    if (result.whitelistedUrls) {
      totalSize += JSON.stringify(result.whitelistedUrls).length;
    }
    if (result.safetyHistory) {
      totalSize += JSON.stringify(result.safetyHistory).length;
    }

    // Convert bytes to KB
    return (totalSize / 1024).toFixed(2);
  } catch (error) {
    console.error('Error calculating cache size:', error);
    return 0;
  }
}

// Update cache size display
async function updateCacheSizeDisplay() {
  const cacheSizeElement = document.getElementById('cacheSize');
  if (!cacheSizeElement) return;

  const sizeKB = parseFloat(await calculateCacheSize());

  if (sizeKB === 0) {
    cacheSizeElement.textContent = 'Empty';
  } else if (sizeKB < 1) {
    cacheSizeElement.textContent = '< 1 KB';
  } else if (sizeKB >= 1024) {
    const sizeMB = (sizeKB / 1024).toFixed(2);
    cacheSizeElement.textContent = `${sizeMB} MB`;
  } else {
    cacheSizeElement.textContent = `${sizeKB.toFixed(2)} KB`;
  }
}

// Clear old cache entries based on auto-clear setting
async function clearOldCacheEntries(maxAgeDays) {
  if (isPreviewMode || maxAgeDays === 'never') {
    return;
  }

  try {
    const maxAgeMs = parseInt(maxAgeDays) * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - maxAgeMs;

    const result = await safeStorage.get(['linkStatusCache', 'safetyStatusCache', 'safetyHistory', 'lastCacheClear']);

    let updated = false;

    // Clear old link status cache entries
    if (result.linkStatusCache) {
      const linkCache = result.linkStatusCache;
      Object.keys(linkCache).forEach(url => {
        if (linkCache[url].timestamp && linkCache[url].timestamp < cutoffTime) {
          delete linkCache[url];
          updated = true;
        }
      });
      if (updated) {
        await safeStorage.set({ linkStatusCache: linkCache });
      }
    }

    // Clear old safety status cache entries
    if (result.safetyStatusCache) {
      const safetyCache = result.safetyStatusCache;
      Object.keys(safetyCache).forEach(url => {
        if (safetyCache[url].timestamp && safetyCache[url].timestamp < cutoffTime) {
          delete safetyCache[url];
          updated = true;
        }
      });
      if (updated) {
        await safeStorage.set({ safetyStatusCache: safetyCache });
      }
    }

    // Clear old safety history entries
    if (result.safetyHistory) {
      const history = result.safetyHistory;
      Object.keys(history).forEach(url => {
        if (Array.isArray(history[url])) {
          history[url] = history[url].filter(entry => entry.timestamp && entry.timestamp >= cutoffTime);
          if (history[url].length === 0) {
            delete history[url];
          }
          updated = true;
        }
      });
      if (updated) {
        await safeStorage.set({ safetyHistory: history });
      }
    }

    // Update last clear timestamp
    await safeStorage.set({ lastCacheClear: Date.now() });

    if (updated) {
      await updateCacheSizeDisplay();
    }
  } catch (error) {
    console.error('Error clearing old cache entries:', error);
  }
}

async function clearCache() {
  if (isPreviewMode) {
    alert('🧹 In the Chrome extension, this would clear the cache for link and safety checks.');
    return;
  }

  try {
    // Clear storage cache (current)
    await safeStorage.remove(['linkStatusCache', 'safetyStatusCache']);

    // ALSO CLEAR: Reset in-memory bookmark statuses
    function resetStatuses(nodes) {
      nodes.forEach(node => {
        if (node.url) {
          node.linkStatus = 'unknown';
          node.safetyStatus = 'unknown';
          node.safetySources = [];
        }
        if (node.children) resetStatuses(node.children);
      });
    }
    resetStatuses(bookmarkTree);

    // Re-render to show cleared states
    renderBookmarks();

    // Clear IndexedDB cache too (if scanner service available)
    if (window.scannerService && window.scannerService.clearAllCache) {
      await window.scannerService.clearAllCache();
    }

    console.log('Cache cleared successfully');
    alert('Cache cleared! Status indicators reset to unknown.');

    // Update cache size display
    await updateCacheSizeDisplay();
  } catch (error) {
    console.error('Error clearing cache:', error);
    alert('Failed to clear cache. Please try again.');
  }
}

// Rescan all bookmarks (clear cache and force re-check)
// Now delegates to background service worker for persistent scanning
async function rescanAllBookmarks() {
  if (isPreviewMode) {
    alert('🔄 In the Chrome extension, this would clear cache and rescan all bookmarks.');
    return;
  }

  try {
    // Stop any ongoing background scan first
    await chrome.runtime.sendMessage({ action: 'stopBackgroundScan' });

    // Wait a moment for the scan to stop
    await new Promise(resolve => setTimeout(resolve, 500));

    // Clear the checkedBookmarks set to allow re-checking
    checkedBookmarks.clear();

    // Reset all bookmark statuses to unknown
    function resetBookmarkStatuses(nodes) {
      nodes.forEach(node => {
        if (node.url) {
          updateBookmarkInTree(node.id, {
            linkStatus: 'unknown',
            safetyStatus: 'unknown'
          });
        }
        if (node.children) {
          resetBookmarkStatuses(node.children);
        }
      });
    }

    resetBookmarkStatuses(bookmarkTree);
    renderBookmarks();

    // Start background scan (runs in background service worker)
    const response = await chrome.runtime.sendMessage({ action: 'startBackgroundScan' });

    if (!response.success) {
      console.error('Failed to start background scan:', response.message);
      alert('Failed to start scan: ' + response.message);
    }

  } catch (error) {
    console.error('Error rescanning bookmarks:', error);
    alert('Failed to rescan bookmarks. Please try again.');
  }
}

// Update selected items count
function updateSelectedCount() {
  const selectedCount = document.getElementById('selectedCount');
  if (selectedCount) {
    selectedCount.textContent = selectedItems.size;
  }
}

// Bulk recheck selected items
async function bulkRecheckItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select items to recheck.');
    return;
  }

  if (!confirm(`Are you sure you want to recheck ${selectedItems.size} selected item(s)?`)) {
    return;
  }

  const itemsToRecheck = Array.from(selectedItems);

  // Find all bookmarks in selected items (including bookmarks in selected folders)
  const bookmarksToRecheck = [];

  for (const itemId of itemsToRecheck) {
    const item = findBookmarkById(allBookmarks, itemId);
    if (item) {
      if (item.url) {
        bookmarksToRecheck.push(item);
      } else if (item.children) {
        // Get all bookmarks in folder recursively
        const folderBookmarks = getAllBookmarksInFolder(item);
        bookmarksToRecheck.push(...folderBookmarks);
      }
    }
  }

  // Remove from checked set to force recheck
  bookmarksToRecheck.forEach(b => checkedBookmarks.delete(b.id));

  // Recheck
  await autoCheckBookmarkStatuses();

  alert(`Rechecked ${bookmarksToRecheck.length} bookmark(s).`);
}

// Bulk move selected items
async function bulkMoveItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select items to move.');
    return;
  }

  // Get all folders for selection
  const folders = getAllFolders(allBookmarks);

  // Create folder selection prompt
  let folderList = 'Select destination folder by number:\n\n';
  folders.forEach((folder, index) => {
    const indent = '  '.repeat(folder.depth || 0);
    folderList += `${index + 1}. ${indent}${folder.title || 'Unnamed Folder'}\n`;
  });

  const selection = prompt(folderList + '\nEnter folder number:');
  if (!selection) return;

  const folderIndex = parseInt(selection) - 1;
  if (isNaN(folderIndex) || folderIndex < 0 || folderIndex >= folders.length) {
    alert('Invalid folder selection.');
    return;
  }

  const destinationFolder = folders[folderIndex];

  if (!confirm(`Move ${selectedItems.size} item(s) to "${destinationFolder.title}"?`)) {
    return;
  }

  try {
    // Move each selected item
    for (const itemId of selectedItems) {
      // Get item details before moving
      const items = await chrome.bookmarks.get(itemId);
      const item = items[0];
      const oldParentPath = item.parentId ? await getFolderPath(item.parentId) : 'Root';

      await chrome.bookmarks.move(itemId, { parentId: destinationFolder.id });

      // Add to changelog
      const newParentPath = await getFolderPath(destinationFolder.id);
      const itemType = item.url ? 'bookmark' : 'folder';
      await addChangelogEntry('move', itemType, item.title, item.url || null, {
        fromFolder: oldParentPath,
        toFolder: newParentPath
      });
    }

    selectedItems.clear();
    await loadBookmarks();
    renderBookmarks();
    updateSelectedCount();

    alert(`Successfully moved items to "${destinationFolder.title}".`);
  } catch (error) {
    console.error('Error moving items:', error);
    alert('Failed to move some items. Please try again.');
  }
}

// Bulk delete selected items
async function bulkDeleteItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select items to delete.');
    return;
  }

  if (!confirm(`⚠️ WARNING: This will permanently delete ${selectedItems.size} selected item(s) and all their contents.\n\nThis action cannot be undone. Are you sure?`)) {
    return;
  }

  try {
    // Delete each selected item
    for (const itemId of selectedItems) {
      await chrome.bookmarks.removeTree(itemId);
    }

    selectedItems.clear();
    await loadBookmarks();
    renderBookmarks();
    updateSelectedCount();

    alert('Selected items deleted successfully.');
  } catch (error) {
    console.error('Error deleting items:', error);
    alert('Failed to delete some items. Please try again.');
  }
}

// Get all bookmarks in a folder recursively
function getAllBookmarksInFolder(folder) {
  const bookmarks = [];

  function traverse(node) {
    if (node.url) {
      bookmarks.push(node);
    } else if (node.children) {
      node.children.forEach(child => traverse(child));
    }
  }

  if (folder.children) {
    folder.children.forEach(child => traverse(child));
  }

  return bookmarks;
}

// Get all folders from bookmark tree
function getAllFolders(nodes, depth = 0) {
  const folders = [];

  nodes.forEach(node => {
    if (node.children) {
      folders.push({ ...node, depth });
      folders.push(...getAllFolders(node.children, depth + 1));
    }
  });

  return folders;
}

// Setup event listeners
function setupEventListeners() {
  // Search
  searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderBookmarks();
  });

  // Filter toggle
  filterToggle.addEventListener('click', () => {
    filterBar.classList.toggle('hidden');
  });

  // Display toggle
  displayToggle.addEventListener('click', () => {
    displayBar.classList.toggle('hidden');
  });

  // Display option toggles
  const displayTitle = document.getElementById('displayTitle');
  const displayUrl = document.getElementById('displayUrl');

  displayTitle.addEventListener('change', (e) => {
    // Ensure at least Title or URL is checked
    if (!e.target.checked && !displayUrl.checked) {
      e.target.checked = true;
      return;
    }
    displayOptions.title = e.target.checked;
    renderBookmarks();
  });

  displayUrl.addEventListener('change', (e) => {
    // Ensure at least Title or URL is checked
    if (!e.target.checked && !displayTitle.checked) {
      e.target.checked = true;
      return;
    }
    displayOptions.url = e.target.checked;
    renderBookmarks();
  });

  const displayFavicon = document.getElementById('displayFavicon');
  displayFavicon.addEventListener('change', (e) => {
    displayOptions.favicon = e.target.checked;
    renderBookmarks();
  });

  const displayLiveStatus = document.getElementById('displayLiveStatus');
  const displaySafetyStatus = document.getElementById('displaySafetyStatus');
  const displayPreview = document.getElementById('displayPreview');

  displayLiveStatus.addEventListener('change', (e) => {
    displayOptions.liveStatus = e.target.checked;
    renderBookmarks();
  });

  displaySafetyStatus.addEventListener('change', (e) => {
    displayOptions.safetyStatus = e.target.checked;
    renderBookmarks();
  });

  displayPreview.addEventListener('change', (e) => {
    displayOptions.preview = e.target.checked;
    renderBookmarks();
  });

  const displayPreviewPopup = document.getElementById('displayPreviewPopup');
  displayPreviewPopup.addEventListener('change', async (e) => {
    previewPopupEnabled = e.target.checked;
    await chrome.storage.local.set({ previewPopupEnabled: previewPopupEnabled });
    if (!previewPopupEnabled) {
      hidePreviewPopup();
    }
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const filter = chip.dataset.filter;

      const index = activeFilters.indexOf(filter);
      if (index > -1) {
        // Remove filter if already active
        activeFilters.splice(index, 1);
        chip.classList.remove('active');
      } else {
        // Add filter
        activeFilters.push(filter);
        chip.classList.add('active');
      }

      renderBookmarks();
    });
  });

  // QR Code button - generate QR for current page URL
  if (qrCodeBtn) {
    qrCodeBtn.addEventListener('click', async () => {
      // Get the current active tab URL
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0] && tabs[0].url) {
          showQRCodePopup(tabs[0].url);
        } else {
          // Fallback: show with empty URL so user can paste one
          showQRCodePopup('');
        }
      } catch (error) {
        console.error('Error getting current tab URL:', error);
        // Fallback: show with empty URL so user can paste one
        showQRCodePopup('');
      }
    });
  }

  // Theme menu
  themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = themeMenu.classList.contains('show');
    closeAllMenus();
    if (!wasOpen) {
      themeMenu.classList.add('show');
      positionFixedDropdown(themeMenu, themeBtn);
    }
  });

  // Theme selection
  // Theme dropdown
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      setTheme(themeSelect.value);
    });
  }

  // Tint control event listeners
  const tintHueInput = document.getElementById('tintHue');
  const tintSaturationInput = document.getElementById('tintSaturation');
  const hueValueSpan = document.getElementById('hueValue');
  const saturationValueSpan = document.getElementById('saturationValue');

  if (tintHueInput && tintSaturationInput) {
    tintHueInput.addEventListener('input', (e) => {
      const hue = e.target.value;
      if (hueValueSpan) hueValueSpan.textContent = `${hue}°`;
      applyTintSettings(parseInt(hue), parseInt(tintSaturationInput.value));
    });

    tintSaturationInput.addEventListener('input', (e) => {
      const saturation = e.target.value;
      if (saturationValueSpan) saturationValueSpan.textContent = `${saturation}%`;
      applyTintSettings(parseInt(tintHueInput.value), parseInt(saturation));
    });
  }

  // View menu
  viewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = viewMenu.classList.contains('show');
    closeAllMenus();
    if (!wasOpen) {
      viewMenu.classList.add('show');
      positionFixedDropdown(viewMenu, viewBtn);
    }
  });

  // View selection
  viewMenu.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedView = btn.dataset.view;
      setView(selectedView);
      closeAllMenus();
    });
  });

  // Zoom menu
  zoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = zoomMenu.classList.contains('show');
    closeAllMenus();
    if (!wasOpen) {
      zoomMenu.classList.add('show');
      positionFixedDropdown(zoomMenu, zoomBtn);
    }
  });

  // Helper function to update slider progress bar
  function updateSliderProgress(slider, value, min, max) {
    const progress = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--zoom-progress', `${progress}%`);
  }

  // Zoom slider
  zoomSlider.addEventListener('input', (e) => {
    const newZoom = parseInt(e.target.value);
    setZoom(newZoom);
    updateSliderProgress(e.target, newZoom, 50, 200);
  });

  // Font size slider
  fontSizeSlider.addEventListener('input', (e) => {
    const newSize = parseInt(e.target.value);
    setFontSize(newSize);
    updateSliderProgress(e.target, newSize, 70, 150);
  });

  // GUI scale select
  guiScaleSelect.addEventListener('change', (e) => {
    guiScale = parseInt(e.target.value);
    applyGuiScale();
    localStorage.setItem('guiScale', guiScale);
  });

  // Manual sync button
  const manualSyncBtn = document.getElementById('manualSyncBtn');
  if (manualSyncBtn) {
    manualSyncBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      if (!snippetToken) {
        console.warn('You must log in or provide a PAT token before using Manual Sync.');
        return;
      }

      const forcePush = e.shiftKey;
      if (forcePush) {
        if (!confirm('Force push local bookmarks to remote? This will overwrite the remote with your local data.')) {
          return;
        }
      }

      manualSyncBtn.disabled = true;
      const originalContent = manualSyncBtn.innerHTML;
      manualSyncBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/></svg>';

      try {
        if (forcePush) {
          await syncToSnippet();
          showToast('Bookmarks pushed to GitLab successfully', 'success');
        } else {
          await syncFromSnippet();
          showToast('Sync completed successfully', 'success');
        }
      } catch (error) {
        console.error('[ManualSync] Sync failed:', error);
        showToast(`Sync failed: ${error.message}`, 'error');
      } finally {
        manualSyncBtn.disabled = false;
        manualSyncBtn.innerHTML = originalContent;
      }
    });
  }

  // GitLab account button
  if (gitlabBtn) {
    gitlabBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      
      if (snippetToken && snippetId) {
        showGitLabDisconnectDialog();
      } else {
        await openSnippetSyncDialog();
      }
    });
  }

  // Settings menu
  settingsBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasOpen = settingsMenu.classList.contains('show');
    closeAllMenus();
    if (!wasOpen) {
      settingsMenu.classList.add('show');
      positionFixedDropdown(settingsMenu, settingsBtn);
      // Update cache size display when menu opens
      await updateCacheSizeDisplay();
    }
  });

  // Open in new tab
  openInTabBtn.addEventListener('click', () => {
    openInNewTab();
    closeAllMenus();
  });

  // Export bookmarks (backup)
  exportBookmarksBtn.addEventListener('click', () => {
    exportBookmarks();
    closeAllMenus();
  });

  // View changelog
  viewChangelogBtn.addEventListener('click', async () => {
    await openChangelogModal();
    closeAllMenus();
  });

  // Clear changelog
  clearChangelogBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all changelog history? This action cannot be undone.')) {
      await clearChangelog();
      await openChangelogModal();
    }
  });

  // Clear cache
  clearCacheBtn.addEventListener('click', async () => {
    await clearCache();
    closeAllMenus();
  });

  const snippetSyncBtn = document.getElementById('snippetSyncBtn');
  if (snippetSyncBtn) {
    snippetSyncBtn.addEventListener('click', async () => {
      await openSnippetSyncDialog();
      closeAllMenus();
    });
  }

  // Auto-clear cache setting
  autoClearCacheSelect.addEventListener('change', async (e) => {
    const autoClearDays = e.target.value;
    await safeStorage.set({ autoClearCacheDays: autoClearDays });

    // Run auto-clear immediately if enabled
    if (autoClearDays !== 'never') {
      await clearOldCacheEntries(autoClearDays);
    }
  });

  // Default start folder setting
  defaultFolderSelect.addEventListener('change', (e) => {
    const selectedFolderId = e.target.value;
    if (selectedFolderId) {
      localStorage.setItem('defaultStartFolder', selectedFolderId);
    } else {
      localStorage.removeItem('defaultStartFolder');
    }
  });

  // Link checking toggle
  const enableLinkCheckingToggle = document.getElementById('enableLinkChecking');
  enableLinkCheckingToggle.addEventListener('change', (e) => {
    linkCheckingEnabled = e.target.checked;
    localStorage.setItem('linkCheckingEnabled', linkCheckingEnabled);
  });

  // Safety checking toggle
  const enableSafetyCheckingToggle = document.getElementById('enableSafetyChecking');
  enableSafetyCheckingToggle.addEventListener('change', (e) => {
    safetyCheckingEnabled = e.target.checked;
    localStorage.setItem('safetyCheckingEnabled', safetyCheckingEnabled);
  });

  // Accent color picker - applies in real-time as user picks
  accentColorPicker.addEventListener('input', (e) => {
    const color = e.target.value;
    applyAccentColor(color);
    localStorage.setItem('customAccentColor', color);
  });

  // Done button for accent color - just closes the menu
  doneAccentColorBtn.addEventListener('click', () => {
    closeAllMenus();
  });

  // Reset accent color
  resetAccentColorBtn.addEventListener('click', () => {
    const defaultColor = getDefaultAccentColor();
    accentColorPicker.value = defaultColor;
    applyAccentColor(defaultColor);
    localStorage.removeItem('customAccentColor');
  });

  // Load saved accent color on startup
  function loadSavedAccentColor() {
    const savedColor = localStorage.getItem('customAccentColor');
    if (savedColor) {
      accentColorPicker.value = savedColor;
      applyAccentColor(savedColor);
    } else {
      const defaultColor = getDefaultAccentColor();
      accentColorPicker.value = defaultColor;
    }
  }

  // Get default accent color based on current theme
  function getDefaultAccentColor() {
    const isDarkMode = document.body.classList.contains('blue-dark') || document.body.classList.contains('dark');
    if (document.body.classList.contains('dark')) {
      return '#bb86fc'; // Pure dark theme purple
    } else if (isDarkMode) {
      return '#818cf8'; // Blue dark theme
    } else {
      return '#6366f1'; // Light theme default
    }
  }

  // Apply accent color by calling the global function
  function applyAccentColor(color) {
    applyCustomAccentColor(color);
  }

  // Container Opacity Slider
  containerOpacity.addEventListener('input', (e) => {
    const value = e.target.value;
    containerOpacityValue.textContent = value + '%';
    const opacity = value / 100;
    document.documentElement.style.setProperty('--bookmark-container-opacity', opacity);
    localStorage.setItem('containerOpacity', value);
  });

  // Load saved container opacity
  const savedOpacity = localStorage.getItem('containerOpacity');
  if (savedOpacity) {
    containerOpacity.value = savedOpacity;
    containerOpacityValue.textContent = savedOpacity + '%';
    const opacity = savedOpacity / 100;
    document.documentElement.style.setProperty('--bookmark-container-opacity', opacity);
  } else {
    // Set default 100% opacity
    document.documentElement.style.setProperty('--bookmark-container-opacity', 1);
  }

  // Dark Text Toggle removed - no longer needed

  // Text Color Picker - applies in real-time as user picks
  textColorPicker.addEventListener('input', (e) => {
    const color = e.target.value;
    applyCustomTextColor(color);
    localStorage.setItem('customTextColor', color);
  });

  // Done button for text color - just closes the menu
  doneTextColorBtn.addEventListener('click', () => {
    closeAllMenus();
  });

  // Reset Text Color
  resetTextColor.addEventListener('click', () => {
    const defaultColor = '#ffffff';
    textColorPicker.value = defaultColor;
    applyCustomTextColor(defaultColor);
    localStorage.removeItem('customTextColor');
  });

  // Apply custom text color using CSS variable
  function applyCustomTextColor(color) {
    document.documentElement.style.setProperty('--custom-text-color', color);
  }

  // Load saved text color on startup
  function loadCustomTextColor() {
    const savedColor = localStorage.getItem('customTextColor');
    if (savedColor) {
      textColorPicker.value = savedColor;
      applyCustomTextColor(savedColor);
    } else {
      textColorPicker.value = '#ffffff';
      applyCustomTextColor('#ffffff');
    }
  }

  // Initialize accent color on page load
  loadSavedAccentColor();

  // Initialize custom text color on page load
  loadCustomTextColor();

  // Background image functionality
  function applyBackgroundImage(imageData, opacity, blur, size, positionX, positionY, scale) {
    if (imageData) {
      // Create or update background overlay
      let bgOverlay = document.getElementById('background-overlay');
      if (!bgOverlay) {
        bgOverlay = document.createElement('div');
        bgOverlay.id = 'background-overlay';
        bgOverlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 0;
          pointer-events: none;
          background-repeat: no-repeat;
        `;
        document.body.insertBefore(bgOverlay, document.body.firstChild);

        // Make sure container has higher z-index
        const container = document.querySelector('.container');
        if (container && !container.style.position) {
          container.style.position = 'relative';
          container.style.zIndex = '1';
        }

        // Make sure status bar has higher z-index
        const statusBar = document.getElementById('scanStatusBar');
        if (statusBar) {
          statusBar.style.position = 'relative';
          statusBar.style.zIndex = '2';
        }
      }
      bgOverlay.style.backgroundImage = `url(${imageData})`;
      bgOverlay.style.opacity = opacity / 100;
      bgOverlay.style.filter = `blur(${blur}px)`;
      bgOverlay.style.backgroundSize = size || 'cover';
      bgOverlay.style.backgroundPosition = `${positionX || 50}% ${positionY || 50}%`;

      // Apply scale by using transform
      // Keep transform origin at center to avoid conflicts with background-position
      if (scale && scale != 100) {
        const scalePercent = scale / 100;
        bgOverlay.style.transform = `scale(${scalePercent})`;
        bgOverlay.style.transformOrigin = 'center center';
      } else {
        bgOverlay.style.transform = 'none';
        bgOverlay.style.transformOrigin = 'center center';
      }
    } else {
      // Remove background overlay
      const bgOverlay = document.getElementById('background-overlay');
      if (bgOverlay) {
        bgOverlay.remove();
      }
    }
  }

  function loadSavedBackgroundImage() {
    const savedImage = localStorage.getItem('backgroundImage');
    const savedOpacity = localStorage.getItem('backgroundOpacity');
    const savedBlur = localStorage.getItem('backgroundBlur');
    const savedSize = localStorage.getItem('backgroundSize');
    const savedPositionX = localStorage.getItem('backgroundPositionX');
    const savedPositionY = localStorage.getItem('backgroundPositionY');
    const savedScale = localStorage.getItem('backgroundScale');

    if (savedOpacity) {
      backgroundOpacitySlider.value = savedOpacity;
      opacityValue.textContent = `${savedOpacity}%`;
    }
    if (savedBlur) {
      backgroundBlurSlider.value = savedBlur;
      blurValue.textContent = `${savedBlur}px`;
    }
    if (savedSize) {
      backgroundSizeSelect.value = savedSize;
    }
    if (savedScale) {
      backgroundScaleSlider.value = savedScale;
      scaleValue.textContent = `${savedScale}%`;
    }

    if (savedImage) {
      applyBackgroundImage(
        savedImage,
        savedOpacity || 100,
        savedBlur || 0,
        savedSize || 'contain',
        savedPositionX || 50,
        savedPositionY || 50,
        savedScale || 200
      );
    }
  }

  // Choose background image button
  chooseBackgroundImageBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    backgroundImagePicker.click();
  });

  // Handle file selection
  backgroundImagePicker.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const imageData = event.target.result;
        localStorage.setItem('backgroundImage', imageData);
        const positionX = localStorage.getItem('backgroundPositionX') || 50;
        const positionY = localStorage.getItem('backgroundPositionY') || 50;
        applyBackgroundImage(
          imageData,
          backgroundOpacitySlider.value,
          backgroundBlurSlider.value,
          backgroundSizeSelect.value,
          positionX,
          positionY,
          backgroundScaleSlider.value
        );
      };
      reader.readAsDataURL(file);
    }
  });

  // Remove background image
  removeBackgroundImageBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    localStorage.removeItem('backgroundImage');
    applyBackgroundImage(null);
    backgroundImagePicker.value = '';
  });

  // Opacity slider
  backgroundOpacitySlider.addEventListener('input', (e) => {
    const value = e.target.value;
    opacityValue.textContent = `${value}%`;
    localStorage.setItem('backgroundOpacity', value);
    const savedImage = localStorage.getItem('backgroundImage');
    if (savedImage) {
      const positionX = localStorage.getItem('backgroundPositionX') || 50;
      const positionY = localStorage.getItem('backgroundPositionY') || 50;
      applyBackgroundImage(
        savedImage,
        value,
        backgroundBlurSlider.value,
        backgroundSizeSelect.value,
        positionX,
        positionY,
        backgroundScaleSlider.value
      );
    }
  });

  // Blur slider
  backgroundBlurSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    blurValue.textContent = `${value}px`;
    localStorage.setItem('backgroundBlur', value);
    const savedImage = localStorage.getItem('backgroundImage');
    if (savedImage) {
      const positionX = localStorage.getItem('backgroundPositionX') || 50;
      const positionY = localStorage.getItem('backgroundPositionY') || 50;
      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        value,
        backgroundSizeSelect.value,
        positionX,
        positionY,
        backgroundScaleSlider.value
      );
    }
  });

  // Size selector
  backgroundSizeSelect.addEventListener('change', (e) => {
    const value = e.target.value;
    localStorage.setItem('backgroundSize', value);
    const savedImage = localStorage.getItem('backgroundImage');
    if (savedImage) {
      const positionX = localStorage.getItem('backgroundPositionX') || 50;
      const positionY = localStorage.getItem('backgroundPositionY') || 50;
      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        backgroundBlurSlider.value,
        value,
        positionX,
        positionY,
        backgroundScaleSlider.value
      );
    }
  });

  // Scale slider
  backgroundScaleSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    scaleValue.textContent = `${value}%`;
    localStorage.setItem('backgroundScale', value);
    const savedImage = localStorage.getItem('backgroundImage');
    if (savedImage) {
      const positionX = localStorage.getItem('backgroundPositionX') || 50;
      const positionY = localStorage.getItem('backgroundPositionY') || 50;
      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        backgroundBlurSlider.value,
        backgroundSizeSelect.value,
        positionX,
        positionY,
        value
      );
    }
  });

  // Drag to reposition functionality
  let isDragging = false;

  repositionBackgroundBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const savedImage = localStorage.getItem('backgroundImage');
    if (!savedImage) {
      return;
    }

    const bgOverlay = document.getElementById('background-overlay');
    if (!bgOverlay) return;

    // Reload current position from localStorage when entering drag mode
    let currentPosX = parseFloat(localStorage.getItem('backgroundPositionX')) || 50;
    let currentPosY = parseFloat(localStorage.getItem('backgroundPositionY')) || 50;
    let dragStartX = 0;
    let dragStartY = 0;

    // Show the drag mode overlay and close all menus
    dragModeOverlay.style.display = 'flex';
    closeAllMenus();

    // Enable dragging - raise z-index above everything (10001)
    bgOverlay.style.cursor = 'move';
    bgOverlay.style.pointerEvents = 'auto';
    bgOverlay.style.zIndex = '10001';

    // Also raise banner to stay on top of overlay
    dragModeOverlay.style.zIndex = '10002';

    const handleMouseDown = (event) => {
      // Don't start dragging if clicking on the exit button
      if (event.target === closeDragModeBtn || closeDragModeBtn.contains(event.target)) {
        return;
      }

      isDragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleMouseMove = (event) => {
      if (!isDragging) return;

      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;

      // Convert pixel movement to percentage based on window size
      const percentX = (deltaX / window.innerWidth) * 100;
      const percentY = (deltaY / window.innerHeight) * 100;

      // Update positions with stricter limits (-50% to 150%)
      currentPosX = Math.max(-50, Math.min(150, currentPosX + percentX));
      currentPosY = Math.max(-50, Math.min(150, currentPosY + percentY));

      dragStartX = event.clientX;
      dragStartY = event.clientY;

      console.log('Drag move:', { deltaX, deltaY, percentX, percentY, currentPosX, currentPosY });

      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        backgroundBlurSlider.value,
        backgroundSizeSelect.value,
        currentPosX,
        currentPosY,
        backgroundScaleSlider.value
      );
    };

    const handleMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        localStorage.setItem('backgroundPositionX', currentPosX);
        localStorage.setItem('backgroundPositionY', currentPosY);
      }
    };

    const handleWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();

      // Get current scale from slider
      let currentScale = parseFloat(backgroundScaleSlider.value);

      // Adjust scale based on scroll direction
      // Scroll down (deltaY > 0) = zoom out, Scroll up (deltaY < 0) = zoom in
      const scaleChange = event.deltaY > 0 ? -5 : 5;
      currentScale = Math.max(10, Math.min(1000, currentScale + scaleChange));

      // Update slider and display
      backgroundScaleSlider.value = currentScale;
      scaleValue.textContent = `${currentScale}%`;

      // Save to localStorage
      localStorage.setItem('backgroundScale', currentScale);

      // Apply the new scale
      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        backgroundBlurSlider.value,
        backgroundSizeSelect.value,
        currentPosX,
        currentPosY,
        currentScale
      );
    };

    const stopDragging = () => {
      isDragging = false;
      bgOverlay.style.cursor = 'default';
      bgOverlay.style.pointerEvents = 'none';
      bgOverlay.style.zIndex = '0';

      // Hide the banner and restore its z-index
      dragModeOverlay.style.display = 'none';
      dragModeOverlay.style.zIndex = '100';

      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('wheel', handleWheel);
      closeDragModeBtn.removeEventListener('click', stopDragging);

      // Save final position
      localStorage.setItem('backgroundPositionX', currentPosX);
      localStorage.setItem('backgroundPositionY', currentPosY);
    };

    // Listen on document instead of bgOverlay to bypass any blocking elements
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('wheel', handleWheel, { passive: false });

    // Set up banner close handler
    closeDragModeBtn.addEventListener('click', stopDragging);
  });

  // Load saved background image on page load
  loadSavedBackgroundImage();

  // Rescan all bookmarks
  rescanAllBtn.addEventListener('click', async () => {
    await rescanAllBookmarks();
    closeAllMenus();
  });

  // Stop scan button
  const stopScanBtn = document.getElementById('stopScanBtn');
  if (stopScanBtn) {
    stopScanBtn.addEventListener('click', async () => {
      // Stop background scan
      await chrome.runtime.sendMessage({ action: 'stopBackgroundScan' });
      console.log('User requested scan cancellation');
    });
  }

  // Set Google API Key
  setApiKeyBtn.addEventListener('click', async () => {
    const currentKey = await getDecryptedApiKey('googleSafeBrowsingApiKey');
    const hasKey = currentKey && currentKey.length > 0;

    const promptMessage = hasKey
      ? 'Google Safe Browsing API Key is currently set.\n\nEnter a new key to update, or leave blank to remove:'
      : 'Enter your Google Safe Browsing API Key:\n\n(Get a free key at: https://developers.google.com/safe-browsing/v4/get-started)\nFree tier: 10,000 requests/day\n\nLeave blank to disable Google Safe Browsing redundancy check.';

    const apiKey = prompt(promptMessage, '');

    if (apiKey !== null) { // User clicked OK (not Cancel)
      if (apiKey.trim() === '') {
        // Remove API key
        await safeStorage.remove('googleSafeBrowsingApiKey');
        alert('Google Safe Browsing API key removed.\n\nOnly URLhaus will be used for safety checking.');
      } else {
        // Save encrypted API key
        await storeEncryptedApiKey('googleSafeBrowsingApiKey', apiKey.trim());
        alert('Google Safe Browsing API key saved securely!\n\nSafety checking will now use:\n1. URLhaus (primary)\n2. Google Safe Browsing (redundancy)');
      }
      updateApiKeyButtonLabels();
    }
    closeAllMenus();
  });

  // Set VirusTotal API Key
  document.getElementById('setVirusTotalApiKeyBtn').addEventListener('click', async () => {
    const currentKey = await getDecryptedApiKey('virusTotalApiKey');
    const hasKey = currentKey && currentKey.length > 0;

    const promptMessage = hasKey
      ? 'VirusTotal API Key is currently set.\n\nEnter a new key to update, or leave blank to remove:'
      : 'Enter your VirusTotal API Key:\n\n(Get a free key at: https://www.virustotal.com/gui/my-apikey)\nFree tier: 500 requests/day, 4 requests/minute\n\nLeave blank to disable VirusTotal checking.';

    const apiKey = prompt(promptMessage, '');

    if (apiKey !== null) { // User clicked OK (not Cancel)
      if (apiKey.trim() === '') {
        // Remove API key
        await safeStorage.remove('virusTotalApiKey');
        alert('VirusTotal API key removed.\n\nVirusTotal checking is now disabled.');
      } else {
        // Save encrypted API key
        await storeEncryptedApiKey('virusTotalApiKey', apiKey.trim());
        alert('VirusTotal API key saved securely!\n\nSafety checking will now include VirusTotal scans.');
      }
      updateApiKeyButtonLabels();
    }
    closeAllMenus();
  });

  // Set Yandex API Key
  document.getElementById('setYandexApiKeyBtn').addEventListener('click', async () => {
    const currentKey = await getDecryptedApiKey('yandexApiKey');
    const hasKey = currentKey && currentKey.length > 0;

    const promptMessage = hasKey
      ? 'Yandex Safe Browsing API Key is currently set.\n\nEnter a new key to update, or leave blank to remove:'
      : 'Enter your Yandex Safe Browsing API Key:\n\n(Register at: https://yandex.com/dev/)\nFree tier: 100,000 requests/day\n\nLeave blank to disable Yandex Safe Browsing.';

    const apiKey = prompt(promptMessage, '');

    if (apiKey !== null) { // User clicked OK (not Cancel)
      if (apiKey.trim() === '') {
        // Remove API key
        await safeStorage.remove('yandexApiKey');
        alert('Yandex Safe Browsing API key removed.\n\nYandex checking is now disabled.');
      } else {
        // Save encrypted API key
        await storeEncryptedApiKey('yandexApiKey', apiKey.trim());
        alert('Yandex Safe Browsing API key saved securely!\n\nSafety checking will now include Yandex Safe Browsing.');
      }
      updateApiKeyButtonLabels();
    }
    closeAllMenus();
  });

  // Function to update API key button labels
  async function updateApiKeyButtonLabels() {
    const googleKey = await getDecryptedApiKey('googleSafeBrowsingApiKey');
    const vtKey = await getDecryptedApiKey('virusTotalApiKey');
    const yandexKey = await getDecryptedApiKey('yandexApiKey');

    const googleBtn = document.querySelector('#setApiKeyBtn span:last-child');
    const vtBtn = document.querySelector('#setVirusTotalApiKeyBtn span:last-child');
    const yandexBtn = document.querySelector('#setYandexApiKeyBtn span:last-child');

    if (googleBtn) {
      googleBtn.textContent = (googleKey && googleKey.length > 0)
        ? 'Change/Remove Google API Key'
        : 'Set Google API Key';
    }
    if (vtBtn) {
      vtBtn.textContent = (vtKey && vtKey.length > 0)
        ? 'Change/Remove VirusTotal API Key'
        : 'Set VirusTotal API Key';
    }
    if (yandexBtn) {
      yandexBtn.textContent = (yandexKey && yandexKey.length > 0)
        ? 'Change/Remove Yandex API Key'
        : 'Set Yandex API Key';
    }
  }

  // Update button labels on load
  updateApiKeyButtonLabels();

  // Help & Documentation
  const helpDocsBtn = document.getElementById('helpDocsBtn');
  helpDocsBtn.addEventListener('click', () => {
    const readmeUrl = 'https://bmz.absolutezero.fyi/';
    if (isPreviewMode) {
      window.open(readmeUrl, '_blank');
    } else {
      chrome.tabs.create({ url: readmeUrl });
    }
    closeAllMenus();
  });

  // Buy Me a Coffee
  const buyMeCoffeeBtn = document.getElementById('buyMeCoffeeBtn');
  buyMeCoffeeBtn.addEventListener('click', () => {
    const coffeeUrl = 'https://buymeacoffee.com/absolutexyzero';
    if (isPreviewMode) {
      window.open(coffeeUrl, '_blank');
    } else {
      chrome.tabs.create({ url: coffeeUrl });
    }
    closeAllMenus();
  });

  // Close extension
  closeExtensionBtn.addEventListener('click', () => {
    closeExtension();
    closeAllMenus();
  });

  // New bookmark
  document.getElementById('newBookmarkBtn').addEventListener('click', createNewBookmark);

  // New folder
  document.getElementById('newFolderBtn').addEventListener('click', createNewFolder);

  // Find duplicates
  document.getElementById('findDuplicatesBtn').addEventListener('click', findDuplicates);

  // Header collapse/expand
  headerCollapseBtn.addEventListener('click', () => {
    const isCollapsed = collapsibleHeader.classList.toggle('collapsed');
    headerCollapseBtn.classList.toggle('collapsed');
    headerCollapseBtn.title = isCollapsed ? 'Expand header' : 'Collapse header';

    // Save state to localStorage
    localStorage.setItem('headerCollapsed', isCollapsed);
  });

  // Restore header collapse state
  const headerCollapsed = localStorage.getItem('headerCollapsed') === 'true';
  if (headerCollapsed) {
    collapsibleHeader.classList.add('collapsed');
    headerCollapseBtn.classList.add('collapsed');
    headerCollapseBtn.title = 'Expand header';
  }

  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    // Check if click is inside any menu or menu button
    const clickedInsideMenu = e.target.closest('.bookmark-actions') ||
                              e.target.closest('#settingsMenu') ||
                              e.target.closest('#themeMenu') ||
                              e.target.closest('#viewMenu') ||
                              e.target.closest('#zoomMenu');

    const clickedMenuButton = e.target.closest('.bookmark-menu-btn') ||
                              e.target.closest('.folder-menu-btn') ||
                              e.target.closest('#settingsBtn') ||
                              e.target.closest('#themeBtn') ||
                              e.target.closest('#viewBtn') ||
                              e.target.closest('#zoomBtn');

    const clickedPreview = e.target.closest('.bookmark-preview-container');

    // Close menus if clicking outside of menus, menu buttons, or previews
    if (!clickedInsideMenu && !clickedMenuButton && !clickedPreview) {
      closeAllMenus();
    }

    // Handle clicks on status icons (shield and chain)
    const statusIcon = e.target.closest('.clickable-status');
    if (statusIcon) {
      e.stopPropagation();
      const message = statusIcon.dataset.statusMessage;
      if (message) {
        alert(message);
      }
    }
  });

  // Edit modal event listeners
  const editModal = document.getElementById('editModal');
  const editModalClose = document.getElementById('editModalClose');
  const editModalCancel = document.getElementById('editModalCancel');
  const editModalSave = document.getElementById('editModalSave');
  const editModalOverlay = editModal.querySelector('.modal-overlay');

  editModalClose.addEventListener('click', closeEditModal);
  editModalCancel.addEventListener('click', closeEditModal);
  editModalSave.addEventListener('click', saveEditModal);
  editModalOverlay.addEventListener('click', closeEditModal);

  // Allow Enter key to save in modal
  editModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditModal();
    } else if (e.key === 'Escape') {
      closeEditModal();
    }
  });

  // Add Bookmark modal event listeners
  const addBookmarkModal = document.getElementById('addBookmarkModal');
  const addBookmarkModalClose = document.getElementById('addBookmarkModalClose');
  const addBookmarkModalCancel = document.getElementById('addBookmarkModalCancel');
  const addBookmarkModalSave = document.getElementById('addBookmarkModalSave');
  const addBookmarkModalOverlay = addBookmarkModal.querySelector('.modal-overlay');

  addBookmarkModalClose.addEventListener('click', closeAddBookmarkModal);
  addBookmarkModalCancel.addEventListener('click', closeAddBookmarkModal);
  addBookmarkModalSave.addEventListener('click', saveNewBookmark);
  addBookmarkModalOverlay.addEventListener('click', closeAddBookmarkModal);

  addBookmarkModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveNewBookmark();
    } else if (e.key === 'Escape') {
      closeAddBookmarkModal();
    }
  });

  // Add Folder modal event listeners
  const addFolderModal = document.getElementById('addFolderModal');
  const addFolderModalClose = document.getElementById('addFolderModalClose');
  const addFolderModalCancel = document.getElementById('addFolderModalCancel');
  const addFolderModalSave = document.getElementById('addFolderModalSave');
  const addFolderModalOverlay = addFolderModal.querySelector('.modal-overlay');

  addFolderModalClose.addEventListener('click', closeAddFolderModal);
  addFolderModalCancel.addEventListener('click', closeAddFolderModal);
  addFolderModalSave.addEventListener('click', saveNewFolder);
  addFolderModalOverlay.addEventListener('click', closeAddFolderModal);

  addFolderModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveNewFolder();
    } else if (e.key === 'Escape') {
      closeAddFolderModal();
    }
  });

  // Duplicates modal event listeners
  const duplicatesModal = document.getElementById('duplicatesModal');
  const duplicatesModalClose = document.getElementById('duplicatesModalClose');
  const duplicatesModalCancel = document.getElementById('duplicatesModalCancel');
  const duplicatesModalDelete = document.getElementById('duplicatesModalDelete');
  const duplicatesModalOverlay = duplicatesModal.querySelector('.modal-overlay');

  duplicatesModalClose.addEventListener('click', closeDuplicatesModal);
  duplicatesModalCancel.addEventListener('click', closeDuplicatesModal);
  duplicatesModalDelete.addEventListener('click', deleteSelectedDuplicates);
  duplicatesModalOverlay.addEventListener('click', closeDuplicatesModal);

  duplicatesModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDuplicatesModal();
    }
  });

  // Changelog modal event listeners
  const changelogModal = document.getElementById('changelogModal');
  const changelogModalClose = document.getElementById('changelogModalClose');
  const changelogModalCancel = document.getElementById('changelogModalCancel');
  const changelogModalOverlay = changelogModal.querySelector('.modal-overlay');

  changelogModalClose.addEventListener('click', closeChangelogModal);
  changelogModalCancel.addEventListener('click', closeChangelogModal);
  changelogModalOverlay.addEventListener('click', closeChangelogModal);

  changelogModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeChangelogModal();
    }
  });

  // BIDIRECTIONAL SYNC: Listen for bookmark changes (only in extension mode)
  // This ensures the extension automatically updates when bookmarks change in Chrome
  if (!isPreviewMode) {
    let syncTimeout = null;

    // Debounced sync function to prevent excessive reloads
    const syncBookmarks = (eventType) => {
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(async () => {
        try {
          await loadBookmarks();
          cleanupSafetyHistory(); // Clean up stale entries after sync
          renderBookmarks();
        } catch (error) {
          console.error('[Bookmark Sync] Failed to sync:', error);
        }
      }, 100); // 100ms debounce
      
      // Trigger event-driven push sync to Snippet (30s debounce, 60s rate limit)
      markSnippetChanges();
    };

    chrome.bookmarks.onCreated.addListener((id, bookmark) => {
      syncBookmarks('onCreated');
    });

    chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
      syncBookmarks('onRemoved');
    });

    chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
      syncBookmarks('onChanged');
    });

    chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
      syncBookmarks('onMoved');
    });

  }

  // Multi-select toggle button
  const multiSelectToggle = document.getElementById('multiSelectToggle');
  multiSelectToggle.addEventListener('click', () => {
    multiSelectMode = !multiSelectMode;

    // Toggle button appearance and ARIA state
    if (multiSelectMode) {
      multiSelectToggle.style.background = 'var(--md-sys-color-primary)';
      multiSelectToggle.style.color = 'var(--md-sys-color-on-primary)';
      multiSelectToggle.setAttribute('aria-pressed', 'true');
    } else {
      multiSelectToggle.style.background = '';
      multiSelectToggle.style.color = '';
      multiSelectToggle.setAttribute('aria-pressed', 'false');
      selectedItems.clear();
    }

    // Show/hide bulk actions bar
    const bulkActionsBar = document.getElementById('bulkActionsBar');
    bulkActionsBar.classList.toggle('hidden', !multiSelectMode);

    // Re-render to show/hide checkboxes
    renderBookmarks();
  });

  // Bulk actions event delegation
  bookmarkList.addEventListener('change', (e) => {
    if (e.target.classList.contains('item-checkbox')) {
      const itemId = e.target.dataset.id;
      if (e.target.checked) {
        selectedItems.add(itemId);
      } else {
        selectedItems.delete(itemId);
      }
      updateSelectedCount();
    }
  });

  // Bulk action buttons
  document.getElementById('bulkSelectAll').addEventListener('click', () => {
    // Select all visible items
    const checkboxes = bookmarkList.querySelectorAll('.item-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = true;
      selectedItems.add(cb.dataset.id);
    });
    updateSelectedCount();
  });

  document.getElementById('bulkDeselectAll').addEventListener('click', () => {
    // Deselect all
    const checkboxes = bookmarkList.querySelectorAll('.item-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = false;
    });
    selectedItems.clear();
    updateSelectedCount();
  });

  document.getElementById('bulkRecheck').addEventListener('click', async () => {
    await bulkRecheckItems();
  });

  document.getElementById('bulkMove').addEventListener('click', async () => {
    await bulkMoveItems();
  });

  document.getElementById('bulkDelete').addEventListener('click', async () => {
    await bulkDeleteItems();
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    // Skip if user is typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    // Skip if a modal is open
    if (!document.getElementById('editModal').classList.contains('hidden') ||
        !document.getElementById('addBookmarkModal').classList.contains('hidden') ||
        !document.getElementById('addFolderModal').classList.contains('hidden') ||
        !document.getElementById('duplicatesModal').classList.contains('hidden')) {
      return;
    }

    // Build list of visible items (both folders and bookmarks)
    const folderElements = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
    const bookmarkElements = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));

    // Combine and sort by DOM position
    const allElements = [...folderElements, ...bookmarkElements].sort((a, b) => {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    if (allElements.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedBookmarkIndex = Math.min(selectedBookmarkIndex + 1, allElements.length - 1);
        highlightSelectedItem(allElements);
        break;

      case 'ArrowUp':
        e.preventDefault();
        selectedBookmarkIndex = Math.max(selectedBookmarkIndex - 1, 0);
        highlightSelectedItem(allElements);
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
          const selectedElement = allElements[selectedBookmarkIndex];
          if (selectedElement.classList.contains('folder-header')) {
            // Check if folder is already expanded
            const toggle = selectedElement.querySelector('.folder-toggle');
            if (!toggle.classList.contains('expanded')) {
              // Expand folder if collapsed
              selectedElement.click();
              // After expanding, rebuild the list and maintain selection
              setTimeout(() => {
                const updatedFolders = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
                const updatedBookmarks = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));
                const updatedElements = [...updatedFolders, ...updatedBookmarks].sort((a, b) => {
                  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                });
                highlightSelectedItem(updatedElements);
              }, 50);
            } else {
              // Folder already expanded, move down to next item
              selectedBookmarkIndex = Math.min(selectedBookmarkIndex + 1, allElements.length - 1);
              highlightSelectedItem(allElements);
            }
          } else {
            // For bookmarks, check if preview is already shown
            if (selectedElement.classList.contains('force-preview')) {
              // Preview already shown, move down to next item
              selectedBookmarkIndex = Math.min(selectedBookmarkIndex + 1, allElements.length - 1);
              highlightSelectedItem(allElements);
            } else {
              // Show preview for bookmark
              const previewContainer = selectedElement.querySelector('.bookmark-preview-container');
              if (previewContainer) {
                selectedElement.classList.add('force-preview');
                const previewImg = previewContainer.querySelector('.preview-image');
                const url = previewImg.dataset.url;
                if (url && !loadedPreviews.has(url)) {
                  // Trigger preview load
                  previewImg.src = `https://s0.wp.com/mshots/v1/${encodeURIComponent(url)}?w=400&h=300`;
                  previewImg.onload = () => {
                    previewImg.classList.add('loaded');
                    loadedPreviews.add(url);
                  };
                  loadedPreviews.add(url);
                } else if (url) {
                  previewImg.classList.add('loaded');
                }
              }
            }
          }
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
          const selectedElement = allElements[selectedBookmarkIndex];
          if (selectedElement.classList.contains('folder-header')) {
            // Check if folder is expanded
            const toggle = selectedElement.querySelector('.folder-toggle');
            if (toggle.classList.contains('expanded')) {
              // Collapse folder if expanded
              selectedElement.click();
              // After collapsing, rebuild the list and maintain selection
              setTimeout(() => {
                const updatedFolders = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
                const updatedBookmarks = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));
                const updatedElements = [...updatedFolders, ...updatedBookmarks].sort((a, b) => {
                  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                });
                highlightSelectedItem(updatedElements);
              }, 50);
            } else {
              // Folder already collapsed, move up to previous item
              selectedBookmarkIndex = Math.max(selectedBookmarkIndex - 1, 0);
              highlightSelectedItem(allElements);
            }
          } else {
            // For bookmarks, check if preview is shown
            if (selectedElement.classList.contains('force-preview')) {
              // Hide preview for bookmark
              selectedElement.classList.remove('force-preview');
            } else {
              // Preview already hidden, move up to previous item
              selectedBookmarkIndex = Math.max(selectedBookmarkIndex - 1, 0);
              highlightSelectedItem(allElements);
            }
          }
        }
        break;

      case 'Enter':
        e.preventDefault();
        if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
          const selectedElement = allElements[selectedBookmarkIndex];
          // Check if it's a folder header or bookmark
          if (selectedElement.classList.contains('folder-header')) {
            // Toggle folder
            selectedElement.click();
            // After toggling, rebuild the list and maintain selection
            setTimeout(() => {
              const updatedFolders = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
              const updatedBookmarks = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));
              const updatedElements = [...updatedFolders, ...updatedBookmarks].sort((a, b) => {
                return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
              });
              highlightSelectedItem(updatedElements);
            }, 50);
          } else {
            // Open bookmark
            selectedElement.click();
          }
        }
        break;

      case 'Escape':
        // Clear selection
        selectedBookmarkIndex = -1;
        allElements.forEach(el => el.style.outline = '');
        break;
    }
  });

  // Undo toast event listeners
  undoButton.addEventListener('click', () => {
    performUndo();
  });

  undoDismiss.addEventListener('click', () => {
    hideUndoToast();
  });

  // ============================================================================
  // PROVIDER SWITCHING & LOGIN HANDLERS
  // ============================================================================

  // GitLab login button handler
  const loginBtnGitlab = document.getElementById('loginBtnGitlab');
  const tokenInputGitlab = document.getElementById('tokenInputGitlab');
  const loginErrorGitlab = document.getElementById('loginErrorGitlab');

  if (loginBtnGitlab && tokenInputGitlab) {
    // Handle Enter key in token input
    tokenInputGitlab.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        loginBtnGitlab.click();
      }
    });

    loginBtnGitlab.onclick = async () => {
      const token = tokenInputGitlab.value.trim();

      if (!token) {
        if (loginErrorGitlab) {
          loginErrorGitlab.textContent = 'Please enter your Personal Access Token';
          loginErrorGitlab.style.display = 'block';
        }
        return;
      }

      // Show loading state
      loginBtnGitlab.disabled = true;
      loginBtnGitlab.textContent = 'Authenticating...';
      if (loginErrorGitlab) loginErrorGitlab.style.display = 'none';

      try {
        // Validate token
        snippetToken = token;
        const user = await validateSnippetToken();

        if (!user) {
          throw new Error('Invalid GitLab token');
        }

        console.log(`Authenticated with GitLab:`, user.username);

        // Store token securely
        await storeSnippetToken(token);

        // Show success message
        showToast(`Authenticated as ${user.username}`);

        // Open Snippet sync dialog
        await openSnippetSyncDialog();

      } catch (error) {
        console.error('Login failed:', error);
        if (loginErrorGitlab) {
          loginErrorGitlab.textContent = error.message || 'Authentication failed. Please check your token and try again.';
          loginErrorGitlab.style.display = 'block';
        }

        // Reset button
        loginBtnGitlab.disabled = false;
        loginBtnGitlab.textContent = 'Login with GitLab';
      }
    };
  }
}

// Highlight the selected item (folder or bookmark) for keyboard navigation
function highlightSelectedItem(allElements) {
  // Remove highlight from all items
  allElements.forEach(el => el.style.outline = '');

  // Add highlight to selected item
  if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
    const selected = allElements[selectedBookmarkIndex];
    selected.style.outline = '2px solid var(--md-sys-color-primary)';
    selected.style.outlineOffset = '2px';
    selected.style.borderRadius = '8px';
    // Scroll into view
    selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
