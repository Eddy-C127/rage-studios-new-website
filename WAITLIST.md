# Waitlist — Rage Studios
> Documento de arquitectura e implementación  
> Fecha: 2026-04-21

---

## 1. Resumen del flujo

Cuando una sesión está llena, la clienta puede unirse a la lista de espera sin que se le descuente ningún crédito. Si alguien cancela su reserva, el sistema asigna automáticamente el lugar al primero en la lista que tenga créditos disponibles, le descuenta el crédito y le envía una notificación push.

---

## 2. Reglas de negocio

| Regla | Valor |
|---|---|
| ¿Se descuenta crédito al inscribirse? | ❌ No — solo al confirmar |
| ¿Cómo se confirma? | ✅ Auto-reserva (sin acción del usuario) |
| Ventana de confirmación | N/A — es automática |
| Límite de waitlist por sesión | Igual al cupo de la sesión (ej. 12 camas → max 12 en espera) |
| ¿Se puede salir de la waitlist? | ✅ Sí, sin penalización (no hay crédito que devolver) |
| ¿Qué pasa si el usuario no tiene créditos? | Se salta al siguiente en la lista |
| ¿Qué pasa si nadie en la lista tiene créditos? | La cama queda libre sin reservar |

---

## 3. Flujo paso a paso

```
1. Clienta abre el booking dialog
2. Ve una sesión marcada como "Completa"
3. Toca "Lista de espera"
4. Se crea un registro en waitlist_entries (status: 'waiting', sin cobrar)
5. Clienta ve confirmación: "Estás en la lista de espera, posición #N"

--- más tarde ---

6. Otra clienta cancela su reserva
7. El frontend llama al servicio de cancelación
8. El servicio invoca la Edge Function `process-waitlist` con { session_id, freed_bed_id }

--- dentro de process-waitlist ---

9. Consulta waitlist_entries WHERE session_id = X AND status = 'waiting' ORDER BY position ASC
10. Toma el primero (#1)
11. Verifica si tiene créditos disponibles
    ├── SÍ: crea booking, descuenta 1 crédito, status → 'confirmed', envía push → FIN
    └── NO: status → 'skipped', pasa al #2 y repite desde paso 11
12. Si ninguno tiene créditos: la cama queda libre
```

---

## 4. Base de datos

### Tabla nueva: `waitlist_entries`

```sql
CREATE TABLE waitlist_entries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position      INTEGER     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'waiting',
    -- waiting | confirmed | skipped | cancelled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at  TIMESTAMPTZ,   -- cuando se auto-confirmó (se creó la reserva)
  cancelled_at  TIMESTAMPTZ,   -- cuando la clienta salió de la lista voluntariamente

  UNIQUE (session_id, user_id)  -- no puede estar 2 veces en la misma sesión
);
```

### Índices recomendados

```sql
CREATE INDEX idx_waitlist_session_status
  ON waitlist_entries (session_id, status, position);
```

### RLS (Row Level Security)

```sql
-- Clienta solo ve sus propias entradas
CREATE POLICY "user sees own waitlist"
  ON waitlist_entries FOR SELECT
  USING (auth.uid() = user_id);

-- Clienta puede insertar la suya
CREATE POLICY "user inserts own waitlist"
  ON waitlist_entries FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Clienta puede cancelar la suya (UPDATE status → cancelled)
CREATE POLICY "user cancels own waitlist"
  ON waitlist_entries FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (status = 'cancelled');

-- Edge Function (service_role) puede hacer todo
-- (service_role bypasses RLS by default)
```

---

## 5. Edge Function: `process-waitlist`

**Archivo:** `supabase/functions/process-waitlist/index.ts`

### Input

```typescript
{
  session_id: string   // UUID de la sesión que liberó una cama
}
```

### Lógica interna

```typescript
1. Obtener la lista de espera activa:
   SELECT * FROM waitlist_entries
   WHERE session_id = $session_id AND status = 'waiting'
   ORDER BY position ASC

2. Para cada entrada en orden:
   a. Verificar créditos del usuario:
      SELECT SUM(credits_remaining) FROM credit_batches
      WHERE user_id = $user_id AND credits_remaining > 0
      AND (expiration_date IS NULL OR expiration_date > now())

   b. Si créditos >= 1:
      - INSERT INTO bookings (...) → nueva reserva
      - Descontar 1 crédito del batch más próximo a vencer
      - UPDATE waitlist_entries SET status = 'confirmed', confirmed_at = now()
      - Enviar push notification al usuario
      - RETURN (proceso termina)

   c. Si créditos < 1:
      - UPDATE waitlist_entries SET status = 'skipped'
      - Continuar con el siguiente

3. Si nadie pudo confirmar:
   - Log: "Waitlist procesada sin confirmación para session_id X"
```

### Output

```typescript
{
  processed: true,
  confirmed_user_id: string | null,   // null si nadie confirmó
  skipped_count: number
}
```

---

## 6. Notificación push

La notificación se envía desde dentro de `process-waitlist` usando el servicio de notificaciones existente (`notification_logs` + Web Push).

```
Título : "¡Tu lugar está listo! 🎉"
Cuerpo  : "Quedaste reservada en [nombre sesión] el [día] a las [hora]. ¡Te esperamos!"
```

> No requiere acción de la clienta — la reserva ya está hecha cuando recibe la notif.

---

## 7. UI — cambios necesarios

### 7.1 Booking Dialog (sesiones llenas)

Cuando `session.available_spots === 0`:
- Mostrar overlay con fondo blur sobre la card de la sesión
- Texto: **"COMPLETA"**
- Botón primario: **"Lista de espera"** (`pi-clock`)
- Si ya está en la lista: mostrar **"En espera — posición #N"** + botón "Salir de la lista"

### 7.2 Mis Reservas / My Bookings

Agregar sección separada **"En espera"** antes o después de las reservas confirmadas:
- Card por cada waitlist_entry con status `waiting`
- Muestra: nombre de sesión, fecha, hora, posición en lista
- Botón: "Salir de la lista" (cancela sin penalización)

### 7.3 Admin — vista de waitlist por sesión

En `admin/sessions` o en el detalle de cada sesión:
- Tab o sección: "Lista de espera"
- Tabla: posición | nombre clienta | fecha de inscripción | status
- Acción manual: mover posición, eliminar entrada

---

## 8. Casos edge a considerar

| Caso | Comportamiento esperado |
|---|---|
| Clienta cancela su reserva en la misma sesión donde está en waitlist | No aplica — no puede reservar y estar en waitlist simultáneamente |
| Clienta sin créditos al momento de procesar | Se salta, status → `skipped`, pasa al siguiente |
| Dos cancelaciones simultáneas en la misma sesión | Cada una dispara `process-waitlist` por separado; la segunda encontrará la lista ya procesada o en menor cantidad |
| Sesión cancelada por admin | `ON DELETE CASCADE` limpia los waitlist_entries automáticamente |
| Clienta ya reservada intenta entrar a waitlist | Validar en frontend y backend: si ya tiene booking activo para esa sesión, bloquear |
| Waitlist llena (posición > cupo) | Mostrar "Lista de espera llena" en lugar del botón |

---

## 9. Orden de implementación sugerido

- [ ] **1. Migración SQL** — crear tabla `waitlist_entries` + índices + RLS
- [ ] **2. Edge Function** — `process-waitlist` con lógica de créditos y notificación
- [ ] **3. WaitlistService** — Angular service con métodos: `joinWaitlist()`, `leaveWaitlist()`, `getMyWaitlistEntries()`
- [ ] **4. Booking Dialog UI** — overlay "Completa" + botón lista de espera
- [ ] **5. Mis Reservas UI** — sección "En espera" con opción de salir
- [ ] **6. Integrar `process-waitlist`** en el flujo de cancelación de reservas
- [ ] **7. Admin UI** — vista de waitlist por sesión
- [ ] **8. Testing** — probar flujo completo: inscripción → cancelación → auto-reserva → push

---

## 10. Dependencias con sistemas existentes

| Sistema | Relación |
|---|---|
| `sessions` | Referencia para saber cupo y datos de la sesión |
| `bookings` | La edge function crea un booking al confirmar |
| `credit_batches` | Se descuenta del batch más próximo a vencer |
| `notification_logs` + Web Push | Para enviar la notificación a la clienta |
| `booking.service.ts` | Debe invocar `process-waitlist` al cancelar una reserva |
| `booking-dialog` | UI principal donde la clienta ve "Completa" y se une |
