// Local dev server for botchedwaffle.com static site
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3002;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain',
};

http.createServer((req, res) => {
  const filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving http://localhost:${PORT}`));
