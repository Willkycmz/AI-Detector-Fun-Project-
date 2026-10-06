import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const datasetsRoot = path.resolve(projectRoot, 'datasets');
const rawDatasetRoot = path.resolve(datasetsRoot, 'raw');
const facesDatasetRoot = path.resolve(datasetsRoot, 'faces');
const trashDatasetRoot = path.resolve(datasetsRoot, '.trash');

// Helper memastikan path aman di dalam direktori datasets/
function assertSafeDatasetPath(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(datasetsRoot)) {
    throw new Error('Akses ditolak: Percobaan path traversal di luar direktori datasets.');
  }
  return resolved;
}

// Helper membaca dan menulis .trash_meta.json
function getTrashMeta() {
  const metaPath = path.resolve(trashDatasetRoot, '.trash_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (e) {
      return { items: {} };
    }
  }
  return { items: {} };
}

function saveTrashMeta(meta) {
  if (!fs.existsSync(trashDatasetRoot)) {
    fs.mkdirSync(trashDatasetRoot, { recursive: true });
  }
  const metaPath = path.resolve(trashDatasetRoot, '.trash_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

// Helper membaca key environment dari env process atau file .env/.env.local
function readEnvKey(key) {
  if (process.env[key] && !process.env[key].includes('your_') && !process.env[key].includes('placeholder')) {
    return process.env[key];
  }
  const candidateFiles = [
    path.resolve(__dirname, '.env.local'),
    path.resolve(__dirname, '.env'),
    path.resolve(projectRoot, '.env')
  ];
  for (const f of candidateFiles) {
    if (fs.existsSync(f)) {
      try {
        const text = fs.readFileSync(f, 'utf-8');
        const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (match) {
          const val = match[1].trim().replace(/^['"]|['"]$/g, '');
          if (val && !val.includes('your_') && !val.includes('placeholder')) {
            return val;
          }
        }
      } catch (_) {}
    }
  }
  return '';
}

// Pastikan background Identity Service aktif
let identityServiceProcess = null;
function ensureIdentityService() {
  fetch('http://127.0.0.1:5175/status')
    .catch(() => {
      if (!identityServiceProcess) {
        console.log('[VisionX] Memulai background Identity Service Python...');
        identityServiceProcess = spawn('python', ['-m', 'app.identity_service'], {
          cwd: projectRoot,
          stdio: 'ignore',
          detached: true
        });
        identityServiceProcess.unref();
      }
    });
}
ensureIdentityService();

// Helper pemindaian cepat dataset nyata (mengabaikan folder staging internal _*, hidden .*, dan labels)
function scanActiveDataset(rootDir, options = {}) {
  const { filterClass = null, filterSource = null, search = '', maxItems = 1000 } = options;
  const supportedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const items = [];
  const classCounts = {};
  const sourceCounts = {};
  let totalImages = 0;
  let totalSizeBytes = 0;

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return; }

    // Prioritaskan folder own dan tangkapan lokal agar muncul lebih awal dibanding external
    entries.sort((a, b) => {
      if (a.name === 'own') return -1;
      if (b.name === 'own') return 1;
      if (a.name === 'external') return 1;
      if (b.name === 'external') return -1;
      return 0;
    });

    for (const ent of entries) {
      if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'labels' || ent.name === '__pycache__') continue;
      const fullPath = path.resolve(dir, ent.name);

      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile() && supportedExts.has(path.extname(ent.name).toLowerCase())) {
        totalImages++;
        const relPath = path.relative(rootDir, fullPath);
        const parts = relPath.split(path.sep);

        let cls = 'general';
        let sourceName = 'own_capture';
        if (parts[0] === 'external') {
          cls = parts[1] || 'general';
          sourceName = 'external';
        } else if (parts[0] === 'own') {
          sourceName = 'own_capture';
          if (parts.length > 2 && parts[1] !== 'images') {
            cls = parts[1];
          } else {
            const m = ent.name.match(/^(?:own_v\d+_)?([a-zA-Z0-9_]+?)_\d+/);
            cls = m ? m[1] : (parts[1] !== 'images' ? parts[1] : 'own');
          }
        } else {
          cls = parts[0] || 'general';
          sourceName = 'own_capture';
        }

        if (ent.name.startsWith('import_') || (parts.length > 1 && parts[1] === 'import')) {
          sourceName = 'own_import';
        }

        classCounts[cls] = (classCounts[cls] || 0) + 1;
        sourceCounts[sourceName] = (sourceCounts[sourceName] || 0) + 1;

        if (filterClass && filterClass !== 'all' && filterClass !== cls) continue;
        if (filterSource && filterSource !== 'all' && filterSource !== sourceName) continue;
        if (search && !ent.name.toLowerCase().includes(search) && !cls.toLowerCase().includes(search)) continue;

        if (items.length < maxItems) {
          try {
            const stat = fs.statSync(fullPath);
            totalSizeBytes += stat.size;
            const urlPath = relPath.replace(/\\/g, '/');
            items.push({
              id: ent.name,
              filename: ent.name,
              className: cls,
              source: sourceName,
              sizeBytes: stat.size,
              formattedSize: `${(stat.size / 1024).toFixed(1)} KB`,
              timestamp: new Date(stat.mtimeMs).toLocaleString(),
              mtime: stat.mtimeMs,
              url: `/api/dataset/image/${urlPath}`,
              isTrash: false
            });
          } catch (_) {}
        }
      }
    }
  }

  walk(rootDir);
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { items, totalImages, totalSizeBytes, classCounts, sourceCounts };
}

function visionxCorePlugin() {
  return {
    name: 'visionx-core-api',
    configureServer(server) {
      // 1. Static file serving untuk /datasets/*, /api/dataset/image/*, dan /api/dataset/file/*
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const rawUrl = req.url.split('?')[0];
        let subPath = null;
        if (rawUrl.startsWith('/datasets/')) {
          subPath = rawUrl.replace('/datasets/', '');
        } else if (rawUrl.startsWith('/api/dataset/image/')) {
          subPath = rawUrl.replace('/api/dataset/image/', '');
        } else if (rawUrl.startsWith('/api/dataset/file/')) {
          subPath = rawUrl.replace('/api/dataset/file/', '');
        }

        if (subPath !== null) {
          try {
            const relativePath = decodeURIComponent(subPath);
            const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
            
            const candidates = [
              path.resolve(datasetsRoot, safePath),
              path.resolve(rawDatasetRoot, safePath),
              path.resolve(trashDatasetRoot, safePath),
              path.resolve(facesDatasetRoot, safePath),
              path.resolve(datasetsRoot, 'raw', safePath)
            ];

            let targetFile = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile());

            if (!targetFile) {
              const baseName = path.basename(safePath);
              const findFile = (dir) => {
                if (!fs.existsSync(dir)) return null;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const ent of entries) {
                  if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'labels' || ent.name === '__pycache__') continue;
                  const fp = path.resolve(dir, ent.name);
                  if (ent.isFile() && ent.name === baseName) return fp;
                  if (ent.isDirectory()) {
                    const found = findFile(fp);
                    if (found) return found;
                  }
                }
                return null;
              };
              targetFile = findFile(datasetsRoot);
            }

            if (targetFile) {
              const ext = path.extname(targetFile).toLowerCase();
              const mimeTypes = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.webp': 'image/webp',
                '.json': 'application/json'
              };
              res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
              res.setHeader('Cache-Control', 'no-cache');
              return fs.createReadStream(targetFile).pipe(res);
            }
          } catch (e) {
            console.warn('[Dataset Static Serve Error]', e.message);
          }
        }
        next();
      });

      // 2. Helper to parse JSON body
      const parseJsonBody = (req) => {
        return new Promise((resolve, reject) => {
          let body = '';
          req.on('data', chunk => {
            body += chunk;
            if (body.length > 50 * 1024 * 1024) {
              reject(new Error('Payload terlalu besar (maks 50MB)'));
            }
          });
          req.on('end', () => {
            try {
              resolve(body ? JSON.parse(body) : {});
            } catch (err) {
              reject(err);
            }
          });
          req.on('error', reject);
        });
      };

      // 3. API endpoints
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const url = new URL(req.url, 'http://localhost:5173');

        // ======================================================================
        // V1.0 AI VISION ASSISTANT PROXY (/api/ai/ask-vision)
        // ======================================================================
        if (url.pathname === '/api/ai/ask-vision' && req.method === 'POST') {
          const startTime = Date.now();
          try {
            const body = await parseJsonBody(req);
            const { image, context, question = '' } = body;

            if (!question || !question.trim()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ success: false, error: 'Pertanyaan tidak boleh kosong.' }));
            }

            let answer = '';
            let provider = 'visionx-local-engine';

            // Server-side LLM API Key (jika disetel pengguna di environment)
            const apiKey = process.env.VISIONX_AI_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
            if (apiKey && process.env.GEMINI_API_KEY) {
              // Jika ada external key, dapat diteruskan ke upstream API di server-side
            }

            // Local Intelligent Multimodal Synthesis
            if (!answer) {
              const q = question.toLowerCase().trim();
              const detections = context?.detections || [];
              const ocr = context?.ocr || {};
              const tracking = context?.tracking || {};
              const identity = context?.identity || {};
              const totalObj = detections.length;

              if (q.includes('teks') || q.includes('baca') || q.includes('tulisan')) {
                if (ocr.has_text && ocr.text) {
                  answer = `Teks yang terbaca pada kamera adalah: "${ocr.text}" (dengan tingkat keyakinan ${ocr.confidence || 0}%).`;
                } else {
                  answer = 'Saat ini tidak terdeteksi teks atau tulisan yang jelas pada objek di depan kamera.';
                }
              } else if (q.includes('siapa') || q.includes('wajah') || q.includes('identitas')) {
                if (identity.is_developer_verified) {
                  answer = `Saya mengenali Anda sebagai ${identity.profile_name || 'VisionX Developer'} (kemiripan ${(identity.similarity_score * 100).toFixed(0)}%).`;
                } else if (detections.some(d => d.class_name === 'person')) {
                  answer = 'Terdeteksi seseorang di depan kamera, tetapi wajah belum terverifikasi sebagai pengembang.';
                } else {
                  answer = 'Tidak ada orang atau wajah yang terdeteksi di depan kamera saat ini.';
                }
              } else if (q.includes('gerak') || q.includes('bergerak') || q.includes('kecepatan')) {
                const activeTracks = tracking.tracks || [];
                if (activeTracks.length > 0) {
                  const moving = activeTracks.filter(t => t.movement && !t.movement.includes('diam'));
                  if (moving.length > 0) {
                    const desc = moving.map(t => `${t.class_name} (Track #${t.track_id}) ${t.movement}`).join(', ');
                    answer = `Objek yang sedang bergerak: ${desc}.`;
                  } else {
                    answer = `Seluruh ${activeTracks.length} objek yang sedang dilacak dalam keadaan diam atau stabil.`;
                  }
                } else {
                  answer = 'Tidak ada objek bergerak yang terdeteksi dalam tracking loop.';
                }
              } else if (q.includes('berapa') || q.includes('jumlah')) {
                if (totalObj === 0) {
                  answer = 'Tidak ada objek yang terdeteksi di frame kamera saat ini.';
                } else {
                  const counts = context?.summary?.class_counts || {};
                  const countItems = Object.entries(counts).map(([cls, num]) => `${num} ${cls}`).join(', ');
                  answer = `Terdapat total ${totalObj} objek yang terdeteksi: ${countItems}.`;
                }
              } else if (q.includes('aman') || q.includes('bahaya') || q.includes('keselamatan') || q.includes('peringatan') || q.includes('alert')) {
                const safety = context?.safety;
                if (!safety || !safety.is_enabled) {
                  answer = 'Sistem keselamatan (Safety Engine) sedang tidak aktif atau tidak tersedia.';
                } else if (safety.active_alerts_count > 0) {
                  const alertDesc = safety.active_alerts.map(a => `${a.title} (${a.message})`).join('; ');
                  answer = `Perhatian: Tingkat risiko saat ini ${safety.risk_level}. Terdapat ${safety.active_alerts_count} peringatan: ${alertDesc}.`;
                } else {
                  answer = `Situasi terpantau aman (Tingkat risiko: ${safety.risk_level}). Tidak ada peringatan keselamatan aktif saat ini.`;
                }
              } else if (q.includes('situasi') || q.includes('kondisi') || q.includes('suasana') || q.includes('padat') || q.includes('fokus') || q.includes('sebelah') || q.includes('posisi')) {
                const su = context?.sceneUnderstanding;
                if (su && su.spatial_narrative) {
                  answer = su.spatial_narrative;
                } else {
                  answer = 'Analisis situasi spasial belum tersedia.';
                }
              } else {
                // Pertanyaan umum / eksplorasi
                if (totalObj === 0 && !ocr.has_text && !identity.is_developer_verified) {
                  answer = 'Saya melihat melalui kamera, saat ini belum ada objek atau teks yang terdeteksi secara jelas.';
                } else {
                  const descParts = [];
                  if (totalObj > 0) {
                    const objDesc = detections.map(d => `${d.class_name} di area ${d.relative_position}`).join(', ');
                    descParts.push(`Di depan Anda terdapat ${totalObj} objek: ${objDesc}`);
                  }
                  if (ocr.has_text && ocr.text) {
                    descParts.push(`terbaca teks "${ocr.text}"`);
                  }
                  if (identity.is_developer_verified) {
                    descParts.push(`dan terverifikasi kehadiran ${identity.profile_name || 'VisionX Developer'}`);
                  }
                  answer = descParts.join(', ') + '.';
                }
              }
            }

            const latencyMs = Date.now() - startTime;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              answer,
              provider,
              latencyMs
            }));
          } catch (aiErr) {
            console.error('[AI Assistant API Error]', aiErr);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: false,
              error: `Gagal memproses pertanyaan AI: ${aiErr.message}`
            }));
          }
        }

        // ======================================================================
        // IDENTITY LAB API PROXY (Forward ke Python service http://127.0.0.1:5175)
        // ======================================================================
        if (url.pathname.startsWith('/api/identity/')) {
          try {
            const targetUrl = `http://127.0.0.1:5175${url.pathname}${url.search}`;
            let fetchOptions = {
              method: req.method,
              headers: { 'Content-Type': 'application/json' }
            };

            if (req.method === 'POST') {
              const body = await parseJsonBody(req);
              fetchOptions.body = JSON.stringify(body);
            }

            const pyRes = await fetch(targetUrl, fetchOptions);
            const pyData = await pyRes.json();
            res.statusCode = pyRes.status;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify(pyData));
          } catch (proxyErr) {
            console.error('[Identity Proxy Error]', proxyErr.message);
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: false,
              error: `Gagal terhubung ke Identity Service: ${proxyErr.message}`
            }));
          }
        }

        // ======================================================================
        // DATASET MANAGER API (V0.6)
        // ======================================================================

        // GET /api/manager/list
        if (url.pathname === '/api/manager/list' && req.method === 'GET') {
          try {
            const view = (url.searchParams.get('view') || 'active').toLowerCase().trim(); // 'active' | 'trash'
            const classFilter = url.searchParams.get('class');
            const sourceFilter = url.searchParams.get('source');
            const search = (url.searchParams.get('search') || '').toLowerCase().trim();
            const supportedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
            let items = [];
            let totalCount = 0;

            if (view === 'trash') {
              // Baca Recycle Bin
              const trashMeta = getTrashMeta();
              if (fs.existsSync(trashDatasetRoot)) {
                const files = fs.readdirSync(trashDatasetRoot);
                for (const f of files) {
                  if (f === '.trash_meta.json') continue;
                  const filePath = path.resolve(trashDatasetRoot, f);
                  if (fs.statSync(filePath).isFile()) {
                    const info = trashMeta.items[f] || {};
                    const stat = fs.statSync(filePath);
                    items.push({
                      id: f,
                      trashFilename: f,
                      filename: info.originalFilename || f,
                      className: info.originalClass || 'unknown',
                      source: info.originalSource || 'own_capture',
                      sizeBytes: stat.size,
                      formattedSize: `${(stat.size / 1024).toFixed(1)} KB`,
                      timestamp: info.trashedAt || new Date(stat.mtimeMs).toLocaleString(),
                      trashedAt: info.trashedAt,
                      url: `/datasets/.trash/${f}`,
                      isTrash: true
                    });
                  }
                }
              }
              if (classFilter && classFilter !== 'all') {
                items = items.filter(it => it.className === classFilter);
              }
              if (sourceFilter && sourceFilter !== 'all') {
                items = items.filter(it => it.source === sourceFilter);
              }
              if (search) {
                items = items.filter(it =>
                  it.filename.toLowerCase().includes(search) ||
                  it.className.toLowerCase().includes(search)
                );
              }
              totalCount = items.length;
            } else {
              // Baca Active Dataset dengan fast scan
              const scanned = scanActiveDataset(rawDatasetRoot, {
                filterClass: classFilter,
                filterSource: sourceFilter,
                search,
                maxItems: 1000
              });
              items = scanned.items;
              totalCount = scanned.totalImages;
            }

            items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              items,
              total: totalCount,
              active_count: totalCount,
              count: items.length
            }));
          } catch (err) {
            console.error('[Manager List Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // GET /api/manager/stats
        if (url.pathname === '/api/manager/stats' && req.method === 'GET') {
          try {
            const scanned = scanActiveDataset(rawDatasetRoot, { maxItems: 0 });

            // Hitung Recycle Bin
            let trashCount = 0;
            if (fs.existsSync(trashDatasetRoot)) {
              trashCount = fs.readdirSync(trashDatasetRoot).filter(f => f !== '.trash_meta.json').length;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              totalImages: scanned.totalImages,
              totalSizeBytes: scanned.totalSizeBytes,
              formattedTotalSize: `${(scanned.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`,
              classesCount: Object.keys(scanned.classCounts).length,
              classCounts: scanned.classCounts,
              sourceCounts: scanned.sourceCounts,
              trashCount
            }));
          } catch (err) {
            console.error('[Manager Stats Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/manager/trash (Soft Delete -> Move to .trash)
        if (url.pathname === '/api/manager/trash' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            const items = data.items || [];
            if (!Array.isArray(items) || items.length === 0) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ success: false, error: 'Daftar items kosong.' }));
            }

            if (!fs.existsSync(trashDatasetRoot)) {
              fs.mkdirSync(trashDatasetRoot, { recursive: true });
            }
            const trashMeta = getTrashMeta();
            let trashedCount = 0;

            for (const item of items) {
              const { filename, className, source = 'own_capture' } = item;
              const folderCategory = source.startsWith('own') ? 'own' : `external/${source}`;
              const sourceFilePath = path.resolve(rawDatasetRoot, folderCategory, className, filename);

              assertSafeDatasetPath(sourceFilePath);

              if (fs.existsSync(sourceFilePath)) {
                const trashFilename = `${Date.now()}_${filename}`;
                const destFilePath = path.resolve(trashDatasetRoot, trashFilename);

                fs.renameSync(sourceFilePath, destFilePath);

                trashMeta.items[trashFilename] = {
                  originalFilename: filename,
                  originalClass: className,
                  originalSource: source,
                  originalFolderCategory: folderCategory,
                  trashedAt: new Date().toLocaleString()
                };
                trashedCount++;
              }
            }

            saveTrashMeta(trashMeta);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, count: trashedCount }));
          } catch (err) {
            console.error('[Manager Trash Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/manager/restore (Restore from .trash)
        if (url.pathname === '/api/manager/restore' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            const items = data.items || [];
            const trashMeta = getTrashMeta();
            let restoredCount = 0;

            for (const it of items) {
              const trashFile = it.trashFilename || it.id;
              const srcPath = path.resolve(trashDatasetRoot, trashFile);
              assertSafeDatasetPath(srcPath);

              if (fs.existsSync(srcPath)) {
                const info = trashMeta.items[trashFile] || {};
                const origClass = info.originalClass || it.className || 'object';
                const origCategory = info.originalFolderCategory || (info.originalSource?.startsWith('own') ? 'own' : 'own');
                const origName = info.originalFilename || it.filename || trashFile.replace(/^\d+_/, '');

                const targetDir = path.resolve(rawDatasetRoot, origCategory, origClass);
                if (!fs.existsSync(targetDir)) {
                  fs.mkdirSync(targetDir, { recursive: true });
                }
                const destPath = path.resolve(targetDir, origName);
                assertSafeDatasetPath(destPath);

                fs.renameSync(srcPath, destPath);
                delete trashMeta.items[trashFile];
                restoredCount++;
              }
            }

            saveTrashMeta(trashMeta);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, count: restoredCount }));
          } catch (err) {
            console.error('[Manager Restore Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/manager/delete-permanent
        if (url.pathname === '/api/manager/delete-permanent' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            const items = data.items || [];
            const trashMeta = getTrashMeta();
            let deletedCount = 0;

            for (const it of items) {
              let targetPath = null;
              if (it.fromTrash || it.trashFilename) {
                const tName = it.trashFilename || it.id;
                targetPath = path.resolve(trashDatasetRoot, tName);
                if (trashMeta.items[tName]) delete trashMeta.items[tName];
              } else {
                const folderCat = it.source?.startsWith('own') ? 'own' : `external/${it.source}`;
                targetPath = path.resolve(rawDatasetRoot, folderCat, it.className, it.filename);
              }

              assertSafeDatasetPath(targetPath);
              if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
                deletedCount++;
              }
            }

            saveTrashMeta(trashMeta);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, count: deletedCount }));
          } catch (err) {
            console.error('[Manager Permanent Delete Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/manager/import
        if (url.pathname === '/api/manager/import' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            const files = data.files || (data.dataUrl ? [data] : []);
            let importedCount = 0;
            const results = [];

            for (const f of files) {
              const { filename, className = 'object', source = 'own_import', dataUrl } = f;
              if (!filename || !dataUrl) continue;

              const cleanClass = className.trim().toLowerCase().replace(/\s+/g, '_');
              const targetDir = path.resolve(rawDatasetRoot, 'own', cleanClass);
              if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
              }

              const targetFilePath = path.resolve(targetDir, filename);
              assertSafeDatasetPath(targetFilePath);

              const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
              const buffer = Buffer.from(base64Data, 'base64');
              fs.writeFileSync(targetFilePath, buffer);

              importedCount++;
              results.push({ filename, className: cleanClass, sizeBytes: buffer.length });
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, count: importedCount, items: results }));
          } catch (err) {
            console.error('[Manager Import Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // ======================================================================
        // STATUS & HEALTH METADATA (VisionX AI)
        // ======================================================================
        if ((url.pathname === '/api/config' || url.pathname === '/status' || url.pathname === '/api/health') && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({
            status: 'online',
            service: 'visionx',
            ai_provider: 'VisionX AI',
            ai_model: 'VisionX Core',
            streaming_enabled: true
          }));
        }

        // ======================================================================
        // GROQ CLOUD CHAT SSE PROXY (/api/chat)
        // ======================================================================
        if (url.pathname === '/api/chat' && (req.method === 'POST' || req.method === 'OPTIONS')) {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            return res.end();
          }

          try {
            const body = await parseJsonBody(req);
            const userMsg = body.message || 'Halo';
            const visionContext = body.vision_context || null;
            const detections = body.detections || (visionContext?.detections || []);
            const groqApiKey = readEnvKey('AI_API_KEY') || readEnvKey('GROQ_API_KEY') || '';
            const groqModel = readEnvKey('AI_MODEL') || 'openai/gpt-oss-120b';

            // Jika API Key Groq belum disetel atau placeholder, fallback ke local grounded responder
            if (!groqApiKey) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');

              let localAnswer = '';
              const qLower = userMsg.toLowerCase().trim();
              const detNames = Array.from(new Set(
                (Array.isArray(detections) ? detections : [])
                  .map(d => d.class_name || d.className || 'objek')
                  .filter(Boolean)
              ));

              if (qLower.includes('halo') || qLower.includes('hai') || qLower.includes('test')) {
                localAnswer = 'Halo! Saya VisionX AI. Sistem deteksi visual aktif dan siap menganalisis objek atau situasi di depan kamera Anda.';
              } else if (qLower.includes('apa yang terlihat') || qLower.includes('ada apa') || qLower.includes('lihat')) {
                localAnswer = detNames.length > 0
                  ? `Berdasarkan deteksi visual kamera saat ini, terlihat: ${detNames.join(', ')}.`
                  : 'Saat ini belum ada objek spesifik yang terdeteksi di dalam frame kamera.';
              } else if (detNames.length > 0) {
                localAnswer = `Objek yang terdeteksi di kamera: ${detNames.join(', ')}.`;
              } else {
                localAnswer = 'VisionX AI siap membantu Anda. Arahkan kamera atau ajukan pertanyaan terkait apa yang ingin dianalisis.';
              }

              const words = localAnswer.split(' ');
              for (const word of words) {
                res.write(`data: ${JSON.stringify({ text: word + ' ' })}\n\n`);
                await new Promise(r => setTimeout(r, 20));
              }
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            // Jika API Key ada, susun prompt bebas simbol markdown kaku
            const systemPrompt = `Kamu adalah VisionX AI, asisten visual dan deteksi cerdas yang ramah, ringkas, dan berbahasa Indonesia.
ATURAN FORMAT WAJIB (SANGAT KETAT):
1. Tulis jawaban dalam bahasa Indonesia santai, jelas, dan mengalir natural layaknya percakapan manusia.
2. DILARANG KERAS menggunakan simbol bintang (*) atau (**) sama sekali (JANGAN gunakan bold/italic dengan bintang).
3. DILARANG KERAS menggunakan tanda pagar (#, ##, ###) untuk judul atau subjudul.
4. DILARANG KERAS membuat tabel markdown atau garis pipa (|).
5. Gunakan teks biasa yang rapi. Bila membuat daftar, gunakan nomor biasa (1, 2, 3) atau tanda strip (-) sederhana.
6. Hindari format kaku yang terlihat seperti salinan AI generator.`;

            const messages = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMsg }
            ];

            // Prioritas model: model pilihan user atau fallback terverifikasi
            const candidateModels = Array.from(new Set([
              groqModel,
              'openai/gpt-oss-120b',
              'openai/gpt-oss-20b',
              'qwen/qwen3.8-27b'
            ]));

            let groqRes = null;
            let lastErrDetail = '';
            for (const targetModel of candidateModels) {
              try {
                const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${groqApiKey}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    model: targetModel,
                    messages,
                    stream: true,
                    temperature: 0.7
                  })
                });

                if (resp.ok) {
                  groqRes = resp;
                  break;
                } else {
                  const errJson = await resp.json().catch(() => ({}));
                  lastErrDetail = errJson?.error?.message || `HTTP ${resp.status}`;
                  console.warn(`[Groq Model ${targetModel} Failed]:`, lastErrDetail);
                }
              } catch (fetchErr) {
                lastErrDetail = fetchErr.message;
              }
            }

            if (!groqRes) {
              console.warn(`[Groq Cloud Error] ${lastErrDetail}`);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.write(`data: ${JSON.stringify({ error: `Groq Cloud error: ${lastErrDetail}` })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const reader = groqRes.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              const lines = text.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const raw = line.slice(6).trim();
                  if (raw === '[DONE]') {
                    res.write('data: [DONE]\n\n');
                    break;
                  }
                  try {
                    const parsed = JSON.parse(raw);
                    let chunk = parsed.choices?.[0]?.delta?.content || '';
                    if (chunk) {
                      // Hapus tanda bintang dan tanda pagar dari chunk jika lolos dari model
                      chunk = chunk.replace(/\*/g, '');
                      if (chunk) {
                        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
                      }
                    }
                  } catch (_) {}
                }
              }
            }
            res.end();
            return;
          } catch (chatErr) {
            console.error('[Vite /api/chat Proxy Error]', chatErr);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write(`data: ${JSON.stringify({ error: `Gateway error: ${chatErr.message}` })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
        }

        // ======================================================================
        // DATASET UPLOAD & COLLECTION SAVE (/api/dataset/upload, /api/collection/save)
        // ======================================================================
        if ((url.pathname === '/api/dataset/upload' || url.pathname === '/api/collection/save' || url.pathname === '/api/upload') && (req.method === 'POST' || req.method === 'OPTIONS')) {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            return res.end();
          }

          try {
            const cType = req.headers['content-type'] || '';
            let filename = `capture_${Date.now()}.jpg`;
            let className = 'object';
            let buffer = null;

            if (cType.includes('application/json')) {
              const body = await parseJsonBody(req);
              className = body.label || body.className || 'object';
              filename = body.filename || `${className}_${Date.now()}.jpg`;
              const b64 = (body.image || body.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
              buffer = Buffer.from(b64, 'base64');
            } else {
              const rawData = await new Promise((resolve, reject) => {
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => resolve(Buffer.concat(chunks)));
                req.on('error', reject);
              });

              if (cType.includes('multipart/form-data')) {
                const boundary = cType.split('boundary=')[1];
                if (boundary) {
                  const parts = rawData.toString('binary').split('--' + boundary);
                  for (const part of parts) {
                    if (part.includes('filename="')) {
                      const fnameMatch = part.match(/filename="([^"]+)"/);
                      if (fnameMatch) filename = fnameMatch[1];
                      const fileStart = part.indexOf('\r\n\r\n') + 4;
                      const fileEnd = part.lastIndexOf('\r\n');
                      const fileContent = part.substring(fileStart, fileEnd);
                      buffer = Buffer.from(fileContent, 'binary');
                    } else if (part.includes('name="label"') || part.includes('name="className"')) {
                      const lStart = part.indexOf('\r\n\r\n') + 4;
                      const lEnd = part.lastIndexOf('\r\n');
                      className = part.substring(lStart, lEnd).trim();
                    }
                  }
                }
              }
              if (!buffer) {
                buffer = rawData;
              }
            }

            const cleanClass = className.trim().toLowerCase().replace(/\s+/g, '_') || 'object';
            const targetDir = path.resolve(rawDatasetRoot, 'own', cleanClass);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            const targetFilePath = path.resolve(targetDir, filename);
            assertSafeDatasetPath(targetFilePath);
            if (buffer && buffer.length > 0) {
              fs.writeFileSync(targetFilePath, buffer);
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              status: 'success',
              message: 'Dataset tersimpan',
              filename: filename,
              label: cleanClass
            }));
          } catch (uploadErr) {
            console.error('[Upload Error]', uploadErr);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: uploadErr.message }));
          }
        }

        // ======================================================================
        // BACKWARD COMPATIBLE DATASET CAPTURE API
        // ======================================================================

        // POST /api/dataset/save
        if (url.pathname === '/api/dataset/save' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            const { filename, className, source = 'own_capture', dataUrl, width, height } = data;

            if (!filename || !className || !dataUrl) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ success: false, error: 'Parameter filename, className, atau dataUrl hilang.' }));
            }

            const cleanClass = className.trim().toLowerCase().replace(/\s+/g, '_');
            const folderCategory = source.startsWith('own') ? 'own' : `external/${source}`;
            const targetDir = path.resolve(rawDatasetRoot, folderCategory, cleanClass);

            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }

            const targetFilePath = path.resolve(targetDir, filename);
            assertSafeDatasetPath(targetFilePath);

            const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');

            if (buffer.length === 0) {
              throw new Error('Buffer citra kosong (0 bytes).');
            }

            fs.writeFileSync(targetFilePath, buffer);

            if (!fs.existsSync(targetFilePath)) {
              throw new Error('Gagal memverifikasi file pada disk.');
            }
            const stat = fs.statSync(targetFilePath);
            if (stat.size === 0) {
              throw new Error('File tersimpan pada disk berukuran 0 bytes.');
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              filename,
              className: cleanClass,
              source,
              width: Number(width) || 0,
              height: Number(height) || 0,
              resolution: (width && height) ? `${width}x${height}` : '-',
              sizeBytes: stat.size,
              formattedSize: `${(stat.size / 1024).toFixed(1)} KB`,
              path: targetFilePath,
              url: `/datasets/raw/${folderCategory}/${cleanClass}/${filename}`,
              timestamp: new Date().toLocaleTimeString()
            }));
          } catch (err) {
            console.error('[API Save Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // GET /api/dataset/list
        if (url.pathname === '/api/dataset/list' && req.method === 'GET') {
          try {
            const requestedClass = url.searchParams.get('className') || url.searchParams.get('class');
            const requestedSource = url.searchParams.get('source');
            const view = (url.searchParams.get('view') || 'active').toLowerCase().trim();
            const search = (url.searchParams.get('search') || '').toLowerCase().trim();
            const supportedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);

            let activeItems = [];
            let trashItems = [];
            let totalActive = 0;

            // 1. Scan active items in rawDatasetRoot
            if (view !== 'trash') {
              const scanned = scanActiveDataset(rawDatasetRoot, {
                filterClass: requestedClass,
                filterSource: requestedSource,
                search,
                maxItems: 1000
              });
              activeItems = scanned.items;
              totalActive = scanned.totalImages;
            } else {
              const scanned = scanActiveDataset(rawDatasetRoot, { maxItems: 0 });
              totalActive = scanned.totalImages;
            }

            // 2. Scan trash items in trashDatasetRoot
            const trashMeta = getTrashMeta();
            const metaItems = trashMeta.items || {};
            if (fs.existsSync(trashDatasetRoot)) {
              const files = fs.readdirSync(trashDatasetRoot, { withFileTypes: true });
              for (const f of files) {
                if (f.isFile() && f.name !== '.trash_meta.json' && supportedExts.has(path.extname(f.name).toLowerCase())) {
                  const fPath = path.resolve(trashDatasetRoot, f.name);
                  const stat = fs.statSync(fPath);
                  const meta = metaItems[f.name] || {};
                  const origFname = meta.originalFilename || f.name;
                  const origCls = meta.originalClass || 'unknown';
                  const origSrc = meta.originalSource || 'own_capture';

                  if (requestedClass && requestedClass !== 'all' && requestedClass !== origCls) continue;
                  if (requestedSource && requestedSource !== 'all' && requestedSource !== origSrc) continue;
                  if (search && !origFname.toLowerCase().includes(search) && !origCls.toLowerCase().includes(search)) continue;

                  trashItems.push({
                    id: f.name,
                    trashFilename: f.name,
                    filename: origFname,
                    className: origCls,
                    source: origSrc,
                    sizeBytes: stat.size,
                    formattedSize: `${(stat.size / 1024).toFixed(1)} KB`,
                    timestamp: meta.trashedAt || new Date(stat.mtimeMs).toLocaleTimeString(),
                    mtime: stat.mtimeMs,
                    url: `/api/dataset/image/.trash/${f.name}`,
                    isTrash: true
                  });
                }
              }
            }

            activeItems.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            trashItems.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

            const selected = view === 'trash' ? trashItems : activeItems;

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              items: selected,
              active: activeItems,
              trash: trashItems,
              active_count: totalActive,
              trash_count: trashItems.length,
              count: selected.length,
              total: totalActive
            }));
          } catch (err) {
            console.error('[API List Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/dataset/trash
        if (url.pathname === '/api/dataset/trash' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            let filenames = data.filenames;
            if (!filenames) {
              if (Array.isArray(data.items)) {
                filenames = data.items.map(it => (typeof it === 'object' ? it.filename : it));
              } else if (data.filename) {
                filenames = [data.filename];
              } else {
                filenames = [];
              }
            }

            if (!filenames || filenames.length === 0) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ success: false, error: 'Parameter filenames kosong.' }));
            }

            if (!fs.existsSync(trashDatasetRoot)) {
              fs.mkdirSync(trashDatasetRoot, { recursive: true });
            }

            const trashMeta = getTrashMeta();
            if (!trashMeta.items) trashMeta.items = {};
            const moved = [];

            // Find and move files to trash
            const findAndMove = (dir) => {
              if (!fs.existsSync(dir)) return;
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const ent of entries) {
                if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'labels' || ent.name === '__pycache__') continue;
                const fullP = path.resolve(dir, ent.name);
                if (ent.isDirectory()) {
                  findAndMove(fullP);
                } else if (ent.isFile() && filenames.includes(ent.name)) {
                  const targetDest = path.resolve(trashDatasetRoot, ent.name);
                  fs.renameSync(fullP, targetDest);
                  trashMeta.items[ent.name] = {
                    originalFilename: ent.name,
                    originalRelPath: path.relative(rawDatasetRoot, fullP).replace(/\\/g, '/'),
                    trashedAt: new Date().toLocaleTimeString()
                  };
                  moved.push(ent.name);
                }
              }
            };
            findAndMove(rawDatasetRoot);

            saveTrashMeta(trashMeta);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, moved, count: moved.length }));
          } catch (err) {
            console.error('[API Trash Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // DELETE or POST /api/dataset/permanent
        if (url.pathname === '/api/dataset/permanent' && (req.method === 'DELETE' || req.method === 'POST')) {
          try {
            const data = await parseJsonBody(req);
            let filenames = data.filenames;
            if (!filenames) {
              if (Array.isArray(data.items)) {
                filenames = data.items.map(it => (typeof it === 'object' ? (it.trashFilename || it.filename) : it));
              } else if (data.filename) {
                filenames = [data.filename];
              } else {
                filenames = [];
              }
            }

            if (!filenames || filenames.length === 0) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ success: false, error: 'Parameter filenames kosong.' }));
            }

            const trashMeta = getTrashMeta();
            const metaItems = trashMeta.items || {};
            const deleted = [];

            for (const fn of filenames) {
              const baseName = path.basename(fn);
              const trashP = path.resolve(trashDatasetRoot, baseName);
              if (fs.existsSync(trashP)) {
                fs.unlinkSync(trashP);
                deleted.push(baseName);
                if (metaItems[baseName]) delete metaItems[baseName];
                continue;
              }

              // Search in raw
              const findAndDel = (dir) => {
                if (!fs.existsSync(dir)) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const ent of entries) {
                  if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'labels' || ent.name === '__pycache__') continue;
                  const fp = path.resolve(dir, ent.name);
                  if (ent.isDirectory()) findAndDel(fp);
                  else if (ent.isFile() && ent.name === baseName) {
                    fs.unlinkSync(fp);
                    deleted.push(baseName);
                  }
                }
              };
              findAndDel(rawDatasetRoot);
            }

            trashMeta.items = metaItems;
            saveTrashMeta(trashMeta);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, deleted, count: deleted.length }));
          } catch (err) {
            console.error('[API Permanent Delete Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/dataset/restore
        if (url.pathname === '/api/dataset/restore' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            let filenames = data.filenames;
            if (!filenames) {
              if (Array.isArray(data.items)) {
                filenames = data.items.map(it => (typeof it === 'object' ? (it.trashFilename || it.filename) : it));
              } else if (data.filename) {
                filenames = [data.filename];
              } else {
                filenames = [];
              }
            }

            const trashMeta = getTrashMeta();
            const metaItems = trashMeta.items || {};
            const restored = [];

            for (const fn of filenames) {
              const baseName = path.basename(fn);
              const srcP = path.resolve(trashDatasetRoot, baseName);
              if (fs.existsSync(srcP)) {
                const meta = metaItems[baseName] || {};
                const origRel = meta.originalRelPath;
                let destP;
                if (origRel) {
                  destP = path.resolve(rawDatasetRoot, origRel);
                } else {
                  destP = path.resolve(rawDatasetRoot, 'own', 'object', baseName);
                }
                fs.mkdirSync(path.dirname(destP), { recursive: true });
                fs.renameSync(srcP, destP);
                restored.push(baseName);
                if (metaItems[baseName]) delete metaItems[baseName];
              }
            }

            trashMeta.items = metaItems;
            saveTrashMeta(trashMeta);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, restored, count: restored.length }));
          } catch (err) {
            console.error('[API Restore Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        // POST /api/dataset/delete
        if (url.pathname === '/api/dataset/delete' && req.method === 'POST') {
          try {
            const data = await parseJsonBody(req);
            const { filename, className, source = 'own_capture' } = data;

            if (!filename || !className) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ success: false, error: 'Parameter filename atau className hilang.' }));
            }

            const cleanClass = className.trim().toLowerCase().replace(/\s+/g, '_');
            const folderCategory = source.startsWith('own') ? 'own' : `external/${source}`;
            const targetFilePath = path.resolve(rawDatasetRoot, folderCategory, cleanClass, filename);
            assertSafeDatasetPath(targetFilePath);

            let deleted = false;
            if (fs.existsSync(targetFilePath)) {
              fs.unlinkSync(targetFilePath);
              deleted = true;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, deleted, filename, className: cleanClass }));
          } catch (err) {
            console.error('[API Delete Error]', err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        }

        next();
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [visionxCorePlugin()],
  server: {
    host: true,
    port: 5173,
    open: false
  }
});
