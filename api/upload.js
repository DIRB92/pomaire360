// POST /api/upload — Sube una imagen a Vercel Blob Storage y devuelve la URL pública.
// Acepta multipart/form-data con un campo "file" (imagen).
// Límites: max 4MB, solo JPEG/PNG/WebP/GIF.
const { put } = require('@vercel/blob');
const { getRedis, getClientIp, checkRateLimit } = require('./_utils');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 4 * 1024 * 1024; // 4 MB

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Verificar que BLOB_READ_WRITE_TOKEN está configurado
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Almacenamiento de imágenes no configurado. Contacta al administrador.' });
  }

  // Rate limit: 10 imágenes por IP por hora
  let redis;
  try {
    redis = getRedis();
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(redis, `ratelimit:upload:${ip}`, 10, 3600);
    if (!allowed) {
      return res.status(429).json({ error: 'Demasiadas subidas. Intenta de nuevo más tarde.' });
    }
  } catch (e) {
    // Si Redis falla, permitimos la subida igualmente (no bloquear por falla de rate limit)
  }

  try {
    // Vercel Edge/Serverless: leer el body como buffer
    const contentType = req.headers['content-type'] || '';

    // Soporta tanto multipart como envío directo del binario con header x-file-name
    if (contentType.startsWith('application/octet-stream') || contentType.startsWith('image/')) {
      // Envío directo del binario (fetch con body: file, content-type: image/*)
      const fileType = contentType.split(';')[0].trim();

      if (!ALLOWED_TYPES.includes(fileType)) {
        return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo JPEG, PNG, WebP o GIF.' });
      }

      const chunks = [];
      let totalSize = 0;

      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_SIZE) {
            reject(new Error('Imagen muy pesada. Máximo 4 MB.'));
          }
          chunks.push(chunk);
        });
        req.on('end', resolve);
        req.on('error', reject);
      });

      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        return res.status(400).json({ error: 'No se recibió ningún archivo.' });
      }

      // Generar nombre único
      const ext = fileType.split('/')[1] === 'jpeg' ? 'jpg' : fileType.split('/')[1];
      const fileName = `pomaire_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

      const blob = await put(fileName, buffer, {
        access: 'public',
        contentType: fileType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });

      return res.status(200).json({ url: blob.url });
    }

    return res.status(400).json({ error: 'Envía la imagen con Content-Type image/* y el archivo como body.' });
  } catch (e) {
    const msg = e.message || 'Error al subir la imagen.';
    if (msg.includes('Máximo') || msg.includes('pesada')) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'Error al subir la imagen. Intenta de nuevo.' });
  }
};
