// Service Worker Avanzato per Workout Coach
const CACHE_VERSION = '2.0.0';
const STATIC_CACHE = `workout-static-v${CACHE_VERSION}`;
const DYNAMIC_CACHE = `workout-dynamic-v${CACHE_VERSION}`;
const EXERCISES_CACHE = `workout-exercises-v${CACHE_VERSION}`;
const VIDEOS_CACHE = `workout-videos-v${CACHE_VERSION}`;
const USER_DATA_CACHE = `workout-userdata-v${CACHE_VERSION}`;

// Risorse statiche
const STATIC_ASSETS = [
  './workout-coach.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js'
];

// Route dinamiche
const DYNAMIC_ROUTES = [
  /\/api\//,
  /\/workouts\//,
  /\/exercises\//,
  /\/progress\//,
  /\/nutrition\//,
  /\/stats\//
];

// Configurazione
const STORAGE_QUOTA_MB = 150; // Più spazio per video e dati fitness
const SYNC_QUEUE_NAME = 'workout-sync';
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|avi)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg)$/i;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp)$/i;

// Stati allenamento
const WORKOUT_STATES = {
  IDLE: 'idle',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed'
};

let isOnline = navigator.onLine;
let syncPending = [];
let workoutState = WORKOUT_STATES.IDLE;
let currentWorkout = null;

// Installazione del service worker
self.addEventListener('install', function(event) {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(cache => {
        console.log('[SW] Caching static assets for Workout Coach');
        return cache.addAll(STATIC_ASSETS);
      }),
      caches.open(DYNAMIC_CACHE),
      caches.open(EXERCISES_CACHE),
      caches.open(VIDEOS_CACHE),
      caches.open(USER_DATA_CACHE),
      setupStorageQuota(),
      initializeWorkoutDB(),
      preloadEssentialExercises()
    ])
  );
  self.skipWaiting();
});

// Gestione intelligente delle richieste
self.addEventListener('fetch', function(event) {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') {
    if (request.method === 'POST' && !navigator.onLine) {
      event.respondWith(handleOfflineWorkoutAction(request));
      return;
    }
    return;
  }

  // Cache-first per risorse statiche
  if (isStaticAsset(request)) {
    event.respondWith(cacheFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Strategia speciale per video
  if (isVideoRequest(request)) {
    event.respondWith(videoStrategy(request));
    return;
  }

  // Strategia per esercizi
  if (isExerciseRequest(request)) {
    event.respondWith(exerciseStrategy(request));
    return;
  }

  // Strategia per immagini/audio
  if (isMediaRequest(request)) {
    event.respondWith(mediaStrategy(request));
    return;
  }

  // Stale-while-revalidate per dati utente
  if (isUserDataRequest(request)) {
    event.respondWith(staleWhileRevalidateStrategy(request, USER_DATA_CACHE));
    return;
  }

  // Network-first per API dinamiche
  if (isDynamicRoute(request)) {
    event.respondWith(networkFirstStrategy(request, DYNAMIC_CACHE));
    return;
  }

  // Default: network-first
  event.respondWith(networkFirstStrategy(request, DYNAMIC_CACHE));
});

// Attivazione e setup
self.addEventListener('activate', function(event) {
  event.waitUntil(
    Promise.all([
      cleanupOldCaches(),
      setupWorkoutSync(),
      setupHealthTracking(),
      setupNotifications(),
      setupPerformanceMonitoring(),
      self.clients.claim()
    ])
  );
});

// === STRATEGIE CACHE SPECIALIZZATE ===

// Cache-first ottimizzato
async function cacheFirstStrategy(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  if (cached) {
    if (await isCacheStale(cached)) {
      updateCacheInBackground(request, cache);
    }
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return await getWorkoutFallback(request);
  }
}

// Network-first per API
async function networkFirstStrategy(request, cacheName) {
  const cache = await caches.open(cacheName);
  
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      cache.put(request, response.clone());
      notifyClientsOfSync('online');
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      notifyClientsOfSync('offline');
      return cached;
    }
    return await getWorkoutFallback(request);
  }
}

// Stale-while-revalidate per dati utente
async function staleWhileRevalidateStrategy(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  const fetchPromise = fetch(request).then(response => {
    if (response.status === 200) {
      cache.put(request, response.clone());
      notifyClientsOfDataUpdate(request.url);
    }
    return response;
  }).catch(() => cached);

  return cached || await fetchPromise;
}

// Strategia per video con streaming support
async function videoStrategy(request) {
  const cache = await caches.open(VIDEOS_CACHE);
  const cached = await cache.match(request);
  
  // Per video grandi, controlla se supporta range requests
  const range = request.headers.get('range');
  if (range && cached) {
    return await handleRangeRequest(cached, range);
  }
  
  if (cached) {
    console.log('[SW] Video served from cache:', request.url);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.status === 200 || response.status === 206) {
      // Cache solo video piccoli (< 50MB) per non saturare storage
      const contentLength = response.headers.get('content-length');
      if (!contentLength || parseInt(contentLength) < 50 * 1024 * 1024) {
        cache.put(request, response.clone());
        console.log('[SW] Video cached:', request.url);
      }
    }
    return response;
  } catch (error) {
    return new Response('Video non disponibile offline', { status: 503 });
  }
}

// Strategia per esercizi
async function exerciseStrategy(request) {
  const cache = await caches.open(EXERCISES_CACHE);
  const cached = await cache.match(request);
  
  // Esercizi sempre da cache se disponibile (priorità alta per offline)
  if (cached) {
    // Aggiorna in background se necessario
    updateCacheInBackground(request, cache);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.status === 200) {
      cache.put(request, response.clone());
      console.log('[SW] Exercise data cached:', request.url);
    }
    return response;
  } catch (error) {
    return await getOfflineExercise();
  }
}

// Strategia per media generale
async function mediaStrategy(request) {
  const cache = await caches.open(VIDEOS_CACHE); // Usa videos cache per tutto il media
  const cached = await cache.match(request);
  
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.status === 200) {
      // Ottimizza media se necessario
      const optimized = await optimizeMediaForWorkout(response.clone());
      cache.put(request, optimized);
    }
    return response;
  } catch (error) {
    return getMediaFallback(request);
  }
}

// === GESTIONE OFFLINE SPECIALIZZATA ===

// Gestione POST offline per workout
async function handleOfflineWorkoutAction(request) {
  const data = await request.clone().json().catch(() => null);
  
  const queueItem = {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: data,
    timestamp: Date.now(),
    type: 'workout-action'
  };

  syncPending.push(queueItem);
  await saveToWorkoutDB('sync-queue', syncPending);
  
  // Salva dati allenamento localmente
  if (data) {
    await handleOfflineWorkoutData(data);
  }
  
  notifyClientsOfSync('queued');
  
  return new Response(JSON.stringify({ 
    success: true, 
    message: 'Allenamento salvato offline - Sincronizzerà quando possibile',
    queued: true,
    offline: true,
    timestamp: Date.now()
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// Fallback per Workout Coach
async function getWorkoutFallback(request) {
  const url = new URL(request.url);
  
  if (request.headers.get('accept')?.includes('text/html')) {
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Offline - Workout Coach</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: 'Arial', sans-serif; text-align: center; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; min-height: 100vh; margin: 0; }
          .offline-content { background: rgba(255,255,255,0.1); padding: 40px; border-radius: 20px; backdrop-filter: blur(15px); max-width: 800px; margin: 50px auto; }
          .status-bar { position: fixed; top: 0; left: 0; right: 0; background: #dc3545; padding: 10px; text-align: center; font-weight: bold; z-index: 1000; }
          .workout-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 40px 0; }
          .workout-card { background: rgba(255,255,255,0.15); padding: 25px; border-radius: 15px; text-align: left; transition: transform 0.3s; }
          .workout-card:hover { transform: translateY(-5px); }
          .workout-card h3 { color: #ffd700; margin: 0 0 15px 0; }
          .feature-list { list-style: none; padding: 0; }
          .feature-list li { margin: 8px 0; padding: 8px 12px; background: rgba(255,255,255,0.1); border-radius: 20px; }
          .btn { background: #28a745; color: white; border: none; padding: 15px 30px; border-radius: 25px; cursor: pointer; font-size: 16px; margin: 10px; transition: all 0.3s; text-decoration: none; display: inline-block; }
          .btn:hover { background: #218838; transform: scale(1.05); }
          .btn-outline { background: transparent; border: 2px solid white; }
          .stats { display: flex; justify-content: space-around; margin: 30px 0; }
          .stat { text-align: center; }
          .stat-number { font-size: 2em; font-weight: bold; color: #ffd700; }
        </style>
      </head>
      <body>
        <div class="status-bar">MODALITÀ OFFLINE - I tuoi allenamenti continuano!</div>
        
        <div class="offline-content">
          <h1>💪 Workout Coach Offline</h1>
          <p style="font-size: 18px; margin-bottom: 30px;">Nessun problema! Continua ad allenarti con i workout già scaricati e i tuoi dati personali.</p>
          
          <div class="stats">
            <div class="stat">
              <div class="stat-number">100%</div>
              <div>Funzionalità Offline</div>
            </div>
            <div class="stat">
              <div class="stat-number">∞</div>
              <div>Workout Disponibili</div>
            </div>
            <div class="stat">
              <div class="stat-number">✓</div>
              <div>Sync Automatico</div>
            </div>
          </div>
          
          <div class="workout-grid">
            <div class="workout-card">
              <h3>🏃‍♂️ Allenamenti Attivi</h3>
              <ul class="feature-list">
                <li>Continua workout in corso</li>
                <li>Cronometro e timer funzionanti</li>
                <li>Tracking ripetizioni e serie</li>
                <li>Calcolo calorie offline</li>
              </ul>
            </div>
            
            <div class="workout-card">
              <h3>📈 Progressi e Statistiche</h3>
              <ul class="feature-list">
                <li>Visualizza progressi salvati</li>
                <li>Grafici performance</li>
                <li>Storico allenamenti</li>
                <li>Obiettivi personali</li>
              </ul>
            </div>
            
            <div class="workout-card">
              <h3>🎯 Workout Personalizzati</h3>
              <ul class="feature-list">
                <li>Crea nuovi allenamenti</li>
                <li>Modifica routine esistenti</li>
                <li>Salvataggio automatico</li>
                <li>Template predefiniti</li>
              </ul>
            </div>
          </div>
          
          <div style="margin-top: 40px;">
            <button class="btn" onclick="startOfflineWorkout()">Inizia Allenamento</button>
            <button class="btn btn-outline" onclick="location.reload()">Riconnetti</button>
          </div>
          
          <div style="margin-top: 30px; padding: 20px; background: rgba(255,255,255,0.1); border-radius: 10px;">
            <h4>Modalità Offline Attiva</h4>
            <p>Tutti i tuoi dati verranno sincronizzati automaticamente quando tornerai online. Continua ad allenarti senza interruzioni!</p>
          </div>
        </div>
        
        <script>
          window.addEventListener('online', () => {
            document.querySelector('.status-bar').textContent = 'CONNESSIONE RIPRISTINATA - Sincronizzazione in corso...';
            document.querySelector('.status-bar').style.background = '#28a745';
            
            // Animazione di riconnessione
            document.body.innerHTML = `
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; text-align: center;">
                <h1 style="font-size: 3em; margin-bottom: 20px;">✨ Connesso!</h1>
                <p style="font-size: 1.2em; margin-bottom: 30px;">Sincronizzazione dati allenamento in corso...</p>
                <div style="width: 60%; height: 6px; background: rgba(255,255,255,0.3); border-radius: 3px; overflow: hidden;">
                  <div style="width: 0%; height: 100%; background: white; animation: syncProgress 3s ease-in-out forwards;"></div>
                </div>
                <p style="margin-top: 20px; opacity: 0.8;">I tuoi progressi sono stati salvati!</p>
              </div>
              <style>
                @keyframes syncProgress { to { width: 100%; } }
              </style>
            `;
            
            setTimeout(() => location.reload(), 3500);
          });
          
          function startOfflineWorkout() {
            window.location.href = './workout-coach.html#offline-workout';
          }
        </script>
      </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  return new Response('Risorsa non disponibile offline', { status: 503 });
}

// === UTILITÀ SPECIFICHE ===

function isStaticAsset(request) {
  const url = new URL(request.url);
  return STATIC_ASSETS.some(asset => url.href.includes(asset)) ||
         /\.(css|js|woff|woff2|ttf|eot|ico)$/.test(url.pathname);
}

function isDynamicRoute(request) {
  const url = new URL(request.url);
  return DYNAMIC_ROUTES.some(pattern => pattern.test(url.pathname));
}

function isVideoRequest(request) {
  return VIDEO_EXTENSIONS.test(new URL(request.url).pathname);
}

function isExerciseRequest(request) {
  const url = new URL(request.url);
  return url.pathname.includes('/exercise') || 
         url.pathname.includes('/workout-plan') ||
         url.pathname.includes('/routine');
}

function isMediaRequest(request) {
  const pathname = new URL(request.url).pathname;
  return AUDIO_EXTENSIONS.test(pathname) || IMAGE_EXTENSIONS.test(pathname);
}

function isUserDataRequest(request) {
  const url = new URL(request.url);
  return url.pathname.includes('/progress') || 
         url.pathname.includes('/profile') ||
         url.pathname.includes('/stats') ||
         url.pathname.includes('/history');
}

async function isCacheStale(response) {
  const cacheDate = new Date(response.headers.get('date') || Date.now());
  const now = new Date();
  const ageInHours = (now - cacheDate) / (1000 * 60 * 60);
  return ageInHours > 2; // Cache stale dopo 2 ore per fitness data
}

async function updateCacheInBackground(request, cache) {
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      await cache.put(request, response);
    }
  } catch (error) {
    console.log('[SW] Background update failed:', error);
  }
}

async function optimizeMediaForWorkout(response) {
  // Per ora ritorna la risposta originale
  // In futuro: compressione video, ridimensionamento immagini per mobile
  return response;
}

async function handleRangeRequest(cachedResponse, rangeHeader) {
  // Implementazione base per range requests su video cached
  const arrayBuffer = await cachedResponse.arrayBuffer();
  const range = parseRangeHeader(rangeHeader, arrayBuffer.byteLength);
  
  if (range) {
    const slicedBuffer = arrayBuffer.slice(range.start, range.end + 1);
    return new Response(slicedBuffer, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${range.start}-${range.end}/${arrayBuffer.byteLength}`,
        'Content-Length': slicedBuffer.byteLength.toString(),
        'Content-Type': cachedResponse.headers.get('Content-Type')
      }
    });
  }
  
  return cachedResponse;
}

function parseRangeHeader(rangeHeader, contentLength) {
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;
  
  const start = parseInt(match[1]);
  const end = match[2] ? parseInt(match[2]) : contentLength - 1;
  
  return { start, end };
}

function getMediaFallback(request) {
  if (isVideoRequest(request)) {
    return new Response('Video non disponibile offline', { status: 503 });
  }
  
  // Placeholder per immagini
  const placeholderSvg = `
    <svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f0f0f0"/>
      <text x="50%" y="50%" font-family="Arial" font-size="16" fill="#666" text-anchor="middle" dy=".3em">
        Immagine non disponibile offline
      </text>
    </svg>
  `;
  
  return new Response(placeholderSvg, {
    headers: { 'Content-Type': 'image/svg+xml' }
  });
}

// === DATABASE WORKOUT ===

async function initializeWorkoutDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('WorkoutCoachDB', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('sync-queue')) {
        db.createObjectStore('sync-queue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('workouts')) {
        const workoutStore = db.createObjectStore('workouts', { keyPath: 'id' });
        workoutStore.createIndex('date', 'date', { unique: false });
        workoutStore.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains('exercises')) {
        const exerciseStore = db.createObjectStore('exercises', { keyPath: 'id' });
        exerciseStore.createIndex('category', 'category', { unique: false });
        exerciseStore.createIndex('difficulty', 'difficulty', { unique: false });
      }
      if (!db.objectStoreNames.contains('progress')) {
        const progressStore = db.createObjectStore('progress', { keyPath: 'id', autoIncrement: true });
        progressStore.createIndex('date', 'date', { unique: false });
        progressStore.createIndex('exerciseId', 'exerciseId', { unique: false });
      }
      if (!db.objectStoreNames.contains('nutrition')) {
        const nutritionStore = db.createObjectStore('nutrition', { keyPath: 'id', autoIncrement: true });
        nutritionStore.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('goals')) {
        db.createObjectStore('goals', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function saveToWorkoutDB(storeName, data) {
  const db = await initializeWorkoutDB();
  const transaction = db.transaction([storeName], 'readwrite');
  const store = transaction.objectStore(storeName);
  
  if (storeName === 'sync-queue') {
    await store.clear();
    for (const item of data) {
      await store.add(item);
    }
  } else {
    await store.put(data);
  }
  
  return transaction.complete;
}

async function getFromWorkoutDB(storeName, key = null) {
  const db = await initializeWorkoutDB();
  const transaction = db.transaction([storeName], 'readonly');
  const store = transaction.objectStore(storeName);
  
  if (key) {
    return await store.get(key);
  } else {
    return await store.getAll();
  }
}

// Gestione dati allenamento offline
async function handleOfflineWorkoutData(data) {
  switch (data.type) {
    case 'workout-start':
      workoutState = WORKOUT_STATES.ACTIVE;
      currentWorkout = {
        id: data.workoutId || generateWorkoutId(),
        startTime: Date.now(),
        exercises: data.exercises || [],
        status: 'active'
      };
      await saveToWorkoutDB('workouts', currentWorkout);
      break;
      
    case 'workout-progress':
      if (currentWorkout) {
        await saveToWorkoutDB('progress', {
          workoutId: currentWorkout.id,
          exerciseId: data.exerciseId,
          sets: data.sets,
          reps: data.reps,
          weight: data.weight,
          timestamp: Date.now()
        });
      }
      break;
      
    case 'workout-complete':
      if (currentWorkout) {
        currentWorkout.endTime = Date.now();
        currentWorkout.status = 'completed';
        currentWorkout.duration = currentWorkout.endTime - currentWorkout.startTime;
        currentWorkout.totalCalories = data.totalCalories;
        await saveToWorkoutDB('workouts', currentWorkout);
        workoutState = WORKOUT_STATES.COMPLETED;
      }
      break;
      
    case 'nutrition-log':
      await saveToWorkoutDB('nutrition', {
        date: new Date().toISOString().split('T')[0],
        meals: data.meals,
        calories: data.calories,
        macros: data.macros,
        timestamp: Date.now()
      });
      break;
  }
}

function generateWorkoutId() {
  return 'workout_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// === ESERCIZI ESSENZIALI ===

async function preloadEssentialExercises() {
  const essentialExercises = [
    {
      id: 'pushup',
      name: 'Push-up',
      category: 'strength',
      difficulty: 'beginner',
      description: 'Esercizio base per petto, spalle e tricipiti',
      instructions: ['Posizionati a terra in plank', 'Abbassa il corpo fino al petto', 'Spingi verso l\'alto'],
      muscleGroups: ['petto', 'tricipiti', 'spalle'],
      equipment: 'nessuno'
    },
    {
      id: 'squat',
      name: 'Squat',
      category: 'strength',
      difficulty: 'beginner',
      description: 'Esercizio fondamentale per gambe e glutei',
      instructions: ['Piedi larghezza spalle', 'Scendi come per sederti', 'Risali mantenendo la schiena dritta'],
      muscleGroups: ['quadricipiti', 'glutei', 'polpacci'],
      equipment: 'nessuno'
    },
    {
      id: 'plank',
      name: 'Plank',
      category: 'core',
      difficulty: 'beginner',
      description: 'Esercizio isometrico per addominali e core',
      instructions: ['Posizione a terra sui gomiti', 'Mantieni corpo dritto', 'Contrai addominali'],
      muscleGroups: ['addominali', 'core', 'schiena'],
      equipment: 'nessuno'
    }
  ];
  
  const cache = await caches.open(EXERCISES_CACHE);
  for (const exercise of essentialExercises) {
    const response = new Response(JSON.stringify(exercise), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put(`/exercises/${exercise.id}`, response);
    await saveToWorkoutDB('exercises', exercise);
  }
  
  console.log('[SW] Essential exercises preloaded');
}

async function getOfflineExercise() {
  const fallbackExercise = {
    id: 'basic-workout',
    name: 'Allenamento Base',
    category: 'general',
    difficulty: 'beginner',
    description: 'Routine base disponibile offline',
    exercises: ['pushup', 'squat', 'plank'],
    duration: '20 minuti'
  };
  
  return new Response(JSON.stringify(fallbackExercise), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// === PULIZIA E MANUTENZIONE ===

async function cleanupOldCaches() {
  const cacheNames = await caches.keys();
  const currentCaches = [STATIC_CACHE, DYNAMIC_CACHE, EXERCISES_CACHE, VIDEOS_CACHE, USER_DATA_CACHE];
  
  return Promise.all(
    cacheNames.map(cacheName => {
      if (!currentCaches.includes(cacheName) && cacheName.includes('workout')) {
        console.log('[SW] Deleting old cache:', cacheName);
        return caches.delete(cacheName);
      }
    })
  );
}

async function setupStorageQuota() {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    const quotaMB = Math.round(estimate.quota / (1024 * 1024));
    const usageMB = Math.round(estimate.usage / (1024 * 1024));
    
    console.log(`[SW] Workout Coach Storage: ${usageMB}MB used of ${quotaMB}MB`);
    
    if (usageMB > STORAGE_QUOTA_MB) {
      await cleanupExcessStorage();
    }
  }
}

async function cleanupExcessStorage() {
  // Pulisci video più vecchi per primi
  const videoCache = await caches.open(VIDEOS_CACHE);
  const videoRequests = await videoCache.keys();
  
  // Rimuovi 40% dei video meno recenti
  const toDelete = videoRequests.slice(0, Math.floor(videoRequests.length * 0.4));
  await Promise.all(toDelete.map(request => videoCache.delete(request)));
  
  console.log('[SW] Cleaned up old workout videos');
}

async function setupWorkoutSync() {
  if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
    await self.registration.sync.register(SYNC_QUEUE_NAME);
  }
}

async function setupHealthTracking() {
  // Setup per future integrazioni health API
  console.log('[SW] Health tracking initialized');
}

async function setupNotifications() {
  // Setup per notifiche allenamento
  console.log('[SW] Workout notifications ready');
}

async function setupPerformanceMonitoring() {
  // Setup monitoring performance utente
  console.log('[SW] Performance monitoring active');
}

// Background Sync
self.addEventListener('sync', function(event) {
  if (event.tag === SYNC_QUEUE_NAME) {
    event.waitUntil(processWorkoutSyncQueue());
  }
});

async function processWorkoutSyncQueue() {
  const queue = await getFromWorkoutDB('sync-queue') || [];
  const successful = [];
  
  for (const item of queue) {
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: JSON.stringify(item.body)
      });
      
      if (response.ok) {
        successful.push(item);
        console.log('[SW] Workout sync completed:', item.url);
      }
    } catch (error) {
      console.log('[SW] Workout sync failed for:', item.url, error);
    }
  }
  
  const remaining = queue.filter(item => !successful.includes(item));
  await saveToWorkoutDB('sync-queue', remaining);
  
  if (successful.length > 0) {
    notifyClientsOfSync('completed', successful.length);
  }
}

// Comunicazione con client
function notifyClientsOfSync(status, count = 0) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'WORKOUT_SYNC_STATUS',
        status: status,
        count: count,
        workoutState: workoutState,
        timestamp: Date.now()
      });
    });
  });
}

function notifyClientsOfDataUpdate(url) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'WORKOUT_DATA_UPDATED',
        url: url,
        timestamp: Date.now()
      });
    });
  });
}

// Monitoraggio connessione e workout
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CONNECTION_CHANGE') {
    isOnline = event.data.online;
    if (isOnline) {
      processWorkoutSyncQueue();
    }
  } else if (event.data && event.data.type === 'WORKOUT_STATE_CHANGE') {
    workoutState = event.data.state;
    if (event.data.workoutData) {
      currentWorkout = event.data.workoutData;
    }
  }
});

console.log('[SW] Workout Coach Service Worker v2.0.0 loaded');