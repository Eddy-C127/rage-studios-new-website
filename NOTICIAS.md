# Noticias y Novedades — Rage Studios
> Documento de arquitectura, configuración e implementación  
> Fecha: 2026-04-21

---

## 1. ¿Qué es este módulo?

Sistema de publicación de noticias y novedades que aparecen en el dashboard del cliente como tarjetas horizontales deslizables (scroll horizontal). El admin puede crear, editar, activar/desactivar y programar noticias. Opcionalmente puede adjuntar imagen y un botón CTA (call to action).

---

## 2. Estado actual del desarrollo

| Componente | Estado |
|---|---|
| Tabla `news` en Supabase | ✅ Creada |
| Bucket `news-images` en Storage | ✅ Creado |
| RLS — SELECT para usuarios autenticados | ✅ Configurada |
| RLS — INSERT para bucket (admin) | ✅ Configurada (con errores iniciales, corregida) |
| `NewsService` (Angular) | ✅ Completo |
| `AdminNoticias` page (tabla desktop + cards mobile) | ✅ Completo |
| `AdminNewsDialog` (crear/editar) | ✅ Completo |
| Sección "Novedades" en dashboard cliente | ✅ Completo |
| CTA links funcionales en dashboard | ✅ Corregido (era `<div>`, ahora `<a>` con routerLink) |
| Edge Function `publish-scheduled-news` | ✅ Creada |
| Cron Job para publicación programada | ⚠️ Pendiente de configurar en Supabase |
| Notificación push al publicar | ⚠️ Implementada en edge function, depende de FCM_SERVER_KEY |

---

## 3. Arquitectura del módulo

```
Admin crea/edita noticia
        ↓
AdminNewsDialog → NewsService.createNews() / updateNews()
        ↓
Supabase tabla `news`
        ↓
        ├── Si is_active = true y sin fecha → published_at = now() → visible inmediatamente
        └── Si tiene scheduled_at → se publica vía Edge Function (cron)

Cliente abre dashboard
        ↓
NewsService.getActiveNews() → noticias con is_active=true y published_at no nulo
        ↓
Sección "Novedades" en dashboard.html (scroll horizontal, tarjetas)
```

---

## 4. Base de datos — tabla `news`

### Migración SQL completa

```sql
CREATE TABLE news (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT        NOT NULL,
  body              TEXT        NOT NULL,
  tag               TEXT,                          -- ej: "18 ABR", "NUEVO"
  tag_color         TEXT        DEFAULT 'red',     -- red | blue | green | amber | purple
  image_url         TEXT,                          -- URL pública del Storage
  link_label        TEXT,                          -- texto del botón CTA
  link_url          TEXT,                          -- destino del botón CTA
  is_active         BOOLEAN     NOT NULL DEFAULT false,
  send_notification BOOLEAN     NOT NULL DEFAULT false,
  notification_sent BOOLEAN     NOT NULL DEFAULT false,
  scheduled_at      TIMESTAMPTZ,                   -- null = publicar al activar
  published_at      TIMESTAMPTZ,                   -- null = no publicado aún
  created_by        UUID        REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER news_updated_at
  BEFORE UPDATE ON news
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### RLS — Row Level Security

```sql
-- Habilitar RLS
ALTER TABLE news ENABLE ROW LEVEL SECURITY;

-- Clientes autenticados pueden leer noticias activas y publicadas
CREATE POLICY "authenticated users can read active news"
  ON news FOR SELECT
  TO authenticated
  USING (is_active = true AND published_at IS NOT NULL);

-- Admins pueden leer todo (via service_role en edge functions)
-- Para el panel admin usar service_role key o:
CREATE POLICY "admins can do everything"
  ON news FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
```

---

## 5. Storage — bucket `news-images`

### Crear el bucket

En Supabase Dashboard → Storage → New Bucket:
- **Name:** `news-images`
- **Public:** ✅ Sí (para que las URLs sean accesibles sin autenticación)

### Políticas del bucket

Ir a Storage → `news-images` → Policies → New Policy → Custom

#### Política 1 — SELECT (lectura pública)

```
Policy name : Public read for news-images
Allowed operation : SELECT
Target roles : (dejar vacío = todos, incluso anónimos)
Policy definition :
  bucket_id = 'news-images'
```

#### Política 2 — INSERT (solo admins pueden subir)

```
Policy name : Admin insert for news-images
Allowed operation : INSERT
Target roles : authenticated
Policy definition :
  bucket_id = 'news-images'
  AND EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
```

> ⚠️ **Error común:** No pegar el `CREATE POLICY ... WITH CHECK (...)` completo en el campo
> "Policy definition" — ese campo solo acepta la expresión booleana interna.
> Solo pegar lo que va dentro del `WITH CHECK (...)`.

#### Política 3 — UPDATE (para `upsert: true` al resubir)

```
Policy name : Admin update for news-images
Allowed operation : UPDATE
Target roles : authenticated
Policy definition :
  bucket_id = 'news-images'
  AND EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
```

---

## 6. Edge Function — `publish-scheduled-news`

**Archivo:** `supabase/functions/publish-scheduled-news/index.ts`

### ¿Qué hace?

Busca noticias con `scheduled_at <= now()` que aún no tienen `published_at`, las marca como publicadas y opcionalmente envía una notificación push a todos los usuarios con push habilitado.

### Deploy de la función

```bash
# Desde la raíz del proyecto
supabase functions deploy publish-scheduled-news
```

### Variables de entorno necesarias

Configurar en Supabase Dashboard → Project Settings → Edge Functions → Secrets:

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto (automática en edge functions) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (automática en edge functions) |
| `FCM_SERVER_KEY` | Firebase Cloud Messaging server key (para push notifications) |

> Si `FCM_SERVER_KEY` no está configurada, la función publica igual pero no envía notificación.

### Lógica interna

```
1. Consulta: news WHERE scheduled_at <= now() AND published_at IS NULL AND is_active = true
2. Para cada noticia encontrada:
   a. UPDATE news SET published_at = now() WHERE id = X
   b. Si send_notification = true AND notification_sent = false AND FCM_SERVER_KEY existe:
      - Obtiene todos los tokens de push de user_notification_preferences
      - Envía POST a https://fcm.googleapis.com/fcm/send
      - UPDATE news SET notification_sent = true
3. Retorna { published: N }
```

### ⚠️ Cron Job — PENDIENTE

La edge function existe pero necesita ser invocada periódicamente. Configurar en Supabase Dashboard → Edge Functions → `publish-scheduled-news` → Schedule:

```
Cron expression: */5 * * * *
```
(cada 5 minutos — ajustar según necesidad)

O alternativamente con el CLI:
```bash
supabase functions schedule publish-scheduled-news --cron "*/5 * * * *"
```

---

## 7. Servicio Angular — `NewsService`

**Archivo:** `src/app/core/services/news.service.ts`

### Interfaces

```typescript
interface NewsItem {
  id: string;
  title: string;
  body: string;
  tag: string | null;
  tag_color: string;          // 'red' | 'blue' | 'green' | 'amber' | 'purple'
  image_url: string | null;
  link_label: string | null;
  link_url: string | null;
  is_active: boolean;
  send_notification: boolean;
  notification_sent: boolean;
  scheduled_at: string | null;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

type NewsStatus = 'draft' | 'scheduled' | 'published' | 'inactive';
```

### Métodos disponibles

| Método | Descripción |
|---|---|
| `getActiveNews()` | Noticias activas y publicadas — para el dashboard cliente |
| `getAllNews()` | Todas las noticias — para el panel admin |
| `getById(id)` | Una noticia por ID |
| `createNews(input, userId)` | Crear noticia — si is_active y sin schedule, publica inmediatamente |
| `updateNews(id, input)` | Editar noticia — si se activa sin schedule y no tenía published_at, lo pone ahora |
| `deleteNews(id)` | Eliminar noticia |
| `uploadImage(file, newsId)` | Sube imagen al bucket `news-images` y retorna la URL pública |
| `getStatus(item)` | Retorna el NewsStatus derivado del estado del item |

### Lógica de publicación inmediata

```typescript
// En createNews():
const publishNow = input.is_active && !input.scheduled_at;
published_at: publishNow ? new Date().toISOString() : null

// En updateNews():
// Si se activa sin schedule y no había published_at previo → poner published_at ahora
```

---

## 8. UI — Panel Admin

### Página: `AdminNoticias`

**Ruta:** `/admin/noticias`  
**Archivos:** `src/app/features/admin/pages/admin-noticias/`

#### Funcionalidades

- Barra de búsqueda por título o etiqueta
- Vista desktop: tabla con columnas (imagen, título, etiqueta, fecha creación, estado, fecha publicación, toggle activo, acciones)
- Vista mobile: cards apiladas con paginador
- Skeletons de carga
- Toggle activo/inactivo inline
- Botones editar / eliminar (con confirm dialog)
- Botón "Nueva noticia" → abre `AdminNewsDialog`

#### Estados de una noticia

| Estado | Condición | Color |
|---|---|---|
| `published` | `is_active = true` y `published_at` no nulo | Verde |
| `scheduled` | `is_active = true` y `scheduled_at` no nulo y sin `published_at` | Azul |
| `draft` | `is_active = false` y sin `published_at` | Gris |
| `inactive` | `is_active = false` con `published_at` | Amarillo |

### Diálogo: `AdminNewsDialog`

**Archivo:** `src/app/features/admin/pages/admin-noticias/components/admin-news-dialog.ts`

#### Campos del formulario

| Campo | Tipo | Descripción |
|---|---|---|
| Título | Text input | Obligatorio |
| Descripción | Textarea | Obligatorio |
| Etiqueta | Text input | Ej: "18 ABR", "NUEVO" |
| Color etiqueta | Select | red / blue / green / amber / purple |
| Texto CTA | Text input | Ej: "Ver más", "Agendar ya" |
| URL CTA | Text input | Ruta interna `/dashboard/reservas` o URL externa |
| Imagen | File upload | JPG/PNG/WEBP, máx 5MB — sube a Storage y guarda URL |
| Activo | Toggle | Si está activo y sin fecha → publica al guardar |
| Enviar notificación push | Toggle | Se procesa en la edge function |
| Publicación programada | DatePicker con hora | Opcional — si vacío, publica al activar |

---

## 9. UI — Dashboard Cliente

### Sección "Novedades"

**Archivo:** `src/app/features/dashboard/pages/dashboard/dashboard.html`

- Scroll horizontal con `snap-x`
- Cards de **256px de ancho fijo** (`w-[256px] min-w-[256px] max-w-[256px]`)
- Imagen: `h-28 object-cover w-full` — se recorta a la altura, no deforma la card
- Etiqueta (tag) con color configurable
- Título y descripción (máx 2 líneas con `line-clamp-2`)
- Botón CTA como `<a>` con:
  - `[routerLink]` para rutas internas (`/...`)
  - `target="_blank"` para URLs externas (`http...`)
- La sección solo aparece si `news().length > 0`

### Cómo se carga

```typescript
// En dashboard.ts — ngOnInit
const data = await this.newsService.getActiveNews();
this.news.set(data);
```

---

## 10. Flujos completos de uso

### Publicación inmediata

```
Admin → Nueva noticia → llena campos → activa toggle "Activo" → sin fecha programada
→ Guardar → published_at = now() → aparece en dashboard de clientes de inmediato
```

### Publicación programada

```
Admin → Nueva noticia → activa toggle "Activo" → selecciona fecha futura
→ Guardar → scheduled_at = fecha, published_at = null
→ Cron job (cada 5 min) invoca publish-scheduled-news
→ Edge function detecta la noticia → UPDATE published_at = now()
→ Si send_notification = true → envía push a todos los usuarios
→ Aparece en dashboard de clientes
```

### Desactivar una noticia

```
Admin → toggle "Activo" en OFF → is_active = false
→ getActiveNews() ya no la retorna → desaparece del dashboard
(published_at se conserva — historial)
```

---

## 11. Problemas encontrados y soluciones

### Error al subir imagen — "No se pudo subir la imagen"

**Causa:** Las políticas RLS del bucket `news-images` no estaban configuradas o se pegó el SQL completo (`CREATE POLICY ... WITH CHECK (...)`) en el campo "Policy definition" de Supabase, que solo acepta la expresión booleana.

**Solución:** En el campo "Policy definition" solo pegar:
```sql
bucket_id = 'news-images'
AND EXISTS (
  SELECT 1 FROM profiles
  WHERE profiles.id = auth.uid()
  AND profiles.role = 'admin'
)
```

### CTA no hacía nada al tocar

**Causa:** El botón CTA estaba renderizado como `<div>` sin evento de click ni href.

**Solución:** Cambiar a `<a [href]="..." [routerLink]="..." [attr.target]="...">` con lógica para rutas internas vs externas. Requirió agregar `RouterModule` a los imports del componente dashboard.

---

## 12. Pendientes

- [ ] **Configurar cron job** en Supabase para `publish-scheduled-news` (cada 5 min)
- [ ] **Configurar `FCM_SERVER_KEY`** en los secrets de Edge Functions para activar push al publicar
- [ ] **Política UPDATE** del bucket `news-images` si se necesita reemplazar imágenes existentes (upsert)
- [ ] **Eliminar imagen del Storage** cuando se elimina una noticia (actualmente solo se elimina el registro en BD)
- [ ] **Vista previa** de cómo se verá la card antes de publicar (nice to have)
