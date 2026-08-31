// Endpoint de moderación, protegido con un token de administrador.
//
// GET    /api/moderar            -> lista TODOS los negocios, mensajes y biografías de alfareros
//                                   (pendientes + publicadas) para el panel admin.html
// POST   /api/moderar?accion=aprobar-alfarero&id=<id>  -> publica una biografía pendiente
// DELETE /api/moderar?tipo=negocio&id=<id>   -> elimina un emprendimiento
// DELETE /api/moderar?tipo=mensaje&id=<id>   -> elimina un mensaje del chat
// DELETE /api/moderar?tipo=alfarero&id=<id>  -> elimina una biografía (pendiente o publicada)
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
  deleteAlfarero,
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

  // Verificar origin en operaciones de mutación (defensa en profundidad + CSRF)
  if (['DELETE', 'PUT', 'POST'].includes(req.method) && !verifyOrigin(req)) {
    return res.status(403).json({ error: 'Origen no autorizado.' });
  }

  if (req.method === 'GET') {
    try {
      const [negocioIds, mensajeIds, alfPendIds, alfPubIds] = await Promise.all([
        redis.zrange('negocios:index', 0, -1, { rev: true }),
        redis.zrange('mensajes:index', 0, -1, { rev: true }),
        redis.zrange('alfareros:pendientes', 0, -1, { rev: true }),
        redis.zrange('alfareros:index', 0, -1, { rev: true }),
      ]);

      // MGET: una llamada por tipo en vez de N gets individuales (evita N+1).
      // mget requiere al menos una clave, así que se omite si el índice está vacío.
      const [negocioItems, mensajeItems, alfPendItems, alfPubItems] = await Promise.all([
        negocioIds.length ? redis.mget(negocioIds.map((id) => `negocio:${id}`)) : Promise.resolve([]),
        mensajeIds.length ? redis.mget(mensajeIds.map((id) => `mensaje:${id}`)) : Promise.resolve([]),
        alfPendIds.length ? redis.mget(alfPendIds.map((id) => `alfarero:${id}`)) : Promise.resolve([]),
        alfPubIds.length ? redis.mget(alfPubIds.map((id) => `alfarero:${id}`)) : Promise.resolve([]),
      ]);

      const negocios = negocioItems.map(parseMaybeJson).filter(Boolean);
      const mensajes = mensajeItems.map(parseMaybeJson).filter(Boolean);
      // Se marca el estado explícitamente por si el doc guardado no lo trae.
      const alfarerosPendientes = alfPendItems
        .map(parseMaybeJson)
        .filter(Boolean)
        .map((a) => ({ ...a, estado: 'pendiente' }));
      const alfarerosPublicados = alfPubItems
        .map(parseMaybeJson)
        .filter(Boolean)
        .map((a) => ({ ...a, estado: 'publicado' }));

      return res.status(200).json({
        negocios,
        mensajes,
        alfarerosPendientes,
        alfarerosPublicados,
      });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo cargar el contenido para moderar.' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const tipo = req.query.tipo;
      const id = req.query.id;
      const tiposValidos = ['negocio', 'mensaje', 'alfarero'];
      if (!id || !tiposValidos.includes(tipo)) {
        return res.status(400).json({ error: 'Parámetros inválidos: se requiere tipo (negocio|mensaje|alfarero) e id.' });
      }

      if (tipo === 'negocio') {
        await deleteNegocio(redis, id);
      } else if (tipo === 'alfarero') {
        await deleteAlfarero(redis, id);
      } else {
        await deleteMensaje(redis, id);
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo eliminar el elemento.' });
    }
  }

  if (req.method === 'POST') {
    // Única acción POST soportada: aprobar (publicar) una biografía de alfarero pendiente.
    try {
      const accion = req.query.accion;
      const id = req.query.id || (req.body && req.body.id);
      if (accion !== 'aprobar-alfarero' || !id) {
        return res.status(400).json({ error: 'Acción inválida. Usa accion=aprobar-alfarero&id=<id>.' });
      }

      const existing = await redis.get(`alfarero:${id}`);
      if (!existing) return res.status(404).json({ error: 'Biografía no encontrada.' });
      const alfarero = typeof existing === 'string' ? JSON.parse(existing) : existing;

      alfarero.estado = 'publicado';
      alfarero.aprobado = Date.now();

      await redis.set(`alfarero:${id}`, JSON.stringify(alfarero));
      // Se saca de la cola de pendientes y se agrega al índice público.
      await redis.zrem('alfareros:pendientes', id);
      await redis.zadd('alfareros:index', { score: alfarero.creado || Date.now(), member: id });

      // Anuncio en el chat comunitario ahora que la biografía es pública.
      await addMessage(redis, {
        autor: 'Pomaire',
        texto: `📖 Nueva biografía publicada: ${alfarero.nombre}${alfarero.oficio ? ' — ' + alfarero.oficio : ''}. ¡Conoce a nuestros alfareros!`,
        system: true,
      });

      return res.status(200).json({ ok: true, alfarero });
    } catch (e) {
      return res.status(500).json({ error: 'No se pudo aprobar la biografía.' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { cleanString, isSafeUrl } = require('./_utils');
      // v2: Usar las mismas categorías estándar que POST /api/negocios
      const CATEGORIAS = [
        'alfareria',
        'talleres',
        'restaurantes',
        'alojamiento',
        'comercio',
        'servicios',
        'estacionamientos',
        'salud',
        'seguridad',
        'banos',
        'transporte',
        'turismo',
      ];
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

  res.setHeader('Allow', 'GET, POST, DELETE, PUT, OPTIONS');
  return res.status(405).json({ error: 'Método no permitido' });
};
