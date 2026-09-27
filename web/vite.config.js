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

function visionxCorePlugin() {
  return {
    name: 'visionx-core-api',
    configureServer(server) {
      // 1. Static file serving untuk /datasets/*
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/datasets/')) {
          try {
            const rawUrl = req.url.split('?')[0];
            const relativePath = decodeURIComponent(rawUrl.replace('/datasets/', ''));
            const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
            const fullPath = path.resolve(datasetsRoot, safePath);

            assertSafeDatasetPath(fullPath);

            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
              const ext = path.extname(fullPath).toLowerCase();
              const mimeTypes = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.webp': 'image/webp',
                '.json': 'application/json'
              };
              res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
              res.setHeader('Cache-Control', 'no-cache');
              return fs.createReadStream(fullPath).pipe(res);
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
            const view = url.searchParams.get('view') || 'active'; // 'active' | 'trash'
            const classFilter = url.searchParams.get('class');
            const sourceFilter = url.searchParams.get('source');
            const search = (url.searchParams.get('search') || '').toLowerCase().trim();
            const supportedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
            const items = [];

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
            } else {
              // Baca Active Dataset
              const scanCategory = (catDir, sourceName) => {
                if (!fs.existsSync(catDir)) return;
                const classDirs = fs.readdirSync(catDir, { withFileTypes: true });
                for (const cd of classDirs) {
                  if (cd.isDirectory()) {
                    const cls = cd.name;
                    const dirPath = path.resolve(catDir, cls);
                    const files = fs.readdirSync(dirPath, { withFileTypes: true });
                    for (const f of files) {
                      if (f.isFile() && supportedExts.has(path.extname(f.name).toLowerCase())) {
                        const filePath = path.resolve(dirPath, f.name);
                        const stat = fs.statSync(filePath);
                        items.push({
                          id: f.name,
                          filename: f.name,
                          className: cls,
                          source: sourceName,
                          sizeBytes: stat.size,
                          formattedSize: `${(stat.size / 1024).toFixed(1)} KB`,
                          timestamp: new Date(stat.mtimeMs).toLocaleString(),
                          mtime: stat.mtimeMs,
                          url: `/datasets/raw/${sourceName.startsWith('own') ? 'own' : 'external'}/${cls}/${f.name}`,
                          isTrash: false
                        });
                      }
                    }
                  }
                }
              };

              scanCategory(path.resolve(rawDatasetRoot, 'own'), 'own_capture');
              scanCategory(path.resolve(rawDatasetRoot, 'external'), 'external');
            }

            // Terapkan filter
            let filtered = items;
            if (classFilter && classFilter !== 'all') {
              filtered = filtered.filter(it => it.className === classFilter);
            }
            if (sourceFilter && sourceFilter !== 'all') {
              filtered = filtered.filter(it => it.source === sourceFilter);
            }
            if (search) {
              filtered = filtered.filter(it =>
                it.filename.toLowerCase().includes(search) ||
                it.className.toLowerCase().includes(search)
              );
            }

            filtered.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, items: filtered, total: filtered.length }));
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
            let totalImages = 0;
            let totalSizeBytes = 0;
            const classCounts = {};
            const sourceCounts = {};
            const supportedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);

            const scanStats = (catDir, sourceName) => {
              if (!fs.existsSync(catDir)) return;
              const classDirs = fs.readdirSync(catDir, { withFileTypes: true });
              for (const cd of classDirs) {
                if (cd.isDirectory()) {
                  const cls = cd.name;
                  const dirPath = path.resolve(catDir, cls);
                  const files = fs.readdirSync(dirPath, { withFileTypes: true });
                  for (const f of files) {
                    if (f.isFile() && supportedExts.has(path.extname(f.name).toLowerCase())) {
                      const stat = fs.statSync(path.resolve(dirPath, f.name));
                      totalImages++;
                      totalSizeBytes += stat.size;
                      classCounts[cls] = (classCounts[cls] || 0) + 1;
                      sourceCounts[sourceName] = (sourceCounts[sourceName] || 0) + 1;
                    }
                  }
                }
              }
            };

            scanStats(path.resolve(rawDatasetRoot, 'own'), 'own_capture');
            scanStats(path.resolve(rawDatasetRoot, 'external'), 'external');

            // Hitung Recycle Bin
            let trashCount = 0;
            if (fs.existsSync(trashDatasetRoot)) {
              trashCount = fs.readdirSync(trashDatasetRoot).filter(f => f !== '.trash_meta.json').length;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
              success: true,
              totalImages,
              totalSizeBytes,
              formattedTotalSize: `${(totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`,
              classesCount: Object.keys(classCounts).length,
              classCounts,
              sourceCounts,
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
            const requestedClass = url.searchParams.get('className');
            const items = [];
            const supportedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);

            const ownDir = path.resolve(rawDatasetRoot, 'own');
            if (fs.existsSync(ownDir)) {
              const classFolders = fs.readdirSync(ownDir, { withFileTypes: true });
              for (const dirent of classFolders) {
                if (dirent.isDirectory()) {
                  const cls = dirent.name;
                  if (requestedClass && requestedClass !== cls) continue;

                  const classDirPath = path.resolve(ownDir, cls);
                  const files = fs.readdirSync(classDirPath, { withFileTypes: true });
                  for (const f of files) {
                    if (f.isFile() && supportedExts.has(path.extname(f.name).toLowerCase())) {
                      const filePath = path.resolve(classDirPath, f.name);
                      const stat = fs.statSync(filePath);
                      items.push({
                        filename: f.name,
                        className: cls,
                        source: 'own_capture',
                        sizeBytes: stat.size,
                        formattedSize: `${(stat.size / 1024).toFixed(1)} KB`,
                        timestamp: new Date(stat.mtimeMs).toLocaleTimeString(),
                        mtime: stat.mtimeMs,
                        url: `/datasets/raw/own/${cls}/${f.name}`
                      });
                    }
                  }
                }
              }
            }

            items.sort((a, b) => b.mtime - a.mtime);

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, items }));
          } catch (err) {
            console.error('[API List Error]', err);
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
  plugins: [visionxCorePlugin()],
  server: {
    host: true,
    port: 5173,
    open: false
  }
});
