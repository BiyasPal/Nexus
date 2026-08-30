import http from 'node:http';

const port = Number(process.argv[2] || 9001);

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: true, port, method: req.method, path: req.url }));
});

server.listen(port, () => {
    console.log(`echo backend listening on ${port}`);
});