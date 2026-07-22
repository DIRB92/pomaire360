const { put } = require('@vercel/blob');
const { getRedis, getClientIp, checkRateLimit } = require('./_utils');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 4 * 1024 * 1024;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
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

    const ext = contentType.split('/')[1] === 'jpeg' ? 'jpg' : contentType.split('/')[1];
    const fileName = `pomaire_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const blob = await put(fileName, buffer, { access: 'public', contentType, token: process.env.BLOB_READ_WRITE_TOKEN });
    return res.status(200).json({ url: blob.url });
  } catch (e) {
    return res.status(e.message.includes('Máximo') ? 400 : 500).json({ error: e.message || 'Error al subir.' });
  }
};
