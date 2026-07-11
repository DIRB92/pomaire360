// Utilidades compartidas por las funciones serverless (Vercel).
// Usa Upstash Redis como base de datos real y compartida entre todos los visitantes.
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

/**
 * Crea el cliente de Redis leyendo las variables de entorno.
 * Acepta tanto los nombres de la integración "Upstash Redis" del
 * Vercel Marketplace (KV_REST_API_URL / KV_REST_API_TOKEN) como los
 * nombres nativos de Upstash (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN),
 * para que funcione sin importar cómo se conectó la base de datos.
 */
function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'Faltan las variables de entorno de la base de datos (KV_REST_API_URL/TOKEN o UPSTASH_REDIS_REST_URL/TOKEN). ' +
      'Conecta una base de datos Upstash Redis desde Vercel > Storage.'
    );
  }

  return new Redis({ url, token });
}

/** Obtiene la IP del cliente para aplicar límites de envío (anti-spam). */
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

/** Limpia y acota un string recibido del cliente. Nunca confiar en el input. */
function cleanString(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

/** Solo permite URLs http(s) válidas; cualquier otra cosa (javascript:, data:, etc.) se descarta. */
function isSafeUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Límite simple de envíos por IP usando INCR + EXPIRE.
 * Devuelve true si la acción está permitida, false si se superó el límite.
 */
async function checkRateLimit(redis, key, limit, windowSeconds) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}

/** Upstash puede devolver el valor ya parseado (objeto) o como string JSON; normaliza a objeto. */
function parseMaybeJson(item) {
  if (typeof item === 'string') {
    try {
      return JSON.parse(item);
    } catch {
      return null;
    }
  }
  return item;
}

const MAX_MENSAJES = 300;

/**
 * Crea y guarda un mensaje de chat (usado tanto por /api/mensajes como
 * automáticamente por /api/negocios al publicarse un nuevo emprendimiento).
 */
async function addMessage(redis, { autor, texto, system = false }) {
  const id = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const ts = Date.now();
  const mensaje = { id, autor, texto, ts, system: !!system };

  await redis.set(`mensaje:${id}`, JSON.stringify(mensaje));
  await redis.zadd('mensajes:index', { score: ts, member: id });

  // Mantiene solo los últimos MAX_MENSAJES para no crecer indefinidamente.
  const total = await redis.zcard('mensajes:index');
  if (total > MAX_MENSAJES) {
    const idsToRemove = await redis.zrange('mensajes:index', 0, total - MAX_MENSAJES - 1);
    if (idsToRemove.length) {
      await redis.zrem('mensajes:index', ...idsToRemove);
      await redis.del(...idsToRemove.map((i) => `mensaje:${i}`));
    }
  }

  return mensaje;
}

/**
 * Compara dos strings en tiempo constante para evitar "timing attacks" al
 * validar el token de administrador (evita que un atacante deduzca el
 * token midiendo cuánto tarda la respuesta carácter por carácter).
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    // Aun así se compara contra sí mismo para no filtrar el largo por timing.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifica el token de administrador enviado en el header "x-admin-token".
 * Requiere la variable de entorno ADMIN_TOKEN configurada en Vercel; si no
 * está configurada, el acceso admin queda deshabilitado por completo (falla
 * cerrado, no abierto).
 */
function checkAdminToken(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers['x-admin-token'];
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/** Elimina un emprendimiento por id (documento + índice ordenado). */
async function deleteNegocio(redis, id) {
  await redis.zrem('negocios:index', id);
  await redis.del(`negocio:${id}`);
}

/** Elimina un mensaje del chat por id (documento + índice ordenado). */
async function deleteMensaje(redis, id) {
  await redis.zrem('mensajes:index', id);
  await redis.del(`mensaje:${id}`);
}

module.exports = {
  getRedis,
  getClientIp,
  cleanString,
  isSafeUrl,
  checkRateLimit,
  parseMaybeJson,
  addMessage,
  checkAdminToken,
  deleteNegocio,
  deleteMensaje,
  MAX_MENSAJES,
};
