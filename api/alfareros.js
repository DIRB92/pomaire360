// GET  /api/alfareros   -> lista las biografías de alfareros PUBLICADAS (aprobadas por moderación)
// POST /api/alfareros   -> envía una nueva biografía; queda PENDIENTE hasta que un admin la apruebe
//
// Las biografías las suben los propios pomaireinos (o vecinos que quieran homenajear a un
// alfarero). Para evitar spam/contenido inapropiado en un contenido tan visible, las nuevas
// biografías NO se muestran de inmediato: entran a `alfareros:pendientes` y solo pasan a
// `alfareros:index` cuando un moderador las aprueba desde /api/moderar (admin.html).
const {
  getRedis,
  getClientIp,
  cleanString,
  isSafeUrl,
  checkRateLimit,
  parseMaybeJson,
  addMessage,
  applyCors,
  verifyOrigin,
} = require('./_utils');

module.exports = async (req, res) => {
  // CORS restrictivo — solo orígenes de pomaire360.cl
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let redis;
  try {
    redis = getRedis();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (req.method === 'GET') {
    try {
      // Rate limiting en GET para prevenir scraping masivo.
      const ip = getClientIp(req);
      const allowed = await checkRateLimit(redis, `ratelimit:alfareros-get:${ip}`, 60, 60);
      if (!allowed) {
        return res.status(429).json({ error: 'Demasiadas consultas. Intenta de nuevo en un momento.' });
      }

      // Solo se devuelven las biografías ya aprobadas (índice `alfareros:index`).
      const ids = await redis.zrange('alfareros:index', 0, -1, { rev: true });
      if (!ids.length) return res.status(200).json({ alfareros: [] });

      // MGET: una sola llamada a Redis en vez de N gets individuales (evita N+1).
      const items = await redis.mget(ids.map((id) => `alfarero:${id}`));
      const alfareros = items.map(parseMaybeJson).filter(Boolean);
      return res.status(200).json({ alfareros });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudieron cargar las biografías de alfareros.' });
    }
  }

  if (req.method === 'POST') {
    // Verificar origin para prevenir CSRF
    if (!verifyOrigin(req)) {
      return res.status(403).json({ error: 'Origen no autorizado.' });
    }

    try {
      const ip = getClientIp(req);
      const allowed = await checkRateLimit(redis, `ratelimit:alfareros:${ip}`, 4, 3600);
      if (!allowed) {
        return res.status(429).json({ error: 'Demasiados envíos. Intenta de nuevo más tarde.' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const nombre = cleanString(body.nombre, 60);
      const oficio = cleanString(body.oficio, 80);
      const biografia = cleanString(body.biografia, 2000);
      const experiencia = cleanString(body.experiencia, 40);
      const contacto = cleanString(body.contacto, 80);
      const fotoRaw = cleanString(body.foto, 500);
      const foto = isSafeUrl(fotoRaw) ? fotoRaw : '';
      const autor = cleanString(body.autor, 40) || 'Anónimo';

      if (!nombre || !biografia) {
        return res.status(400).json({ error: 'Completa al menos el nombre del alfarero y su biografía.' });
      }
      if (biografia.length < 40) {
        return res.status(400).json({ error: 'La biografía es muy corta. Cuéntanos un poco más (mínimo 40 caracteres).' });
      }

      const id = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const creado = Date.now();
      const nuevo = {
        id,
        nombre,
        oficio,
        biografia,
        experiencia,
        contacto,
        foto,
        autor,
        creado,
        estado: 'pendiente',
      };

      await redis.set(`alfarero:${id}`, JSON.stringify(nuevo));
      // Entra a la cola de pendientes; NO se publica hasta que un moderador la apruebe.
      await redis.zadd('alfareros:pendientes', { score: creado, member: id });

      // Aviso al chat comunitario para que la comunidad sepa que llegó una biografía nueva
      // (queda en revisión). No revela contenido que aún no fue moderado.
      await addMessage(redis, {
        autor: 'Pomaire',
        texto: `📖 Nueva biografía de alfarero enviada por ${autor} — en revisión antes de publicarse.`,
        system: true,
      });

      return res.status(201).json({
        ok: true,
        mensaje: 'Tu biografía fue enviada y quedará publicada una vez revisada por el equipo de Pomaire.',
      });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo enviar la biografía.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Método no permitido' });
};
