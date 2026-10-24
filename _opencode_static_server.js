/* Throwaway static server for local load-testing of the game
   (serve.js above has a hardcoded ROOT from another machine). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 18211;
const ROOT = __dirname;
const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
  '.glb':'model/gltf-binary','.gltf':'model/gltf+json',
  '.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav',
  '.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.bin':'application/octet-stream'
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if(urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const fp = path.join(ROOT, urlPath);
  if(!fp.startsWith(ROOT)){ res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(fp, (err, stat) => {
    if(err || !stat.isFile()){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    fs.createReadStream(fp).pipe(res);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('OK ' + PORT));
