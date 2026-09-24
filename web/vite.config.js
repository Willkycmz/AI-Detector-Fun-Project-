import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const rawDatasetRoot = path.resolve(projectRoot, 'datasets', 'raw');

function datasetApiPlugin() {
  return {
    name: 'visionx-dataset-api',
    configureServer(server) {
      // 1. Static file serving for /datasets/raw/*
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/datasets/raw/')) {
          try {
            const rawUrl = req.url.split('?')[0];
            const relativePath = decodeURIComponent(rawUrl.replace('/datasets/raw/', ''));
            const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
            const fullPath = path.resolve(rawDatasetRoot, safePath);

            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
              const ext = path.extname(fullPath).toLowerCase();
              const mimeTypes = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.webp': 'image/webp'
              };
              res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
              res.setHeader('Cache-Control', 'no-cache');
              return fs.createReadStream(fullPath).pipe(res);
            }
          } catch (e) {
            console.warn('[Dataset Static Serve Error]', e);
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
              reject(new Error('Payload too large (max 50MB)'));
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
  plugins: [datasetApiPlugin()],
  server: {
    host: true, // Mendukung akses dari HP melalui jaringan IP lokal
    port: 5173,
    open: false
  }
});
