// GET  /api/mensajes?since=<timestamp>  -> lista mensajes del chat (opcionalmente solo los nuevos)
// POST /api/mensajes                    -> envía un mensaje al chat comunitario
const {
  getRedis,
  getClientIp,
  cleanString,
  checkRateLimit,
  parseMaybeJson,
  addMessage,
} = require('./_utils');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let redis;
  try {
    redis = getRedis();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (req.method === 'GET') {
    try {
      const ids = await redis.zrange('mensajes:index', 0, -1);
      if (!ids.length) return res.status(200).json({ mensajes: [] });

      const items = await Promise.all(ids.map((id) => redis.get(`mensaje:${id}`)));
      let mensajes = items.map(parseMaybeJson).filter(Boolean);

      const since = Number(req.query.since);
      if (!Number.isNaN(since) && since > 0) {
        mensajes = mensajes.filter((m) => m.ts > since);
      }

      return res.status(200).json({ mensajes });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo cargar el chat.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const ip = getClientIp(req);
      const allowed = await checkRateLimit(redis, `ratelimit:mensajes:${ip}`, 20, 60);
      if (!allowed) {
        return res.status(429).json({ error: 'Estás enviando mensajes muy rápido. Espera un momento.' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const autor = cleanString(body.autor, 40);
      const texto = cleanString(body.texto, 500);

      if (!autor || !texto) {
        return res.status(400).json({ error: 'Falta el nombre o el mensaje.' });
      }

      const mensaje = await addMessage(redis, { autor, texto, system: false });
      return res.status(201).json({ mensaje });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo enviar el mensaje.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Método no permitido' });
};
