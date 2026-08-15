const { put } = require('@vercel/blob');
const { getRedis, getClientIp, checkRateLimit, applyCors, verifyOrigin } = require('./_utils');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 4 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Validación de Magic Bytes — verifica que el contenido real sea una imagen
// y no un archivo malicioso disfrazado (HTML, SVG con JS, ejecutable, etc.)
// ─────────────────────────────────────────────────────────────────────────────
const MAGIC_BYTES = {
  'image/jpeg': [
    { offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  ],
  'image/png': [
    { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  ],
  'image/gif': [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  ],
  'image/webp': [
    // RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], extraCheck: (buf) => buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 },
  ],
};

/**
 * Verifica que los primeros bytes del buffer coincidan con la firma
 * esperada para el tipo de imagen declarado.
 * Retorna true si el archivo es legítimo, false si es sospechoso.
 */
function verifyMagicBytes(buffer, declaredType) {
  const signatures = MAGIC_BYTES[declaredType];
  if (!signatures) return false;
  if (buffer.length < 12) return false; // Archivo demasiado pequeño para ser imagen válida

  return signatures.some((sig) => {
    // Verificar bytes principales
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
    }
    // Verificación adicional (ej: WEBP tiene firma dividida)
    if (sig.extraCheck && !sig.extraCheck(buffer)) return false;
    return true;
  });
}

module.exports = async (req, res) => {
  // CORS restrictivo — solo orígenes de pomaire360.cl
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Verificar origin para prevenir CSRF
  if (!verifyOrigin(req)) {
    return res.status(403).json({ error: 'Origen no autorizado.' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: 'Almacenamiento no configurado.' });

  try {
    const redis = getRedis();
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(redis, `ratelimit:upload:${ip}`, 10, 3600);
    if (!allowed) return res.status(429).json({ error: 'Demasiadas subidas. Intenta más tarde.' });
  } catch (e) { /* allow if redis fails */ }

  try {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!ALLOWED_TYPES.includes(contentType)) return res.status(400).json({ error: 'Solo JPEG, PNG, WebP o GIF.' });

    const chunks = [];
    let totalSize = 0;
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => { totalSize += chunk.length; if (totalSize > MAX_SIZE) reject(new Error('Máximo 4 MB.')); chunks.push(chunk); });
      req.on('end', resolve);
      req.on('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    if (!buffer.length) return res.status(400).json({ error: 'No se recibió archivo.' });

    // Verificar magic bytes — el contenido real debe coincidir con el tipo declarado
    if (!verifyMagicBytes(buffer, contentType)) {
      return res.status(400).json({ error: 'El archivo no es una imagen válida o no coincide con el tipo declarado.' });
    }

    const ext = contentType.split('/')[1] === 'jpeg' ? 'jpg' : contentType.split('/')[1];
    const fileName = `pomaire_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const blob = await put(fileName, buffer, { access: 'public', contentType, token: process.env.BLOB_READ_WRITE_TOKEN });
    return res.status(200).json({ url: blob.url });
  } catch (e) {
    return res.status(e.message.includes('Máximo') ? 400 : 500).json({ error: e.message || 'Error al subir.' });
  }
};
