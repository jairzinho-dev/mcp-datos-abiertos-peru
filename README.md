# mcp-datos-abiertos-peru

Servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io) **y app Android** que dan a un modelo de lenguaje acceso directo a la **Plataforma Nacional de Datos Abiertos del Perú** ([datosabiertos.gob.pe](https://www.datosabiertos.gob.pe)): buscar datasets, inspeccionarlos, calcular cifras sobre sus tablas (CSV, Excel XLSX/XLS y tablas dentro de ZIP) y leer sus documentos (PDF, DOCX, HTML) como Markdown, citando siempre la fuente.

- **Servidor MCP** (`src/server.js`): se conecta a Claude Desktop, VS Code o cualquier host MCP por stdio.
- **App Android** (`app/`): chat que lleva dentro el mismo servidor MCP y funciona con la API key de **cualquier LLM** (Gemini, Groq, OpenRouter, OpenAI, Claude, DeepSeek u otro compatible con OpenAI), con rotación automática entre keys y proveedores. Se instala en un teléfono o en emuladores como BlueStacks.

**Descargar el APK:** [Releases → apk](https://github.com/jairzinho-dev/mcp-datos-abiertos-peru/releases/tag/apk) (se compila solo con GitHub Actions en cada cambio de `main`).

Proyecto final del curso *Inteligencia Artificial Aplicada* (Universidad de Lima, 2026-2). Asociado al **ODS 16, meta 16.10**: garantizar el acceso público a la información.

> **Estado:** prueba de punta a punta superada contra el portal real (nov-2026): `node scripts/probar.js`.

## Qué expone

| Primitiva MCP | Nombre | Descripción |
|---|---|---|
| tool | `buscar_datasets` | Búsqueda por texto libre (BM25 sobre título, entidad, etiquetas y descripción), con filtros por entidad, formato y fecha |
| tool | `ver_dataset` | Metadatos y recursos (archivos) de un dataset, consultados en vivo |
| tool | `listar_entidades` | Entidades publicadoras y su número de datasets |
| tool | `previsualizar_recurso` | Columnas, tipos inferidos y primeras filas de una tabla: CSV, Excel (XLSX y XLS antiguo, elige hoja y detecta la fila de encabezados) o CSV/Excel dentro de un ZIP |
| tool | `consultar_recurso` | Filtros + agregaciones (contar, suma, promedio, min, max) sobre la tabla completa (CSV en streaming; ZIP descomprimido en streaming) |
| tool | `leer_documento` | PDF, DOCX, HTML, texto u hoja pequeña → Markdown (también dentro de un ZIP), con metadatos y paginación |
| tool | `explorar_zip` | Contenido de un ZIP: archivos, tipos, tamaños y vista rápida de cada tabla |
| tool | `actualizar_catalogo` | Fuerza la recarga del índice local |
| resource | `pnda://catalogo/resumen` | Totales del catálogo |
| resource | `pnda://dataset/{nombre}` | Metadatos de un dataset |
| prompt | `analizar_datos_publicos` | Plantilla para responder una pregunta con datos y cita de fuente |

## Arquitectura

```
Host (Claude Desktop / VS Code) ──JSON-RPC 2.0 por stdio──▶ src/server.js ─┐
                                                                           ├─▶ src/core/servidor.js (tools, resources, prompts)
App Android: chat + agente ──JSON-RPC 2.0 en memoria─────▶ servidor MCP ───┘        │
      │                                                                    src/core/indice.js  BM25F sobre el catálogo
      └─▶ API del LLM elegido (key del usuario)                            src/core/ckan.js    API CKAN del portal
                                                                           src/core/csv.js     lectura y agregación de CSV
```

El núcleo (`src/core/`) es isomórfico: no usa APIs de Node. La red, el almacenamiento y los registros los aporta una *plataforma*: `src/plataforma-node.js` (fetch en streaming, caché en disco) o `app/src/plataforma-movil.js` (CapacitorHttp nativo, sin CORS; IndexedDB).

- **Búsqueda local:** el endpoint `package_search` del portal no funciona (Drupal interpreta `q` como ruta), así que se descarga el catálogo con `current_package_list_with_resources` y se indexa localmente.
- **Streaming:** los CSV se procesan fila a fila (hay archivos de más de 1 GB) y tienen un tope configurable (`max_mb`, 300 MB por defecto). Si el tope se alcanza, la respuesta lo indica (`lectura_completa: false`).
- **Detección automática** de codificación (UTF-8 / Windows-1252) y separador (`,` `;` `|` tab).
- **El tipo real se detecta por la firma del archivo** (`PK`, `%PDF`, OLE), no por el formato declarado: en el portal hay `.xls` que en realidad son XLSX, ZIP etiquetados como CSV, etc.
- **Formatos:** XLSX/XLS/ODS con [SheetJS](https://sheetjs.com) 0.20.3 (de su CDN oficial: la versión de npm tiene vulnerabilidades conocidas), ZIP con [fflate](https://github.com/101arrowz/fflate) y PDF con [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla). El PDF se reconstruye a Markdown por posiciones: títulos por tamaño de letra y columnas de tablas separadas con `|`. Los PDF escaneados (imagen) se detectan y se informan.
- **ZIP:** se lista sin descomprimir; los CSV de adentro se descomprimen en flujo, y cada entrada tiene un tope de tamaño (contra "bombas zip"). Los archivos nunca se escriben a disco.
- **Seguridad:** solo se leen recursos del catálogo o de dominios `.gob.pe` (evita SSRF). Las respuestas se recortan a 60 000 caracteres.
- **Trazabilidad:** cada llamada a una tool se registra en `logs/llamadas.jsonl` (fecha, argumentos, tiempo, éxito).

## App Android

| Archivo | Qué hace |
|---|---|
| `app/src/main.js` | Interfaz (chat y ajustes); conecta cliente y servidor MCP con `InMemoryTransport` |
| `app/src/agente.js` | Ciclo ReAct: el LLM pide herramientas MCP hasta poder responder. Proveedores, rotación de keys y traducción del historial a los formatos OpenAI y Anthropic |
| `app/src/plataforma-movil.js` | Red nativa (CapacitorHttp), IndexedDB, lectura de CSV con `Range` hasta 40 MB |

**Rotación de proveedores:** en Ajustes se puede poner una o varias keys por proveedor. Si una key falla (cuota, 429, key inválida, caída) se prueba la siguiente; si se acaban, el siguiente proveedor. Las keys que fallan quedan en espera 1 min (10 min si son inválidas). El historial se guarda en un formato neutro, así que el cambio de proveedor ocurre a mitad de la conversación sin perderla.

**Instalar en BlueStacks:** descarga `datos-abiertos-peru.apk` desde la release y arrástralo a la ventana de BlueStacks (o *Instalar APK*). Abre la app, ve a Ajustes, pega una API key (Gemini y Groq tienen nivel gratuito) y pregunta.

**Compilar localmente** (requiere JDK 21 y Android SDK): `npm run app:build && npx cap add android && npx cap sync android && cd android && ./gradlew assembleDebug`.

**Probar el agente sin el teléfono** (mismo código del APK):

```bash
LLM_PROVEEDOR=gemini LLM_API_KEY=tu_key node scripts/chat.js "¿Cuántos fallecidos por COVID registró Tacna, por sexo?"
```

## Evaluación del buscador

`node scripts/evaluar-busqueda.js 300` mide, con consultas reproducibles de "dataset conocido", el acierto@k y el MRR de BM25F frente a BM25 de un solo campo y a una coincidencia simple de palabras. Resultados en `docs/resultados-busqueda.json`.

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
`node scripts/probar-formatos.js` prueba PDF, DOCX, XLSX, XLS y ZIP reales del portal.

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
| `PNDA_MAX_MB_COMPLETO` | `200` | Tope para archivos que se leen completos (XLSX, ZIP, PDF) |
| `PNDA_TIMEOUT_MS` | `60000` | Timeout de las llamadas a la API |
| `PNDA_CACHE_DIR` / `PNDA_LOG_DIR` | `.cache/` / `logs/` | Directorios de caché y logs |

## Limitaciones

- El portal tiene un WAF que rechaza (HTTP 418) a clientes sin identificación; acepta el User-Agent honesto del proyecto.
- En la app, cada CSV se lee hasta 40 MB (memoria del teléfono). Si el archivo es más grande, la respuesta lo marca como parcial.
- XLSX, ZIP y PDF se cargan completos en memoria: tope de 200 MB en la computadora y 20 MB en el teléfono.
- No se leen `.doc` antiguos ni PDF escaneados (no hay OCR).
- La calidad depende de los metadatos publicados: hay enlaces rotos, formatos mal etiquetados y datasets desactualizados.

## Uso de IA

De acuerdo con los lineamientos del curso, el **código** de este repositorio (servidor y app) se desarrolló con asistencia de IA generativa (Claude, de Anthropic, mediante Claude Code). El diseño, la validación y la redacción del informe son responsabilidad del grupo.

## Licencia

MIT
