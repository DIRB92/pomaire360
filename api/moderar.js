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
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, PUT, OPTIONS');
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

  if (req.method === 'PUT') {
    try {
      const { cleanString, isSafeUrl } = require('./_utils');
      const CATEGORIAS = ['Artesanía en greda','Comida y cocinería','Hospedaje','Turismo y paseos','Otro'];
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const id = body.id;
      if (!id) return res.status(400).json({ error: 'Se requiere el id.' });

      const existing = await redis.get(`negocio:${id}`);
      if (!existing) return res.status(404).json({ error: 'No encontrado.' });
      const negocio = typeof existing === 'string' ? JSON.parse(existing) : existing;

      if (body.nombre !== undefined) negocio.nombre = cleanString(body.nombre, 60) || negocio.nombre;
      if (body.categoria !== undefined && CATEGORIAS.includes(body.categoria)) negocio.categoria = body.categoria;
      if (body.descripcion !== undefined) negocio.descripcion = cleanString(body.descripcion, 300) || negocio.descripcion;
      if (body.contacto !== undefined) negocio.contacto = cleanString(body.contacto, 80) || negocio.contacto;
      if (body.autor !== undefined) negocio.autor = cleanString(body.autor, 40) || negocio.autor;
      if (body.imagen !== undefined) {
        const img = cleanString(body.imagen, 500);
        negocio.imagen = isSafeUrl(img) ? img : '';
      }
      negocio.editado = Date.now();

      await redis.set(`negocio:${id}`, JSON.stringify(negocio));
      return res.status(200).json({ negocio });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo editar.' });
    }
  }

  res.setHeader('Allow', 'GET, DELETE, PUT, OPTIONS');
  return res.status(405).json({ error: 'Método no permitido' });
};
