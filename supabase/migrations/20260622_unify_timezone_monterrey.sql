-- ============================================================================
-- MIGRATION: unificar el timezone de las funciones a 'America/Monterrey'
-- Date: 2026-06-22
-- Description:
--   El negocio está en Monterrey. close_past_bookings() ya usaba 'America/Monterrey'
--   pero el resto de funciones usaba 'America/Mexico_City'. Ambas zonas son UTC-6
--   sin horario de verano, así que NO hay cambio de comportamiento hoy; el objetivo
--   es consistencia y correctez (todas hablan de la zona de la sede).
--
--   Se hace de forma mecánica y exacta: para cada función de public que contiene el
--   literal 'America/Mexico_City', se toma su definición real (pg_get_functiondef),
--   se reemplaza solo ese literal por 'America/Monterrey' y se vuelve a crear con
--   CREATE OR REPLACE (conserva el mismo oid y sus triggers asociados).
--
--   Funciones afectadas (13): admin_checkin_membership_today, checkin_scan_pass,
--   enroll_in_waitlist, get_checkin_classes_today, get_checkin_roster,
--   get_session_availability, mx_today, promote_waitlist_for_session,
--   schedule_all_booking_notifications, schedule_reminder_notification,
--   validate_membership_beds, validate_membership_reactivation_beds,
--   validate_membership_schedule_beds.
--
--   Nota: el timezone por defecto de la base (GUC TimeZone) se deja como está; es
--   idéntico en offset y cambiarlo es más amplio y sin beneficio funcional.
-- ============================================================================

DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%America/Mexico_City%'
  LOOP
    EXECUTE replace(r.def, 'America/Mexico_City', 'America/Monterrey');
    RAISE NOTICE 'timezone unificado en: %', r.proname;
  END LOOP;
END
$do$;
