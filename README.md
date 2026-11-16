# mcp-datos-abiertos-peru

Servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io) que da a un modelo de lenguaje acceso directo a la **Plataforma Nacional de Datos Abiertos del Perú** ([datosabiertos.gob.pe](https://www.datosabiertos.gob.pe)): buscar datasets, inspeccionarlos y calcular cifras sobre sus CSV, citando siempre la fuente.

Proyecto final del curso *Inteligencia Artificial Aplicada* (Universidad de Lima, 2026-2). Asociado al **ODS 16, meta 16.10**: garantizar el acceso público a la información.

> **Estado:** en desarrollo, todavía no se ha validado de punta a punta contra el portal (ver [Limitaciones](#limitaciones)).

## Qué expone

| Primitiva MCP | Nombre | Descripción |
|---|---|---|
| tool | `buscar_datasets` | Búsqueda por texto libre (BM25 sobre título, entidad, etiquetas y descripción), con filtros por entidad, formato y fecha |
| tool | `ver_dataset` | Metadatos y recursos (archivos) de un dataset, consultados en vivo |
| tool | `listar_entidades` | Entidades publicadoras y su número de datasets |
| tool | `previsualizar_recurso` | Columnas, tipos inferidos y primeras filas de un CSV |
| tool | `consultar_recurso` | Filtros + agregaciones (contar, suma, promedio, min, max) sobre el CSV completo, en streaming |
| tool | `actualizar_catalogo` | Fuerza la recarga del índice local |
| resource | `pnda://catalogo/resumen` | Totales del catálogo |
| resource | `pnda://dataset/{nombre}` | Metadatos de un dataset |
| prompt | `analizar_datos_publicos` | Plantilla para responder una pregunta con datos y cita de fuente |

## Arquitectura

```
Host (Claude Desktop / VS Code) ──JSON-RPC 2.0 por stdio──▶ src/server.js
                                                              │
                         src/indice.js ◀── catálogo (caché 24 h, .cache/)
                         src/ckan.js   ──▶ https://www.datosabiertos.gob.pe/api/3/action/*
                         src/csv.js    ──▶ descarga en streaming de los recursos CSV
```

- **Búsqueda local:** el endpoint `package_search` del portal no funciona (Drupal interpreta `q` como ruta), así que se descarga el catálogo con `current_package_list_with_resources` y se indexa localmente.
- **Streaming:** los CSV se procesan fila a fila (hay archivos de más de 1 GB) y tienen un tope configurable (`max_mb`, 300 MB por defecto). Si el tope se alcanza, la respuesta lo indica (`lectura_completa: false`).
- **Detección automática** de codificación (UTF-8 / Windows-1252) y separador (`,` `;` `|` tab).
- **Seguridad:** solo se leen recursos del catálogo o de dominios `.gob.pe` (evita SSRF). Las respuestas se recortan a 60 000 caracteres.
- **Trazabilidad:** cada llamada a una tool se registra en `logs/llamadas.jsonl` (fecha, argumentos, tiempo, éxito).

## Instalación

Requiere Node.js 20 o superior.

```bash
git clone https://github.com/jairzinho-dev/mcp-datos-abiertos-peru.git
cd mcp-datos-abiertos-peru
npm install
```

### Probar sin un host MCP

```bash
node scripts/probar.js "fallecidos covid"
```

Lanza el servidor por stdio y ejecuta el flujo buscar → ver → previsualizar → consultar.

### Inspector oficial de MCP

```bash
npm run inspector
```

### Conectarlo a Claude Desktop

En `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "datos-abiertos-peru": {
      "command": "node",
      "args": ["C:/ruta/a/mcp-datos-abiertos-peru/src/server.js"]
    }
  }
}
```

## Configuración (variables de entorno)

| Variable | Por defecto | Uso |
|---|---|---|
| `PNDA_URL` | `https://www.datosabiertos.gob.pe` | URL base del portal |
| `PNDA_USER_AGENT` | `mcp-datos-abiertos-peru/0.1 (...)` | Identificador del cliente |
| `PNDA_TTL_HORAS` | `24` | Vigencia del caché del catálogo |
| `PNDA_MAX_MB` | `300` | Tope de lectura por CSV |
| `PNDA_TIMEOUT_MS` | `60000` | Timeout de las llamadas a la API |
| `PNDA_CACHE_DIR` / `PNDA_LOG_DIR` | `.cache/` / `logs/` | Directorios de caché y logs |

## Limitaciones

- El portal tiene un WAF que rechaza (HTTP 418) a clientes sin identificación. Falta confirmar que acepta el User-Agent del proyecto.
- Solo se leen CSV sin comprimir. Los recursos ZIP, XLSX y PDF se listan, pero no se consultan.
- La calidad depende de los metadatos publicados: hay enlaces rotos, formatos mal etiquetados y datasets desactualizados.

## Uso de IA

De acuerdo con los lineamientos del curso, el **código** de este repositorio se desarrolló con asistencia de IA generativa (Claude, de Anthropic, mediante Claude Code). El diseño, la validación y la redacción del informe son responsabilidad del grupo.

## Licencia

MIT
