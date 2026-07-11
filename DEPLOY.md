# Desplegar comprayvende.pomaire360.cl (Vercel + Cloudflare)

Esta app es un sitio estático (`index.html`) + 2 funciones serverless (`api/negocios.js`,
`api/mensajes.js`) que usan una base de datos real (Upstash Redis) para que el directorio
de emprendimientos y el chat sean compartidos por **todos** los visitantes, no solo por
navegador.

## 1. Crear el proyecto en Vercel

1. En [vercel.com](https://vercel.com), **Add New > Project**.
2. Importa el repositorio `DIRB92/pomaire360`.
3. Framework Preset: **Other** (es HTML estático + funciones serverless, no necesita build).
4. Deja Build Command y Output Directory vacíos. Click **Deploy**.

## 2. Conectar la base de datos (Upstash Redis)

Vercel KV fue descontinuado (dic. 2024); el reemplazo oficial es la integración
**Upstash Redis** del Marketplace, que provee la misma experiencia (base de datos
serverless tipo Redis) con conexión de 1 clic.

1. En el proyecto de Vercel: pestaña **Storage** → **Create Database** → elige **Upstash Redis** (Marketplace).
2. Sigue el flujo: crea la base de datos y **conéctala al proyecto**.
3. Esto agrega automáticamente las variables de entorno `KV_REST_API_URL` y
   `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`,
   ambos nombres funcionan con este código, ver `api/_utils.js`).
4. Vuelve a **Deployments** y haz **Redeploy** para que las funciones tomen las nuevas variables.

Puedes verificar que funciona visitando `https://<tu-proyecto>.vercel.app/api/negocios`
en el navegador: debe responder `{"negocios":[]}` (JSON), no un error 500.

## 3. Agregar el subdominio en Vercel

1. En el proyecto: **Settings > Domains** → agrega `comprayvende.pomaire360.cl`.
2. Vercel te mostrará el registro DNS a crear. Para un subdominio, normalmente es:
   - Tipo: `CNAME`
   - Nombre: `comprayvende`
   - Valor: `cname.vercel-dns.com`

## 4. Configurar el DNS en Cloudflare

1. Entra al panel de Cloudflare, selecciona la zona `pomaire360.cl`.
2. **DNS > Records > Add record**:
   - Type: `CNAME`
   - Name: `comprayvende`
   - Target: `cname.vercel-dns.com`
   - Proxy status: puedes dejarlo **Proxied (naranja)**. Vercel emite su propio
     certificado SSL igual y Cloudflare puede proxyar CNAMEs de subdominios sin
     problema (a diferencia del apex/root, que requiere "CNAME flattening").
     Si ves errores de certificado o loops de redirección, cambia el registro a
     **DNS only (gris)** como paso de diagnóstico. Fuente: [Cloudflare – Proxy status](https://developers.cloudflare.com/dns/proxy-status/), [Vercel – Using Cloudflare with Vercel](https://vercel.com/guides/using-cloudflare-with-vercel).
3. Guarda. La propagación suele tomar minutos, a veces hasta un par de horas.
4. Vuelve a Vercel (**Settings > Domains**) y confirma que el dominio queda marcado
   como **Valid Configuration**.

## 5. Habilitar el panel de moderación (admin.html)

La app incluye un panel de moderación en `/admin.html` para borrar publicaciones
o mensajes inapropiados sin tener que entrar manualmente a la consola de Upstash.

1. Genera un token secreto largo y aleatorio, por ejemplo ejecutando en tu máquina:
   ```bash
   openssl rand -hex 32
   ```
2. En Vercel: **Settings > Environment Variables** → agrega `ADMIN_TOKEN` con ese valor
   (marca los 3 entornos: Production, Preview, Development).
3. Haz **Redeploy** para que la función `api/moderar.js` tome la variable nueva.
4. Entra a `https://comprayvende.pomaire360.cl/admin.html`, ingresa el token y podrás
   ver y borrar emprendimientos y mensajes.

Notas de seguridad de este panel:
- Sin `ADMIN_TOKEN` configurado, el endpoint `/api/moderar` responde `401` siempre
  (falla cerrado, no abierto).
- El token se guarda solo en `sessionStorage` del navegador (se borra al cerrar la
  pestaña), nunca en la URL ni en `localStorage`.
- `/api/moderar` tiene su propio límite de intentos por IP (30 solicitudes/minuto)
  para dificultar ataques de fuerza bruta contra el token.
- Guarda el token en un gestor de contraseñas; cualquiera que lo tenga puede borrar
  contenido. Si se filtra, genera uno nuevo y actualiza la variable en Vercel.
- `admin.html` no está enlazado desde `index.html` ni indexado (`<meta name="robots"
  content="noindex, nofollow">`), pero al ser un sitio público la URL no es secreta
  por sí sola — la seguridad real la da el token, no la "URL oculta".

## 6. Verificación final

- `https://comprayvende.pomaire360.cl/` carga la app.
- `https://comprayvende.pomaire360.cl/api/negocios` responde JSON.
- Publica un emprendimiento de prueba y confirma que aparece también en el chat como anuncio automático.
- Abre el sitio desde otro dispositivo/red y confirma que ve los mismos datos (esto prueba que ya no depende del navegador, sino de la base de datos real).

## Notas de seguridad ya incluidas en el código

- Todo el HTML generado dinámicamente escapa el contenido (texto y atributos) para
  evitar XSS almacenado si alguien publica un nombre, contacto o URL de imagen con
  caracteres especiales.
- Las funciones serverless validan y limitan el tamaño de los campos, solo aceptan
  URLs `http(s)` para la imagen, y aplican un límite de envíos por IP
  (5 publicaciones/hora, 20 mensajes/minuto) para mitigar spam.
- El nombre de perfil del chat se guarda solo en `localStorage` del navegador (no es
  una cuenta ni dato sensible), mientras que el directorio y el chat viven en Redis,
  compartidos por todos los visitantes.

## Desarrollo local (opcional)

```bash
npm install -g vercel
vercel link
vercel env pull .env.development.local
vercel dev
```

Esto levanta `index.html` y las funciones `api/*.js` en `localhost` conectadas a la
misma base de datos de Redis.
