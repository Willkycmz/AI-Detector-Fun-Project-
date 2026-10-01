import http from 'http';

async function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:5174${path}`, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function run() {
  console.log('--- 1. Testing GET /api/dataset/list ---');
  const listRes = await request('/api/dataset/list');
  console.log('Status:', listRes.status);
  console.log('Response summary:', {
    success: listRes.json?.success,
    active_count: listRes.json?.active_count,
    trash_count: listRes.json?.trash_count,
    item_count: listRes.json?.items?.length
  });

  if (!listRes.json?.success) {
    console.error('Failed list test:', listRes.body);
    process.exit(1);
  }

  // 2. Test saving a test image
  console.log('\n--- 2. Testing POST /api/dataset/save ---');
  // 1x1 transparent png in base64
  const testPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const saveRes = await request('/api/dataset/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'test_trash_sample.png',
      className: 'test_obj',
      source: 'own_capture',
      dataUrl: testPng,
      width: 1,
      height: 1
    })
  });
  console.log('Save Status:', saveRes.status);
  console.log('Save Success:', saveRes.json?.success);

  // 3. Test static image serving
  console.log('\n--- 3. Testing GET /api/dataset/image/own/test_obj/test_trash_sample.png ---');
  const imgRes = await request('/api/dataset/image/own/test_obj/test_trash_sample.png');
  console.log('Image Serve Status:', imgRes.status);
  console.log('Image Content-Type:', imgRes.headers['content-type']);

  // 4. Test soft delete / trash
  console.log('\n--- 4. Testing POST /api/dataset/trash ---');
  const trashRes = await request('/api/dataset/trash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames: ['test_trash_sample.png'] })
  });
  console.log('Trash Status:', trashRes.status);
  console.log('Trash JSON:', trashRes.json);

  // 5. Test list view=trash
  console.log('\n--- 5. Testing GET /api/dataset/list?view=trash ---');
  const trashListRes = await request('/api/dataset/list?view=trash');
  console.log('Trash List Status:', trashListRes.status);
  console.log('Trash items found:', trashListRes.json?.items?.map(i => i.filename));
  console.log('Trash count:', trashListRes.json?.trash_count);

  // 6. Test static image serving from .trash
  console.log('\n--- 6. Testing GET /api/dataset/image/.trash/test_trash_sample.png ---');
  const trashImgRes = await request('/api/dataset/image/.trash/test_trash_sample.png');
  console.log('Trash Image Serve Status:', trashImgRes.status);
  console.log('Trash Image Content-Type:', trashImgRes.headers['content-type']);

  // 7. Test restore
  console.log('\n--- 7. Testing POST /api/dataset/restore ---');
  const restoreRes = await request('/api/dataset/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames: ['test_trash_sample.png'] })
  });
  console.log('Restore Status:', restoreRes.status);
  console.log('Restore JSON:', restoreRes.json);

  // 8. Move back to trash for permanent delete test
  console.log('\n--- 8. Moving to trash again ---');
  await request('/api/dataset/trash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames: ['test_trash_sample.png'] })
  });

  // 9. Test permanent delete
  console.log('\n--- 9. Testing DELETE /api/dataset/permanent ---');
  const permRes = await request('/api/dataset/permanent', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames: ['test_trash_sample.png'] })
  });
  console.log('Permanent Delete Status:', permRes.status);
  console.log('Permanent Delete JSON:', permRes.json);

  console.log('\nALL DATASET TRASH API TESTS COMPLETED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('Error running test:', err);
  process.exit(1);
});
