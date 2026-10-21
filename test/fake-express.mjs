// A tiny stand-in for the part of Express the auth module uses: app.use / app.get / app.post,
// req.headers / req.method, res.status().json(), res.setHeader(), res.statusCode, res.end().
// Real Express is exercised by test/conformance-express.mjs (needs network); this keeps the
// unit tests dependency-free and offline.
import http from 'node:http'

export function fakeExpress() {
  const middleware = []
  const routes = []
  const app = {
    routes,
    use: (fn) => middleware.push(fn),
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
  }
  const handle = (req, res) => {
    res.status = (code) => {
      res.statusCode = code
      return res
    }
    res.json = (body) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    const route = routes.find((r) => r.method === req.method && r.path === req.url.split('?')[0])
    const chain = [...middleware, ...(route ? route.handlers : [])]
    let i = 0
    const next = (err) => {
      if (err) return res.status(500).json({ detail: `error: ${err.message}` })
      const fn = chain[i++]
      if (!fn) return res.status(404).json({ detail: 'Not Found' })
      return fn(req, res, next)
    }
    next()
  }
  app.listen = () =>
    new Promise((resolve) => {
      const server = http.createServer(handle)
      server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.() }) }))
    })
  return app
}
