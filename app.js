const CATS = ["Todos","Artesanía en greda","Comida y cocinería","Hospedaje","Turismo y paseos","Otro"];
let negocios = [];
let mensajes = [];
let activeCat = "Todos";
let searchQuery = "";
let userName = null;
let lastMsgTs = 0;
let chatPollTimer = null;
const PAGE_SIZE = 12;
let currentPage = 1;
let uploadedImageUrl = '';

/* ---------------- Helpers de seguridad y formato ---------------- */
// Escapa texto para insertarlo de forma segura dentro de HTML (nodos de texto).
function esc(s){
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Extrae un número de teléfono chileno de un string y retorna la URL de WhatsApp, o null.
function extractWhatsApp(contacto){
  if(!contacto) return null;
  // Buscar patrón de número chileno: +56 9 XXXX XXXX o variantes
  const cleaned = contacto.replace(/[\s\-().]/g, '');
  // Buscar +569XXXXXXXX o 569XXXXXXXX o 9XXXXXXXX
  let match = cleaned.match(/(?:\+?56)?9\d{8}/);
  if(match){
    let num = match[0].replace(/^\+/, '');
    if(num.startsWith('9') && num.length === 9) num = '56' + num;
    if(!num.startsWith('56')) num = '56' + num;
    return 'https://wa.me/' + num;
  }
  return null;
}

function fmtTime(ts){
  const d = new Date(ts);
  return d.toLocaleDateString('es-CL',{day:'2-digit',month:'2-digit'}) + ' ' + d.toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'});
}

function showToast(msg, isError){
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2600);
}

async function apiGet(url){
  const res = await fetch(url);
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

async function apiPost(url, body){
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

/* ---------------- Tabs ---------------- */
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-negocios').classList.toggle('hidden', tab!=='negocios');
    document.getElementById('tab-chat').classList.toggle('hidden', tab!=='chat');
    document.getElementById('fabBtn').classList.toggle('hidden', tab!=='negocios');
    if(tab==='chat'){
      initChatView();
    }
  });
});

/* ---------------- Chips ---------------- */
function renderChips(){
  const wrap = document.getElementById('chips');
  wrap.innerHTML = '';
  CATS.forEach(cat=>{
    const c = document.createElement('button');
    c.className = 'chip' + (cat===activeCat ? ' active' : '');
    c.textContent = cat;
    c.addEventListener('click', ()=>{ activeCat = cat; currentPage = 1; renderChips(); renderNegocios(); });
    wrap.appendChild(c);
  });
}

/* ---------------- Search ---------------- */
document.getElementById('searchInput').addEventListener('input', (e)=>{
  searchQuery = e.target.value.trim();
  currentPage = 1;
  renderNegocios();
});

/* ---------------- Negocios: API real (Vercel + Redis) ---------------- */
async function loadNegocios(){
  try{
    const data = await apiGet('/api/negocios');
    negocios = data.negocios || [];
  }catch(e){
    negocios = [];
    showToast('No se pudo cargar la lista. Revisa tu conexión.', true);
  }
  renderNegocios();
}

function renderNegocios(){
  const list = document.getElementById('negociosList');
  const countEl = document.getElementById('countNegocios');
  countEl.textContent = negocios.length ? `(${negocios.length})` : '';
  let filtered = activeCat==='Todos' ? negocios : negocios.filter(n=>n.categoria===activeCat);

  if(searchQuery){
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(n =>
      (n.nombre && n.nombre.toLowerCase().includes(q)) ||
      (n.descripcion && n.descripcion.toLowerCase().includes(q)) ||
      (n.autor && n.autor.toLowerCase().includes(q)) ||
      (n.categoria && n.categoria.toLowerCase().includes(q))
    );
  }

  const sorted = [...filtered].sort((a,b)=>b.creado - a.creado);

  if(sorted.length===0){
    list.innerHTML = `
      <div class="empty-state">
        <div class="ring"><svg viewBox="0 0 60 60"><g fill="none" stroke="#c98a34" stroke-width="2"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="14"/></g></svg></div>
        <strong>${searchQuery ? 'Sin resultados' : 'Aún no hay publicaciones aquí'}</strong>
        <p>${searchQuery ? 'Intenta con otros términos.' : 'Sé el primero en mostrar tu emprendimiento a la comunidad. Toca el botón + para publicar.'}</p>
      </div>`;
    return;
  }

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice(0, currentPage * PAGE_SIZE);

  list.innerHTML = paginated.map(n => {
    const waUrl = extractWhatsApp(n.contacto);
    const waBtn = waUrl ? `<a class="card-wa" href="${esc(waUrl)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : '';
    return `
    <div class="card">
      ${n.imagen ? `<img class="card-img" src="${esc(n.imagen)}" alt="${esc(n.nombre)}" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="card-body">
        <div class="card-top">
          <div>
            <div class="card-cat">${esc(n.categoria)}</div>
            <h3 class="card-title">${esc(n.nombre)}</h3>
          </div>
        </div>
        <p class="card-desc">${esc(n.descripcion)}</p>
        <div class="card-foot">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="card-contact" data-contacto="${esc(n.contacto)}">📞 ${esc(n.contacto)}</button>
            ${waBtn}
          </div>
          <span class="card-author">publicado por ${esc(n.autor)} · ${fmtTime(n.creado)}</span>
        </div>
      </div>
    </div>
  `}).join('');

  if(currentPage < totalPages){
    list.innerHTML += `<div class="load-more-wrap"><button class="load-more-btn" id="loadMoreBtn">Mostrar más (${sorted.length - paginated.length} restantes)</button></div>`;
    document.getElementById('loadMoreBtn').addEventListener('click', ()=>{ currentPage++; renderNegocios(); });
  }
}

// Delegación de eventos: copiar contacto al portapapeles sin usar onclick inline con datos del usuario.
document.getElementById('negociosList').addEventListener('click', (e)=>{
  const btn = e.target.closest('.card-contact');
  if(!btn) return;
  const contacto = btn.dataset.contacto || '';
  if(navigator.clipboard){
    navigator.clipboard.writeText(contacto).then(()=>showToast('Contacto copiado')).catch(()=>{});
  }
});

/* ---------------- Modal ---------------- */
const overlay = document.getElementById('modalOverlay');
const formError = document.getElementById('formError');

document.getElementById('fabBtn').addEventListener('click', ()=>{
  formError.textContent = '';
  overlay.classList.remove('hidden');
});
document.getElementById('cancelBtn').addEventListener('click', ()=>{
  overlay.classList.add('hidden');
});
overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.classList.add('hidden'); });

document.getElementById('publishBtn').addEventListener('click', async ()=>{
  const nombre = document.getElementById('fNombre').value.trim();
  const categoria = document.getElementById('fCategoria').value;
  const descripcion = document.getElementById('fDesc').value.trim();
  const contacto = document.getElementById('fContacto').value.trim();
  const imagen = uploadedImageUrl || '';
  const autor = document.getElementById('fAutor').value.trim() || 'Anónimo';

  formError.textContent = '';
  if(!nombre || !descripcion || !contacto){
    formError.textContent = 'Completa nombre, descripción y contacto.';
    return;
  }

  const btn = document.getElementById('publishBtn');
  btn.disabled = true; btn.textContent = 'Publicando…';

  try{
    await apiPost('/api/negocios', { nombre, categoria, descripcion, contacto, imagen, autor });
    await loadNegocios();

    overlay.classList.add('hidden');
    ['fNombre','fDesc','fContacto','fAutor'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('fCategoria').selectedIndex = 0;
    resetImageUpload();
    showToast('¡Publicado con éxito!');
  }catch(e){
    formError.textContent = e.message || 'Error al publicar, intenta de nuevo.';
  }finally{
    btn.disabled = false; btn.textContent = 'Publicar';
  }
});

/* ---------------- Image Upload ---------------- */
const imgFileInput = document.getElementById('fImgFile');
const imgPreview = document.getElementById('imgPreview');
const imgPlaceholder = document.getElementById('imgPlaceholder');
const imgRemoveBtn = document.getElementById('imgRemoveBtn');
const imgUploadArea = document.getElementById('imgUploadArea');

imgUploadArea.addEventListener('click', (e)=>{
  if(e.target === imgRemoveBtn || e.target.closest('.img-upload-remove')) return;
  imgFileInput.click();
});
imgFileInput.addEventListener('change', async ()=>{
  const file = imgFileInput.files[0];
  if(!file) return;
  if(file.size > 4*1024*1024){ showToast('Imagen muy pesada. Máximo 4 MB.', true); imgFileInput.value=''; return; }
  if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)){ showToast('Solo JPEG, PNG, WebP o GIF.', true); imgFileInput.value=''; return; }
  const reader = new FileReader();
  reader.onload = (ev)=>{ imgPreview.src=ev.target.result; imgPreview.classList.remove('hidden'); imgRemoveBtn.classList.remove('hidden'); imgPlaceholder.classList.add('hidden'); };
  reader.readAsDataURL(file);
  imgPlaceholder.innerHTML = '<span>⏳</span> Subiendo imagen…';
  try{
    const res = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':file.type}, body:file });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Error al subir');
    uploadedImageUrl = data.url;
    document.getElementById('fImg').value = data.url;
  }catch(e){ showToast(e.message||'No se pudo subir la imagen.', true); resetImageUpload(); }
});
imgRemoveBtn.addEventListener('click', (e)=>{ e.stopPropagation(); resetImageUpload(); });
function resetImageUpload(){
  uploadedImageUrl=''; document.getElementById('fImg').value=''; imgFileInput.value='';
  imgPreview.src=''; imgPreview.classList.add('hidden'); imgRemoveBtn.classList.add('hidden');
  imgPlaceholder.classList.remove('hidden'); imgPlaceholder.innerHTML='<span>📷</span> Toca para elegir una imagen';
}

/* ---------------- Chat: API real (Vercel + Redis) ---------------- */
function renderMensajes(){
  const wrap = document.getElementById('chatMsgs');
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 40;
  wrap.innerHTML = mensajes.map(m=>{
    if(m.system){
      return `<div class="msg system">${esc(m.texto)}</div>`;
    }
    const mine = m.autor === userName;
    return `
      <div class="msg ${mine?'mine':''}">
        ${!mine ? `<div class="msg-author">${esc(m.autor)}</div>` : ''}
        <div>${esc(m.texto)}</div>
        <div class="msg-time">${fmtTime(m.ts)}</div>
      </div>`;
  }).join('');
  if(mensajes.length) lastMsgTs = mensajes[mensajes.length - 1].ts;
  if(atBottom || mensajes.length <= 20) wrap.scrollTop = wrap.scrollHeight;
}

async function loadMensajes(){
  try{
    const data = await apiGet('/api/mensajes');
    mensajes = data.mensajes || [];
  }catch(e){
    showToast('No se pudo cargar el chat.', true);
  }
}

// El nombre de perfil es una preferencia puramente local del navegador: se guarda con
// localStorage (no requiere servidor ni cuenta de usuario).
function getStoredName(){
  try{ return localStorage.getItem('pomaire_nombre'); }catch(e){ return null; }
}
function setStoredName(name){
  try{ localStorage.setItem('pomaire_nombre', name); }catch(e){}
}

async function initChatView(){
  userName = getStoredName();

  if(!userName){
    document.getElementById('nameGate').classList.remove('hidden');
    document.getElementById('chatArea').classList.add('hidden');
  }else{
    document.getElementById('nameGate').classList.add('hidden');
    document.getElementById('chatArea').classList.remove('hidden');
    await loadMensajes();
    renderMensajes();
    startChatPolling();
  }
}

document.getElementById('saveNameBtn').addEventListener('click', async ()=>{
  const val = document.getElementById('nameInput').value.trim();
  if(!val){ showToast('Escribe tu nombre', true); return; }
  userName = val;
  setStoredName(val);
  document.getElementById('nameGate').classList.add('hidden');
  document.getElementById('chatArea').classList.remove('hidden');
  await loadMensajes();
  renderMensajes();
  startChatPolling();
});
document.getElementById('nameInput').addEventListener('keydown', (e)=>{
  if(e.key==='Enter') document.getElementById('saveNameBtn').click();
});

async function sendMessage(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;
  const sendBtn = document.getElementById('sendBtn');
  input.value = '';
  sendBtn.disabled = true;
  try{
    await apiPost('/api/mensajes', { autor: userName, texto: text });
    await loadMensajes();
    renderMensajes();
  }catch(e){
    showToast(e.message || 'No se pudo enviar, intenta de nuevo', true);
    input.value = text;
  }finally{
    sendBtn.disabled = false;
  }
}
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('chatInput').addEventListener('keydown', (e)=>{
  if(e.key==='Enter') sendMessage();
});

function startChatPolling(){
  if(chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = setInterval(async ()=>{
    if(document.getElementById('tab-chat').classList.contains('hidden')) return;
    try{
      const data = await apiGet('/api/mensajes?since=' + lastMsgTs);
      const nuevos = data.mensajes || [];
      if(nuevos.length){
        mensajes = mensajes.concat(nuevos);
        renderMensajes();
      }
    }catch(e){ /* silencioso: se reintenta en el próximo ciclo */ }
  }, 4000);
}

/* ---------------- Init ---------------- */
renderChips();
loadNegocios();
