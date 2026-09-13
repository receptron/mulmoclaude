# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

[English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [한국어](README.ko.md) · **Español** · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**Un asistente de IA que lo sabe todo sobre ti y te acompaña las 24 horas del día no se vende en ninguna parte. No puedes comprarlo — solo puedes cultivarlo. MulmoClaude es una herramienta para cultivar tu propio asistente de IA, en tu propio ordenador.**

La sustancia de un asistente no es el modelo de IA — el modelo es solo el motor. Lo que hace valioso a un asistente es cuánto sabe sobre ti: tus conversaciones, tu calendario, tus notas, tus datos y las aplicaciones que usas. Algo tan importante no debería confiarse a ningún proveedor de servicios — cuanto más tiempo lo uses, más difícil se vuelve marcharse. MulmoClaude es de código abierto y se ejecuta localmente, así que todo lo que tu asistente acumula — recuerdos, datos, aplicaciones — permanece en tus propias manos, como archivos planos en tu workspace.

Cultivar requiere un entorno, y MulmoClaude lo proporciona: un lugar para acumular recuerdos (una wiki personal que Claude construye y mantiene por sí mismo), un lugar para guardar tus datos (colecciones basadas en esquemas, feeds, archivos planos) y un lugar para crear aplicaciones solo para ti — sin necesidad de conocimientos de programación. Dices "quiero algo así" con palabras cotidianas, y Claude construye la pequeña aplicación que necesitas: una lista de restaurantes, un gestor de facturas, práctica de vocabulario — software para una audiencia de una sola persona. Justo después de instalarlo, el jardín está vacío; siembras semillas, cuidas la tierra y cultivas un asistente que es solo tuyo.

Y el asistente no está atado a tu escritorio. Inicia sesión desde tu teléfono — o desde una app de mensajería que ya uses — y llegas al mismo asistente que vive en tu ordenador. El servidor de retransmisión solo transporta mensajes en tránsito — tus recuerdos, datos y aplicaciones nunca salen de tu ordenador.

Por debajo, MulmoClaude es una plataforma de aplicaciones AI-nativa: las capacidades son plugins dentro de un único registro (hoy: un sistema contable completo con lógica real de contabilidad del lado del servidor, una wiki personal, un lector de documentos de la SEC y más), Claude actúa como un controlador universal que compone a través de ellos, y el chat invoca la GUI adecuada para cada tarea — markdown, gráficos, formularios, wikis, hojas de cálculo o escenas 3D.

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** — la tesis sobre arquitectura, UX y protocolo que hay detrás de MulmoClaude.

## 📣 Novedades

Las nuevas versiones y funciones se anuncian **en japonés** en X.

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — anuncios de versiones y nuevas funciones
- [Satoshi Nakajima (@snakajima)](https://x.com/snakajima) — propietario de MulmoClaude

## Inicio rápido

```bash
npx mulmoclaude@latest
```

El lanzador arranca el servidor y abre [http://localhost:3001](http://localhost:3001) en tu navegador. Y listo — empieza a chatear.

> **Para mantenerlo en ejecución**: cerrar la terminal detiene el servidor. Para ejecutarlo en segundo plano, lánzalo dentro de `tmux` / `screen` (macOS/Linux) o regístralo como tarea de inicio en el Programador de tareas de Windows.

### Requisitos previos

- **Node.js 22.19+** — entorno de ejecución
- **[Claude Code CLI](https://claude.ai/code)** — instalado y autenticado. Ejecuta `claude` una vez para completar el OAuth
- **ffmpeg** — necesario para la generación de vídeo. Puedes omitirlo si no vas a generar vídeos
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (opcional pero recomendado) — habilita el modo sandbox. Consulta [Cómo instalar Docker Desktop](#cómo-instalar-docker-desktop) más abajo

> **Idioma de la UI**: se admiten 8 idiomas (inglés, japonés, chino, coreano, español, portugués (BR), francés, alemán). Por defecto se detecta automáticamente a partir del idioma del navegador / sistema operativo. Para indicarlo explícitamente, define `VITE_LOCALE=es` en `.env`. El idioma se selecciona en tiempo de build/dev; reinicia `yarn dev` después de cambiarlo. Consulta [`docs/developer.md`](docs/developer.md#i18n-vue-i18n) para saber cómo añadir cadenas.

### Ejecutar desde el código fuente (para desarrolladores)

Si quieres modificar el código en lugar de solo ejecutarlo:

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # opcional — añade GEMINI_API_KEY para generación de imágenes
yarn dev
```

Abre [http://localhost:5173](http://localhost:5173). Consulta [`docs/developer.md`](docs/developer.md) para la arquitectura y los scripts.

> **¿La interfaz se ve rota o sin estilos?** Iconos mostrados como palabras, `404` en `dist/*`, `401` tras reiniciar — consulta [`docs/troubleshooting.md`](docs/troubleshooting.md).

## ¿Qué puedes hacer?

| Pídele a Claude...                          | Lo que obtienes                                             |
| ------------------------------------------- | ----------------------------------------------------------- |
| "Escribe una propuesta de proyecto"         | Documento markdown enriquecido en el canvas                 |
| "Grafica los ingresos del último trimestre" | Visualización interactiva con ECharts                       |
| "Crea un plan de viaje para Kioto"          | Guía ilustrada con imágenes                                 |
| "Gestiona mis pendientes"                   | Tablero Kanban con arrastrar y soltar                       |
| "Ingiere este artículo: URL"                | Página de wiki con `[[enlaces]]` para memoria a largo plazo |
| "Programa un resumen diario de noticias"    | Tarea recurrente que se ejecuta automáticamente             |
| "Genera una imagen de un atardecer"         | Imagen generada por IA (Gemini)                             |
| "Suscríbete a este feed RSS"                | Feed de datos en `/feeds`, recogido por programación        |
| "¿Qué hay nuevo en mis fuentes?"            | Elementos del feed reunidos en `/feeds`                     |

> **Páginas a las que puedes acceder directamente**: `/wiki` (explorar + Lint), `/feeds` (feeds de datos), `/collections` (apps de datos), `/automations` (tareas recurrentes), `/files`, `/skills`, `/roles`. Cada una incluye un compositor de chat propio que arranca una conversación nueva ya consciente del contexto de la página.

> **¿Quieres hackear MulmoClaude?** Consulta [`docs/developer.md`](docs/developer.md) para variables de entorno, scripts y arquitectura.

### Puentes de mensajería

Se puede acceder a MulmoClaude desde aplicaciones de mensajería mediante **procesos puente** (bridges). Los puentes se ejecutan como procesos hijos independientes y se conectan al servidor a través de socket.io.

```bash
# Interactive CLI bridge (same machine)
yarn cli

# Telegram bot bridge (requires TELEGRAM_BOT_TOKEN in .env)
yarn telegram
```

Los puentes también están disponibles como paquetes npm independientes:

```bash
# Chat platforms
npx @mulmobridge/cli@latest          # CLI bridge
npx @mulmobridge/telegram@latest     # Telegram bridge
npx @mulmobridge/slack@latest        # Slack bridge
npx @mulmobridge/discord@latest      # Discord bridge
npx @mulmobridge/line@latest         # LINE bridge
npx @mulmobridge/whatsapp@latest     # WhatsApp bridge
npx @mulmobridge/matrix@latest       # Matrix bridge
npx @mulmobridge/irc@latest          # IRC bridge
npx @mulmobridge/mattermost@latest   # Mattermost bridge
npx @mulmobridge/zulip@latest        # Zulip bridge
npx @mulmobridge/messenger@latest    # Facebook Messenger bridge
npx @mulmobridge/google-chat@latest  # Google Chat bridge
npx @mulmobridge/mastodon@latest     # Mastodon bridge
npx @mulmobridge/bluesky@latest      # Bluesky bridge
npx @mulmobridge/chatwork@latest     # Chatwork bridge (Japanese business chat)
npx @mulmobridge/xmpp@latest         # XMPP / Jabber bridge
npx @mulmobridge/rocketchat@latest   # Rocket.Chat bridge
npx @mulmobridge/signal@latest       # Signal bridge (via signal-cli-rest-api)
npx @mulmobridge/teams@latest        # Microsoft Teams bridge (Bot Framework)
npx @mulmobridge/line-works@latest   # LINE Works bridge (enterprise LINE)
npx @mulmobridge/nostr@latest        # Nostr encrypted DM bridge
npx @mulmobridge/viber@latest        # Viber bridge

# Universal / glue
npx @mulmobridge/webhook@latest      # Generic HTTP webhook (dev glue)
npx @mulmobridge/twilio-sms@latest   # SMS via Twilio
npx @mulmobridge/email@latest        # Email bridge (IMAP + SMTP)
```

Todos los puentes admiten **streaming de texto en tiempo real** (actualizaciones tipo "escribiendo" a medida que el agente escribe). CLI y Telegram también admiten **archivos adjuntos** (imágenes, PDF, DOCX, XLSX, PPTX). Consulta [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md) para ver la lista completa de plataformas e instrucciones de configuración.

### ¿Por qué necesitas una clave de API de Gemini?

MulmoClaude usa el modelo **Gemini 3.1 Flash Image (nano banana 2)** de Google para la generación y edición de imágenes. Esto impulsa:

- `generateImage` — crea imágenes a partir de descripciones de texto
- `editImage` — transforma o modifica una imagen existente (p. ej. "convertir a estilo Ghibli")
- Imágenes incrustadas en documentos (Guía de recetas, Planificador de viajes, etc.)

Sin una clave de API de Gemini, los roles que usan generación de imágenes estarán deshabilitados en la UI.

### Cómo obtener una clave de API de Gemini

1. Ve a [Google AI Studio](https://aistudio.google.com/apikey)
2. Inicia sesión con tu cuenta de Google
3. Haz clic en **Create API key**
4. Copia la clave y pégala en tu archivo `.env` como `GEMINI_API_KEY=...`

La API de Gemini tiene un nivel gratuito que es suficiente para uso personal.

## Seguridad

MulmoClaude usa Claude Code como su backend de IA, que tiene acceso a herramientas que incluyen Bash — lo que significa que puede leer y escribir archivos en tu máquina.

**Sin Docker**, Claude puede acceder a cualquier archivo al que tu cuenta de usuario pueda llegar, incluidas las claves SSH y credenciales almacenadas fuera de tu workspace. Esto es aceptable para uso personal local, pero vale la pena entenderlo.

**Con Docker Desktop instalado**, MulmoClaude ejecuta automáticamente Claude dentro de un contenedor en sandbox. Solo se montan tu workspace y la configuración propia de Claude (`~/.claude`) — el resto de tu sistema de archivos es invisible para Claude. No se requiere ninguna configuración: la app detecta Docker al iniciar y habilita el sandbox automáticamente.

**Autenticación con bearer token**: cada endpoint `/api/*` requiere un encabezado `Authorization: Bearer <token>`. El token se genera automáticamente al iniciar el servidor y se inyecta en el navegador mediante una etiqueta `<meta>` — sin configuración manual. La única excepción es `/api/files/*` (exento porque las etiquetas `<img>` en documentos renderizados no pueden adjuntar encabezados). Consulta [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api) para más detalles.

**Reenvío de credenciales al sandbox** (opt-in): por defecto el sandbox no tiene acceso a las credenciales del host. Dos variables de entorno te permiten exponer selectivamente lo que `git` / `gh` necesitan:

- `SANDBOX_SSH_AGENT_FORWARD=1` — reenvía el socket del agente SSH del host. Las claves privadas permanecen en el host.
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — monta `~/.config/gh` y `~/.gitconfig` en modo solo lectura.

Contrato completo y notas de seguridad: [`docs/sandbox-credentials.md`](docs/sandbox-credentials.md).

### Cómo instalar Docker Desktop

1. Descarga Docker Desktop desde [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
2. **macOS**: abre el `.dmg` y arrastra Docker a Applications, luego lánzalo desde Applications
3. **Windows**: ejecuta el instalador y sigue las indicaciones (WSL2 se configura automáticamente si es necesario)
4. **Linux**: sigue la [guía de instalación para Linux](https://docs.docker.com/desktop/install/linux/)
5. Espera a que Docker Desktop termine de iniciarse — el icono de la ballena en la barra de menú / bandeja del sistema debe volverse fijo (no animado)
6. Reinicia MulmoClaude — detectará Docker y construirá la imagen del sandbox en la primera ejecución (una sola vez, toma aproximadamente un minuto)

Cuando el sandbox de Docker está activo en macOS, las credenciales se gestionan automáticamente — la app extrae los tokens OAuth del Keychain del sistema al inicio y los renueva ante errores 401, por lo que no se necesitan pasos manuales.

Si Docker no está instalado, la app muestra un aviso y sigue funcionando sin sandbox.

> **Modo depuración**: para ejecutar sin sandbox aunque Docker esté instalado, define `DISABLE_SANDBOX=1` antes de iniciar el servidor, o pasa el flag de CLI `--disable-sandbox` (`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox`; funciona en Windows PowerShell).
>
> **Historial de llamadas a herramientas**: define `PERSIST_TOOL_CALLS=1` para registrar también los eventos `tool_call` (con sus `args`) en el jsonl de la sesión junto a `tool_result`. Desactivado por defecto porque `args` puede ser grande y contener bytes de carga útil (imágenes en base64, JSON de MulmoScript) que no querrías guardar en disco; útil para depurar tras refrescar la página o reiniciar el servidor. Ver [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096).

## Registro (logging)

El servidor escribe texto legible a la consola y JSON completo a archivos diarios rotativos bajo `server/system/logs/`. Todo es
configurable mediante `LOG_LEVEL`, `LOG_*_FORMAT`, `LOG_FILE_DIR`, etc.

Consulta [docs/logging.md](docs/logging.md) para la referencia completa, ejemplos de formatos, comportamiento de rotación y recetas.

## Roles

Cada rol le da a Claude una persona diferente, una paleta de herramientas distinta y un área de enfoque específica:

| Rol                 | Qué hace                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| **General**         | Asistente de propósito general — pendientes, planificador, wiki, documentos, mapas mentales |
| **Office**          | Documentos, hojas de cálculo, formularios, presentaciones, paneles de datos                 |
| **Guide & Planner** | Guías de viaje, libros de recetas, planificadores de viajes con resultados visuales ricos   |
| **Artist**          | Generación de imágenes, edición de imágenes, arte generativo con p5.js                      |
| **Tutor**           | Enseñanza adaptativa — evalúa tu nivel antes de explicar cualquier cosa                     |
| **Storyteller**     | Historias ilustradas interactivas con imágenes y escenas HTML                               |

Cambiar de rol reinicia el contexto de Claude y carga solo las herramientas que ese rol necesita — manteniendo las respuestas rápidas y enfocadas.

## Skills — Ejecuta tus Skills de Claude Code desde MulmoClaude

MulmoClaude puede listar y lanzar los **skills de Claude Code** que ya tienes. Un skill es cualquier carpeta bajo `~/.claude/skills/<name>/` que contenga un archivo `SKILL.md` con un frontmatter YAML con `description` y un cuerpo markdown de instrucciones. Consulta la [documentación de Claude Code Skills](https://docs.claude.com/en/docs/claude-code/skills) para detalles sobre cómo crear skills.

### Cómo usarlo

1. Abre MulmoClaude y permanece en uno de los roles con skills habilitados: **General**, **Office** o **Tutor**.
2. Pídele a Claude que muestre tus skills — p. ej. _"muestra mis skills"_ o _"lista los skills"_.
3. Claude invoca la herramienta `manageSkills` y se abre una vista **Skills** de panel dividido en el canvas:
   - **Izquierda**: todos los skills descubiertos en tu máquina, con su descripción e insignia de alcance (`USER` / `PROJECT`).
   - **Derecha**: el contenido completo del `SKILL.md` del skill seleccionado.
4. Haz clic en **Run** en un skill. MulmoClaude envía `/<skill-name>` a Claude como un mensaje de chat normal; la maquinaria de slash-commands de Claude Code lo resuelve contra `~/.claude/skills/` y ejecuta las instrucciones del skill inline en la misma sesión de chat.

Sin escribir nada extra, sin copiar y pegar cuerpos de SKILL.md — el botón Run es un envoltorio de un solo clic alrededor de `/skill-name`.

### Descubrimiento de skills — dos alcances

| Scope       | Location                               | Semantics                                                                                                                 |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | Skills personales, compartidos en cada proyecto que abras con la CLI de Claude.                                           |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | Skills con alcance al workspace de MulmoClaude. El alcance de proyecto **gana** si un nombre colisiona con el de usuario. |

Ambos alcances son de solo lectura en la fase 0 — las ediciones se hacen en el sistema de archivos. Una versión futura permitirá que MulmoClaude mismo cree / edite skills de alcance de proyecto.

### Sandbox de Docker vs sin Docker

El **modo sandbox de Docker** por defecto de MulmoClaude aísla Claude Code en un contenedor por seguridad (ver [Seguridad](#seguridad)). El comportamiento de los skills difiere entre los dos modos:

| Mode                                 | User skills (`~/.claude/skills/`) | Project skills (`~/mulmoclaude/.claude/skills/`) | Built-in CLI skills (`/simplify`, `/update-config`, …) |
| ------------------------------------ | --------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| **Non-Docker** (`DISABLE_SANDBOX=1`) | ✅ Todos funcionan                | ✅                                               | ✅                                                     |
| **Docker sandbox** (default)         | ⚠️ Ver advertencias abajo         | ✅ Montado mediante volumen de workspace         | ✅                                                     |

**Advertencias de Docker — por qué los skills de usuario a veces no funcionan en el sandbox:**

- **`~/.claude/skills/` enlazado simbólicamente** — si tu `~/.claude/skills` (o cualquier subentrada) es un symlink que apunta fuera de `~/.claude/` (por ejemplo `~/.claude/skills → ~/ss/dotfiles/claude/skills`), el destino del symlink no está presente dentro del contenedor. El enlace aparece como **colgante**, y Claude Code recae solo en los skills integrados.
- **CLI de Claude más antiguo dentro de la imagen del sandbox** — `Dockerfile.sandbox` fija la versión de la CLI en el momento de construir la imagen. Si esa versión está atrasada respecto a tu CLI del host (p. ej. 2.1.96 en la imagen vs 2.1.105 en el host), el descubrimiento de skills de usuario puede comportarse de forma diferente.

**Soluciones alternativas para configuraciones con muchos skills que no funcionan bien con el sandbox:**

1. **Deshabilita el sandbox para esta sesión**:

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   La CLI de Claude se ejecuta con tu `~/.claude/` real y todo se resuelve de forma nativa. Úsalo cuando confíes en los prompts que estás a punto de enviar — el sandbox sigue siendo el valor predeterminado recomendado para trabajo no confiable / exploratorio.

2. **Mueve skills al alcance de proyecto** — copia los skills específicos que quieras a `~/mulmoclaude/.claude/skills/` (esta ruta se monta como volumen del workspace dentro del sandbox, así que nada de dramas con symlinks). Ideal para skills que de todos modos son específicos de tu flujo de trabajo en MulmoClaude.

3. **Aplana los symlinks** — si mantienes tu biblioteca de skills vía symlinks (p. ej. en un repo de dotfiles), reemplazar el symlink de nivel superior `~/.claude/skills` con el directorio real es la solución más sencilla.

### Qué recibe realmente el skill

Cuando pulsas **Run**, MulmoClaude envía un turno de usuario simple que contiene la cadena del slash-command:

```text
/my-skill-name
```

Esa es toda la carga útil — MulmoClaude **no** incrusta el cuerpo de `SKILL.md` ni contexto extra. El cuerpo es lo que Claude Code lee cuando la CLI resuelve el slash command por su lado. Esto mantiene pequeña la entrada del chat y hace que skills largos (SKILL.md de varios kilobytes) sean seguros de ejecutar sin desbordar el contexto del prompt.

### Guardar una conversación como un nuevo skill

Después de un chat productivo, puedes pedirle a MulmoClaude que capture el flujo de trabajo:

```text
"この会話を fix-ci という skill にして"
"save this as a skill called publish-flow"
"skill 化して"   ← Claude picks a slug for you
```

Claude lee la transcripción actual del chat, destila los pasos que diste y escribe un nuevo `SKILL.md` en `~/mulmoclaude/.claude/skills/<slug>/`. El skill aparece en la vista Skills de inmediato y se puede invocar mediante `/<slug>` en cualquier sesión futura.

Notas sobre guardar:

- **Solo alcance de proyecto** — los guardados van a `~/mulmoclaude/.claude/skills/`, nunca a `~/.claude/skills/`. El alcance de usuario permanece de solo lectura desde MulmoClaude.
- **Sin sobreescribir** — si ya existe un skill con el mismo nombre (en cualquier alcance), el guardado falla y Claude te pedirá un nombre diferente.
- **Reglas para slugs** — letras minúsculas, dígitos y guiones; 1–64 caracteres; sin guiones iniciales / finales ni consecutivos. Claude elige uno automáticamente; si quieres un nombre específico, menciónalo en la solicitud.

### Eliminar un skill guardado

Los skills de alcance de proyecto obtienen un botón **Delete** junto al botón Run en la vista Skills (los skills de alcance de usuario son de solo lectura — no se muestra el botón Delete). Al confirmar el diálogo se elimina `~/mulmoclaude/.claude/skills/<slug>/SKILL.md`. Si además dejaste archivos adicionales en esa carpeta a mano, se dejan en su lugar; solo se elimina el SKILL.md.

También puedes pedirle a Claude que elimine por nombre:

```text
"delete the fix-ci skill"
```

## Wiki — Memoria a largo plazo para Claude Code

MulmoClaude incluye una **base de conocimiento personal** inspirada en la [idea de LLM Knowledge Bases de Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Le da a Claude Code auténtica memoria a largo plazo — no solo un `memory.md` corto, sino una wiki creciente e interconectada que Claude construye y mantiene por sí mismo.

El rol **General** tiene soporte de wiki integrado. Prueba:

- `"Ingest this article: <URL>"` — Claude descarga la página, extrae el conocimiento clave, crea o actualiza páginas de la wiki y registra la actividad
- `"What does my wiki say about transformers?"` — Claude busca en el índice, lee páginas relevantes y sintetiza una respuesta fundamentada
- `"Lint my wiki"` — chequeo de salud para páginas huérfanas, enlaces rotos y entradas de índice faltantes
- `"Show me the wiki index"` — renderiza el catálogo completo de páginas en el canvas

### Cómo funciona

La wiki vive enteramente como archivos markdown en texto plano dentro de tu workspace:

```
<workspace>/data/wiki/
  index.md          ← catalog of all pages (title, description, last updated)
  log.md            ← append-only activity log
  pages/<slug>.md   ← one page per entity, concept, or theme
  sources/<slug>.md ← raw ingested sources
```

Claude usa sus herramientas de archivos integradas (`read`, `write`, `glob`, `grep`) para navegar y mantener la wiki — no se requiere ninguna base de datos ni indexación especial. Las referencias cruzadas usan la sintaxis `[[wiki link]]`, que la UI del canvas renderiza como navegación clicable.

Con el tiempo, la wiki se convierte en una base de conocimiento personal que cualquier rol puede consultar, haciendo que Claude sea progresivamente más útil cuanto más lo uses.

## Gráficos (ECharts)

El plugin `presentChart` renderiza visualizaciones de [Apache ECharts](https://echarts.apache.org/) en el canvas. Pide una línea, barras, velas, sankey, heatmap o red/grafo — Claude escribe un objeto de opciones de ECharts y el plugin lo monta. Cada gráfico tiene un botón **[↓ PNG]** para exportar con un clic.

Disponible en los roles **General**, **Office**, **Guide & Planner** y **Tutor**. Prueba:

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### Almacenamiento

Cada llamada a `presentChart` escribe un archivo bajo `<workspace>/artifacts/charts/`:

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

Un único documento puede contener cualquier cantidad de gráficos, que se renderizan apilados en el canvas:

```json
{
  "title": "Apple Stock Analysis",
  "charts": [
    {
      "title": "Daily close",
      "type": "line",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "line", "data": [180, 195, 210] }]
      }
    },
    {
      "title": "Volume",
      "type": "bar",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "bar", "data": [1000000, 1200000, 950000] }]
      }
    }
  ]
}
```

El campo `option` se pasa a [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) de ECharts tal cual — puedes consultar la [referencia completa de opciones de ECharts](https://echarts.apache.org/en/option.html) al editar estos archivos a mano. Las ediciones se reflejan la próxima vez que el documento se vuelva a abrir en el canvas.

## Opcional: Herramientas MCP de X (Twitter)

MulmoClaude incluye herramientas MCP opcionales para leer y buscar publicaciones en X (Twitter) mediante la API oficial v2 de X.

| Tool        | What it does                                               |
| ----------- | ---------------------------------------------------------- |
| `readXPost` | Obtiene una publicación individual por URL o ID de tweet   |
| `searchX`   | Busca publicaciones recientes por palabra clave o consulta |

Estas herramientas están **deshabilitadas por defecto** y requieren un Bearer Token de la API de X para activarse.

### Configuración

1. Ve a [console.x.com](https://console.x.com) e inicia sesión con tu cuenta de X
2. Crea una nueva app — se genera un Bearer Token automáticamente
3. Copia el Bearer Token y añádelo a tu `.env`:
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. Añade créditos a tu cuenta en [console.x.com](https://console.x.com) (requerido para hacer llamadas a la API)
5. Reinicia el servidor de desarrollo — las herramientas se activan automáticamente

### Uso

Estas herramientas **solo están disponibles en roles personalizados**. Los roles integrados no las incluyen por defecto (excepto General). Para usarlas en tu propio rol:

1. Crea o edita un archivo JSON de rol personalizado en `~/mulmoclaude/roles/<id>.json`
2. Añade `readXPost` y/o `searchX` a su lista `availablePlugins`

Una vez configurado, puedes pegar cualquier URL de `x.com` o `twitter.com` en el chat y Claude la descargará y leerá automáticamente.

## Configuración de herramientas adicionales (Ajustes web)

El icono de engranaje en la barra lateral abre un modal de Ajustes donde puedes ampliar el conjunto de herramientas de Claude sin editar código. Los cambios se aplican en el siguiente mensaje (no hace falta reiniciar el servidor).

### Pestaña Allowed Tools

Pega los nombres de las herramientas, uno por línea. Útil para los servidores MCP integrados de Claude Code (Gmail, Google Calendar) después de un apretón de manos OAuth único:

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

Primero, ejecuta `claude mcp` una vez en una terminal y completa el flujo OAuth para cada servicio — las credenciales persisten bajo `~/.claude/`.

### Pestaña MCP Servers

Añade servidores MCP externos sin editar JSON a mano. Se admiten dos tipos:

- **HTTP** — servidores remotos (p. ej. `https://example.com/mcp`). Funciona en cada modo; en Docker, las URL `localhost` / `127.0.0.1` se reescriben automáticamente a `host.docker.internal`.
- **Stdio** — subproceso local (p. ej. un MCP con `npx`), restringido a `npx` / `node` / `tsx` por seguridad. Se ejecuta en el host cuando el sandbox de Docker está **desactivado**. Cuando el sandbox está **activado**, las entradas stdio se **descartan por defecto** (la imagen mínima del sandbox no puede alojar runtimes arbitrarios) — usa `"hostExecInDocker": true` para ejecutar una en el host detrás de una pasarela `stdio ↔ HTTP`. Consulta [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

Pasa credenciales a un servidor stdio con un mapa **`env`** (`"env": { "IMAP_PASS": "…" }`). Los valores son literales y se guardan en `mcp.json` (modo `0600`, pero en **texto plano** — protección por permisos de archivo, no una bóveda). Todos los detalles, incluida la opción `hostExecInDocker` y cómo llega `env` al proceso, están en [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

La configuración vive bajo `<workspace>/config/`:

```text
<workspace>/config/
  settings.json    ← extra allowed tool names
  mcp.json         ← Claude CLI --mcp-config compatible
```

El archivo MCP usa el formato estándar de la CLI de Claude, por lo que puedes copiarlo entre máquinas, o incluso usarlo directamente con la CLI `claude`.

### Edición directa de los archivos de configuración

Ambos archivos son JSON plano — puedes editarlos con cualquier editor de texto en lugar de la UI de Ajustes. El servidor los vuelve a leer en cada mensaje, por lo que:

- No hace falta reiniciar el servidor tras editar un archivo.
- Los cambios también son recogidos por la UI de Ajustes — simplemente cierra y vuelve a abrir el modal.
- La UI y el archivo siempre están sincronizados: guardar desde la UI sobrescribe el archivo, y las ediciones a mano aparecen en la UI la próxima vez que se abre.

Esto es útil para:

- Importar en bloque servidores MCP de otra estación de trabajo (copia `mcp.json` encima).
- Versionar tu configuración en un repo de dotfiles.
- Comentar un servidor temporalmente cambiando `"enabled": false`.

**Ejemplo de `mcp.json`** — un servidor HTTP remoto (público, sin auth) y un servidor local stdio:

```json
{
  "mcpServers": {
    "deepwiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "enabled": true
    },
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "enabled": true
    }
  }
}
```

Restricciones que el servidor aplica al cargar el archivo:

- Las claves de `mcpServers` (el id del servidor) deben coincidir con `^[a-z][a-z0-9_-]{0,63}$`.
- El `url` HTTP debe parsearse como `http:` o `https:`.
- El `command` de Stdio está restringido a `npx`, `node` o `tsx`.
- Las entradas que fallan la validación se descartan silenciosamente al cargar (se registra una advertencia); el resto del archivo se sigue aplicando.

**Ejemplo** — un servidor stdio con credenciales que también se ejecuta bajo el sandbox de Docker (p. ej. un MCP de IMAP):

```json
{
  "mcpServers": {
    "imap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-imap-mcp"],
      "env": { "IMAP_HOST": "imap.example.com", "IMAP_USER": "me", "IMAP_PASS": "secret" },
      "hostExecInDocker": true,
      "enabled": true
    }
  }
}
```

`hostExecInDocker` ejecuta ese servidor en el host, fuera del sandbox. Es una opción por servidor — actívala para tantos servidores como necesites, pero solo en los que confíes. Con el sandbox desactivado se ignora (el servidor ya se ejecuta en el host).

**Ejemplo de `settings.json`**:

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

No necesitas listar entradas `mcp__<id>` para servidores definidos en `mcp.json` — esos se permiten automáticamente en cada ejecución del agente. `extraAllowedTools` es solo para herramientas que no son alcanzables a través de tus propios `mcpServers`, típicamente los puentes integrados `mcp__claude_ai_*` de Claude Code después de haber ejecutado `claude mcp` y completado OAuth.

## Archivos adjuntos en el chat

Pega (Ctrl+V / Cmd+V) o arrastra y suelta archivos en la entrada del chat para enviarlos a Claude junto con tu mensaje.

| File type                                          | What Claude sees                          | Dependency                      |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------- |
| Imagen (PNG, JPEG, GIF, WebP, …)                   | Bloque de contenido de visión (nativo)    | Ninguna                         |
| PDF                                                | Bloque de contenido de documento (nativo) | Ninguna                         |
| Texto (.txt, .csv, .json, .md, .xml, .html, .yaml) | Texto UTF-8 decodificado                  | Ninguna                         |
| DOCX                                               | Texto plano extraído                      | `mammoth` (npm)                 |
| XLSX                                               | CSV por hoja                              | `xlsx` (npm)                    |
| PPTX                                               | Convertido a PDF                          | LibreOffice (sandbox de Docker) |

La conversión de PPTX se ejecuta dentro de la imagen del sandbox de Docker (`libreoffice --headless`). Sin Docker, un mensaje sugiere exportar a PDF o imágenes en su lugar. El tamaño máximo de archivo adjunto es 30 MB.

## Modos de vista del canvas

El canvas (panel derecho) admite 8 modos de vista, intercambiables mediante la barra de herramientas del lanzador, el parámetro de consulta en la URL o un atajo de teclado:

| Shortcut     | View      | URL param         | Description                                         |
| ------------ | --------- | ----------------- | --------------------------------------------------- |
| `Cmd/Ctrl+1` | Single    | (default)         | Muestra el resultado de la herramienta seleccionada |
| `Cmd/Ctrl+2` | Stack     | `?view=stack`     | Todos los resultados apilados verticalmente         |
| `Cmd/Ctrl+3` | Files     | `?view=files`     | Explorador de archivos del workspace                |
| `Cmd/Ctrl+5` | Scheduler | `?view=scheduler` | Calendario de tareas programadas                    |
| `Cmd/Ctrl+6` | Wiki      | `?view=wiki`      | Índice de páginas de la wiki                        |
| `Cmd/Ctrl+7` | Skills    | `?view=skills`    | Lista y editor de skills                            |
| `Cmd/Ctrl+8` | Roles     | `?view=roles`     | Gestión de roles                                    |

Cada modo de vista está impulsado por la URL: hacer clic en un botón del lanzador actualiza `?view=`, y aterrizar en una URL con `?view=wiki` (por ejemplo) restaura la vista correspondiente. La lista de modos de vista se define una sola vez en `src/utils/canvas/viewMode.ts` — añadir un nuevo modo es un simple append al array.

## Acceso remoto

Accede a tu MulmoClaude en ejecución desde un teléfono (o cualquier navegador): explora sus colecciones, feeds y vistas personalizadas, e inicia chats, desde cualquier lugar. No hay que configurar ninguna cuenta ni servidor aparte: el acceso se concede simplemente iniciando sesión en **ambos** extremos con la **misma cuenta de Google**.

**Cómo conectar**

1. En el escritorio, haz clic en el icono **phonelink** de la cabecera para abrir el popover _Host remoto_ y elige **Iniciar sesión con Google**. MulmoClaude inicia sesión como tu usuario de Google y abre un canal de comandos a través de Firebase (el proyecto público compartido [`mulmoserver`](https://mulmoserver.web.app)). El icono se pone verde mientras el host está en línea.
2. En tu teléfono, abre **[https://mulmoserver.web.app](https://mulmoserver.web.app)** e inicia sesión con la **misma cuenta de Google**. La app web encuentra tu host en línea y se conecta a él.

Como ambos extremos se autentican como el mismo usuario de Firebase, el teléfono y el escritorio solo se encuentran dentro de tu propio espacio de usuario; ningún tercero puede acceder a tu host.

**Firebase y Firestore se usan únicamente como transporte**: un relé para pasar comandos y respuestas entre tu teléfono y tu escritorio. Tus datos **nunca se almacenan ni se conservan** en ninguno de los dos. En el host solo existen tus archivos locales del workspace; todo lo que deba cruzar el canal (como un adjunto en tránsito por Firebase Storage) se elimina en cuanto llega a su destino.

**Qué puedes hacer desde el teléfono**

- Explorar y paginar tus **colecciones** y **feeds**.
- Abrir **vistas remotas personalizadas** (custom remote views): páginas adaptadas a móvil que Claude crea para ti. Pídele a Claude que cree una _custom remote view_ (no una vista personalizada normal); puede ser de solo lectura o editable.
- **Iniciar un chat** en el host y adjuntar **fotos, vídeos o PDF** desde el teléfono. Los bytes de los adjuntos son demasiado grandes para el canal de comandos, así que pasan por Firebase Storage; el host descarga cada archivo en su workspace (`data/attachments/`), elimina la copia en tránsito y entrega el archivo a Claude junto con tu mensaje.

El canal está basado en comandos y lo dirige el host: el teléfono envía peticiones y tu MulmoClaude de escritorio las responde. Usa **Desconectar** en el popover (o cierra MulmoClaude) para poner el host fuera de línea.

## Workspace

Todos los datos se almacenan como archivos planos en el directorio del workspace, agrupados en cuatro cubos semánticos (#284):

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

Consulta [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude) para la referencia completa.

### Listas de pendientes

Las listas de pendientes se construyen como **colecciones** basadas en esquema, no como una vista dedicada. Pídele a Claude que "configure una lista de pendientes" y seguirá `config/helps/todo-collection.md` para crear una colección `todos` — con un enum de estado (`Backlog / Todo / In Progress / Done`), un toggle `done`, y campos opcionales de prioridad / fecha de vencimiento, eligiendo automáticamente una vista kanban / tabla / calendario según el esquema.

### Programador y programación de skills

El programador (`Cmd/Ctrl+5` o `?view=scheduler`) gestiona tareas recurrentes almacenadas en `data/scheduler/items.json`. El núcleo del programador (`@receptron/task-scheduler`) maneja la lógica de recuperación para ejecuciones perdidas y admite los horarios `interval`, `daily` y `cron`.

Los skills pueden programarse para ejecutarse automáticamente añadiendo un campo `schedule` al frontmatter del SKILL.md:

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude registrará el skill en el programador, y se ejecutará automáticamente según el horario especificado.

### Extracción de memoria

Claude extrae automáticamente hechos duraderos del usuario a partir de las conversaciones del chat y los anexa a `conversations/memory.md`. Esto se ejecuta como parte de la pasada diaria del diario — hechos como preferencias alimentarias, hábitos de trabajo y preferencias de herramientas se destilan a partir de chats recientes sin intervención del usuario. El archivo de memoria siempre se carga en el contexto del agente para que Claude pueda personalizar las respuestas.

## Paquetes del monorepo

El código compartido se extrae en paquetes npm publicables bajo `packages/`:

| Package                     | Description                                                      | Links                                                                                                   |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | Tipos y constantes compartidos                                   | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [source](packages/protocol/)               |
| `@mulmobridge/client`       | Librería cliente de Socket.io                                    | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [source](packages/client/)                   |
| `@mulmobridge/chat-service` | Servicio de chat del lado del servidor (factory DI)              | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [source](packages/chat-service/)       |
| `@mulmobridge/cli`          | Puente de terminal                                               | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [source](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Puente de bot de Telegram                                        | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [source](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Puente de bot de Slack                                           | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [source](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Puente de bot de Discord                                         | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [source](packages/bridges/discord/)         |
| `@mulmobridge/line`         | Puente de bot de LINE                                            | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [source](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | Puente de WhatsApp                                               | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [source](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Puente de Matrix                                                 | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [source](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | Puente de IRC                                                    | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [source](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Puente de Mattermost                                             | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [source](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Puente de Zulip                                                  | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [source](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Puente de Facebook Messenger                                     | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [source](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Puente de Google Chat                                            | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [source](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Puente de Mastodon                                               | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [source](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Puente de Bluesky                                                | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [source](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Puente de Chatwork (chat empresarial japonés)                    | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [source](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | Puente de XMPP / Jabber                                          | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [source](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Puente de Rocket.Chat                                            | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [source](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Puente de Signal (vía signal-cli-rest-api)                       | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [source](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Puente de Microsoft Teams (Bot Framework)                        | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [source](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | Puente de LINE Works (LINE empresarial)                          | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [source](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Puente de DM cifrado de Nostr                                    | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [source](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Puente de Viber                                                  | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [source](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | Puente genérico de webhook HTTP (pegamento para desarrolladores) | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [source](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | SMS vía Twilio                                                   | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [source](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | Puente de Email (IMAP + SMTP)                                    | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [source](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | Servidor mock para pruebas                                       | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [source](packages/mock-server/)         |
| `@receptron/task-scheduler` | Programador de tareas persistente                                | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [source](packages/scheduler/)          |

Cualquiera puede escribir un puente en cualquier lenguaje — solo necesita hablar el protocolo de socket.io documentado en [`docs/bridge-protocol.md`](docs/bridge-protocol.md).

## Documentación

La documentación completa vive en [`docs/`](docs/README.md). Aquí están los puntos de entrada clave:

### Para usuarios

| Guide                                                                                                      | Description                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [MulmoBridge Guide](docs/mulmobridge-guide.en.md) / [日本語](docs/mulmobridge-guide.md)                    | Conecta aplicaciones de mensajería (Telegram, Slack, LINE, etc.) a tu PC de casa |
| [Scheduler Guide](docs/scheduler-guide.en.md) / [日本語](docs/scheduler-guide.md)                          | Tareas automáticas recurrentes                                                   |
| [Obsidian Integration](docs/tips/obsidian.en.md) / [日本語](docs/tips/obsidian.md)                         | Usa Obsidian para navegar la wiki y los documentos de MulmoClaude                |
| [Telegram Setup](docs/message_apps/telegram/README.md) / [日本語](docs/message_apps/telegram/README.ja.md) | Configuración paso a paso de un bot de Telegram                                  |
| [LINE Setup](docs/message_apps/line/README.md) / [日本語](docs/message_apps/line/README.ja.md)             | Configuración paso a paso de un bot de LINE                                      |

### Para desarrolladores

| Guide                                              | Description                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| [Developer Guide](docs/developer.md)               | Variables de entorno, scripts, estructura del workspace, CI                |
| [Bridge Protocol](docs/bridge-protocol.md)         | Especificación a nivel de cable para escribir nuevos puentes de mensajería |
| [Sandbox Credentials](docs/sandbox-credentials.md) | Reenvío de credenciales del sandbox de Docker (SSH, CLI de GitHub)         |
| [Logging](docs/logging.md)                         | Niveles de log, formatos, rotación de archivos                             |
| [Troubleshooting](docs/troubleshooting.md)         | Problemas de instalación — interfaz rota, `404` en `dist/*`, Windows/OneDrive, `401` tras reiniciar, avisos de arranque |
| [CHANGELOG](docs/CHANGELOG.md)                     | Historial de versiones                                                     |

## Licencia

MIT — consulta [LICENSE](LICENSE).
