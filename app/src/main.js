// App Android "Datos Abiertos Perú": host MCP con chat.
// Dentro de la app corren las dos mitades de MCP: el servidor (src/core/servidor.js, el mismo código
// que usa Claude Desktop por stdio) y un cliente MCP, unidos por un transporte en memoria. El agente
// (agente.js) traduce las herramientas MCP al formato del LLM que el usuario configure.
// Las conversaciones se guardan en IndexedDB y se pueden retomar desde la lista (☰).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { crearServidorMcp } from '../../src/core/servidor.js';
import { crearPlataformaMovil } from './plataforma-movil.js';
import { PROVEEDORES, configuracionInicial, listarModelos, ordenDeIntento, responder } from './agente.js';

const $ = (s) => document.querySelector(s);
const CLAVE_CONFIG = 'config-llm-v1';
const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// La respuesta del modelo puede contener texto copiado de los datasets: se sanea antes de mostrarla.
const markdown = (s) => DOMPurify.sanitize(marked.parse(s || ''), { FORBID_TAGS: ['style', 'img', 'iframe', 'form'] });

// ---------- configuración (localStorage del WebView, privado de la app) ----------

function cargarConfig() {
  const base = configuracionInicial();
  try {
    const guardada = JSON.parse(localStorage.getItem(CLAVE_CONFIG) || 'null');
    if (guardada) {
      base.activo = guardada.activo || base.activo;
      for (const id of Object.keys(base.proveedores)) Object.assign(base.proveedores[id], guardada.proveedores?.[id] || {});
    }
  } catch {}
  return base;
}
const guardarConfig = () => {
  try {
    localStorage.setItem(CLAVE_CONFIG, JSON.stringify(config));
  } catch {}
};
const config = cargarConfig();

// ---------- MCP dentro de la app ----------

const plataforma = crearPlataformaMovil({ log: (...a) => console.log(...a) });
const { server, indice } = crearServidorMcp(plataforma);
const cliente = new Client({ name: 'app-datos-abiertos-peru', version: '0.3.0' });
const [transporteCliente, transporteServidor] = InMemoryTransport.createLinkedPair();
const listo = (async () => {
  await server.connect(transporteServidor);
  await cliente.connect(transporteCliente);
})();

function mostrarEstadoCatalogo(texto) {
  $('#estado-catalogo').textContent = texto;
  $('#detalle-catalogo').textContent = texto;
}

async function cargarCatalogo(forzar = false) {
  mostrarEstadoCatalogo(forzar ? 'Actualizando catálogo…' : 'Cargando catálogo…');
  try {
    const c = await indice.obtenerCatalogo({
      forzar,
      progreso: (n, total) => mostrarEstadoCatalogo(`Descargando catálogo… ${Math.round((100 * n) / total)} %`),
    });
    const fecha = new Date(c.generado).toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' });
    mostrarEstadoCatalogo(`${c.datasets.length.toLocaleString('es-PE')} datasets · catálogo del ${fecha}`);
  } catch (e) {
    mostrarEstadoCatalogo(`Sin catálogo: ${e.message}`);
  }
}

// ---------- avisos breves ----------

let relojAviso;
function aviso(texto) {
  const a = $('#aviso');
  a.textContent = texto;
  a.classList.add('visible');
  clearTimeout(relojAviso);
  relojAviso = setTimeout(() => a.classList.remove('visible'), 2600);
}

// ---------- vistas (chat, lista, ajustes) con transición ----------

let vistaActual = 'chat';
const VISTAS = { chat: '#vista-chat', lista: '#vista-lista', ajustes: '#vista-ajustes' };
function mostrarVista(nombre) {
  if (nombre === vistaActual) return;
  const desde = vistaActual;
  for (const [n, sel] of Object.entries(VISTAS)) $(sel).classList.toggle('oculta', n !== nombre);
  const el = $(VISTAS[nombre]);
  el.classList.remove('entra-der', 'entra-izq');
  void el.offsetWidth; // reinicia la animación
  // la lista entra desde la izquierda (como un cajón); ajustes desde la derecha; el chat, según de dónde se vuelve
  el.classList.add(nombre === 'lista' || (nombre === 'chat' && desde === 'ajustes') ? 'entra-izq' : 'entra-der');
  vistaActual = nombre;
  if (nombre === 'ajustes') {
    edicion = null;
    pintarProveedores();
  }
  if (nombre === 'lista') pintarListaConversaciones();
}

// ---------- conversaciones guardadas (IndexedDB) ----------

const almacen = plataforma.almacen;
let indiceConv = []; // [{id, titulo, actualizada, preguntas}]
let actual = null; // {id, titulo, creada, actualizada, historial, vista}
let ocupado = false;

const nuevaConversacion = () => ({
  id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  titulo: '',
  creada: Date.now(),
  actualizada: Date.now(),
  historial: [], // formato neutro del agente
  vista: [], // lo que se muestra: {t:'u'|'a'|'e'|'p', ...}
});

async function cargarIndiceConversaciones() {
  try {
    indiceConv = (await almacen.leer('conv:indice')) || [];
  } catch {
    indiceConv = [];
  }
}

async function guardarConversacion(c) {
  if (!c.vista.length) return;
  c.actualizada = Date.now();
  try {
    await almacen.guardar(`conv:${c.id}`, c);
    const entrada = { id: c.id, titulo: c.titulo, actualizada: c.actualizada, preguntas: c.vista.filter((v) => v.t === 'u').length };
    indiceConv = [entrada, ...indiceConv.filter((x) => x.id !== c.id)].slice(0, 100);
    await almacen.guardar('conv:indice', indiceConv);
  } catch (e) {
    aviso(`No se pudo guardar la conversación: ${e.message}`);
  }
}

async function borrarConversacion(id) {
  indiceConv = indiceConv.filter((x) => x.id !== id);
  await almacen.guardar('conv:indice', indiceConv);
  await almacen.guardar(`conv:${id}`, null);
  if (actual?.id === id) abrirConversacion(nuevaConversacion());
}

function abrirConversacion(c) {
  actual = c;
  pintarConversacion();
}

async function abrirGuardada(id) {
  if (ocupado) return aviso('Espera a que termine la respuesta actual');
  const c = await almacen.leer(`conv:${id}`);
  if (!c) {
    aviso('No se encontró esa conversación');
    await borrarConversacion(id);
    return pintarListaConversaciones();
  }
  abrirConversacion(c);
  mostrarVista('chat');
}

function empezarNueva() {
  if (ocupado) return aviso('Espera a que termine la respuesta actual');
  if (actual && !actual.vista.length && vistaActual === 'chat') return; // ya está vacía
  abrirConversacion(nuevaConversacion());
  mostrarVista('chat');
  $('#entrada').focus();
}

function fechaRelativa(t) {
  const d = new Date(t);
  const hoy = new Date();
  const ayer = new Date(Date.now() - 86_400_000);
  const hora = d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === hoy.toDateString()) return `hoy, ${hora}`;
  if (d.toDateString() === ayer.toDateString()) return `ayer, ${hora}`;
  return d.toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: d.getFullYear() === hoy.getFullYear() ? undefined : 'numeric' });
}

function pintarListaConversaciones() {
  const ul = $('#conversaciones');
  ul.innerHTML = '';
  $('#sin-conversaciones').classList.toggle('oculta', indiceConv.length > 0);
  indiceConv.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'conversacion' + (c.id === actual?.id ? ' actual' : '');
    li.style.setProperty('--i', Math.min(i, 12));
    li.innerHTML = `
      <button class="abrir">
        <span class="titulo">${escapar(c.titulo || 'Conversación sin título')}</span>
        <span class="sub">${escapar(fechaRelativa(c.actualizada))} · ${c.preguntas} pregunta${c.preguntas === 1 ? '' : 's'}</span>
      </button>
      <button class="icono borrar" aria-label="Borrar conversación" title="Borrar">🗑</button>`;
    li.querySelector('.abrir').addEventListener('click', () => abrirGuardada(c.id));
    li.querySelector('.borrar').addEventListener('click', async () => {
      if (!confirm(`¿Borrar la conversación «${c.titulo || 'sin título'}»?`)) return;
      li.classList.add('saliendo');
      await new Promise((ok) => setTimeout(ok, 220));
      await borrarConversacion(c.id);
      pintarListaConversaciones();
    });
    ul.append(li);
  });
}

// ---------- pintar mensajes ----------

function resumenArgs(args) {
  const s = JSON.stringify(args);
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function nodoPaso(item) {
  if (item.k === 'n') {
    const d = document.createElement('div');
    d.className = 'paso' + (item.mal ? ' mal' : '');
    d.textContent = item.texto;
    return d;
  }
  const d = document.createElement('details');
  d.className = 'paso' + (item.ms === undefined ? '' : item.error ? ' mal' : ' ok');
  const estado = item.ms === undefined ? '<span class="girando"></span>' : `${item.error ? '✗' : '✓'} ${(item.ms / 1000).toFixed(1)} s`;
  d.innerHTML = `<summary>🔧 <span class="nombre">${escapar(item.nombre)}</span> <span class="estado">${estado}</span><br><small>${escapar(resumenArgs(item.args))}</small></summary>`;
  if (item.contenido) {
    const pre = document.createElement('pre');
    pre.textContent = item.contenido;
    d.append(pre);
  }
  return d;
}

function nodoDe(v) {
  const div = document.createElement('div');
  if (v.t === 'u') {
    div.className = 'msg usuario';
    div.textContent = v.texto;
  } else if (v.t === 'a') {
    div.className = 'msg asistente';
    div.innerHTML = markdown(v.md);
    if (v.meta) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = v.meta;
      div.append(meta);
    }
    for (const a of div.querySelectorAll('a')) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  } else if (v.t === 'e') {
    div.className = 'msg error';
    div.textContent = v.texto;
  } else if (v.t === 'p') {
    div.className = 'pasos';
    for (const item of v.items) div.append(nodoPaso(item));
  }
  return div;
}

function pintarConversacion() {
  const m = $('#mensajes');
  m.innerHTML = '';
  if (!actual.vista.length) {
    m.append($('#tpl-bienvenida').content.cloneNode(true));
    for (const b of m.querySelectorAll('.ejemplo')) b.addEventListener('click', () => preguntar(b.textContent));
    return;
  }
  const n = actual.vista.length;
  actual.vista.forEach((v, i) => {
    const nodo = nodoDe(v);
    // al abrir una conversación, los últimos mensajes aparecen escalonados
    if (n - i <= 6) {
      nodo.classList.add('entra');
      nodo.style.animationDelay = `${(6 - (n - i)) * 40}ms`;
    }
    m.append(nodo);
  });
  requestAnimationFrame(() => (m.scrollTop = m.scrollHeight));
}

function agregar(v) {
  const m = $('#mensajes');
  m.querySelector('.bienvenida')?.remove();
  const nodo = nodoDe(v);
  nodo.classList.add('entra');
  m.append(nodo);
  nodo.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return nodo;
}

// ---------- preguntar ----------

async function preguntar(pregunta) {
  pregunta = pregunta.trim();
  if (ocupado || !pregunta) return;
  if (!ordenDeIntento(config).length) {
    aviso('Primero agrega la API key de algún proveedor en Ajustes');
    mostrarVista('ajustes');
    return;
  }
  ocupado = true;
  document.body.classList.add('ocupado');
  $('#btn-enviar').disabled = true;
  const conv = actual;
  if (!conv.titulo) conv.titulo = pregunta.length > 70 ? pregunta.slice(0, 70) + '…' : pregunta;

  const vUsuario = { t: 'u', texto: pregunta };
  conv.vista.push(vUsuario);
  agregar(vUsuario);
  const registro = { t: 'p', items: [] };
  conv.vista.push(registro); // en orden: pregunta, pasos, respuesta
  const nodoPasos = agregar(registro);
  const quitarRegistroSiVacio = () => {
    if (registro.items.length) return;
    const i = conv.vista.indexOf(registro);
    if (i >= 0) conv.vista.splice(i, 1);
    nodoPasos.remove();
  };
  const espera = document.createElement('div');
  espera.className = 'msg asistente escribiendo entra';
  espera.innerHTML = '<span class="texto">Pensando</span> <span class="puntos"><i></i><i></i><i></i></span>';
  $('#mensajes').append(espera);
  const estadoEspera = (t) => (espera.querySelector('.texto').textContent = t);
  const pendientes = new Map();
  const nota = (texto, mal = false) => {
    const item = { k: 'n', texto, mal };
    registro.items.push(item);
    const n = nodoPaso(item);
    n.classList.add('entra');
    nodoPasos.append(n);
  };

  try {
    await listo;
    const { texto, traza } = await responder({
      pregunta,
      historial: conv.historial,
      cliente,
      config,
      http: plataforma.http,
      onEvento: (e) => {
        if (e.tipo === 'herramienta_inicio') {
          const item = { k: 'h', nombre: e.nombre, args: e.args };
          registro.items.push(item);
          const n = nodoPaso(item);
          n.classList.add('entra');
          nodoPasos.append(n);
          if (!pendientes.has(e.nombre)) pendientes.set(e.nombre, []);
          pendientes.get(e.nombre).push({ item, n });
          estadoEspera(`Consultando ${e.nombre}`);
        } else if (e.tipo === 'herramienta_fin') {
          const p = pendientes.get(e.nombre)?.shift();
          if (p) {
            Object.assign(p.item, { ms: e.ms, error: e.error, contenido: e.contenido.slice(0, 3000) });
            const nuevo = nodoPaso(p.item);
            p.n.replaceWith(nuevo);
          }
          estadoEspera('Pensando');
        } else if (e.tipo === 'espera') {
          nota(`⏳ Esperando ${e.segundos} s por el ${e.motivo}; luego se reintenta…`);
          estadoEspera(`Esperando ${e.segundos} s`);
        } else if (e.tipo === 'modelo') {
          nota(`↻ ${e.proveedor}: el modelo ${e.de} ya no está disponible para tu key; se cambió a ${e.a}`);
          guardarConfig();
          pintarPie();
        } else if (e.tipo === 'rotacion') {
          nota(`↻ ${e.motivo.length > 220 ? e.motivo.slice(0, 220) + '…' : e.motivo}`, true);
        } else if (e.tipo === 'llm') {
          $('#proveedor-actual').textContent = `Respondiendo con ${e.proveedor} · ${e.modelo}`;
        }
        if (conv === actual) espera.scrollIntoView({ block: 'end', behavior: 'smooth' });
      },
    });
    const meta =
      `${traza.proveedores.join(', ')} · ${traza.pasos.length} herramienta(s) · ${traza.llamadasLLM} llamada(s) al modelo` +
      (traza.tokens.entrada ? ` · ${traza.tokens.entrada.toLocaleString('es-PE')} tokens de entrada + ${traza.tokens.salida.toLocaleString('es-PE')} de salida` +
        (traza.tokens.razonamiento ? ` (${traza.tokens.razonamiento.toLocaleString('es-PE')} de razonamiento)` : '') : '');
    quitarRegistroSiVacio();
    const vRespuesta = { t: 'a', md: texto, meta };
    conv.vista.push(vRespuesta);
    espera.remove();
    if (conv === actual) agregar(vRespuesta);
    guardarConfig(); // guarda qué key funcionó
  } catch (e) {
    quitarRegistroSiVacio();
    const vError = { t: 'e', texto: e.message };
    conv.vista.push(vError);
    espera.remove();
    if (conv === actual) agregar(vError);
  } finally {
    await guardarConversacion(conv);
    ocupado = false;
    document.body.classList.remove('ocupado');
    $('#btn-enviar').disabled = false;
  }
}

$('#formulario').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = $('#entrada').value;
  if (!t.trim() || ocupado) return;
  $('#entrada').value = '';
  $('#entrada').style.height = '';
  preguntar(t);
});
$('#entrada').addEventListener('input', (ev) => {
  ev.target.style.height = 'auto';
  ev.target.style.height = Math.min(ev.target.scrollHeight, 140) + 'px';
});
$('#entrada').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    $('#formulario').requestSubmit();
  }
});

// ---------- ajustes: proveedores de LLM ----------
// Arriba, los proveedores ya conectados (tarjetas compactas). "Conectar un proveedor" muestra
// primero la lista para elegir y luego solo el formulario de ese proveedor.

let edicion = null; // null | 'elegir' | id del proveedor que se está conectando o editando

const tieneKey = (id) => config.proveedores[id].keys.length > 0;
const partirKeys = (t) => t.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean);
const enmascarar = (k) => (k.length > 10 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••');

function elegirModeloPorDefecto(c, modelos, primeraVez) {
  // al conectar por primera vez se prefiere el más reciente (el de fábrica puede estar listado pero
  // restringido, como los Gemini 2.5 para cuentas nuevas); al volver a probar se respeta la elección
  if (!primeraVez && modelos.includes(c.modelo)) return c.modelo;
  // si el modelo guardado no está (p. ej. Google cerró los Gemini 2.5 a cuentas nuevas), el "flash"
  // estable más reciente; si no hay, el primero de la lista
  const version = (id) => parseFloat(/(\d+(?:\.\d+)?)/.exec(id)?.[1] || '0');
  const estables = modelos.filter((m) => /flash/i.test(m) && !/lite|preview|exp|image|tts|audio|live|thinking/i.test(m));
  const mejor = estables.sort((a, b) => version(b) - version(a))[0];
  if (mejor) return mejor;
  return modelos.includes(c.modelo) ? c.modelo : modelos[0] || c.modelo;
}

function pintarProveedores() {
  const cont = $('#lista-proveedores');
  cont.innerHTML = '';
  const conectados = PROVEEDORES.filter((p) => tieneKey(p.id)).sort((a, b) => (b.id === config.activo) - (a.id === config.activo));
  if (!conectados.length && edicion === null) edicion = 'elegir';

  for (const p of conectados) {
    const c = config.proveedores[p.id];
    const principal = config.activo === p.id;
    const card = document.createElement('div');
    card.className = 'conectado entra' + (principal ? ' es-principal' : '');
    card.innerHTML = `
      <div class="fila">
        <div class="info">
          <strong>${escapar(p.nombre)}</strong>
          <span class="sub">${escapar(c.modelo || 'sin modelo')} · ${c.keys.length} key${c.keys.length === 1 ? '' : 's'} (${escapar(c.keys.map(enmascarar).join(', '))})</span>
        </div>
        ${principal ? '<span class="etiqueta">principal</span>' : ''}
      </div>
      <div class="acciones">
        ${principal ? '' : '<button class="secundario hacer-principal">Usar como principal</button>'}
        ${principal ? '' : `<label class="interruptor"><input type="checkbox" class="respaldo" ${c.habilitado ? 'checked' : ''}/> de respaldo</label>`}
        <button class="secundario editar">Editar</button>
        <button class="secundario quitar">Quitar</button>
      </div>`;
    card.querySelector('.hacer-principal')?.addEventListener('click', () => {
      config.activo = p.id;
      guardarConfig();
      aviso(`${p.nombre} es ahora el proveedor principal`);
      pintarProveedores();
      pintarPie();
    });
    card.querySelector('.respaldo')?.addEventListener('change', (ev) => {
      c.habilitado = ev.target.checked;
      guardarConfig();
      pintarPie();
    });
    card.querySelector('.editar').addEventListener('click', () => {
      edicion = p.id;
      pintarProveedores();
    });
    card.querySelector('.quitar').addEventListener('click', () => {
      if (!confirm(`¿Quitar ${p.nombre} y sus keys de este dispositivo?`)) return;
      c.keys = [];
      c.modelos = [];
      if (config.activo === p.id) config.activo = PROVEEDORES.find((x) => x.id !== p.id && tieneKey(x.id))?.id || config.activo;
      guardarConfig();
      pintarProveedores();
      pintarPie();
    });
    cont.append(card);
  }

  if (edicion === null) {
    const b = document.createElement('button');
    b.className = 'primario entra';
    b.textContent = conectados.length ? '＋ Conectar otro proveedor' : '＋ Conectar un proveedor';
    b.addEventListener('click', () => {
      edicion = 'elegir';
      pintarProveedores();
    });
    cont.append(b);
  } else if (edicion === 'elegir') {
    const panel = document.createElement('div');
    panel.className = 'elegir entra';
    panel.innerHTML = `<p class="sub">¿De qué proveedor es tu API key?</p><div class="opciones"></div>
      ${conectados.length ? '<button class="secundario cancelar">Cancelar</button>' : ''}`;
    PROVEEDORES.forEach((p, i) => {
      const o = document.createElement('button');
      o.className = 'opcion';
      o.style.setProperty('--i', i);
      o.innerHTML = `<strong>${escapar(p.nombre)}</strong><span class="sub">${escapar(p.ayuda)}</span>${tieneKey(p.id) ? '<span class="etiqueta">conectado</span>' : ''}`;
      o.addEventListener('click', () => {
        edicion = p.id;
        pintarProveedores();
      });
      panel.querySelector('.opciones').append(o);
    });
    panel.querySelector('.cancelar')?.addEventListener('click', () => {
      edicion = null;
      pintarProveedores();
    });
    cont.append(panel);
  } else {
    cont.append(formularioProveedor(PROVEEDORES.find((p) => p.id === edicion)));
  }
}

function formularioProveedor(p) {
  const c = config.proveedores[p.id];
  const f = document.createElement('div');
  f.className = 'formulario entra';
  f.innerHTML = `
    <h4>Conectar ${escapar(p.nombre)}</h4>
    <p class="sub">${escapar(p.ayuda)}</p>
    <label>API key
      <div class="con-boton">
        <input type="password" class="key" value="${escapar(c.keys.join(', '))}" placeholder="Pega aquí tu API key" spellcheck="false" autocomplete="off" />
        <button class="icono ver" type="button" aria-label="Mostrar u ocultar">👁</button>
      </div>
      <span class="sub">¿Tienes varias? Sepáralas con comas: si una se queda sin cuota, se usa la siguiente.</span>
    </label>
    <label class="${p.id === 'personalizado' ? '' : 'oculta'}">URL base (compatible con OpenAI)
      <input type="url" class="base" value="${escapar(c.base)}" placeholder="https://…/v1" spellcheck="false" />
    </label>
    <label class="bloque-modelo ${c.modelos?.length ? '' : 'oculta'}">Modelo
      <select class="lista-modelos"></select>
    </label>
    <p class="resultado"></p>
    <div class="acciones">
      <button class="primario probar">Probar y guardar</button>
      <button class="secundario cancelar">${tieneKey(p.id) ? 'Listo' : 'Cancelar'}</button>
    </div>`;
  const lista = f.querySelector('.lista-modelos');
  const res = f.querySelector('.resultado');
  const pintarModelos = () => {
    const malos = c.modelosNoDisponibles || [];
    const modelos = [...new Set([c.modelo, ...(c.modelos || [])].filter((m) => m && (m === c.modelo || !malos.includes(m))))];
    lista.innerHTML = modelos.map((m) => `<option value="${escapar(m)}"${m === c.modelo ? ' selected' : ''}>${escapar(m)}</option>`).join('');
  };
  pintarModelos();
  lista.addEventListener('change', () => {
    c.modelo = lista.value;
    guardarConfig();
    pintarPie();
  });
  f.querySelector('.ver').addEventListener('click', () => {
    const i = f.querySelector('.key');
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  f.querySelector('.cancelar').addEventListener('click', () => {
    edicion = null;
    pintarProveedores();
  });
  f.querySelector('.probar').addEventListener('click', async (ev) => {
    const keys = partirKeys(f.querySelector('.key').value);
    const base = (f.querySelector('.base').value || c.base).trim();
    if (!keys.length) {
      res.className = 'resultado mal';
      res.textContent = 'Pega la API key primero';
      return;
    }
    if (!base) {
      res.className = 'resultado mal';
      res.textContent = 'Falta la URL base';
      return;
    }
    ev.target.disabled = true;
    res.className = 'resultado';
    res.innerHTML = '<span class="girando"></span> Probando la key…';
    try {
      const modelos = await listarModelos(plataforma.http, p.id, { base, key: keys[0] });
      const primeraVez = !c.modelos?.length;
      Object.assign(c, { keys, base, modelos, habilitado: true, indiceKey: 0 });
      c.modelo = elegirModeloPorDefecto(c, modelos, primeraVez);
      // el primer proveedor conectado (o si el principal no tiene key) pasa a ser el principal
      if (!tieneKey(config.activo) || config.activo === p.id || !PROVEEDORES.some((x) => x.id !== p.id && tieneKey(x.id))) config.activo = p.id;
      guardarConfig();
      pintarPie();
      pintarModelos();
      f.querySelector('.bloque-modelo').classList.remove('oculta');
      f.querySelector('.cancelar').textContent = 'Listo';
      res.className = 'resultado ok';
      res.textContent = `✓ Conectado · ${modelos.length} modelos de chat. Se eligió ${c.modelo}; puedes cambiarlo arriba.`;
    } catch (e) {
      res.className = 'resultado mal';
      res.textContent = `✗ ${e.message}`;
    } finally {
      ev.target.disabled = false;
    }
  });
  return f;
}

function pintarPie() {
  const orden = ordenDeIntento(config);
  $('#proveedor-actual').textContent = orden.length
    ? `Modelo: ${PROVEEDORES.find((p) => p.id === orden[0]).nombre} · ${config.proveedores[orden[0]].modelo}` +
      (orden.length > 1 ? ` (+${orden.length - 1} de respaldo)` : '')
    : 'Sin modelo: conecta un proveedor en Ajustes (⚙)';
}

// ---------- botones y arranque ----------

$('#btn-ajustes').addEventListener('click', () => mostrarVista(vistaActual === 'ajustes' ? 'chat' : 'ajustes'));
$('#btn-cerrar-ajustes').addEventListener('click', () => mostrarVista('chat'));
$('#btn-lista').addEventListener('click', () => mostrarVista(vistaActual === 'lista' ? 'chat' : 'lista'));
$('#btn-cerrar-lista').addEventListener('click', () => mostrarVista('chat'));
$('#btn-nueva').addEventListener('click', empezarNueva);
$('#btn-nueva-lista').addEventListener('click', empezarNueva);
$('#btn-actualizar').addEventListener('click', () => cargarCatalogo(true));

// Botón "atrás" de Android: vuelve al chat; desde el chat, minimiza la app en vez de cerrarla.
if (Capacitor.isNativePlatform()) {
  App.addListener('backButton', () => {
    if (vistaActual !== 'chat') mostrarVista('chat');
    else App.minimizeApp();
  });
}

(async () => {
  abrirConversacion(nuevaConversacion());
  pintarPie();
  await cargarIndiceConversaciones();
  // quitar la clase de arranque cuando terminó la animación de entrada
  setTimeout(() => document.body.classList.remove('arranque'), 1200);
  cargarCatalogo();
  if (!ordenDeIntento(config).length) setTimeout(() => mostrarVista('ajustes'), 700);
})();
