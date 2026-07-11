// GET  /api/negocios         -> lista todos los emprendimientos publicados
// POST /api/negocios         -> publica un nuevo emprendimiento (validado y sanitizado en servidor)
const {
  getRedis,
  getClientIp,
  cleanString,
  isSafeUrl,
  checkRateLimit,
  parseMaybeJson,
  addMessage,
} = require('./_utils');

const CATEGORIAS_VALIDAS = [
  'Artesanía en greda',
  'Comida y cocinería',
  'Hospedaje',
  'Turismo y paseos',
  'Otro',
];

module.exports = async (req, res) => {
  // CORS básico (permite que el frontend en el mismo dominio/subdominio consuma la API sin problemas)
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
      const ids = await redis.zrange('negocios:index', 0, -1, { rev: true });
      if (!ids.length) return res.status(200).json({ negocios: [] });

      const items = await Promise.all(ids.map((id) => redis.get(`negocio:${id}`)));
      const negocios = items.map(parseMaybeJson).filter(Boolean);
      return res.status(200).json({ negocios });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo cargar la lista de emprendimientos.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const ip = getClientIp(req);
      const allowed = await checkRateLimit(redis, `ratelimit:negocios:${ip}`, 5, 3600);
      if (!allowed) {
        return res.status(429).json({ error: 'Demasiadas publicaciones. Intenta de nuevo más tarde.' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const nombre = cleanString(body.nombre, 60);
      const categoria = CATEGORIAS_VALIDAS.includes(body.categoria) ? body.categoria : 'Otro';
      const descripcion = cleanString(body.descripcion, 300);
      const contacto = cleanString(body.contacto, 80);
      const imagenRaw = cleanString(body.imagen, 500);
      const imagen = isSafeUrl(imagenRaw) ? imagenRaw : '';
      const autor = cleanString(body.autor, 40) || 'Anónimo';

      if (!nombre || !descripcion || !contacto) {
        return res.status(400).json({ error: 'Completa nombre, descripción y contacto.' });
      }

      const id = 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const creado = Date.now();
      const nuevo = { id, nombre, categoria, descripcion, contacto, imagen, autor, creado };

      await redis.set(`negocio:${id}`, JSON.stringify(nuevo));
      await redis.zadd('negocios:index', { score: creado, member: id });

      // Anuncio automático en el chat comunitario.
      await addMessage(redis, {
        autor: 'Pomaire',
        texto: `📢 Nuevo emprendimiento: "${nombre}" (${categoria}) — publicado por ${autor}`,
        system: true,
      });

      return res.status(201).json({ negocio: nuevo });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo publicar el emprendimiento.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Método no permitido' });
};
