const CACHE_NAME = 'better-pantry-v1';
const ASSETS = [
  './',
  'index.html',
  'index.css',
  'index.js',
  'manifest.json',
  'icon.png'
];

// Install Service Worker and cache assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('SW: Pre-caching static assets');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Service Worker and clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('SW: Clearing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch handler - Network-First, fallback to Cache for assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip caching for server API endpoints
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // If valid response, update cache
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache if network fails
        return caches.match(event.request);
      })
  );
});

// Handle Web Push Notifications
self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Better Pantry', body: event.data.text() };
    }
  }

  const title = data.title || 'New Notification';
  const options = {
    body: data.body || 'You have a new update.',
    icon: 'icon.png',
    badge: 'icon.png',
    vibrate: [100, 50, 100],
    data: data.data || {},
    tag: data.data?.notificationId || 'pantry-notification'
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Handle Notification Clicks (Open App and navigate to notifications tab)
self.addEventListener('notificationclick', event => {
  const notif = event.notification;
  notif.close();

  const notifData = notif.data || {};
  
  // Base folder path of the service worker (handles subfolders on GitHub Pages)
  const basePath = self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1);
  
  // URL to open: index.html with notifications tab parameter and optional deep-linked notification
  const targetUrl = new URL('index.html', basePath);
  targetUrl.searchParams.set('tab', 'notifications');
  if (notifData.notificationId) {
    targetUrl.searchParams.set('focusId', notifData.notificationId);
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing open window if possible
      for (const client of clientList) {
        if (client.url.startsWith(basePath) && 'focus' in client) {
          // Send message to client to switch tabs if already running
          client.postMessage({
            type: 'NAVIGATE_TAB',
            tab: 'notifications',
            focusId: notifData.notificationId
          });
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
    })
  );
});
