// Endpoint de moderación, protegido con un token de administrador.
//
// GET    /api/moderar            -> lista TODOS los negocios y mensajes (para el panel admin.html)
// DELETE /api/moderar?tipo=negocio&id=<id>   -> elimina un emprendimiento
// DELETE /api/moderar?tipo=mensaje&id=<id>   -> elimina un mensaje del chat
//
// Requiere el header "x-admin-token" con el valor de la variable de entorno
// ADMIN_TOKEN configurada en Vercel. Sin esa variable configurada, el acceso
// queda deshabilitado (falla cerrado).
const {
  getRedis,
  getClientIp,
  checkRateLimit,
  parseMaybeJson,
  checkAdminToken,
  deleteNegocio,
  deleteMensaje,
} = require('./_utils');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let redis;
  try {
    redis = getRedis();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Límite de intentos por IP para dificultar la fuerza bruta del token,
  // independientemente de si el token resulta válido o no.
  try {
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(redis, `ratelimit:moderar:${ip}`, 30, 60);
    if (!allowed) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera un momento.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo verificar el límite de intentos.' });
  }

  if (!checkAdminToken(req)) {
    return res.status(401).json({ error: 'Token de administrador inválido o no configurado.' });
  }

  if (req.method === 'GET') {
    try {
      const [negocioIds, mensajeIds] = await Promise.all([
        redis.zrange('negocios:index', 0, -1, { rev: true }),
        redis.zrange('mensajes:index', 0, -1, { rev: true }),
      ]);

      const [negocioItems, mensajeItems] = await Promise.all([
        Promise.all(negocioIds.map((id) => redis.get(`negocio:${id}`))),
        Promise.all(mensajeIds.map((id) => redis.get(`mensaje:${id}`))),
      ]);

      const negocios = negocioItems.map(parseMaybeJson).filter(Boolean);
      const mensajes = mensajeItems.map(parseMaybeJson).filter(Boolean);

      return res.status(200).json({ negocios, mensajes });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo cargar el contenido para moderar.' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const tipo = req.query.tipo;
      const id = req.query.id;
      if (!id || (tipo !== 'negocio' && tipo !== 'mensaje')) {
        return res.status(400).json({ error: 'Parámetros inválidos: se requiere tipo (negocio|mensaje) e id.' });
      }

      if (tipo === 'negocio') {
        await deleteNegocio(redis, id);
      } else {
        await deleteMensaje(redis, id);
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo eliminar el elemento.' });
    }
  }

  res.setHeader('Allow', 'GET, DELETE, OPTIONS');
  return res.status(405).json({ error: 'Método no permitido' });
};
