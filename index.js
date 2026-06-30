// ==========================================================================
// STATE MANAGEMENT & LOCAL STORAGE
// ==========================================================================
const state = {
  serverUrl: localStorage.getItem('serverUrl') || '',
  accessToken: localStorage.getItem('accessToken') || '',
  refreshToken: localStorage.getItem('refreshToken') || '',
  tokenExpiry: parseInt(localStorage.getItem('tokenExpiry') || '0', 10),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  
  // App cache (similar to ScheduleCache.kt)
  cache: {
    schedule: JSON.parse(localStorage.getItem('cache_schedule') || 'null'),
    teamSchedule: JSON.parse(localStorage.getItem('cache_teamSchedule') || 'null'),
    availability: JSON.parse(localStorage.getItem('cache_availability') || 'null'),
    maxHours: JSON.parse(localStorage.getItem('cache_maxHours') || 'null'),
    timeOff: JSON.parse(localStorage.getItem('cache_timeOff') || 'null'),
    notifiedIds: JSON.parse(localStorage.getItem('cache_notifiedIds') || '[]'),
    favorites: new Set(JSON.parse(localStorage.getItem('cache_favorites') || '[]')),
    nicknames: JSON.parse(localStorage.getItem('cache_nicknames') || '{}'), // empId -> {first, last, hideLast}
    lastUpdate: parseInt(localStorage.getItem('cache_lastUpdate') || '0', 10),
    lastTeamUpdate: parseInt(localStorage.getItem('cache_lastTeamUpdate') || '0', 10)
  },
  
  // UI Configuration preferences
  settings: {
    combineShifts: localStorage.getItem('settings_combineShifts') !== 'false',
    showAvailabilityOnCalendar: localStorage.getItem('settings_showAvailabilityOnCalendar') !== 'false',
    showMoney: localStorage.getItem('settings_showMoney') === 'true',
    hourlyWage: parseFloat(localStorage.getItem('settings_hourlyWage') || '0'),
    theme: localStorage.getItem('settings_theme') || 'system',
    enabledCafes: JSON.parse(localStorage.getItem('settings_enabledCafes') || '[]'), // Empty means show all
    pushEnabled: localStorage.getItem('settings_pushEnabled') === 'true',
    pushSettings: JSON.parse(localStorage.getItem('settings_pushSettings') || 'null') || {
      shiftApprovedEnabled: true,
      managerCallsEnabled: true,
      shiftPickupsEnabled: true,
      schedulePublishedEnabled: true,
      otherEnabled: true
    }
  },

  // Active view navigation
  currentTab: 'home',
  activePeer: null, // For coworker sub-view
  activeDaySchedule: null // For expanded timeline view
};

// VAPID Public Key fetched from server on registration
let vapidPublicKey = '';

// Cache persistence helper
function saveCache(key, val) {
  state.cache[key] = val;
  if (val instanceof Set) {
    localStorage.setItem('cache_' + key, JSON.stringify(Array.from(val)));
  } else {
    localStorage.setItem('cache_' + key, JSON.stringify(val));
  }
}

// ----------------------------------------------------
// STATE UTILITIES
// ----------------------------------------------------
function isTokenValid() {
  return state.accessToken && Date.now() < state.tokenExpiry - 300000; // 5 min margin
}

function resolveServerUrl(path) {
  const base = state.serverUrl || window.location.origin;
  return `${base.replace(/\/$/, '')}${path}`;
}

// Global fetch proxy handler
async function apiRequest(url, method = 'GET', body = null) {
  const headers = {};
  if (state.accessToken) {
    headers['Authorization'] = `Bearer ${state.accessToken}`;
  }

  // Call the proxy endpoint to bypass CORS and set mobile User-Agent
  const response = await fetch(resolveServerUrl('/api/proxy'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      method,
      headers,
      body: body ? (typeof body === 'object' ? JSON.stringify(body) : body) : null
    })
  });

  if (response.status === 401) {
    // Attempt token refresh inline
    const refreshed = await performTokenRefresh();
    if (refreshed) {
      // Retry request once with new token
      return apiRequest(url, method, body);
    } else {
      logout();
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP error ${response.status}`);
  }

  // Detect and return JSON if possible
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function performTokenRefresh() {
  if (!state.refreshToken) return false;
  try {
    const response = await fetch(resolveServerUrl('/api/refresh-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refreshToken })
    });

    if (!response.ok) return false;

    const data = await response.json();
    saveLoginState(data);
    return true;
  } catch (e) {
    console.error('Background token refresh failed:', e);
    return false;
  }
}

function saveLoginState(data) {
  state.accessToken = data.access_token;
  state.refreshToken = data.refresh_token;
  state.tokenExpiry = Date.now() + (data.expires_in * 1000);
  state.user = {
    userId: data.user_id,
    firstName: data.first_name,
    lastName: data.last_name,
    preferredName: data.preferred_name,
    cafeNo: data.cafe_no
  };

  localStorage.setItem('accessToken', state.accessToken);
  localStorage.setItem('refreshToken', state.refreshToken);
  localStorage.setItem('tokenExpiry', state.tokenExpiry.toString());
  localStorage.setItem('user', JSON.stringify(state.user));
}

function logout() {
  state.accessToken = '';
  state.refreshToken = '';
  state.tokenExpiry = 0;
  state.user = null;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('tokenExpiry');
  localStorage.removeItem('user');
  
  // Clear caches
  localStorage.removeItem('cache_schedule');
  localStorage.removeItem('cache_teamSchedule');
  localStorage.removeItem('cache_availability');
  localStorage.removeItem('cache_maxHours');
  localStorage.removeItem('cache_timeOff');
  state.cache.schedule = null;
  state.cache.teamSchedule = null;
  state.cache.availability = null;
  state.cache.maxHours = null;
  state.cache.timeOff = null;

  // Unsubscribe Web Push on server
  if (state.settings.pushEnabled) {
    togglePushSubscription(false);
  }

  showAuthScreen();
}

// ----------------------------------------------------
// PWA INITIALIZATION & DOM ROUTING
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupUIEventListeners();
  
  // Check deep links / query params
  const params = new URLSearchParams(window.location.search);
  const startTab = params.get('tab');
  const focusId = params.get('focusId');

  // Verify server configuration
  if (!state.serverUrl && window.location.origin.includes('localhost')) {
    // If running on localhost, default to the page origin automatically
    state.serverUrl = window.location.origin;
    localStorage.setItem('serverUrl', state.serverUrl);
  }

  if (!state.serverUrl) {
    showSetupScreen();
  } else if (!state.accessToken) {
    showAuthScreen();
  } else {
    initApp(startTab || 'home', focusId);
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('SW: Registered successfully');
        
        // Listen for messages from sw.js
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data && event.data.type === 'NAVIGATE_TAB') {
            switchTab(event.data.tab);
            if (event.data.focusId) {
              setTimeout(() => focusNotification(event.data.focusId), 500);
            }
          }
        });
      })
      .catch(err => console.error('SW: Registration failed:', err));
  }
});

function initTheme() {
  const theme = state.settings.theme;
  document.body.classList.remove('light-theme', 'dark-theme');
  if (theme === 'light') {
    document.body.classList.add('light-theme');
  } else if (theme === 'dark') {
    document.body.classList.add('dark-theme');
  }
  
  // Update Theme Modal selected indicator
  document.querySelectorAll('.theme-option-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

function showSetupScreen() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('server-address-input').value = state.serverUrl;
}

function showAuthScreen() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  
  // Clear values
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('callback-url-input').value = '';
  document.getElementById('direct-login-error').classList.add('hidden');
  document.getElementById('login-error').classList.add('hidden');
}

async function initApp(startTab = 'home', focusId = null) {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');

  // Load settings preferences views inside try-catch to prevent DOM-mismatch crashes
  try {
    document.getElementById('combine-shifts-switch').checked = state.settings.combineShifts;
    document.getElementById('show-availability-calendar-switch').checked = state.settings.showAvailabilityOnCalendar;
    document.getElementById('show-money-switch').checked = state.settings.showMoney;
    document.getElementById('push-master-switch').checked = state.settings.pushEnabled;
    document.getElementById('push-settings-panel').classList.toggle('hidden', !state.settings.pushEnabled);
    document.getElementById('current-theme-label').innerText = 
      state.settings.theme === 'system' ? 'System Default' : (state.settings.theme === 'light' ? 'Light Mode' : 'Dark Mode');

    // Load push notification toggles
    document.getElementById('push-pickups-switch').checked = state.settings.pushSettings.shiftPickupsEnabled;
    document.getElementById('push-approvals-switch').checked = state.settings.pushSettings.shiftApprovedEnabled;
    document.getElementById('push-calls-switch').checked = state.settings.pushSettings.managerCallsEnabled;
    document.getElementById('push-published-switch').checked = state.settings.pushSettings.schedulePublishedEnabled;
    document.getElementById('push-other-switch').checked = state.settings.pushSettings.otherEnabled;
  } catch(e) {
    console.error('Settings UI initialization warning:', e);
  }

  // Render cached views immediately for instant load
  try {
    renderAllViews();
  } catch(e) {
    console.error('Initial rendering failed:', e);
  }

  // Navigate to start tab synchronously so user sees Home dashboard immediately
  switchTab(startTab);
  if (focusId) {
    setTimeout(() => focusNotification(focusId), 500);
  }

  // If token is expired, refresh in background before syncing
  if (!isTokenValid()) {
    const refreshed = await performTokenRefresh();
    if (!refreshed) {
      logout();
      return;
    }
  }

  // Fetch fresh database items in background
  refreshData();
  
  // Setup Background Polling Loops (matching Android Client)
  // Fast Active loop: every 20 seconds checks notifications & schedule caches
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      console.log('Active loop: checking updates');
      fetchNotificationsCount();
    }
  }, 20000);

  // Passive loop: every 5 minutes refresh schedule & coworkers
  setInterval(() => {
    console.log('Passive loop: fetching schedule & coworkers');
    refreshData();
  }, 5 * 60 * 1000);
}

// ----------------------------------------------------
// UI NAVIGATION ROUTING
// ----------------------------------------------------
function updateHeaderTimestamp(timestamp = null) {
  const el = document.getElementById('header-update-time');
  if (!el) return;
  
  const timeToUse = timestamp || state.cache.lastUpdate;
  if (timeToUse > 0) {
    el.innerText = getLastUpdateText(timeToUse);
    el.classList.remove('hidden');
  } else {
    el.innerText = 'Updated --';
    el.classList.remove('hidden');
  }
}

function switchTab(tabId) {
  // Navigation item active state
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });

  // Views toggling
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.add('hidden');
  });
  
  // Close any secondary subviews if navigating away from subview tabs
  document.getElementById('header-back-btn').classList.add('hidden');
  state.activePeer = null;
  state.activeDaySchedule = null;

  if (tabId === 'home') {
    document.getElementById('tab-home').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'SCHEDULED SHIFTS';
    setupHomeHeaderActions();
    updateHeaderTimestamp(state.cache.lastUpdate);
  } else if (tabId === 'people') {
    document.getElementById('tab-people').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'COWORKERS';
    setupPeopleHeaderActions();
    updateHeaderTimestamp(state.cache.lastTeamUpdate || state.cache.lastUpdate);
  } else if (tabId === 'notifications') {
    document.getElementById('tab-notifications').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'NOTIFICATIONS';
    setupNotificationsHeaderActions();
    updateHeaderTimestamp(state.cache.lastUpdate);
  } else if (tabId === 'settings') {
    document.getElementById('tab-settings').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'SETTINGS';
    setupSettingsHeaderActions();
    document.getElementById('header-update-time').classList.add('hidden'); // Hide on settings
  }
  
  state.currentTab = tabId;
}

function openPeerSchedule(associate) {
  state.activePeer = associate;
  document.querySelectorAll('.tab-view').forEach(view => view.classList.add('hidden'));
  document.getElementById('sub-peer-schedule').classList.remove('hidden');
  
  // Set headers
  document.getElementById('header-title').innerText = resolveCoworkerName(associate.employeeId, associate.firstName, associate.lastName).toUpperCase();
  document.getElementById('header-back-btn').classList.remove('hidden');
  document.getElementById('header-actions').innerHTML = ''; // no actions
  document.getElementById('header-update-time').classList.add('hidden'); // Hide on peer profile
  
  // Fill profile details
  document.getElementById('peer-avatar-large').innerText = (associate.preferredName || associate.firstName || 'C').substring(0,2);
  document.getElementById('peer-name-title').innerText = resolveCoworkerName(associate.employeeId, associate.firstName, associate.lastName);
  document.getElementById('peer-info-subtitle').innerText = `Home Cafe: ${associate.cafeNumber || 'Unknown'}`;
  
  renderPeerShiftsList();
}

function openTeamSchedule() {
  document.querySelectorAll('.tab-view').forEach(view => view.classList.add('hidden'));
  document.getElementById('sub-team-schedule').classList.remove('hidden');
  
  document.getElementById('header-title').innerText = 'FULL SCHEDULE';
  document.getElementById('header-back-btn').classList.remove('hidden');
  document.getElementById('header-actions').innerHTML = '';
  updateHeaderTimestamp(state.cache.lastTeamUpdate || state.cache.lastUpdate);
  
  renderTeamScheduleView();
  fetchTeamSchedules(); // fetch latest coworker schedules
}

function openAvailabilityView() {
  document.querySelectorAll('.tab-view').forEach(view => view.classList.add('hidden'));
  document.getElementById('sub-availability').classList.remove('hidden');
  
  document.getElementById('header-title').innerText = 'AVAILABILITY';
  document.getElementById('header-back-btn').classList.remove('hidden');
  updateHeaderTimestamp(state.cache.lastUpdate);
  
  // Header action: edit availability
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.07,6.19L3,17.25Z"/></svg>`;
  editBtn.onclick = () => openModal('edit-availability-modal');
  
  const addTimeOffBtn = document.createElement('button');
  addTimeOffBtn.className = 'icon-btn';
  addTimeOffBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>`;
  addTimeOffBtn.onclick = () => {
    // Set default date to today
    document.getElementById('time-off-date-input').value = new Date().toISOString().split('T')[0];
    openModal('time-off-modal');
  };

  const container = document.getElementById('header-actions');
  container.innerHTML = '';
  container.appendChild(editBtn);
  container.appendChild(addTimeOffBtn);
  
  renderAvailabilityView();
}

function handleBackNavigation() {
  if (state.activePeer) {
    switchTab('people');
  } else if (state.activeDaySchedule) {
    openTeamSchedule();
  } else if (document.getElementById('sub-team-schedule').classList.contains('hidden') === false) {
    switchTab('people');
  } else if (document.getElementById('sub-availability').classList.contains('hidden') === false) {
    switchTab('home');
  }
}

// ----------------------------------------------------
// HEADER ACTION MENUS POPULATOR
// ----------------------------------------------------
function setupHomeHeaderActions() {
  const container = document.getElementById('header-actions');
  container.innerHTML = '';

  // Availability / Checklist Button
  const availBtn = document.createElement('button');
  availBtn.className = 'icon-btn';
  availBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
  availBtn.onclick = openAvailabilityView;

  // Earnings/Money Button
  const moneyBtn = document.createElement('button');
  moneyBtn.className = 'icon-btn';
  moneyBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M11.5,6v1.08c-1.04,0.18 -1.8,0.76 -1.97,1.69h1.97c0.11,-0.41 0.49,-0.69 1,-0.69c0.58,0 1,0.35 1,0.81c0,0.5 -0.38,0.75 -1.03,1.06C11.66,10.31 10.5,11.06 10.5,12.5v0.5H12v-0.5c0,-0.69 0.44,-1.03 1.06,-1.31C13.88,10.81 15,10.06 15,8.81c0,-1.19 -0.92,-1.97 -2.5,-2.06v-1.08h-1zM11.5,15v2h2v-2h-2z"/></svg>`;
  moneyBtn.onclick = () => {
    // Open Money Settings
    document.getElementById('hourly-wage-input').value = state.settings.hourlyWage || '';
    
    // Auto-calculate weekly hours
    const weeklyHours = calculateScheduledHoursForCurrentWeek();
    document.getElementById('weekly-hours-input').value = weeklyHours.toFixed(2).replace(/\.00$/, '');
    
    updateProjectedEarningsResult();
    openModal('money-settings-modal');
  };

  container.appendChild(availBtn);
  container.appendChild(moneyBtn);
}

function setupPeopleHeaderActions() {
  const container = document.getElementById('header-actions');
  container.innerHTML = '';

  // Calendar timeline button
  const calBtn = document.createElement('button');
  calBtn.className = 'icon-btn';
  calBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M19,4H18V2H16V4H8V2H6V4H5C3.89,4 3,4.9 3,6V20A2,2 0 0,0 5,22H19A2,2 0 0,0 21,20V6A2,2 0 0,0 19,4M19,20H5V10H19V20M19,8H5V6H19V8M7,12h5v5H7V12Z"/></svg>`;
  calBtn.onclick = openTeamSchedule;
  container.appendChild(calBtn);
}

function setupNotificationsHeaderActions() {
  const container = document.getElementById('header-actions');
  container.innerHTML = '';
  
  // Mark all as read button
  const readAllBtn = document.createElement('button');
  readAllBtn.className = 'icon-btn';
  readAllBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M0.41,13.41L6,19L7.41,17.59L1.83,12M5.67,16.27L12.5,9.44L11.08,8L4.25,14.85M22.54,6.42L21.12,5L12.5,13.62L8.92,10.04L7.5,11.46L12.5,16.46M17.58,11.46L19,10.04L13.92,5L12.5,6.42L17.58,11.46Z"/></svg>`;
  readAllBtn.onclick = markAllNotificationsAsRead;
  container.appendChild(readAllBtn);
}

function setupSettingsHeaderActions() {
  document.getElementById('header-actions').innerHTML = '';
}

// ----------------------------------------------------
// ----------------------------------------------------
// LOADING SPINNER OVERLAY TRIGGERS
// ----------------------------------------------------
function showLoading(message = 'Refreshing schedule...') {
  const overlay = document.getElementById('loading-overlay');
  const text = document.getElementById('loading-message');
  if (overlay && text) {
    text.innerText = message;
    overlay.classList.remove('hidden');
  }
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

// CORE API DATA FETCHER & CACHER
// ----------------------------------------------------
async function refreshData() {
  if (!state.accessToken) return;
  
  console.log('Syncing all data from Panera APIs concurrently...');
  showLoading('Refreshing schedule...');
  
  try {
    const response = await fetch(resolveServerUrl('/api/sync-all'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.accessToken}`
      },
      body: JSON.stringify({
        userId: state.user.userId,
        cafeNo: state.user.cafeNo,
        enabledCafes: state.settings.enabledCafes,
        personalRangeDays: 30,
        coworkerRangeDays: 14
      })
    });

    if (!response.ok) {
      throw new Error(`Sync-all returned HTTP status ${response.status}`);
    }

    const data = await response.json();
    
    // 1. Process Schedule
    if (data.schedule) {
      saveCache('schedule', data.schedule);
      saveCache('lastUpdate', Date.now());
    }

    // 2. Process Notifications
    if (data.notifications) {
      const cachedNotifs = state.cache.notifiedIds || [];
      const merged = (data.notifications.content || []).map(n => {
        if (cachedNotifs.includes(n.notificationId)) {
          return { ...n, read: true };
        }
        return n;
      });
      saveCache('notifiedIds', cachedNotifs);
      saveCache('notifications', merged);
      updateNotificationBadge();
    }

    // 3. Process Availability, Max Hours, Time Off
    if (data.availability) saveCache('availability', data.availability);
    if (data.maxHours) saveCache('maxHours', data.maxHours);
    if (data.timeOff) saveCache('timeOff', data.timeOff);

    // 4. Process Coworker Schedules
    if (data.teamSchedule) {
      saveCache('teamSchedule', data.teamSchedule);
      saveCache('lastTeamUpdate', Date.now());
    }

    renderAllViews();
    renderTeamScheduleView();
    renderPeopleView();
    
    hideLoading();
    showToast('Schedule updated');
  } catch (err) {
    console.error('Unified refresh error:', err);
    hideLoading();
    showToast('Failed to sync. Using cached data.');
  }
}

async function fetchNotificationsCount() {
  try {
    const url = 'https://pantry.panerabread.com/apis/pantry-ui-service/notification/v1/api/notifications/summary';
    const summaries = await apiRequest(url);
    const count = summaries?.[0]?.count || 0;
    
    // Update layout badge counter
    const badge = document.getElementById('notif-badge');
    if (count > 0) {
      badge.innerText = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch(e) {
    console.warn('Failed to check notification summary count:', e);
  }
}

async function fetchTeamSchedules() {
  // Coworker schedules are now pulled automatically in the main refreshData sync-all call
  await refreshData();
}

// ----------------------------------------------------
// TAB 1: HOME VIEW RENDERER
// ----------------------------------------------------
function renderHomeView() {
  const schedule = state.cache.schedule;

  // Initialize cafe toggles switcher for Home Screen
  const homeCafe = state.user?.cafeNo || '';
  const enabledCafes = state.settings.enabledCafes || [];
  
  let filterCafes = enabledCafes;
  if (filterCafes.length === 0 && schedule) {
    const sampleShift = (schedule.currentShifts || []).find(s => s.cafeNumber) || 
                        (schedule.track || []).map(t => t.primaryShiftRequest?.shift).find(s => s?.cafeNumber);
    filterCafes = homeCafe ? [homeCafe] : (sampleShift?.cafeNumber ? [sampleShift.cafeNumber] : []);
  }

  // Home Cafe Switch Bar
  const switcher = document.getElementById('home-cafe-chip-group-scroll');
  const chipGroup = document.getElementById('home-cafe-chip-group');
  if (switcher && chipGroup) {
    chipGroup.innerHTML = '';

    if (filterCafes.length <= 1) {
      switcher.classList.add('hidden');
      activeCafeHome = ''; // No filtering needed
    } else {
      switcher.classList.remove('hidden');
      
      const sorted = [...filterCafes].sort();
      
      const allChip = document.createElement('button');
      allChip.className = `chip ${!activeCafeHome ? 'active' : ''}`;
      allChip.innerText = 'ALL CAFES';
      allChip.onclick = () => {
        activeCafeHome = '';
        document.querySelectorAll('#home-cafe-chip-group .chip').forEach(c => c.classList.remove('active'));
        allChip.classList.add('active');
        renderHomeView();
      };
      chipGroup.appendChild(allChip);

      sorted.forEach(cafeNo => {
        const displayName = getCafeDisplayName(cafeNo, schedule?.cafeList);
        const chip = document.createElement('button');
        chip.className = `chip ${activeCafeHome === cafeNo ? 'active' : ''}`;
        chip.innerText = displayName;
        chip.onclick = () => {
          activeCafeHome = cafeNo;
          document.querySelectorAll('#home-cafe-chip-group .chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          renderHomeView();
        };
        chipGroup.appendChild(chip);
      });
    }
  }
  
  // Render timestamp
  const updatedText = document.getElementById('home-update-time');
  if (updatedText) {
    if (state.cache.lastUpdate > 0) {
      updatedText.innerText = getLastUpdateText(state.cache.lastUpdate);
    } else {
      updatedText.innerText = 'Updated --';
    }
  }
  if (state.currentTab === 'home') {
    updateHeaderTimestamp(state.cache.lastUpdate);
  }

  // 1. Calculate 28-day calendar starting previous Wednesday
  const today = new Date();
  const day = today.getDay(); // 0-6 (Sun-Sat)
  // Calculate difference to get back to Wednesday (3)
  const diffToWed = (day >= 3) ? (day - 3) : (day + 4);
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - diffToWed);
  startDate.setHours(0,0,0,0);

  const dates = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d);
  }

  // Update date range title
  const endCalendarDate = dates[27];
  const fmtRange = `${formatDateRangeString(dates[0])} - ${formatDateRangeString(endCalendarDate)}`;
  document.getElementById('calendar-date-range').innerText = fmtRange;

  // Process schedules indices for fast calendar lookups
  const scheduledDates = {}; // yyyy-mm-dd -> true
  if (schedule && schedule.currentShifts) {
    schedule.currentShifts.forEach(s => {
      if (s.startDateTime && isCafeFilterEnabled(s.cafeNumber)) {
        scheduledDates[s.startDateTime.substring(0, 10)] = true;
      }
    });
  }

  // Process available shifts dot indicators
  const availableDates = {};
  if (schedule && schedule.track) {
    schedule.track.forEach(item => {
      const s = item.primaryShiftRequest?.shift;
      const isClaimed = item.relatedShiftRequests?.some(r => r.state === 'APPROVED');
      const isStateOpen = item.primaryShiftRequest?.state === 'AVAILABLE' || item.primaryShiftRequest?.state === 'APPROVED';
      
      if (item.type === 'AVAILABLE' && isStateOpen && !isClaimed && s && isCafeFilterEnabled(s.cafeNumber)) {
        availableDates[s.startDateTime.substring(0, 10)] = true;
      }
    });
  }

  // Process time off requests highlights
  const timeOffDates = {};
  if (state.cache.timeOff) {
    state.cache.timeOff.forEach(req => {
      if (req.timeOffDate && (req.status === 'APPROVED' || req.status === 'PENDING')) {
        timeOffDates[req.timeOffDate] = true;
      }
    });
  }

  // Render calendar grid cells
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';
  
  dates.forEach(d => {
    const key = d.toISOString().split('T')[0];
    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    cell.innerText = d.getDate();



    // Check states
    const isToday = key === today.toISOString().split('T')[0];
    if (isToday) cell.classList.add('today');
    
    if (scheduledDates[key]) cell.classList.add('work-day');
    if (availableDates[key]) cell.classList.add('available-shift-day');
    
    if (state.settings.showAvailabilityOnCalendar && timeOffDates[key]) {
      cell.classList.add('time-off-day');
    }

    // On Click: Open daily shifts details dialog
    cell.onclick = () => {
      const dateShifts = (schedule?.currentShifts || []).filter(s => s.startDateTime.substring(0, 10) === key && isCafeFilterEnabled(s.cafeNumber));
      const dateAvails = (schedule?.track || [])
        .filter(t => t.type === 'AVAILABLE' && t.primaryShiftRequest?.shift?.startDateTime?.substring(0, 10) === key)
        .map(t => t.primaryShiftRequest.shift)
        .filter(s => isCafeFilterEnabled(s.cafeNumber));
        
      showDayScheduleModal(d, dateShifts, dateAvails);
    };

    grid.appendChild(cell);
  });

  // 2. Render collapsibles
  // YOUR SHIFTS
  const myShiftsList = document.getElementById('your-shifts-list');
  myShiftsList.innerHTML = '';
  const myShifts = (schedule?.currentShifts || [])
    .filter(s => isCafeFilterEnabled(s.cafeNumber))
    .sort((a,b) => a.startDateTime.localeCompare(b.startDateTime));

  if (myShifts.length > 0) {
    document.getElementById('your-shifts-section').classList.remove('hidden');
    myShifts.forEach(shift => {
      const card = document.createElement('div');
      card.className = 'shift-card';
      card.onclick = () => openShiftDetails(shift, false);

      const left = document.createElement('div');
      left.className = 'shift-left';
      
      const timeText = document.createElement('div');
      timeText.className = 'shift-time';
      timeText.innerText = formatShiftDateTime(shift.startDateTime, shift.endDateTime);
      
      const roleText = document.createElement('div');
      roleText.className = 'shift-role';
      roleText.innerText = getWorkstationDisplayName(shift.workstationId || shift.workstationCode, shift.workstationName);

      left.appendChild(timeText);
      left.appendChild(roleText);

      const right = document.createElement('div');
      right.className = 'shift-right';
      
      const locText = document.createElement('div');
      locText.className = 'shift-location';
      locText.innerText = getCafeDisplayName(shift.cafeNumber, schedule.cafeList);
      right.appendChild(locText);

      if (state.settings.showMoney) {
        const moneyText = document.createElement('div');
        moneyText.className = 'shift-money';
        moneyText.innerText = `$${calculateShiftEarnings(shift.startDateTime, shift.endDateTime).toFixed(2)}`;
        right.appendChild(moneyText);
      }

      card.appendChild(left);
      card.appendChild(right);
      myShiftsList.appendChild(card);
    });
  } else {
    document.getElementById('your-shifts-section').classList.add('hidden');
  }

  // AVAILABLE SHIFTS
  const availList = document.getElementById('available-shifts-list');
  availList.innerHTML = '';
  
  // Filter open track available shift requests
  const availableShifts = [];
  if (schedule && schedule.track) {
    schedule.track.forEach(item => {
      const isTypeAvailable = item.type === 'AVAILABLE';
      const stateOpen = item.primaryShiftRequest?.state === 'AVAILABLE' || item.primaryShiftRequest?.state === 'APPROVED';
      const claimed = item.relatedShiftRequests?.some(r => r.state === 'APPROVED');
      const shift = item.primaryShiftRequest?.shift;

      if (isTypeAvailable && stateOpen && !claimed && shift && isCafeFilterEnabled(shift.cafeNumber)) {
        availableShifts.push({
          shift,
          requesterId: item.primaryShiftRequest.requesterId,
          requestedAt: item.primaryShiftRequest.requestedAt,
          trackItem: item
        });
      }
    });
  }

  availableShifts.sort((a,b) => a.shift.startDateTime.localeCompare(b.shift.startDateTime));

  if (availableShifts.length > 0) {
    document.getElementById('available-shifts-section').classList.remove('hidden');
    availableShifts.forEach(item => {
      const card = document.createElement('div');
      card.className = 'shift-card';
      card.onclick = () => openShiftDetails(item.shift, true, item.trackItem);

      const left = document.createElement('div');
      left.className = 'shift-left';
      
      const timeText = document.createElement('div');
      timeText.className = 'shift-time';
      timeText.innerText = formatShiftDateTime(item.shift.startDateTime, item.shift.endDateTime);
      
      const roleText = document.createElement('div');
      roleText.className = 'shift-role';
      roleText.innerText = getWorkstationDisplayName(item.shift.workstationId || item.shift.workstationCode, item.shift.workstationName);

      left.appendChild(timeText);
      left.appendChild(roleText);

      // Meta subtitle for posted author
      const meta = document.createElement('div');
      meta.className = 'shift-meta-desc';
      const poster = getCoworkerNameResolved(item.requesterId);
      const timeago = getTimeAgoText(item.requestedAt);
      meta.innerText = `Posted by ${poster} ${timeago}`;
      left.appendChild(meta);

      const right = document.createElement('div');
      right.className = 'shift-right';
      
      const locText = document.createElement('div');
      locText.className = 'shift-location';
      locText.innerText = getCafeDisplayName(item.shift.cafeNumber, schedule.cafeList);
      right.appendChild(locText);

      if (state.settings.showMoney) {
        const moneyText = document.createElement('div');
        moneyText.className = 'shift-money';
        moneyText.innerText = `$${calculateShiftEarnings(item.shift.startDateTime, item.shift.endDateTime).toFixed(2)}`;
        right.appendChild(moneyText);
      }

      card.appendChild(left);
      card.appendChild(right);
      availList.appendChild(card);
    });
  } else {
    document.getElementById('available-shifts-section').classList.add('hidden');
  }
}

// ----------------------------------------------------
// TAB 2: PEOPLE VIEW RENDERER
// ----------------------------------------------------
function renderPeopleView() {
  const list = document.getElementById('coworkers-list');
  list.innerHTML = '';
  
  // Extract all unique associates from cached schedules
  const allAssociatesMap = {};
  
  if (state.cache.teamSchedule) {
    state.cache.teamSchedule.forEach(m => {
      if (m.associate && m.associate.employeeId !== 'AVAILABLE_SHIFT' && m.associate.employeeId !== state.user.userId) {
        allAssociatesMap[m.associate.employeeId] = m.associate;
      }
    });
  }

  // Also verify employeeInfo in personal schedule
  const schedule = state.cache.schedule;
  if (schedule && schedule.employeeInfo) {
    schedule.employeeInfo.forEach(info => {
      if (info.employeeId !== state.user.userId && !allAssociatesMap[info.employeeId]) {
        allAssociatesMap[info.employeeId] = {
          employeeId: info.employeeId,
          firstName: info.firstName,
          lastName: info.lastName,
          preferredName: null
        };
      }
    });
  }

  const associates = Object.values(allAssociatesMap);
  const searchVal = document.getElementById('coworkers-search').value.toLowerCase().trim();

  // Filter coworkers by search term
  const filtered = associates.filter(a => {
    const fullName = `${a.preferredName || a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
    const nickname = resolveCoworkerName(a.employeeId, a.firstName, a.lastName).toLowerCase();
    return fullName.includes(searchVal) || nickname.includes(searchVal);
  });

  // Sort alphabetically
  filtered.sort((a,b) => {
    const nameA = resolveCoworkerName(a.employeeId, a.firstName, a.lastName);
    const nameB = resolveCoworkerName(b.employeeId, b.firstName, b.lastName);
    return nameA.localeCompare(nameB);
  });

  // Group favorites vs normal
  const favList = [];
  const normalList = [];
  filtered.forEach(a => {
    if (state.cache.favorites.has(a.employeeId)) {
      favList.push(a);
    } else {
      normalList.push(a);
    }
  });

  // Render favorites header
  if (favList.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'person-row separator';
    sep.innerText = 'FAVORITES';
    list.appendChild(sep);
    
    favList.forEach(a => renderCoworkerRow(a, list));
  }

  // Render normal alphabetical
  if (normalList.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'person-row separator';
    sep.innerText = 'COWORKERS';
    list.appendChild(sep);
    
    normalList.forEach(a => renderCoworkerRow(a, list));
  }

  // Empty state handling
  document.getElementById('people-empty-state').classList.toggle('hidden', filtered.length > 0 || associates.length === 0);

  // Update timestamps
  const updatedText = document.getElementById('people-update-time');
  if (updatedText) {
    if (state.cache.lastTeamUpdate > 0) {
      updatedText.innerText = getLastUpdateText(state.cache.lastTeamUpdate);
    } else {
      updatedText.innerText = 'Updated --';
    }
  }
  if (state.currentTab === 'people') {
    updateHeaderTimestamp(state.cache.lastTeamUpdate || state.cache.lastUpdate);
  }
}

function renderCoworkerRow(a, parentContainer) {
  const row = document.createElement('div');
  row.className = 'person-row';
  
  // Click coworker: Open their individual schedule panel
  row.onclick = (e) => {
    if (e.target.closest('button')) return; // prevent favorite trigger clicking row
    openPeerSchedule(a);
  };

  const left = document.createElement('div');
  left.className = 'person-left';
  
  const avatar = document.createElement('div');
  avatar.className = 'person-avatar';
  avatar.innerText = (a.preferredName || a.firstName || 'C').substring(0, 2);
  left.appendChild(avatar);

  const nameGroup = document.createElement('div');
  nameGroup.className = 'person-name-group';
  
  const nameTv = document.createElement('div');
  nameTv.className = 'person-name';
  nameTv.innerText = resolveCoworkerName(a.employeeId, a.firstName, a.lastName);
  nameGroup.appendChild(nameTv);
  
  const subTv = document.createElement('div');
  subTv.className = 'person-subtitle';
  subTv.innerText = `Home Cafe: ${a.cafeNumber || 'Unknown'}`;
  nameGroup.appendChild(subTv);

  left.appendChild(nameGroup);
  row.appendChild(left);

  const right = document.createElement('div');
  right.className = 'person-right';

  // Pencil Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'edit-btn';
  editBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.07,6.19L3,17.25Z"/></svg>`;
  editBtn.onclick = () => showNicknameDialog(a);
  right.appendChild(editBtn);

  // Favorite Star button
  const isFav = state.cache.favorites.has(a.employeeId);
  const starBtn = document.createElement('button');
  starBtn.className = `star-btn ${isFav ? 'favorited' : ''}`;
  starBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z"/></svg>`;
  starBtn.onclick = () => {
    toggleFavoriteCoworker(a.employeeId);
  };
  right.appendChild(starBtn);

  row.appendChild(right);
  parentContainer.appendChild(row);
}

function toggleFavoriteCoworker(employeeId) {
  if (state.cache.favorites.has(employeeId)) {
    state.cache.favorites.delete(employeeId);
  } else {
    state.cache.favorites.add(employeeId);
  }
  saveCache('favorites', state.cache.favorites);
  renderPeopleView();
}

// Nicknames resolver helpers
function resolveCoworkerName(employeeId, defaultFirst, defaultLast) {
  const nn = state.cache.nicknames[employeeId];
  const originalFirst = defaultFirst || 'Coworker';
  const originalLast = defaultLast || '';
  
  if (nn) {
    const resolvedFirst = nn.first || originalFirst;
    const resolvedLast = nn.hideLast ? '' : (nn.last || originalLast);
    return `${resolvedFirst} ${resolvedLast}`.trim();
  }
  return `${originalFirst} ${originalLast}`.trim();
}

function resolveCoworkerLastName(employeeId, defaultLast) {
  const nn = state.cache.nicknames[employeeId];
  if (nn) {
    if (nn.hideLast) return '';
    return nn.last || defaultLast || '';
  }
  return defaultLast || '';
}

function getCoworkerNameResolved(employeeId) {
  if (employeeId === state.user.userId) {
    return `${state.user.preferredName || state.user.firstName} ${state.user.lastName}`.trim();
  }
  
  let found = null;
  if (state.cache.teamSchedule) {
    const match = state.cache.teamSchedule.find(m => m.associate?.employeeId === employeeId);
    if (match) found = match.associate;
  }

  if (found) {
    return resolveCoworkerName(employeeId, found.firstName, found.lastName);
  }
  return 'Coworker';
}

// ----------------------------------------------------
// SUB-VIEW: PEER SHIFTS PANEL RENDERER
// ----------------------------------------------------
function renderPeerShiftsList() {
  const list = document.getElementById('peer-shifts-list');
  list.innerHTML = '';
  const empId = state.activePeer.employeeId;

  // Filter shifts belonging to this associate from team schedule
  const peerShifts = [];
  const schedule = state.cache.schedule;

  if (state.cache.teamSchedule) {
    const member = state.cache.teamSchedule.find(m => m.associate?.employeeId === empId);
    if (member && member.shifts) {
      member.shifts.forEach(s => {
        if (isCafeFilterEnabled(s.cafeNumber)) {
          peerShifts.push(s);
        }
      });
    }
  }

  // Sort chronologically
  peerShifts.sort((a,b) => a.startDateTime.localeCompare(b.startDateTime));
  const todayStart = new Date().toISOString().substring(0, 10) + 'T00:00:00';
  const futureShifts = peerShifts.filter(s => s.startDateTime >= todayStart);

  if (futureShifts.length > 0) {
    document.getElementById('peer-shifts-empty').classList.add('hidden');
    futureShifts.forEach(shift => {
      const card = document.createElement('div');
      card.className = 'shift-card';
      
      // Map to Shift object format
      const mappedShift = {
        shiftId: shift.shiftId?.toString(),
        startDateTime: shift.startDateTime,
        endDateTime: shift.endDateTime,
        workstationId: shift.workstationId,
        workstationCode: shift.workstationCode,
        workstationName: shift.workstationName,
        cafeNumber: shift.cafeNumber,
        employeeId: shift.employeeId
      };
      card.onclick = () => openShiftDetails(mappedShift, false);

      const left = document.createElement('div');
      left.className = 'shift-left';
      
      const timeText = document.createElement('div');
      timeText.className = 'shift-time';
      timeText.innerText = formatShiftDateTime(shift.startDateTime, shift.endDateTime);
      
      const roleText = document.createElement('div');
      roleText.className = 'shift-role';
      roleText.innerText = getWorkstationDisplayName(shift.workstationId || shift.workstationCode, shift.workstationName);

      left.appendChild(timeText);
      left.appendChild(roleText);

      const right = document.createElement('div');
      right.className = 'shift-right';
      
      const locText = document.createElement('div');
      locText.className = 'shift-location';
      locText.innerText = getCafeDisplayName(shift.cafeNumber, schedule?.cafeList);
      right.appendChild(locText);

      card.appendChild(left);
      card.appendChild(right);
      list.appendChild(card);
    });
  } else {
    document.getElementById('peer-shifts-empty').classList.remove('hidden');
  }
}

// ----------------------------------------------------
// SUB-VIEW: TEAM SCHEDULE GRID TIMELINE CHART RENDERER
// ----------------------------------------------------
let activeCafeTimeline = '';
let activeCafeHome = '';

function renderTeamScheduleView() {
  const schedule = state.cache.schedule;
  if (!schedule) return;

  // Initialize cafe toggles switcher
  const homeCafe = state.user.cafeNo;
  const enabledCafes = state.settings.enabledCafes;
  
  let filterCafes = enabledCafes;
  if (filterCafes.length === 0) {
    const sampleShift = (schedule.currentShifts || []).find(s => s.cafeNumber) || 
                        (schedule.track || []).map(t => t.primaryShiftRequest?.shift).find(s => s?.cafeNumber);
    filterCafes = homeCafe ? [homeCafe] : (sampleShift?.cafeNumber ? [sampleShift.cafeNumber] : []);
  }

  // Cafe switch bar
  const switcher = document.getElementById('cafe-chip-group-scroll');
  const chipGroup = document.getElementById('cafe-chip-group');
  chipGroup.innerHTML = '';

  if (filterCafes.length <= 1) {
    switcher.classList.add('hidden');
    activeCafeTimeline = filterCafes[0] || homeCafe;
  } else {
    switcher.classList.remove('hidden');
    
    // Sort cafes to be consistent
    const sorted = [...filterCafes].sort();
    if (!activeCafeTimeline || !sorted.includes(activeCafeTimeline)) {
      activeCafeTimeline = sorted.includes(homeCafe) ? homeCafe : sorted[0];
    }

    sorted.forEach(cafeNo => {
      const displayName = getCafeDisplayName(cafeNo, schedule.cafeList);
      const chip = document.createElement('button');
      chip.className = `chip ${activeCafeTimeline === cafeNo ? 'active' : ''}`;
      chip.innerText = displayName;
      chip.onclick = () => {
        activeCafeTimeline = cafeNo;
        document.querySelectorAll('#cafe-chip-group .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        renderTeamScheduleView();
      };
      chipGroup.appendChild(chip);
    });
  }

  // Dynamic Horizontal Timeline Days Generator
  const container = document.getElementById('schedule-timeline-container');
  container.innerHTML = '';

  const teamData = state.cache.teamSchedule || [];
  const myShifts = schedule.currentShifts || [];
  const tracks = schedule.track || [];
  const employeeInfo = schedule.employeeInfo || [];

  // Merge datasets
  const mergedMembers = mergeTeamData(teamData, myShifts, tracks, employeeInfo);

  // Generate for the next 15 days (today to +14 days)
  const today = new Date();
  today.setHours(0,0,0,0);
  
  let hasData = false;

  for (let i = 0; i < 15; i++) {
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + i);
    const key = targetDate.toISOString().split('T')[0];

    // Filter shifts for this date and selected active Cafe
    const dayShifts = [];
    mergedMembers.forEach(member => {
      const isMe = member.associate?.employeeId === state.user.userId;
      const isAvail = member.associate?.employeeId === 'AVAILABLE_SHIFT';
      
      (member.shifts || []).forEach(shift => {
        if (shift.startDateTime && shift.startDateTime.substring(0, 10) === key) {
          const shiftCafe = shift.cafeNumber || activeCafeTimeline;
          if (shiftCafe === activeCafeTimeline) {
            dayShifts.push({
              shift,
              associate: member.associate,
              isMe,
              isAvailable: isAvail
            });
          }
        }
      });
    });

    if (dayShifts.length === 0) continue;
    hasData = true;

    // Render Timeline Card for this day
    const card = document.createElement('div');
    card.className = 'timeline-day-card';

    const header = document.createElement('div');
    header.className = 'timeline-day-header';
    
    const title = document.createElement('div');
    title.className = 'timeline-day-date';
    title.innerText = targetDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    header.appendChild(title);

    // Expand day details btn
    const expandBtn = document.createElement('button');
    expandBtn.className = 'text-action-btn';
    expandBtn.innerText = 'Expand';
    expandBtn.onclick = () => {
      const daySchedule = {
        date: targetDate,
        shifts: dayShifts
      };
      showExpandedDayTimeline(daySchedule);
    };
    header.appendChild(expandBtn);
    card.appendChild(header);

    // Timeline Visual Chart Row
    const chartOuter = document.createElement('div');
    chartOuter.className = 'chart-container-outer';
    
    // Draw visual grid inside chart
    drawTimelineChart(chartOuter, dayShifts);

    card.appendChild(chartOuter);
    container.appendChild(card);
  }

  document.getElementById('schedule-loading').classList.toggle('hidden', hasData || teamData.length > 0);
  
  // Timestamp updates
  const updatedText = document.getElementById('schedule-update-time');
  if (updatedText) {
    if (state.cache.lastTeamUpdate > 0) {
      updatedText.innerText = getLastUpdateText(state.cache.lastTeamUpdate);
    } else {
      updatedText.innerText = 'Updated --';
    }
  }
  if (state.currentTab === 'team-schedule') {
    updateHeaderTimestamp(state.cache.lastTeamUpdate || state.cache.lastUpdate);
  }
}

// Replicates Kotlin's mergeData mapping
function mergeTeamData(teamMembers, myShifts, tracks, employeeInfo) {
  const myId = state.user.userId;

  // 1. Map My Shifts
  const myTeamShifts = myShifts.map(s => ({
    shiftId: parseInt(s.shiftId, 10) || 0,
    startDateTime: s.startDateTime,
    endDateTime: s.endDateTime,
    workstationId: s.workstationId,
    workstationName: s.workstationName,
    workstationCode: s.workstationCode,
    cafeNumber: s.cafeNumber,
    companyCode: s.companyCode,
    employeeId: myId
  }));

  const me = {
    associate: {
      employeeId: myId,
      firstName: state.user.firstName,
      lastName: state.user.lastName,
      preferredName: state.user.preferredName
    },
    shifts: myTeamShifts
  };

  // 2. Map Available Shifts from Tracks
  const availableMembers = [];
  const availableShiftIds = new Set();

  tracks.forEach(item => {
    const isAvail = item.type === 'AVAILABLE';
    const stateOpen = item.primaryShiftRequest?.state === 'AVAILABLE' || item.primaryShiftRequest?.state === 'APPROVED';
    const claimed = item.relatedShiftRequests?.some(r => r.state === 'APPROVED');
    const s = item.primaryShiftRequest?.shift;

    if (isAvail && stateOpen && !claimed && s && isCafeFilterEnabled(s.cafeNumber)) {
      const myRequest = item.relatedShiftRequests?.find(r => r.requesterId === myId && (r.state === 'PENDING' || r.state === 'APPROVED'));
      
      const pendingRequests = (item.relatedShiftRequests || [])
        .filter(r => r.state === 'PENDING')
        .map(r => {
          const name = getCoworkerNameResolved(r.requesterId);
          const timeago = getTimeAgoText(r.requestedAt);
          return `${name} - ${timeago}`;
        });

      const ts = {
        shiftId: parseInt(s.shiftId, 10) || 0,
        startDateTime: s.startDateTime,
        endDateTime: s.endDateTime,
        workstationId: s.workstationId || s.workstationCode,
        workstationName: s.workstationName,
        workstationCode: s.workstationCode,
        cafeNumber: s.cafeNumber,
        companyCode: s.companyCode,
        employeeId: 'AVAILABLE_SHIFT',
        managerNotes: item.primaryShiftRequest.managerNotes,
        requesterName: getCoworkerNameResolved(item.primaryShiftRequest.requesterId),
        requestedAt: item.primaryShiftRequest.requestedAt,
        requestId: item.primaryShiftRequest.requestId,
        myPickupRequestId: myRequest?.requestId || null,
        pickupRequests: pendingRequests
      };

      if (s.shiftId) availableShiftIds.add(s.shiftId.toString());

      availableMembers.push({
        associate: {
          employeeId: 'AVAILABLE_SHIFT',
          firstName: 'AVAILABLE',
          lastName: 'PICK UP',
          preferredName: 'Available'
        },
        shifts: [ts]
      });
    }
  });

  // Filter out any shifts already posted for pickup from general coworker lists
  const filteredTeam = teamMembers
    .filter(member => member.associate?.employeeId !== myId)
    .map(member => {
      const shifts = (member.shifts || []).filter(s => !availableShiftIds.has(s.shiftId?.toString()));
      return { ...member, shifts };
    })
    .filter(member => member.shifts && member.shifts.length > 0);

  return [...filteredTeam, me, ...availableMembers];
}

// SVG / HTML Absolute CSS positioning timeline chart drawer
function drawTimelineChart(parentWrapper, dayShifts) {
  // Config dimensions
  const HOUR_WIDTH_PX = 60;
  const LANE_HEIGHT_PX = 32;

  // Determine day time window limits (min start, max end)
  let minStart = 24 * 60; // midnight in minutes
  let maxEnd = 0;
  
  const parsedShifts = dayShifts.map(item => {
    const sDate = new Date(item.shift.startDateTime);
    const eDate = new Date(item.shift.endDateTime);
    const startMin = sDate.getHours() * 60 + sDate.getMinutes();
    const endMin = eDate.getHours() * 60 + eDate.getMinutes();
    
    if (startMin < minStart) minStart = startMin;
    if (endMin > maxEnd) maxEnd = endMin;

    return {
      ...item,
      startMin,
      endMin
    };
  });

  // Default buffer parameters: 5 AM (300) to 11:30 PM (1410)
  const padStart = 300;
  const padEnd = 1410;
  
  const dayStartMin = Math.max(0, Math.min(padStart, minStart - 30));
  const dayEndMin = Math.min(24 * 60, Math.max(padEnd, maxEnd + 30));
  const totalDurationMin = dayEndMin - dayStartMin;

  // Render wrapper grid dimensions
  const totalHours = Math.ceil(totalDurationMin / 60);
  const containerWidthPx = totalHours * HOUR_WIDTH_PX;

  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'chart-grid-wrapper';
  scrollWrapper.style.width = `${containerWidthPx}px`;

  // Draw time axis headers
  const headerRow = document.createElement('div');
  headerRow.className = 'time-header-row';
  
  const axisStartHour = Math.floor(dayStartMin / 60);
  for (let h = 0; h <= totalHours; h++) {
    const currentHour = (axisStartHour + h) % 24;
    const label = document.createElement('div');
    label.className = 'time-axis-label';
    
    const ampm = currentHour >= 12 ? 'PM' : 'AM';
    const dispHour = currentHour % 12 === 0 ? 12 : currentHour % 12;
    
    label.innerText = `${dispHour}${ampm}`;
    
    // Position offset
    const offsetMin = (axisStartHour + h) * 60 - dayStartMin;
    const leftPct = (offsetMin / totalDurationMin) * 100;
    label.style.left = `${leftPct}%`;
    
    if (leftPct >= 0 && leftPct <= 100) {
      headerRow.appendChild(label);
    }
  }
  scrollWrapper.appendChild(headerRow);

  // Group shifts by lane rows to avoid overlap
  const lanes = []; // arrays of parsedShifts
  
  parsedShifts.forEach(item => {
    // Find first lane where this shift doesn't overlap existing items
    let placed = false;
    for (let l = 0; l < lanes.length; l++) {
      const lane = lanes[l];
      const overlap = lane.some(s => item.startMin < s.endMin && item.endMin > s.startMin);
      if (!overlap) {
        lane.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lanes.push([item]);
    }
  });

  // Render lanes and bars
  lanes.forEach((laneShifts, idx) => {
    const laneDiv = document.createElement('div');
    laneDiv.className = 'timeline-lane';

    laneShifts.forEach(item => {
      const bar = document.createElement('div');
      
      let stateClass = 'coworker';
      if (item.isMe) stateClass = 'me';
      if (item.isAvailable) stateClass = 'available';

      bar.className = `timeline-bar ${stateClass}`;
      
      // Calculate positioning
      const leftPct = ((item.startMin - dayStartMin) / totalDurationMin) * 100;
      const widthPct = ((item.endMin - item.startMin) / totalDurationMin) * 100;
      
      bar.style.left = `${leftPct}%`;
      bar.style.width = `${widthPct}%`;

      const role = getWorkstationDisplayName(item.shift.workstationId || item.shift.workstationCode, item.shift.workstationName);
      const name = resolveCoworkerName(item.associate?.employeeId, item.associate?.firstName, item.associate?.lastName);
      
      bar.innerText = item.isAvailable ? `${role}` : `${name} (${role})`;

      // Map to Shift object format on details click
      const mappedShift = {
        shiftId: item.shift.shiftId?.toString(),
        startDateTime: item.shift.startDateTime,
        endDateTime: item.shift.endDateTime,
        workstationId: item.shift.workstationId,
        workstationCode: item.shift.workstationCode,
        workstationName: item.shift.workstationName,
        cafeNumber: item.shift.cafeNumber,
        employeeId: item.associate?.employeeId,
        managerNotes: item.shift.managerNotes,
        requesterName: item.shift.requesterName,
        requestedAt: item.shift.requestedAt,
        requestId: item.shift.requestId,
        myPickupRequestId: item.shift.myPickupRequestId,
        pickupRequests: item.shift.pickupRequests
      };

      bar.onclick = () => openShiftDetails(mappedShift, item.isAvailable, item.shift);

      // Lane labels floating helper
      const label = document.createElement('div');
      label.className = 'timeline-lane-label';
      label.innerText = name;
      // We don't render it in mini timeline to save vertical space, but we can for expanded

      laneDiv.appendChild(bar);
    });

    scrollWrapper.appendChild(laneDiv);
  });

  parentWrapper.appendChild(scrollWrapper);
  
  // Center scroll wrapper onto current time if date is today
  const isToday = dayShifts.some(s => s.shift.startDateTime?.substring(0, 10) === new Date().toISOString().substring(0, 10));
  if (isToday) {
    setTimeout(() => {
      const now = new Date();
      const currentMin = now.getHours() * 60 + now.getMinutes();
      if (currentMin >= dayStartMin && currentMin <= dayEndMin) {
        const pct = (currentMin - dayStartMin) / totalDurationMin;
        parentWrapper.scrollLeft = (containerWidthPx * pct) - (parentWrapper.clientWidth / 2);
      }
    }, 100);
  }
}

// Expanded single-day timeline chart viewer modal
function showExpandedDayTimeline(daySchedule) {
  state.activeDaySchedule = daySchedule;
  
  // Create detail layout modal popup
  const container = document.getElementById('modal-coworkers-chart');
  container.innerHTML = '';

  const modal = document.getElementById('shift-detail-modal');
  document.getElementById('shift-modal-title').innerText = daySchedule.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  
  // Hide details parameters
  document.getElementById('shift-modal-position').parentElement.classList.add('hidden');
  document.getElementById('shift-modal-datetime').parentElement.classList.add('hidden');
  document.getElementById('shift-modal-location').parentElement.classList.add('hidden');
  document.getElementById('shift-modal-note-row').classList.add('hidden');
  document.getElementById('shift-modal-money-row').classList.add('hidden');
  document.getElementById('shift-modal-pickup-requests-row').classList.add('hidden');
  document.getElementById('shift-modal-actions').innerHTML = '';

  // Show visual chart container
  document.getElementById('shift-modal-coworkers-wrapper').classList.remove('hidden');
  document.getElementById('modal-share-chart-btn').classList.add('hidden');
  document.getElementById('modal-expand-chart-btn').classList.add('hidden');

  drawTimelineChart(container, daySchedule.shifts);
  openModal('shift-detail-modal');
}

// ----------------------------------------------------
// TAB 3: NOTIFICATIONS VIEW RENDERER
// ----------------------------------------------------
function renderNotificationsView() {
  const notifs = state.cache.notifications || [];
  const list = document.getElementById('notifications-list');
  list.innerHTML = '';

  const activeNotifs = notifs.filter(n => n.deleted !== true);

  if (activeNotifs.length > 0) {
    document.getElementById('notifications-empty').classList.add('hidden');
    
    // Sort unread first, then by date descending
    const sorted = [...activeNotifs].sort((a,b) => {
      if (a.read !== b.read) {
        return a.read ? 1 : -1;
      }
      return b.createDateTime.localeCompare(a.createDateTime);
    });

    sorted.forEach(notif => {
      const card = document.createElement('div');
      card.className = `notif-card ${notif.read ? '' : 'unread'}`;
      
      card.onclick = (e) => {
        if (e.target.closest('button')) return; // ignore row clicks if clicking action buttons
        openNotificationViewer(notif);
      };

      const header = document.createElement('div');
      header.className = 'notif-header';
      
      const subject = document.createElement('div');
      subject.className = 'notif-subject';
      subject.innerText = notif.subject || 'No Subject';
      header.appendChild(subject);

      const dateText = document.createElement('div');
      dateText.className = 'notif-date';
      dateText.innerText = formatNotifDate(notif.createDateTime);
      header.appendChild(dateText);
      card.appendChild(header);

      const preview = document.createElement('div');
      preview.className = 'notif-preview';
      preview.innerText = cleanHtmlText(notif.message || '').substring(0, 100);
      card.appendChild(preview);

      // Actions bottom row
      const actions = document.createElement('div');
      actions.className = 'notif-row-actions';

      const readBtn = document.createElement('button');
      readBtn.className = 'text-action-btn';
      readBtn.innerText = notif.read ? 'Mark Unread' : 'Mark Read';
      readBtn.onclick = () => toggleNotificationReadState(notif.notificationId, !notif.read);
      actions.appendChild(readBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'text-action-btn red-text';
      delBtn.innerText = 'Delete';
      delBtn.onclick = () => deleteNotificationItem(notif.notificationId);
      actions.appendChild(delBtn);

      card.appendChild(actions);
      list.appendChild(card);
    });
  } else {
    document.getElementById('notifications-empty').classList.remove('hidden');
  }
}

async function toggleNotificationReadState(notificationId, isRead) {
  // Optimistic UI updates
  const notifs = state.cache.notifications || [];
  const idx = notifs.findIndex(n => n.notificationId === notificationId);
  if (idx !== -1) {
    notifs[idx].read = isRead;
    saveCache('notifications', notifs);
    renderNotificationsView();
    updateNotificationBadge();
  }

  // Update notified list on client side
  if (isRead) {
    if (!state.cache.notifiedIds.includes(notificationId)) {
      state.cache.notifiedIds.push(notificationId);
      saveCache('notifiedIds', state.cache.notifiedIds);
    }
  } else {
    state.cache.notifiedIds = state.cache.notifiedIds.filter(id => id !== notificationId);
    saveCache('notifiedIds', state.cache.notifiedIds);
  }

  try {
    const url = `https://pantry.panerabread.com/apis/pantry-ui-service/notification/v1/api/notifications/${notificationId}/read`;
    // PUT request with body "true" or "false"
    await apiRequest(url, 'PUT', isRead ? 'true' : 'false');
  } catch (e) {
    console.error('Failed to sync notification read state:', e);
  }
}

async function deleteNotificationItem(notificationId) {
  // Optimistic UI updates
  const notifs = state.cache.notifications || [];
  const idx = notifs.findIndex(n => n.notificationId === notificationId);
  if (idx !== -1) {
    notifs[idx].deleted = true;
    saveCache('notifications', notifs);
    renderNotificationsView();
    updateNotificationBadge();
  }

  try {
    const url = `https://pantry.panerabread.com/apis/pantry-ui-service/notification/v1/api/notifications/${notificationId}/delete`;
    await apiRequest(url, 'PUT', 'true');
    showToast('Notification deleted');
  } catch (e) {
    console.error('Failed to delete notification:', e);
  }
}

function updateNotificationBadge() {
  const notifs = state.cache.notifications || [];
  const unreadCount = notifs.filter(n => n.read === false && n.deleted !== true && isCafeFilterEnabled(getCafeNumberFromNotification(n))).length;
  
  const badge = document.getElementById('notif-badge');
  if (unreadCount > 0) {
    badge.innerText = unreadCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function markAllNotificationsAsRead() {
  const notifs = state.cache.notifications || [];
  const unread = notifs.filter(n => n.read === false && n.deleted !== true);
  if (unread.length === 0) return;

  unread.forEach(n => {
    toggleNotificationReadState(n.notificationId, true);
  });
  showToast('All notifications marked as read');
}

// ----------------------------------------------------
// TAB 4: SETTINGS VIEW RENDERER
// ----------------------------------------------------
function renderSettingsView() {
  if (state.user) {
    document.getElementById('settings-user-name').innerText = `${state.user.preferredName || state.user.firstName} ${state.user.lastName}`.trim();
    document.getElementById('settings-user-id').innerText = `User ID: ${state.user.userId || '--'}`;
  }
  document.getElementById('settings-server-url').innerText = state.serverUrl || window.location.origin;
}

// enabled cafe helpers
function isCafeFilterEnabled(cafeNo) {
  if (!cafeNo) return true;
  // If we are currently rendering the home view, filter by activeCafeHome if set
  if (state.currentTab === 'home' && activeCafeHome) {
    return cafeNo.toString() === activeCafeHome.toString();
  }
  // If we are rendering the team schedule view, filter by activeCafeTimeline if set
  if (state.currentTab === 'team-schedule' && activeCafeTimeline) {
    return cafeNo.toString() === activeCafeTimeline.toString();
  }
  const list = state.settings.enabledCafes;
  if (list.length === 0) return true;
  return list.includes(cafeNo.toString());
}

// ----------------------------------------------------
// SUB-VIEW: AVAILABILITY & TIME OFF RENDERER
// ----------------------------------------------------
function renderAvailabilityView() {
  const av = state.cache.availability;
  const max = state.cache.maxHours;
  const timeOff = state.cache.timeOff || [];

  // Update timestamps
  const updatedText = document.getElementById('updatedText');
  if (updatedText) {
    updatedText.innerText = getLastUpdateText(state.cache.lastUpdate);
  }

  // 1. Max Hours Card
  const approvedDaily = max?.approved?.maxHoursDaily || '--';
  const approvedWeekly = max?.approved?.maxHoursWeekly || '--';
  document.getElementById('daily-max-value').innerText = approvedDaily;
  document.getElementById('weekly-max-value').innerText = approvedWeekly;

  const pendingDailyDiv = document.getElementById('daily-max-pending');
  const pendingWeeklyDiv = document.getElementById('weekly-max-pending');
  const cancelBtn = document.getElementById('cancel-pending-changes-btn');

  const hasPendingMax = max?.pending !== null && max?.pending !== undefined;
  const hasPendingAvail = av?.pending !== null && av?.pending !== undefined;

  if (hasPendingMax) {
    pendingDailyDiv.innerText = `PENDING: ${max.pending.maxHoursDaily}`;
    pendingDailyDiv.classList.remove('hidden');
    pendingWeeklyDiv.innerText = `PENDING: ${max.pending.maxHoursWeekly}`;
    pendingWeeklyDiv.classList.remove('hidden');
  } else {
    pendingDailyDiv.classList.add('hidden');
    pendingWeeklyDiv.classList.add('hidden');
  }

  // Show cancel changes button if pending items exist
  if (hasPendingMax || hasPendingAvail) {
    cancelBtn.classList.remove('hidden');
  } else {
    cancelBtn.classList.add('hidden');
  }

  // 2. Weekly Availability Row List
  const avContainer = document.getElementById('availability-rows-container');
  avContainer.innerHTML = '';

  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const approvedMap = av?.approved?.availableTime || {};
  const pendingMap = av?.pending?.availableTime || null;

  days.forEach(dayKey => {
    const card = document.createElement('div');
    card.className = 'card';

    const row = document.createElement('div');
    row.className = 'availability-day-row';

    const nameTv = document.createElement('div');
    nameTv.className = 'avail-day-name';
    nameTv.innerText = dayKey.charAt(0) + dayKey.substring(1).toLowerCase();
    row.appendChild(nameTv);

    const timesCol = document.createElement('div');
    timesCol.className = 'avail-times-column';

    // Approved time slot text
    const approvedSlots = approvedMap[dayKey] || [];
    const approvedText = formatTimeSlotsText(approvedSlots);
    
    const apprTv = document.createElement('div');
    apprTv.className = 'avail-time-approved';
    apprTv.innerText = approvedText;
    timesCol.appendChild(apprTv);

    // Pending time slot text
    if (pendingMap && pendingMap[dayKey]) {
      const pendingSlots = pendingMap[dayKey];
      const pendingText = formatTimeSlotsText(pendingSlots);
      
      const pendTv = document.createElement('div');
      pendTv.className = 'avail-time-pending orange-text';
      pendTv.innerText = `PENDING: ${pendingText}`;
      timesCol.appendChild(pendTv);
    }

    row.appendChild(timesCol);
    card.appendChild(row);
    avContainer.appendChild(card);
  });

  // 3. Time Off Requests list
  const toContainer = document.getElementById('time-off-list-container');
  toContainer.innerHTML = '';
  
  const today = new Date();
  today.setHours(0,0,0,0);

  // Filter chronologically upcoming requests
  const upcomingTo = timeOff.filter(req => {
    try {
      const date = new Date(req.timeOffDate);
      return date >= today;
    } catch(e) { return true; }
  });

  upcomingTo.sort((a,b) => a.timeOffDate.localeCompare(b.timeOffDate));

  if (upcomingTo.length > 0) {
    document.getElementById('time-off-empty').classList.add('hidden');
    
    upcomingTo.forEach(req => {
      const card = document.createElement('div');
      card.className = 'card';

      const content = document.createElement('div');
      content.className = 'time-off-card-content';

      // Header Date & Status
      const row1 = document.createElement('div');
      row1.className = 'time-off-card-row';

      const dateTv = document.createElement('div');
      dateTv.className = 'time-off-date';
      dateTv.innerText = new Date(req.timeOffDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      row1.appendChild(dateTv);

      const statusTv = document.createElement('div');
      statusTv.className = `time-off-status ${req.status.toLowerCase()}`;
      statusTv.innerText = req.status;
      row1.appendChild(statusTv);
      content.appendChild(row1);

      // Times & Delete Action Row
      const row2 = document.createElement('div');
      row2.className = 'time-off-card-row';

      const hoursTv = document.createElement('div');
      hoursTv.className = 'time-off-hours';
      
      const isAllDay = !req.startTime || !req.endTime;
      if (isAllDay) {
        hoursTv.innerText = 'All Day';
      } else {
        const sTime = formatTimeSlotString(req.startTime);
        const eTime = formatTimeSlotString(req.endTime);
        hoursTv.innerText = `${sTime} - ${eTime}`;
      }
      row2.appendChild(hoursTv);

      // Trash cancellation button
      if (req.status === 'PENDING' || req.status === 'APPROVED') {
        const trashBtn = document.createElement('button');
        trashBtn.className = 'icon-btn';
        trashBtn.innerHTML = `<svg class="icon red-text" viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>`;
        trashBtn.onclick = () => cancelTimeOffRequest(req);
        row2.appendChild(trashBtn);
      }
      content.appendChild(row2);

      // Comments
      if (req.associateComments) {
        const comment = document.createElement('div');
        comment.className = 'time-off-comment';
        comment.innerText = req.associateComments;
        content.appendChild(comment);
      }

      card.appendChild(content);
      toContainer.appendChild(card);
    });
  } else {
    document.getElementById('time-off-empty').classList.remove('hidden');
  }
}

function formatTimeSlotsText(slots) {
  if (slots.length === 0) return 'Not Available';
  if (slots.some(s => s.allDay === true)) return 'All Day';
  return slots.map(s => `${formatTimeSlotString(s.start)} - ${formatTimeSlotString(s.end)}`).join('\n');
}

function formatTimeSlotString(timeStr) {
  if (!timeStr) return '';
  // Check if ISO LocalDateTime
  if (timeStr.includes('T')) {
    const parts = timeStr.split('T');
    timeStr = parts[1];
  }
  try {
    const parts = timeStr.split(':');
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1] || '00';
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 is 12
    return `${hours}:${minutes}${ampm}`;
  } catch(e) { return timeStr; }
}

async function cancelTimeOffRequest(req) {
  const confirmCancel = confirm('Are you sure you want to cancel this time off request?');
  if (!confirmCancel) return;

  showToast('Cancelling request...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/franchise-request-time-off/cancel';
    const payload = {
      thirdPartyId: 'Self-Service',
      requestId: req.requestId,
      status: 'CANCELLED'
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Time off request cancelled');
      // Re-fetch time off list
      const toUrl = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/franchise-request-time-off/all?paneraId=${state.user.userId}`;
      const timeoff = await apiRequest(toUrl);
      saveCache('timeOff', timeoff);
      renderAvailabilityView();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to cancel request');
  }
}

async function cancelPendingAvailabilityChanges() {
  const confirmCancel = confirm('Are you sure you want to cancel all pending availability and max hours changes?');
  if (!confirmCancel) return;

  showToast('Cancelling changes...');
  try {
    const hasPendingAvail = state.cache.availability?.pending !== null;
    const hasPendingMax = state.cache.maxHours?.pending !== null;
    
    let success = true;
    const cafeNo = parseInt(state.user.cafeNo, 10) || 202924;

    if (hasPendingAvail) {
      const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/availability/cancel';
      const payload = {
        request: {},
        employeeId: state.user.userId,
        cafeNo: cafeNo
      };
      const res = await apiRequest(url, 'POST', payload);
      if (!res) success = false;
    }

    if (hasPendingMax) {
      const url = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/max-hours/cancel?paneraId=${state.user.userId}`;
      const res = await apiRequest(url, 'POST', {});
      if (!res) success = false;
    }

    if (success) {
      showToast('Pending changes cancelled');
      // Reload Availability and Cache
      const avUrl = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/availability?employeeId=${state.user.userId}`;
      const av = await apiRequest(avUrl);
      saveCache('availability', av);

      const maxUrl = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/max-hours/all?paneraId=${state.user.userId}`;
      const max = await apiRequest(maxUrl);
      saveCache('maxHours', max);

      renderAvailabilityView();
    } else {
      showToast('Failed to cancel some pending changes');
    }
  } catch(e) {
    console.error(e);
    showToast('Error cancelling changes');
  }
}

// ----------------------------------------------------
// MODAL POPUPS CONTROLLER & RENDERS
// ----------------------------------------------------
function openModal(modalId) {
  document.getElementById(modalId).classList.remove('hidden');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.add('hidden');
  
  // Clear any sub-states
  if (modalId === 'shift-detail-modal') {
    state.activeDaySchedule = null;
  }
}

// Day schedule details calendar grid cell click modal
// Day schedule details calendar grid cell click modal
function createShiftCardElement(shift, isAvailable, hideCoworkers = false, trackItem = null) {
  // Combine shifts logic if combineShifts is enabled
  let displayShift = { ...shift };
  if (state.settings.combineShifts && !isAvailable && shift.employeeId) {
    const cacheTeam = state.cache.teamSchedule || [];
    const schedule = state.cache.schedule;
    const mergedMembers = mergeTeamData(cacheTeam, schedule?.currentShifts || [], schedule?.track || [], schedule?.employeeInfo || []);
    const person = mergedMembers.find(m => m.associate?.employeeId === shift.employeeId);
    const day = shift.startDateTime.substring(0, 10);
    const sameDayShifts = (person?.shifts || []).filter(s => s.startDateTime.substring(0, 10) === day);
    
    if (sameDayShifts.length > 1) {
      const sorted = [...sameDayShifts].sort((a,b) => a.startDateTime.localeCompare(b.startDateTime));
      displayShift.startDateTime = sorted[0].startDateTime;
      displayShift.endDateTime = sorted[sorted.length - 1].endDateTime;
      displayShift.workstationName = sorted.map(s => getWorkstationDisplayName(s.workstationId || s.workstationCode, s.workstationName)).join(' / ');
      displayShift.combinedShifts = sorted;
    }
  }

  const card = document.createElement('div');
  card.className = 'card shift-detail-card';

  // Centered Title/Header (similar to Android app)
  const titleEl = document.createElement('h3');
  titleEl.className = 'shift-card-title';
  titleEl.style.fontSize = '16px';
  titleEl.style.fontWeight = '700';
  titleEl.style.marginBottom = '8px';
  titleEl.style.textAlign = 'center';
  titleEl.innerText = isAvailable ? 'Available Shift' : getCoworkerNameResolved(displayShift.employeeId);
  card.appendChild(titleEl);

  // Centered Date & Time
  const timeEl = document.createElement('div');
  timeEl.className = 'shift-card-datetime';
  timeEl.innerText = formatShiftDetailsDateTimeString(displayShift.startDateTime, displayShift.endDateTime);
  card.appendChild(timeEl);

  // Resolve track item if needed
  let resolvedTrackItem = trackItem;
  if (isAvailable && !resolvedTrackItem) {
    resolvedTrackItem = (state.cache.schedule?.track || []).find(t => 
      t.type === 'AVAILABLE' && 
      t.primaryShiftRequest?.shift?.shiftId?.toString() === displayShift.shiftId?.toString()
    );
  }

  // Status / Posted By (if available shift or note present)
  let statusText = '';
  if (isAvailable && resolvedTrackItem?.primaryShiftRequest) {
    const req = resolvedTrackItem.primaryShiftRequest;
    statusText = `Posted by ${getCoworkerNameResolved(req.requesterId)} ${getTimeAgoText(req.requestedAt)}`;
  }
  if (displayShift.managerNotes) {
    statusText = (statusText ? statusText + '\n' : '') + `Note: ${displayShift.managerNotes}`;
  }

  if (statusText) {
    const statusEl = document.createElement('div');
    statusEl.className = 'shift-card-status';
    statusEl.innerText = statusText;
    card.appendChild(statusEl);
  }

  // Position (Workstation)
  const posEl = document.createElement('div');
  posEl.className = 'shift-card-position';
  posEl.innerText = getWorkstationDisplayName(displayShift.workstationId || displayShift.workstationCode, displayShift.workstationName);
  card.appendChild(posEl);

  // Money (Projected Earnings)
  if (state.settings.showMoney && (displayShift.employeeId === state.user.userId || isAvailable)) {
    const moneyEl = document.createElement('div');
    moneyEl.className = 'shift-card-money';
    moneyEl.innerText = `$${calculateShiftEarnings(displayShift.startDateTime, displayShift.endDateTime).toFixed(2)}`;
    card.appendChild(moneyEl);
  }

  // Coworkers on Duty section (timeline chart)
  if (!hideCoworkers && displayShift.cafeNumber) {
    const coworkersWrapper = document.createElement('div');
    coworkersWrapper.className = 'shift-card-coworkers-wrapper';

    const headerRow = document.createElement('div');
    headerRow.className = 'coworkers-header-row';
    
    const h4 = document.createElement('h4');
    h4.innerText = 'SCHEDULE';
    headerRow.appendChild(h4);

    const actions = document.createElement('div');
    actions.className = 'action-row';

    // Share Button
    const shareBtn = document.createElement('button');
    shareBtn.className = 'text-action-btn flex-center';
    shareBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.91,20.61 20.91,19C20.91,17.39 19.61,16.08 18,16.08Z"/></svg> Share`;
    shareBtn.onclick = (e) => {
      e.stopPropagation();
      showToast('Share details chart is coming soon.');
    };
    actions.appendChild(shareBtn);

    // Expand Button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'text-action-btn flex-center';
    expandBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M9.5,13.09L10.91,14.5L6.41,19H10V21H3V14H5V17.59L9.5,13.09M10.91,9.5L9.5,10.91L5,6.41V10H3V3H10V5H6.41L10.91,9.5M14.5,13.09L19,17.59V14H21V21H14V19H17.59L13.09,14.5L14.5,13.09M13.09,9.5L14.5,8.09L19,12.59V9H21V3H14V5H17.59L13.09,9.5Z"/></svg> Expand`;
    
    actions.appendChild(expandBtn);
    headerRow.appendChild(actions);
    coworkersWrapper.appendChild(headerRow);

    const chartScroll = document.createElement('div');
    chartScroll.className = 'coworkers-chart-scroll';
    const chartTimeline = document.createElement('div');
    chartTimeline.className = 'coworkers-timeline-chart';
    chartScroll.appendChild(chartTimeline);
    coworkersWrapper.appendChild(chartScroll);

    // Load coworker shifts overlapping with this shift (exact Kotlin overlap math)
    const teamData = state.cache.teamSchedule || [];
    const schedule = state.cache.schedule;
    const merged = mergeTeamData(teamData, schedule?.currentShifts || [], schedule?.track || [], schedule?.employeeInfo || []);
    const key = displayShift.startDateTime.substring(0, 10);
    const myStart = new Date(displayShift.startDateTime);
    const myEnd = new Date(displayShift.endDateTime);

    const dayShifts = [];
    merged.forEach(member => {
      const isMe = member.associate?.employeeId === state.user.userId;
      const isAvail = member.associate?.employeeId === 'AVAILABLE_SHIFT';
      
      (member.shifts || []).forEach(s => {
        if (s.startDateTime && s.startDateTime.substring(0, 10) === key) {
          const sStart = new Date(s.startDateTime);
          const sEnd = new Date(s.endDateTime);
          if (sStart < myEnd && sEnd > myStart && (s.cafeNumber === null || s.cafeNumber === displayShift.cafeNumber)) {
            dayShifts.push({
              shift: s,
              associate: member.associate,
              isMe,
              isAvailable: isAvail
            });
          }
        }
      });
    });

    if (dayShifts.length > 0) {
      expandBtn.onclick = (e) => {
        e.stopPropagation();
        closeModal('shift-detail-modal');
        showExpandedDayTimeline({ date: new Date(displayShift.startDateTime), shifts: dayShifts });
      };
      drawTimelineChart(chartTimeline, dayShifts);
      card.appendChild(coworkersWrapper);
    }
  }

  // Pickup attempts list (coworkers attempting to pickup my posted shifts)
  const myId = state.user.userId;
  const isPoster = !isAvailable && displayShift.employeeId === myId;
  if (isAvailable || isPoster) {
    const trackItem = resolvedTrackItem || (state.cache.schedule?.track || []).find(t => 
      t.primaryShiftRequest?.shift?.shiftId?.toString() === displayShift.shiftId?.toString() &&
      t.primaryShiftRequest?.state !== 'CANCELLED'
    );
    
    if (trackItem) {
      const pendingList = (trackItem.relatedShiftRequests || []).filter(r => r.state === 'PENDING');
      if (pendingList.length > 0) {
        const pickupTitle = document.createElement('div');
        pickupTitle.className = 'pickup-requests-title';
        pickupTitle.innerText = `Pickup Requests (${pendingList.length})`;
        card.appendChild(pickupTitle);

        const listContainer = document.createElement('div');
        listContainer.className = 'pickup-requests-wrapper';
        pendingList.forEach(r => {
          const rowText = document.createElement('div');
          const pName = getCoworkerNameResolved(r.requesterId);
          rowText.innerText = `• ${pName} requested ${getTimeAgoText(r.requestedAt)}`;
          listContainer.appendChild(rowText);
        });
        card.appendChild(listContainer);
      }
    }
  }

  // Location (Cafe Display Name)
  const locEl = document.createElement('div');
  locEl.className = 'shift-card-location';
  locEl.innerText = getCafeDisplayName(displayShift.cafeNumber, state.cache.schedule?.cafeList);
  card.appendChild(locEl);

  // Actions (Footer buttons: Trade, Cover, Pickup, Post, etc.)
  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'modal-actions-container';

  if (isAvailable) {
    const myRequest = resolvedTrackItem?.relatedShiftRequests?.find(r => r.requesterId === myId && (r.state === 'PENDING' || r.state === 'APPROVED'));

    if (myRequest) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn warning-btn';
      cancelBtn.innerText = 'Cancel Pickup Request';
      cancelBtn.onclick = () => {
        closeModal('shift-detail-modal');
        cancelPickupRequest(myRequest.requestId, displayShift);
      };
      actionsContainer.appendChild(cancelBtn);
    } else {
      const pickupBtn = document.createElement('button');
      pickupBtn.className = 'btn success-btn';
      pickupBtn.innerText = 'Pick Up';
      pickupBtn.onclick = () => {
        closeModal('shift-detail-modal');
        requestShiftPickup(resolvedTrackItem?.primaryShiftRequest?.requestId, displayShift);
      };
      actionsContainer.appendChild(pickupBtn);
    }
  } else {
    const isFuture = new Date(displayShift.startDateTime) > new Date();
    if (isFuture && displayShift.employeeId === state.user.userId) {
      const latestActivePost = state.cache.schedule?.track?.filter(it => 
        it.primaryShiftRequest?.shift?.shiftId?.toString() === displayShift.shiftId?.toString() &&
        (it.primaryShiftRequest?.state === 'AVAILABLE' || it.primaryShiftRequest?.state === 'PENDING')
      )?.sort((a,b) => (b.primaryShiftRequest?.requestedAt || '').localeCompare(a.primaryShiftRequest?.requestedAt || ''))?.[0];

      if (latestActivePost) {
        const reqType = latestActivePost.type || latestActivePost.primaryShiftRequest?.type || 'POST';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn warning-btn';
        cancelBtn.innerText = reqType === 'TRADE' ? 'Cancel Trade' : (reqType === 'COVER' ? 'Cancel Cover' : 'Cancel Post');
        cancelBtn.onclick = () => {
          closeModal('shift-detail-modal');
          cancelShiftPost(latestActivePost.primaryShiftRequest.requestId, displayShift);
        };
        actionsContainer.appendChild(cancelBtn);
      } else {
        const postBtn = document.createElement('button');
        postBtn.className = 'btn success-btn';
        postBtn.style.width = '100%';
        postBtn.style.marginBottom = '8px';
        postBtn.innerText = 'Post Shift for Pickup';
        postBtn.onclick = () => {
          closeModal('shift-detail-modal');
          postShiftForPickup(displayShift);
        };
        actionsContainer.appendChild(postBtn);

        const tradeBtn = document.createElement('button');
        tradeBtn.className = 'btn secondary-btn';
        tradeBtn.style.width = '100%';
        tradeBtn.style.marginBottom = '8px';
        tradeBtn.innerText = 'Trade Shift';
        tradeBtn.onclick = () => {
          closeModal('shift-detail-modal');
          startShiftTradeFlow(displayShift);
        };
        actionsContainer.appendChild(tradeBtn);

        const coverBtn = document.createElement('button');
        coverBtn.className = 'btn secondary-btn';
        coverBtn.style.width = '100%';
        coverBtn.innerText = 'Request Cover';
        coverBtn.onclick = () => {
          closeModal('shift-detail-modal');
          startShiftCoverFlow(displayShift);
        };
        actionsContainer.appendChild(coverBtn);
      }
    }
  }

  if (actionsContainer.children.length > 0) {
    card.appendChild(actionsContainer);
  }

  return card;
}

function showDayScheduleModal(date, shifts, avails) {
  const modalBody = document.getElementById('shift-detail-modal-body');
  modalBody.innerHTML = '';

  // Header Title Date
  document.getElementById('shift-modal-title').innerText = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // 1. My Shifts
  shifts.forEach(s => {
    const card = createShiftCardElement(s, false, false);
    modalBody.appendChild(card);
  });

  // Separator & 2. Available Shifts
  if (shifts.length > 0 && avails.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'shift-detail-card-separator';
    sep.innerText = 'AVAILABLE SHIFTS';
    modalBody.appendChild(sep);
  }

  avails.forEach(s => {
    const trackItem = (state.cache.schedule?.track || []).find(t => 
      t.type === 'AVAILABLE' && 
      t.primaryShiftRequest?.shift?.shiftId?.toString() === s.shiftId?.toString()
    );
    const card = createShiftCardElement(s, true, false, trackItem);
    modalBody.appendChild(card);
  });

  if (shifts.length === 0 && avails.length === 0) {
    showToast('No shifts scheduled for this day');
    return;
  }

  openModal('shift-detail-modal');
}

function openShiftDetails(shift, isAvailable, trackItem = null) {
  const modalBody = document.getElementById('shift-detail-modal-body');
  modalBody.innerHTML = '';

  // Determine Title Name
  let titleName = 'Shift Details';
  let hideCoworkers = false;

  if (isAvailable) {
    titleName = 'Available Shift';
  } else if (shift.employeeId && shift.employeeId !== state.user.userId) {
    titleName = getCoworkerNameResolved(shift.employeeId);
    hideCoworkers = true;
  }

  document.getElementById('shift-modal-title').innerText = titleName;

  // Resolve Track Item if needed
  let resolvedTrackItem = trackItem;
  if (isAvailable && !resolvedTrackItem) {
    resolvedTrackItem = (state.cache.schedule?.track || []).find(t => 
      t.type === 'AVAILABLE' && 
      t.primaryShiftRequest?.shift?.shiftId?.toString() === shift.shiftId?.toString()
    );
  }

  const card = createShiftCardElement(shift, isAvailable, hideCoworkers, resolvedTrackItem);
  modalBody.appendChild(card);

  openModal('shift-detail-modal');
}

// ----------------------------------------------------
// SHIFT MODIFY CONTROLLER WORKFLOWS
// ----------------------------------------------------
async function requestShiftPickup(requestId, shift) {
  showToast('Submitting request...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/shifts/available/accept';
    const payload = {
      associateResponse: 'Accepted',
      requestId: requestId,
      shiftId: parseInt(shift.shiftId, 10),
      receiveAssociate: {
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        employeeId: state.user.userId
      }
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Pickup request submitted');
      closeModal('shift-detail-modal');
      refreshData();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to pick up shift');
  }
}

async function cancelPickupRequest(requestId, shift) {
  showToast('Cancelling request...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/shifts/available/cancel';
    const payload = {
      requestId: parseInt(requestId, 10),
      giveAssociate: {
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        employeeId: state.user.userId
      }
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Pickup request cancelled');
      closeModal('shift-detail-modal');
      refreshData();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to cancel request');
  }
}

async function postShiftForPickup(shift) {
  const confirmPost = confirm('Are you sure you want to post this shift for pickup?');
  if (!confirmPost) return;

  showToast('Posting shift...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/shifts/available';
    const payload = {
      cafeNo: parseInt(shift.cafeNumber, 10) || 0,
      companyCode: shift.companyCode || '101',
      giveAssociate: {
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        employeeId: state.user.userId
      },
      giveShift: {
        shiftId: parseInt(shift.shiftId, 10),
        startDateTime: shift.startDateTime,
        endDateTime: shift.endDateTime
      }
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Shift posted successfully');
      closeModal('shift-detail-modal');
      refreshData();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to post shift');
  }
}

async function cancelShiftPost(requestId, shift) {
  showToast('Cancelling post...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/shifts/available/cancel';
    const payload = {
      requestId: parseInt(requestId, 10),
      giveAssociate: {
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        employeeId: state.user.userId
      }
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Shift post cancelled');
      closeModal('shift-detail-modal');
      refreshData();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to cancel post');
  }
}

// ----------------------------------------------------
// COWORKER SELECT & FLOW TRIGGERS
// ----------------------------------------------------
let tradeFlowShift = null;
let coverFlowShift = null;

function startShiftCoverFlow(shift) {
  coverFlowShift = shift;
  closeModal('shift-detail-modal');
  
  // Set title
  document.getElementById('select-coworker-title').innerText = 'Select Coworker to Cover';
  populateCoworkerSelectList(associate => {
    performShiftCover(shift, associate);
  });
  
  openModal('select-coworker-modal');
}

async function performShiftCover(shift, coworker) {
  const confirmCover = confirm(`Request ${coworker.preferredName || coworker.firstName} to cover your shift?`);
  if (!confirmCover) return;

  showToast('Sending cover request...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/shifts/cover';
    const payload = {
      cafeNo: parseInt(shift.cafeNumber, 10) || 0,
      giveAssociate: {
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        employeeId: state.user.userId
      },
      giveShift: {
        shiftId: parseInt(shift.shiftId, 10),
        startDateTime: shift.startDateTime,
        endDateTime: shift.endDateTime
      },
      receiveAssociate: {
        firstName: coworker.firstName,
        lastName: coworker.lastName,
        preferredName: coworker.preferredName,
        employeeId: coworker.employeeId
      }
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Cover request sent successfully');
      closeModal('select-coworker-modal');
      refreshData();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to request cover');
  }
}

function startShiftTradeFlow(shift) {
  tradeFlowShift = shift;
  closeModal('shift-detail-modal');
  
  document.getElementById('select-coworker-title').innerText = 'Select Coworker to Trade With';
  populateCoworkerSelectList(associate => {
    closeModal('select-coworker-modal');
    startTradeShiftSelection(shift, associate);
  });
  
  openModal('select-coworker-modal');
}

function startTradeShiftSelection(myShift, coworker) {
  const modal = document.getElementById('select-peer-shift-modal');
  document.getElementById('select-peer-shift-title').innerText = `Trade with ${coworker.preferredName || coworker.firstName}`;
  
  const list = document.getElementById('peer-shift-select-list');
  list.innerHTML = '';
  
  // Find coworker shifts for trade options
  const peerShifts = [];
  if (state.cache.teamSchedule) {
    const member = state.cache.teamSchedule.find(m => m.associate?.employeeId === coworker.employeeId);
    if (member && member.shifts) {
      member.shifts.forEach(s => {
        if (s.cafeNumber === myShift.cafeNumber) {
          peerShifts.push(s);
        }
      });
    }
  }

  // Sort
  peerShifts.sort((a,b) => a.startDateTime.localeCompare(b.startDateTime));
  const todayStart = new Date().toISOString().substring(0, 10) + 'T00:00:00';
  const futureShifts = peerShifts.filter(s => s.startDateTime >= todayStart);

  if (futureShifts.length > 0) {
    document.getElementById('peer-shift-select-empty').classList.add('hidden');
    
    futureShifts.forEach(s => {
      const card = document.createElement('div');
      card.className = 'shift-card';
      card.onclick = () => performShiftTrade(myShift, coworker, s);

      const left = document.createElement('div');
      left.className = 'shift-left';
      
      const timeText = document.createElement('div');
      timeText.className = 'shift-time';
      timeText.innerText = formatShiftDateTime(s.startDateTime, s.endDateTime);
      
      const roleText = document.createElement('div');
      roleText.className = 'shift-role';
      roleText.innerText = getWorkstationDisplayName(s.workstationId || s.workstationCode, s.workstationName);

      left.appendChild(timeText);
      left.appendChild(roleText);
      card.appendChild(left);
      list.appendChild(card);
    });
  } else {
    document.getElementById('peer-shift-select-empty').classList.remove('hidden');
  }

  openModal('select-peer-shift-modal');
}

async function performShiftTrade(myShift, coworker, coworkerShift) {
  const confirmTrade = confirm(`Send trade request: your shift for their shift on ${new Date(coworkerShift.startDateTime).toLocaleDateString()}?`);
  if (!confirmTrade) return;

  showToast('Sending trade request...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/shifts/trade';
    const payload = {
      cafeNo: parseInt(myShift.cafeNumber, 10) || 0,
      giveAssociate: {
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        employeeId: state.user.userId
      },
      giveShift: {
        shiftId: parseInt(myShift.shiftId, 10),
        startDateTime: myShift.startDateTime,
        endDateTime: myShift.endDateTime
      },
      receiveAssociate: {
        firstName: coworker.firstName,
        lastName: coworker.lastName,
        preferredName: coworker.preferredName,
        employeeId: coworker.employeeId
      },
      receiveShift: {
        shiftId: coworkerShift.shiftId,
        startDateTime: coworkerShift.startDateTime,
        endDateTime: coworkerShift.endDateTime
      }
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Trade request sent successfully');
      closeModal('select-peer-shift-modal');
      refreshData();
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to trade shifts');
  }
}

function populateCoworkerSelectList(onSelectCallback) {
  const list = document.getElementById('coworker-select-list');
  list.innerHTML = '';

  const allAssociatesMap = {};
  if (state.cache.teamSchedule) {
    state.cache.teamSchedule.forEach(m => {
      if (m.associate && m.associate.employeeId !== 'AVAILABLE_SHIFT' && m.associate.employeeId !== state.user.userId) {
        allAssociatesMap[m.associate.employeeId] = m.associate;
      }
    });
  }

  const associates = Object.values(allAssociatesMap);
  const searchVal = document.getElementById('coworker-select-search').value.toLowerCase().trim();

  const filtered = associates.filter(a => {
    const fullName = `${a.preferredName || a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
    const nickname = resolveCoworkerName(a.employeeId, a.firstName, a.lastName).toLowerCase();
    return fullName.includes(searchVal) || nickname.includes(searchVal);
  });

  filtered.sort((a,b) => {
    const nameA = resolveCoworkerName(a.employeeId, a.firstName, a.lastName);
    const nameB = resolveCoworkerName(b.employeeId, b.firstName, b.lastName);
    return nameA.localeCompare(nameB);
  });

  filtered.forEach(a => {
    const row = document.createElement('div');
    row.className = 'person-row';
    row.onclick = () => onSelectCallback(a);

    const left = document.createElement('div');
    left.className = 'person-left';
    
    const avatar = document.createElement('div');
    avatar.className = 'person-avatar';
    avatar.innerText = (a.preferredName || a.firstName || 'C').substring(0, 2);
    left.appendChild(avatar);

    const nameGroup = document.createElement('div');
    nameGroup.className = 'person-name-group';
    
    const nameTv = document.createElement('div');
    nameTv.className = 'person-name';
    nameTv.innerText = resolveCoworkerName(a.employeeId, a.firstName, a.lastName);
    nameGroup.appendChild(nameTv);
    
    const subTv = document.createElement('div');
    subTv.className = 'person-subtitle';
    subTv.innerText = `Home Cafe: ${a.cafeNumber || 'Unknown'}`;
    nameGroup.appendChild(subTv);

    left.appendChild(nameGroup);
    row.appendChild(left);
    list.appendChild(row);
  });
}

// ----------------------------------------------------
// NICKNAMES & DIALOG POPUPS HANDLERS
// ----------------------------------------------------
let activeEditNicknameEmpId = null;

function showNicknameDialog(associate) {
  activeEditNicknameEmpId = associate.employeeId;
  const nn = state.cache.nicknames[associate.employeeId] || {};
  
  document.getElementById('nickname-first-input').value = nn.first || '';
  document.getElementById('nickname-last-input').value = nn.last || '';
  document.getElementById('hide-last-name-switch').checked = nn.hideLast === true;

  const defaultFirst = associate.preferredName || associate.firstName || '';
  const defaultLast = associate.lastName || '';
  document.getElementById('nickname-first-input').placeholder = defaultFirst;
  document.getElementById('nickname-last-input').placeholder = defaultLast;

  document.getElementById('nickname-modal-title').innerText = `${defaultFirst} ${defaultLast} Nickname`.toUpperCase();
  openModal('nickname-modal');
}

function saveNicknameChanges() {
  if (!activeEditNicknameEmpId) return;
  const f = document.getElementById('nickname-first-input').value.trim();
  const l = document.getElementById('nickname-last-input').value.trim();
  const h = document.getElementById('hide-last-name-switch').checked;

  state.cache.nicknames[activeEditNicknameEmpId] = {
    first: f || null,
    last: l || null,
    hideLast: h
  };
  saveCache('nicknames', state.cache.nicknames);
  
  closeModal('nickname-modal');
  renderPeopleView();
  renderHomeView();
  renderTeamScheduleView();
  showToast('Nickname updated');
}

function showMoneySettingsDialog() {
  document.getElementById('hourly-wage-input').value = state.settings.hourlyWage || '';
  const weeklyHours = calculateScheduledHoursForCurrentWeek();
  document.getElementById('weekly-hours-input').value = weeklyHours.toFixed(2).replace(/\.00$/, '');
  updateProjectedEarningsResult();
  openModal('money-settings-modal');
}

function updateProjectedEarningsResult() {
  const wage = parseFloat(document.getElementById('hourly-wage-input').value) || 0;
  const hours = parseFloat(document.getElementById('weekly-hours-input').value) || 0;
  const total = wage * hours;
  document.getElementById('earnings-result-value').innerText = `$${total.toFixed(2)}`;

  // Save settings preferences
  state.settings.hourlyWage = wage;
  localStorage.setItem('settings_hourlyWage', wage.toString());
}

function openNotificationViewer(notif) {
  document.getElementById('notif-modal-subject').innerText = notif.subject || 'No Subject';
  document.getElementById('notif-modal-date').innerText = new Date(notif.createDateTime).toLocaleString();
  
  const status = document.getElementById('notif-modal-read-status');
  status.className = `badge ${notif.read ? '' : 'unread'}`;
  status.innerText = notif.read ? 'Read' : 'Unread';

  // Render email HTML body inside a sandboxed iframe to prevent CSS leaks
  const iframe = document.getElementById('notif-modal-iframe');
  
  // Custom HTML wrapper with custom margins and dark/light support
  const htmlContent = `
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            line-height: 1.4;
            color: #1a1a1a;
            padding: 8px;
            margin: 0;
            background-color: #ffffff;
          }
          @media (prefers-color-scheme: dark) {
            body {
              color: #f1f1f1;
              background-color: #1e1e1e;
            }
          }
          table { width: 100% !important; border-collapse: collapse; margin-top: 10px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          @media (prefers-color-scheme: dark) {
            th, td { border-color: #444; }
            th { background-color: #2c2c2c; }
          }
        </style>
      </head>
      <body>
        ${notif.message || ''}
      </body>
    </html>
  `;
  
  iframe.srcdoc = htmlContent;

  // Build actions footer
  const actions = document.getElementById('notif-modal-actions');
  actions.innerHTML = '';

  const readBtn = document.createElement('button');
  readBtn.className = 'btn primary-btn';
  readBtn.innerText = notif.read ? 'Mark Unread' : 'Mark Read';
  readBtn.onclick = () => {
    toggleNotificationReadState(notif.notificationId, !notif.read);
    closeModal('notif-viewer-modal');
  };
  actions.appendChild(readBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn warning-btn';
  delBtn.innerText = 'Delete Notification';
  delBtn.onclick = () => {
    deleteNotificationItem(notif.notificationId);
    closeModal('notif-viewer-modal');
  };
  actions.appendChild(delBtn);

  // If unread, mark read optimistically
  if (!notif.read) {
    toggleNotificationReadState(notif.notificationId, true);
  }

  openModal('notif-viewer-modal');
}

function focusNotification(notifId) {
  const notifs = state.cache.notifications || [];
  const notif = notifs.find(n => n.notificationId === notifId);
  if (notif) {
    openNotificationViewer(notif);
  }
}

// ----------------------------------------------------
// PUSH SUBSCRIPTIONS MANAGER (VAPID & SERVICE WORKER)
// ----------------------------------------------------
async function togglePushSubscription(enable) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Push Notifications not supported on this device');
    document.getElementById('push-master-switch').checked = false;
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const statusLabel = document.getElementById('push-permission-status');

  if (enable) {
    // Request permissions
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notification permission denied');
      document.getElementById('push-master-switch').checked = false;
      return;
    }

    showToast('Subscribing to push alerts...');
    try {
      // 1. Fetch public VAPID key
      if (!vapidPublicKey) {
        const keyRes = await fetch(resolveServerUrl('/api/vapid-public-key'));
        const keyData = await keyRes.json();
        vapidPublicKey = keyData.publicKey;
      }

      // 2. Subscribe service worker to push
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(vapidPublicKey)
      });

      // 3. Send subscription to server
      const payload = {
        userId: state.user.userId,
        refreshToken: state.refreshToken,
        cafeNo: state.user.cafeNo,
        firstName: state.user.firstName,
        lastName: state.user.lastName,
        preferredName: state.user.preferredName,
        subscription: subscription,
        enabledCafes: state.settings.enabledCafes.length > 0 ? state.settings.enabledCafes : [state.user.cafeNo],
        notificationSettings: state.settings.pushSettings
      };

      const res = await fetch(resolveServerUrl('/api/notifications/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Subscription sync failed');

      state.settings.pushEnabled = true;
      localStorage.setItem('settings_pushEnabled', 'true');
      statusLabel.innerText = 'Active (Subscribed)';
      document.getElementById('push-settings-panel').classList.remove('hidden');
      showToast('Push notifications enabled!');
    } catch(e) {
      console.error(e);
      showToast('Failed to subscribe');
      document.getElementById('push-master-switch').checked = false;
    }
  } else {
    // Unsubscribe flow
    showToast('Unsubscribing...');
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }

      // Tell server to delete subscription
      await fetch(resolveServerUrl('/api/notifications/unsubscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: state.user.userId })
      });

      state.settings.pushEnabled = false;
      localStorage.setItem('settings_pushEnabled', 'false');
      statusLabel.innerText = 'Disabled';
      document.getElementById('push-settings-panel').classList.add('hidden');
      showToast('Push notifications disabled');
    } catch(e) {
      console.error(e);
      showToast('Error unsubscribing');
    }
  }
}

async function syncPushSettingsWithServer() {
  if (!state.settings.pushEnabled) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;

    const payload = {
      userId: state.user.userId,
      refreshToken: state.refreshToken,
      cafeNo: state.user.cafeNo,
      firstName: state.user.firstName,
      lastName: state.user.lastName,
      preferredName: state.user.preferredName,
      subscription: subscription,
      enabledCafes: state.settings.enabledCafes.length > 0 ? state.settings.enabledCafes : [state.user.cafeNo],
      notificationSettings: state.settings.pushSettings
    };

    await fetch(resolveServerUrl('/api/notifications/subscribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch(e) {
    console.error('Failed to sync push settings:', e);
  }
}

// Convert VAPID key helper
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ----------------------------------------------------
// DYNAMIC UI DATA RENDERERS
// ----------------------------------------------------
function renderAllViews() {
  renderHomeView();
  renderPeopleView();
  renderNotificationsView();
  renderSettingsView();
}

// ----------------------------------------------------
// TIME & WAGE CALCULATIONS FORMULAS
// ----------------------------------------------------
function calculateShiftEarnings(startStr, endStr) {
  if (!state.settings.hourlyWage) return 0;
  try {
    const start = new Date(startStr);
    const end = new Date(endStr);
    const diffHours = (end - start) / (1000 * 60 * 60);
    return diffHours * state.settings.hourlyWage;
  } catch(e) { return 0; }
}

function calculateScheduledHoursForCurrentWeek() {
  const schedule = state.cache.schedule;
  if (!schedule || !schedule.currentShifts) return 0;

  // Wed-Tue workweek range computation
  const today = new Date();
  const day = today.getDay();
  const diffToWed = (day >= 3) ? (day - 3) : (day + 4);
  
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - diffToWed);
  startOfWeek.setHours(0,0,0,0);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23,59,59,999);

  let totalHours = 0;
  schedule.currentShifts.forEach(shift => {
    if (isCafeFilterEnabled(shift.cafeNumber)) {
      try {
        const s = new Date(shift.startDateTime);
        const e = new Date(shift.endDateTime);
        if (s >= startOfWeek && s <= endOfWeek) {
          totalHours += (e - s) / (1000 * 60 * 60);
        }
      } catch(e) {}
    }
  });

  return totalHours;
}

function getWeekDateRangeText() {
  const today = new Date();
  const day = today.getDay();
  const diffToWed = (day >= 3) ? (day - 3) : (day + 4);
  
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - diffToWed);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  const options = { month: 'numeric', day: 'numeric' };
  return `${startOfWeek.toLocaleDateString('en-US', options)} - ${endOfWeek.toLocaleDateString('en-US', options)}`;
}

// ----------------------------------------------------
// UI VIEW FORMATTER RESOLVERS
// ----------------------------------------------------
function formatShiftDateTime(startStr, endStr) {
  try {
    const start = new Date(startStr);
    const end = new Date(endStr);
    
    const dayName = start.toLocaleDateString('en-US', { weekday: 'short' });
    const dateStr = `${start.getMonth() + 1}/${start.getDate()}`;
    const sTime = formatTime(start);
    const eTime = formatTime(end);

    return `${dayName} ${dateStr} ${sTime} - ${eTime}`;
  } catch(e) { return startStr; }
}

function formatShiftDetailsDateTimeString(startStr, endStr) {
  try {
    const start = new Date(startStr);
    const end = new Date(endStr);
    
    const dateStr = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const sTime = formatTime(start);
    const eTime = formatTime(end);

    return `${dateStr} ${sTime} - ${eTime}`;
  } catch(e) { return startStr; }
}

function formatTime(date) {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 is 12
  const minStr = minutes < 10 ? '0' + minutes : minutes;
  return `${hours}:${minStr}${ampm}`;
}

function formatDateRangeString(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatNotifDate(dateStr) {
  try {
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  } catch(e) { return dateStr; }
}

const workstationCustomNames = {
  "QC_2": "QC 2",
  "1ST_CASHIER_1": "Cashier 1",
  "SANDWICH_2": "Sandwich 2",
  "SANDWICH_1": "Sandwich 1",
  "SALAD_1": "Salad 1",
  "SALAD_2": "Salad 2",
  "DTORDERTAKER_1": "DriveThru",
  "1ST_DR_1": "Dining Room",
  "1st_Cashier": "Cashier 1",
  "1st_Dr": "Dining Room",
  "DtOrderTaker": "DriveThru",
  "Sandwich_1": "Sandwich 1",
  "Sandwich_2": "Sandwich 2",
  "Qc_2": "QC 2",
  "1ST_SANDWICH_1": "Sandwich 1",
  "Bake": "Baker",
  "BAKER": "Baker",
  "SALAD": "Salad 1",
  "SANDWICH": "Sandwich 1",
  "1ST_CASHIER": "Cashier 1",
  "QC_1": "QC 1",
  "DTORDERTAKER": "DriveThru",
  "1ST_DR": "Dining Room",
  "1st_DR": "Dining Room",
  "1st _DR": "Dining Room",
  "1st _Dr": "Dining Room",
  "1st_dr": "Dining Room",
  "1st _dr": "Dining Room",
  "MANAGER_1": "Manager",
  "MANAGER": "Manager",
  "MANAGERADMIN_1": "Manager",
  "MANAGERADMIN": "Manager",
  "PEOPLEMANAGEMENT_1": "Manager",
  "PEOPLEMANAGEMENT": "Manager",
  "LABOR_MANAGEMENT": "Manager",
  "LABORMANAGEMENT": "Manager",
  "Labor Management": "Manager"
};

function getWorkstationDisplayName(id, name) {
  const finalId = id ? id.trim() : null;
  const finalName = name ? name.trim() : null;
  
  if (finalId && workstationCustomNames[finalId]) return workstationCustomNames[finalId];
  if (finalName && workstationCustomNames[finalName]) return workstationCustomNames[finalName];
  
  // Try case-insensitive matching if not exact match found
  if (finalId) {
    const match = Object.keys(workstationCustomNames).find(k => k.toLowerCase() === finalId.toLowerCase());
    if (match) return workstationCustomNames[match];
  }
  if (finalName) {
    const match = Object.keys(workstationCustomNames).find(k => k.toLowerCase() === finalName.toLowerCase());
    if (match) return workstationCustomNames[match];
  }
  
  return name || id || 'Shift';
}

function getCafeDisplayName(cafeNo, cafeList) {
  if (!cafeNo) return 'Cafe';
  const match = (cafeList || []).find(c => c.cafeNumber === cafeNo.toString());
  if (match && match.cafeName) {
    // Extract name inside parentheses e.g. "Panera Bread (Panera Bread Cafe)"
    return match.cafeName;
  }
  return `Cafe #${cafeNo}`;
}

function getCafeNumberFromNotification(notification) {
  if (!notification) return null;
  const appData = notification.appData;
  if (!appData) return null;
  try {
    let json = JSON.parse(appData);
    if (typeof json === 'string') json = JSON.parse(json);
    
    const shift = json.initiatorShift || json.relatedShifts?.[0] || json.recipientShift;
    if (shift && shift.cafeNumber) {
      return shift.cafeNumber.toString();
    }
  } catch (e) {}
  return null;
}

function cleanHtmlText(html) {
  return html.replace(/<[^>]*>?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLastUpdateText(timestamp) {
  const elapsedSec = Math.floor((Date.now() - timestamp) / 1000);
  if (elapsedSec < 60) return 'Updated just now';
  const mins = Math.floor(elapsedSec / 60);
  return `Updated ${mins}m ago`;
}

function getTimeAgoText(dateTimeStr) {
  if (!dateTimeStr) return '';
  try {
    const date = new Date(dateTimeStr);
    const elapsedSec = Math.floor((Date.now() - date.getTime()) / 1000);
    
    if (elapsedSec < 60) return 'just now';
    
    const mins = Math.floor(elapsedSec / 60);
    if (mins < 60) return `${mins}m ago`;
    
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch(e) { return ''; }
}

// ----------------------------------------------------
// WEB PWA DIALOG MODALS UTILITIES
// ----------------------------------------------------
function showToast(message) {
  const toast = document.getElementById('toast-message');
  toast.innerText = message;
  toast.classList.remove('hidden');
  
  // Clear previous timers
  if (toast.timer) clearTimeout(toast.timer);
  
  toast.timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2500);
}

// Setup elements listeners
function setupUIEventListeners() {
  
  // Back navigation button
  document.getElementById('header-back-btn').onclick = handleBackNavigation;

  // Bottom dock navbar items click navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => {
      switchTab(item.dataset.tab);
    };
  });

  // Collapsible toggle items click triggers
  document.getElementById('your-shifts-toggle').onclick = () => {
    const parent = document.getElementById('your-shifts-section');
    parent.classList.toggle('collapsed');
    const content = document.getElementById('your-shifts-content');
    content.classList.toggle('hidden', parent.classList.contains('collapsed'));
  };

  document.getElementById('available-shifts-toggle').onclick = () => {
    const parent = document.getElementById('available-shifts-section');
    parent.classList.toggle('collapsed');
    const content = document.getElementById('available-shifts-content');
    content.classList.toggle('hidden', parent.classList.contains('collapsed'));
  };

  // Coworkers search filter text changes
  const searchInput = document.getElementById('coworkers-search');
  const clearSearchBtn = document.getElementById('clear-search-btn');

  searchInput.oninput = () => {
    const val = searchInput.value;
    clearSearchBtn.classList.toggle('hidden', !val);
    renderPeopleView();
  };
  
  clearSearchBtn.onclick = () => {
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    renderPeopleView();
  };

  // Close modals elements click hooks
  document.querySelectorAll('.close-modal-btn, .modal').forEach(el => {
    el.onclick = (e) => {
      // If clicking background or close &times; button, dismiss modal
      if (e.target === el || el.classList.contains('close-modal-btn')) {
        const modal = el.closest('.modal');
        if (modal) closeModal(modal.id);
      }
    };
  });

  // Setup form submit buttons
  document.getElementById('save-server-btn').onclick = saveServerConfigAddress;
  document.getElementById('direct-login-btn').onclick = handleDirectCredentialsLogin;
  document.getElementById('get-auth-url-btn').onclick = handleGetAuthRedirectUrl;
  document.getElementById('submit-code-btn').onclick = handleExchangeAuthCode;
  document.getElementById('change-server-link').onclick = () => showSetupScreen();

  // Settings screen modal triggers
  document.getElementById('reconfigure-server-btn').onclick = () => showSetupScreen();
  document.getElementById('cafe-settings-btn').onclick = showCafeTogglesModal;
  document.getElementById('logout-settings-btn').onclick = logout;
  
  // Reset favorites and nicknames
  document.getElementById('reset-nicknames-btn').onclick = () => {
    const confirmReset = confirm('Are you sure you want to reset all nicknames and favorite coworker stars?');
    if (confirmReset) {
      state.cache.nicknames = {};
      state.cache.favorites.clear();
      saveCache('nicknames', {});
      saveCache('favorites', state.cache.favorites);
      renderPeopleView();
      renderHomeView();
      showToast('Resetted settings successfully');
    }
  };

  // Earnings options switches toggles changes
  document.getElementById('show-money-switch').onchange = (e) => {
    state.settings.showMoney = e.target.checked;
    localStorage.setItem('settings_showMoney', state.settings.showMoney.toString());
    renderHomeView();
  };
  document.getElementById('combine-shifts-switch').onchange = (e) => {
    state.settings.combineShifts = e.target.checked;
    localStorage.setItem('settings_combineShifts', state.settings.combineShifts.toString());
    renderHomeView();
    renderTeamScheduleView();
  };
  document.getElementById('show-availability-calendar-switch').onchange = (e) => {
    state.settings.showAvailabilityOnCalendar = e.target.checked;
    localStorage.setItem('settings_showAvailabilityOnCalendar', state.settings.showAvailabilityOnCalendar.toString());
    renderHomeView();
  };

  // Push notifications toggles changes
  document.getElementById('push-master-switch').onchange = (e) => {
    togglePushSubscription(e.target.checked);
  };

  const pushSwitches = ['push-pickups-switch', 'push-approvals-switch', 'push-calls-switch', 'push-published-switch', 'push-other-switch'];
  pushSwitches.forEach(id => {
    document.getElementById(id).onchange = () => {
      state.settings.pushSettings = {
        shiftPickupsEnabled: document.getElementById('push-pickups-switch').checked,
        shiftApprovedEnabled: document.getElementById('push-approvals-switch').checked,
        managerCallsEnabled: document.getElementById('push-calls-switch').checked,
        schedulePublishedEnabled: document.getElementById('push-published-switch').checked,
        otherEnabled: document.getElementById('push-other-switch').checked
      };
      localStorage.setItem('settings_pushSettings', JSON.stringify(state.settings.pushSettings));
      syncPushSettingsWithServer();
    };
  });

  // Modal subforms handlers
  document.getElementById('save-nickname-btn').onclick = saveNicknameChanges;
  
  // Money hourly wage dynamic calculator input
  document.getElementById('hourly-wage-input').oninput = updateProjectedEarningsResult;
  document.getElementById('weekly-hours-input').oninput = updateProjectedEarningsResult;

  // Time off dialog "All Day" toggle
  document.getElementById('time-off-allday-switch').onchange = (e) => {
    document.getElementById('time-off-hours-container').classList.toggle('hidden', e.target.checked);
  };
  document.getElementById('submit-time-off-btn').onclick = submitTimeOffRequestForm;

  // Max hours cancel changes button
  document.getElementById('cancel-pending-changes-btn').onclick = cancelPendingAvailabilityChanges;

  // Co-worker select search filters
  document.getElementById('coworker-select-search').oninput = () => {
    populateCoworkerSelectList(associate => {
      // Find trade flow callback or cover flow callback
      if (tradeFlowShift) {
        closeModal('select-coworker-modal');
        startTradeShiftSelection(tradeFlowShift, associate);
      } else if (coverFlowShift) {
        performShiftCover(coverFlowShift, associate);
      }
    });
  };

  // Submit Availability modifications form
  document.getElementById('submit-availability-btn').onclick = submitAvailabilityEditorForm;

  // Theme settings toggle options click
  document.getElementById('theme-settings-btn').onclick = () => openModal('theme-settings-modal');
  document.querySelectorAll('.theme-option-btn').forEach(btn => {
    btn.onclick = () => {
      const theme = btn.dataset.theme;
      state.settings.theme = theme;
      localStorage.setItem('settings_theme', theme);
      initTheme();
      closeModal('theme-settings-modal');
      renderSettingsView();
    };
  });

  // Co-worker schedule search filter resets
  document.getElementById('select-coworker-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('close-modal-btn')) {
      tradeFlowShift = null;
      coverFlowShift = null;
      document.getElementById('coworker-select-search').value = '';
    }
  });

  document.getElementById('check-updates-btn').onclick = checkGitHubUpdates;
}

// ----------------------------------------------------
// FRONT-END FORMS LOGIC SUBMISSIONS
// ----------------------------------------------------
function saveServerConfigAddress() {
  const val = document.getElementById('server-address-input').value.trim();
  state.serverUrl = val;
  if (val) {
    localStorage.setItem('serverUrl', val);
  } else {
    localStorage.removeItem('serverUrl');
  }

  showToast('Server address saved');
  closeModal('setup-screen');
  
  if (!state.accessToken) {
    showAuthScreen();
  } else {
    initApp();
  }
}

// DIRECT USERNAME/PASSWORD LOGIN (User request)
async function handleDirectCredentialsLogin() {
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value.trim();
  const errTv = document.getElementById('direct-login-error');
  
  if (!u || !p) {
    errTv.innerText = 'Email and password are required';
    errTv.classList.remove('hidden');
    return;
  }

  errTv.classList.add('hidden');
  showToast('Logging in...');

  try {
    const response = await fetch(resolveServerUrl('/api/login-credentials'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Direct credentials login failed:', data);
      let errMsg = data.details || 'Check credentials and try again';
      if (data.code && data.code.includes('MFA')) {
        errMsg = 'Multi-Factor Authentication (MFA) is required. Please use interactive login below.';
      }
      errTv.innerText = errMsg;
      errTv.classList.remove('hidden');
      return;
    }

    saveLoginState(data);
    showToast('Logged in successfully!');
    initApp();
  } catch(e) {
    console.error(e);
    errTv.innerText = 'Connection error. Check your server address.';
    errTv.classList.remove('hidden');
  }
}

// fallback PKCE browser interactive flow
let localCodeVerifier = '';

async function handleGetAuthRedirectUrl() {
  showToast('Connecting...');
  try {
    const res = await fetch(resolveServerUrl('/api/auth-url'));
    const data = await res.json();
    
    // Save verifier locally
    localCodeVerifier = data.verifier;
    localStorage.setItem('local_code_verifier', localCodeVerifier);
    
    // Open in separate window/tab
    window.open(data.url, '_blank');
    showToast('Opened authorization window');
  } catch(e) {
    console.error(e);
    showToast('Failed to connect to Pi server');
  }
}

async function handleExchangeAuthCode() {
  const urlVal = document.getElementById('callback-url-input').value.trim();
  const errTv = document.getElementById('login-error');
  
  if (!urlVal) {
    errTv.innerText = 'Paste the redirect URL first';
    errTv.classList.remove('hidden');
    return;
  }

  // Parse code from URL callback
  let code = '';
  try {
    if (urlVal.startsWith('pantry://')) {
      const u = new URL(urlVal.replace('pantry://', 'http://'));
      code = u.searchParams.get('code');
    } else if (urlVal.includes('code=')) {
      const match = urlVal.match(/code=([^&]+)/);
      code = match ? match[1] : '';
    } else {
      code = urlVal; // assume raw code entered
    }
  } catch(e) {
    errTv.innerText = 'Invalid URL format';
    errTv.classList.remove('hidden');
    return;
  }

  if (!code) {
    errTv.innerText = 'Could not extract auth code from URL';
    errTv.classList.remove('hidden');
    return;
  }

  const verifier = localCodeVerifier || localStorage.getItem('local_code_verifier');
  if (!verifier) {
    errTv.innerText = 'Session expired. Please click authorization button again.';
    errTv.classList.remove('hidden');
    return;
  }

  errTv.classList.add('hidden');
  showToast('Exchanging code...');

  try {
    const res = await fetch(resolveServerUrl('/api/exchange-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.details || 'Exchange failed');
    }

    const data = await res.json();
    saveLoginState(data);
    showToast('Logged in successfully!');
    initApp();
  } catch(e) {
    console.error(e);
    errTv.innerText = `Auth Error: ${e.message}`;
    errTv.classList.remove('hidden');
  }
}

async function submitTimeOffRequestForm() {
  const dateVal = document.getElementById('time-off-date-input').value;
  const isAllDay = document.getElementById('time-off-allday-switch').checked;
  const comments = document.getElementById('time-off-comments-input').value.trim();

  if (!dateVal) {
    showToast('Please select a date');
    return;
  }

  showToast('Submitting request...');
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/franchise-request-time-off/request';
    
    let startTime = null;
    let endTime = null;
    if (!isAllDay) {
      const s = document.getElementById('time-off-start-time').value;
      const e = document.getElementById('time-off-end-time').value;
      startTime = `${dateVal}T${s}:00`;
      endTime = `${dateVal}T${e}:00`;
    }

    const payload = {
      employeeId: state.user.userId,
      timeOffDate: dateVal,
      startTime: startTime,
      endTime: endTime,
      status: 'PENDING',
      associateComments: comments || null,
      managerComments: null,
      thirdPartyId: 'Self-Service'
    };

    const success = await apiRequest(url, 'POST', payload);
    if (success) {
      showToast('Time off request submitted');
      closeModal('time-off-modal');
      
      // Update local time off cache
      const toUrl = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/franchise-request-time-off/all?paneraId=${state.user.userId}`;
      const timeoff = await apiRequest(toUrl);
      saveCache('timeOff', timeoff);
      renderAvailabilityView();
      renderHomeView(); // update calendar underscores
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to submit request');
  }
}

// availability edit subforms generators
function openEditAvailabilityDialog() {
  const av = state.cache.availability;
  const max = state.cache.maxHours;

  const currentDaily = max?.approved?.maxHoursDaily || '';
  const currentWeekly = max?.approved?.maxHoursWeekly || '';
  document.getElementById('edit-max-daily-hours').value = currentDaily;
  document.getElementById('edit-max-weekly-hours').value = currentWeekly;

  const listContainer = document.getElementById('edit-availability-days-list');
  listContainer.innerHTML = '';

  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const currentMap = av?.approved?.availableTime || {};

  days.forEach(day => {
    const card = document.createElement('div');
    card.className = 'edit-day-slot-card';
    card.dataset.day = day;

    const header = document.createElement('div');
    header.className = 'edit-day-slot-header';
    header.innerHTML = `<span>${day.charAt(0) + day.substring(1).toLowerCase()}</span>`;
    
    // Copy options button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'text-action-btn no-border';
    copyBtn.innerText = 'Copy Option';
    copyBtn.onclick = (e) => {
      e.preventDefault();
      copyOptionFromDaySelector(day);
    };
    // header.appendChild(copyBtn); // simple copy feature
    card.appendChild(header);

    const approvedSlots = currentMap[day] || [];
    const isNotAvail = approvedSlots.length === 0;
    const isAllDay = approvedSlots.some(s => s.allDay === true);
    
    // Time radio buttons
    const select = document.createElement('select');
    select.className = 'avail-state-selector form-group';
    select.style.marginBottom = '8px';
    select.innerHTML = `
      <option value="not_available" ${isNotAvail ? 'selected' : ''}>Not Available</option>
      <option value="all_day" ${isAllDay ? 'selected' : ''}>All Day</option>
      <option value="custom" ${(!isNotAvail && !isAllDay) ? 'selected' : ''}>Custom Hours</option>
    `;

    const rangeDiv = document.createElement('div');
    rangeDiv.className = `time-range-group ${(!isNotAvail && !isAllDay) ? '' : 'hidden'}`;

    const slot = approvedSlots.find(s => !s.allDay) || { start: '08:00:00', end: '16:00:00' };
    
    // Strip seconds
    const startStr = slot.start?.substring(0, 5) || '08:00';
    const endStr = slot.end?.substring(0, 5) || '16:00';

    rangeDiv.innerHTML = `
      <div class="form-group" style="margin-bottom:0">
        <label>Start</label>
        <input type="time" class="slot-start-input" value="${startStr}">
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>End</label>
        <input type="time" class="slot-end-input" value="${endStr}">
      </div>
    `;

    select.onchange = (e) => {
      rangeDiv.classList.toggle('hidden', e.target.value !== 'custom');
    };

    card.appendChild(select);
    card.appendChild(rangeDiv);
    listContainer.appendChild(card);
  });

  openModal('edit-availability-modal');
}

// Hook Edit availability modal trigger
document.getElementById('edit-availability-modal').addEventListener('click', (e) => {
  // If clicking open editAvailability dialog, regenerate elements
  if (e.target.id === 'reconfigure-server-btn') return;
});

async function submitAvailabilityEditorForm() {
  showToast('Submitting changes...');
  
  // 1. Submit Max Hours change if modified
  const max = state.cache.maxHours;
  const dVal = parseFloat(document.getElementById('edit-max-daily-hours').value) || 0;
  const wVal = parseFloat(document.getElementById('edit-max-weekly-hours').value) || 0;

  let maxHoursSuccess = true;
  if (dVal !== max?.approved?.maxHoursDaily || wVal !== max?.approved?.maxHoursWeekly) {
    try {
      const url = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/max-hours?paneraId=${state.user.userId}`;
      const payload = {
        maxHoursDaily: dVal,
        maxHoursWeekly: wVal,
        paneraId: state.user.userId
      };
      await apiRequest(url, 'POST', payload);
    } catch(e) {
      console.error(e);
      maxHoursSuccess = false;
    }
  }

  // 2. Submit Weekly availability changes
  const av = state.cache.availability;
  const daysList = document.getElementById('edit-availability-days-list').querySelectorAll('.edit-day-slot-card');
  const availableTime = {};

  daysList.forEach(card => {
    const day = card.dataset.day;
    const type = card.querySelector('.avail-state-selector').value;
    
    if (type === 'all_day') {
      availableTime[day] = [{ allDay: true, start: '00:00:00', end: '23:59:59' }];
    } else if (type === 'custom') {
      const s = card.querySelector('.slot-start-input').value;
      const e = card.querySelector('.slot-end-input').value;
      availableTime[day] = [{ allDay: false, start: `${s}:00`, end: `${e}:00` }];
    } else {
      availableTime[day] = []; // Not available
    }
  });

  let availSuccess = true;
  try {
    const url = 'https://pantry.panerabread.com/apis/selfservice-ui-service/v1/availability';
    const payload = {
      cafeNo: parseInt(state.user.cafeNo, 10) || 202924,
      employeeId: state.user.userId,
      request: {
        availableTime: availableTime
      }
    };
    await apiRequest(url, 'POST', payload);
  } catch(e) {
    console.error(e);
    availSuccess = false;
  }

  if (maxHoursSuccess && availSuccess) {
    showToast('Changes submitted successfully');
    closeModal('edit-availability-modal');
    
    // Refresh availability caches
    const avUrl = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/availability?employeeId=${state.user.userId}`;
    const avRes = await apiRequest(avUrl);
    saveCache('availability', avRes);

    const maxUrl = `https://pantry.panerabread.com/apis/selfservice-ui-service/v1/max-hours/all?paneraId=${state.user.userId}`;
    const maxRes = await apiRequest(maxUrl);
    saveCache('maxHours', maxRes);

    renderAvailabilityView();
  } else {
    showToast('Failed to submit some changes');
  }
}

// ----------------------------------------------------
// SETTINGS: CAFES TOGGLE MODAL
// ----------------------------------------------------
function showCafeTogglesModal() {
  const schedule = state.cache.schedule;
  if (!schedule) return;

  const container = document.getElementById('cafe-toggles-list');
  container.innerHTML = '';

  const cafeList = schedule.cafeList || [];
  
  // Extract all unique cafes listed across personal & coworker lists
  const allCafes = {};
  cafeList.forEach(c => { allCafes[c.cafeNumber] = c.cafeName || `Cafe #${c.cafeNumber}`; });
  
  // Verify home cafe exists
  if (state.user.cafeNo && !allCafes[state.user.cafeNo]) {
    allCafes[state.user.cafeNo] = `Home Cafe #${state.user.cafeNo}`;
  }

  Object.keys(allCafes).forEach(cafeNo => {
    const row = document.createElement('div');
    row.className = 'settings-item toggle-item no-border';

    const left = document.createElement('div');
    left.className = 'flex-col align-start';
    
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.innerText = allCafes[cafeNo];
    left.appendChild(label);

    const desc = document.createElement('span');
    desc.className = 'settings-desc';
    desc.innerText = `Cafe ID: ${cafeNo}`;
    left.appendChild(desc);
    row.appendChild(left);

    // Switch input checkbox
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    
    const input = document.createElement('input');
    input.type = 'checkbox';
    
    const isEnabled = state.settings.enabledCafes.length === 0 || state.settings.enabledCafes.includes(cafeNo);
    input.checked = isEnabled;
    
    input.onchange = () => {
      // Toggle cafe number in list
      let list = [...state.settings.enabledCafes];
      
      // If list was empty (default all enabled), populate all first
      if (list.length === 0) {
        list = Object.keys(allCafes);
      }

      if (input.checked) {
        if (!list.includes(cafeNo)) list.push(cafeNo);
      } else {
        list = list.filter(num => num !== cafeNo);
      }

      // If all enabled, clear list back to default empty state
      if (list.length === Object.keys(allCafes).length) {
        list = [];
      }

      state.settings.enabledCafes = list;
      localStorage.setItem('settings_enabledCafes', JSON.stringify(list));
      
      renderHomeView();
      renderTeamScheduleView();
      renderPeopleView();
      syncPushSettingsWithServer(); // Sync background alerts scope
    };

    switchLabel.appendChild(input);
    
    const slider = document.createElement('span');
    slider.className = 'slider';
    switchLabel.appendChild(slider);
    
    row.appendChild(switchLabel);
    container.appendChild(row);
  });

  openModal('cafe-settings-modal');
}

// ----------------------------------------------------
// APP CHECKS GITHUB UPDATE RELEASE NOTES
// ----------------------------------------------------
async function checkGitHubUpdates() {
  showToast('Checking updates...');
  try {
    const url = 'https://api.github.com/repos/AnonymousAssociate1/Better-Pantry/releases/latest';
    const release = await apiRequest(url);
    
    if (release && release.tag_name) {
      alert(`Latest release version tag: ${release.tag_name}\n\nDescription:\n${release.body || 'No release details provided.'}`);
    } else {
      showToast('No updates found.');
    }
  } catch(e) {
    console.error(e);
    showToast('Failed to fetch updates');
  }
}
