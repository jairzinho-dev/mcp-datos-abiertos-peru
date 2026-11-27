// App Android "Datos Abiertos Perú": host MCP con chat.
// Dentro de la app corren las dos mitades de MCP: el servidor (src/core/servidor.js, el mismo código
// que usa Claude Desktop por stdio) y un cliente MCP, unidos por un transporte en memoria. El agente
// (agente.js) traduce las herramientas MCP al formato del LLM que el usuario configure.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { crearServidorMcp } from '../../src/core/servidor.js';
import { crearPlataformaMovil } from './plataforma-movil.js';
import { PROVEEDORES, configuracionInicial, listarModelos, ordenDeIntento, responder } from './agente.js';

const $ = (s) => document.querySelector(s);
const CLAVE_CONFIG = 'config-llm-v1';

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
const cliente = new Client({ name: 'app-datos-abiertos-peru', version: '0.2.0' });
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

// ---------- chat ----------

const historial = [];
let ocupado = false;

function agregar(clase, html) {
  $('#bienvenida')?.remove();
  const div = document.createElement('div');
  div.className = clase;
  if (html !== undefined) div.innerHTML = html;
  $('#mensajes').append(div);
  div.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return div;
}
const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// La respuesta del modelo puede contener texto copiado de los datasets: se sanea antes de mostrarla.
const markdown = (s) => DOMPurify.sanitize(marked.parse(s || ''), { FORBID_TAGS: ['style', 'img', 'iframe', 'form'] });

function resumenArgs(args) {
  const s = JSON.stringify(args);
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

async function preguntar(pregunta) {
  if (ocupado || !pregunta.trim()) return;
  if (!ordenDeIntento(config).length) {
    agregar('msg error', 'Primero agrega la API key de algún proveedor en Ajustes (⚙).');
    return;
  }
  ocupado = true;
  $('#btn-enviar').disabled = true;
  agregar('msg usuario').textContent = pregunta;
  const pasos = agregar('pasos');
  const espera = agregar('msg asistente escribiendo', 'Pensando');
  const pasoActual = new Map();

  try {
    await listo;
    const { texto, traza } = await responder({
      pregunta,
      historial,
      cliente,
      config,
      http: plataforma.http,
      onEvento: (e) => {
        if (e.tipo === 'herramienta_inicio') {
          const d = document.createElement('details');
          d.className = 'paso';
          d.innerHTML = `<summary>🔧 <span class="nombre">${escapar(e.nombre)}</span> <span class="estado">…</span><br><small>${escapar(resumenArgs(e.args))}</small></summary>`;
          pasos.append(d);
          if (!pasoActual.has(e.nombre)) pasoActual.set(e.nombre, []);
          pasoActual.get(e.nombre).push(d);
          espera.textContent = `Consultando ${e.nombre}`;
        } else if (e.tipo === 'herramienta_fin') {
          const d = pasoActual.get(e.nombre)?.shift();
          if (d) {
            d.classList.add(e.error ? 'mal' : 'ok');
            d.querySelector('.estado').textContent = `${e.error ? '✗' : '✓'} ${(e.ms / 1000).toFixed(1)} s`;
            const pre = document.createElement('pre');
            pre.textContent = e.contenido.slice(0, 4000);
            d.append(pre);
          }
          espera.textContent = 'Pensando';
        } else if (e.tipo === 'rotacion') {
          const d = document.createElement('div');
          d.className = 'paso mal';
          d.textContent = `↻ Cambio de proveedor: ${e.motivo}`;
          pasos.append(d);
        } else if (e.tipo === 'llm') {
          $('#proveedor-actual').textContent = `Respondiendo con ${e.proveedor} · ${e.modelo}`;
        }
        espera.scrollIntoView({ block: 'end' });
      },
    });
    espera.remove();
    const div = agregar('msg asistente', markdown(texto));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      `${traza.proveedores.join(', ')} · ${traza.pasos.length} herramienta(s) · ${traza.llamadasLLM} llamada(s) al modelo` +
      (traza.tokens.entrada ? ` · ${traza.tokens.entrada + traza.tokens.salida} tokens` : '');
    div.append(meta);
    for (const a of div.querySelectorAll('a')) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    guardarConfig(); // guarda qué key funcionó
  } catch (e) {
    espera.remove();
    agregar('msg error').textContent = e.message;
  } finally {
    ocupado = false;
    $('#btn-enviar').disabled = false;
  }
}

$('#formulario').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = $('#entrada').value;
  $('#entrada').value = '';
  $('#entrada').style.height = '';
  preguntar(t);
});
$('#entrada').addEventListener('input', (ev) => {
  ev.target.style.height = 'auto';
  ev.target.style.height = ev.target.scrollHeight + 'px';
});
$('#entrada').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    $('#formulario').requestSubmit();
  }
});
for (const b of document.querySelectorAll('.ejemplo')) b.addEventListener('click', () => preguntar(b.textContent));

// ---------- ajustes ----------

function pintarProveedores() {
  const cont = $('#lista-proveedores');
  cont.innerHTML = '';
  for (const p of PROVEEDORES) {
    const c = config.proveedores[p.id];
    const div = document.createElement('div');
    div.className = 'proveedor';
    div.innerHTML = `
      <div class="cab">
        <strong>${escapar(p.nombre)}</strong>
        <span>
          ${config.activo === p.id ? '<span class="etiqueta">principal</span>' : `<button class="secundario principal">Usar como principal</button>`}
        </span>
      </div>
      <p class="sub">${escapar(p.ayuda)}</p>
      <label>API key(s) — una por línea
        <textarea class="keys oculto" rows="2" spellcheck="false" autocomplete="off">${escapar(c.keys.join('\n'))}</textarea>
      </label>
      <label>Modelo
        <input type="text" class="modelo" list="modelos-${p.id}" value="${escapar(c.modelo)}" spellcheck="false" />
        <datalist id="modelos-${p.id}"></datalist>
      </label>
      <label>URL base
        <input type="url" class="base" value="${escapar(c.base)}" spellcheck="false" ${p.id === 'personalizado' ? '' : 'readonly'} />
      </label>
      <div class="acciones">
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" class="habilitado" ${c.habilitado ? 'checked' : ''}/> usar en la rotación</label>
        <button class="secundario ver">Mostrar keys</button>
        <button class="secundario probar">Probar y cargar modelos</button>
        <span class="resultado"></span>
      </div>`;
    const guardar = () => {
      c.keys = div.querySelector('.keys').value.split('\n').map((k) => k.trim()).filter(Boolean);
      c.modelo = div.querySelector('.modelo').value.trim();
      c.base = div.querySelector('.base').value.trim();
      c.habilitado = div.querySelector('.habilitado').checked;
      guardarConfig();
      pintarPie();
    };
    for (const el of div.querySelectorAll('textarea, input')) el.addEventListener('change', guardar);
    div.querySelector('.principal')?.addEventListener('click', () => {
      config.activo = p.id;
      guardarConfig();
      pintarProveedores();
      pintarPie();
    });
    div.querySelector('.ver').addEventListener('click', (ev) => {
      const t = div.querySelector('.keys');
      t.classList.toggle('oculto');
      ev.target.textContent = t.classList.contains('oculto') ? 'Mostrar keys' : 'Ocultar keys';
    });
    div.querySelector('.probar').addEventListener('click', async () => {
      guardar();
      const res = div.querySelector('.resultado');
      if (!c.keys.length || !c.base) {
        res.className = 'resultado mal';
        res.textContent = 'Falta la key o la URL';
        return;
      }
      res.className = 'resultado';
      res.textContent = 'Probando…';
      try {
        const modelos = await listarModelos(plataforma.http, p.id, { base: c.base, key: c.keys[0] });
        div.querySelector('datalist').innerHTML = modelos.map((m) => `<option value="${escapar(m)}"></option>`).join('');
        res.className = 'resultado ok';
        res.textContent = `✓ key válida · ${modelos.length} modelos (toca el campo Modelo para elegir)`;
      } catch (e) {
        res.className = 'resultado mal';
        res.textContent = `✗ ${e.message}`;
      }
    });
    cont.append(div);
  }
}

function pintarPie() {
  const orden = ordenDeIntento(config);
  $('#proveedor-actual').textContent = orden.length
    ? `Modelo: ${PROVEEDORES.find((p) => p.id === orden[0]).nombre} · ${config.proveedores[orden[0]].modelo}` +
      (orden.length > 1 ? ` (+${orden.length - 1} de respaldo)` : '')
    : 'Sin modelo configurado: abre Ajustes (⚙)';
}

function abrirAjustes(abrir) {
  $('#vista-ajustes').classList.toggle('oculta', !abrir);
  $('#vista-chat').classList.toggle('oculta', abrir);
  if (abrir) pintarProveedores();
}
$('#btn-ajustes').addEventListener('click', () => abrirAjustes($('#vista-ajustes').classList.contains('oculta')));
$('#btn-cerrar-ajustes').addEventListener('click', () => abrirAjustes(false));
$('#btn-actualizar').addEventListener('click', () => cargarCatalogo(true));
$('#btn-nueva').addEventListener('click', () => location.reload());

pintarPie();
cargarCatalogo();
if (!ordenDeIntento(config).length) abrirAjustes(true);
