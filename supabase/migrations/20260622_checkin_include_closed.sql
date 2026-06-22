-- ============================================================================
-- MIGRATION: el check-in debe ver reservas 'closed', no solo 'active'
-- Date: 2026-06-22
-- Description:
--   close_past_bookings() mueve las reservas pasadas a status='closed'. Las tres
--   funciones de recepción (get_checkin_classes_today, get_checkin_roster,
--   checkin_scan_pass) filtraban status='active', por lo que una clase ya cerrada
--   desaparecía de la lista y el escáner respondía "fuera de horario" (caso real:
--   la clase de las 06:00 que el cron cerró a las 06:00 en punto).
--   Se cambia el filtro de "status='active'" a "status<>'cancelled'" (incluye
--   'active' y 'closed') en las consultas de LECTURA/BÚSQUEDA. El UPDATE de
--   auto-marcado de inasistencias se deja en status='active' a propósito, para
--   no reescribir ni recalcular rachas al navegar a fechas pasadas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_checkin_classes_today(p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_now_local timestamp := (now() at time zone 'America/Mexico_City');
  v_today     date := coalesce(p_date, (now() at time zone 'America/Mexico_City')::date);
  v_isodow    int  := extract(isodow from v_today)::int;
  v_before    int;
  v_after     int;
begin
  if not public.is_admin() then
    return jsonb_build_object('error', 'NOT_ADMIN');
  end if;

  select coalesce(value, '30')::int into v_before from public.app_settings where key = 'checkin_window_before_minutes';
  select coalesce(value, '30')::int into v_after  from public.app_settings where key = 'checkin_window_after_minutes';
  v_before := coalesce(v_before, 30);
  v_after  := coalesce(v_after, 30);

  -- Auto-mark past bookings as unattended (se mantiene en 'active' a propósito)
  update public.bookings
  set attendance_status = 'unattended',
      attendance_marked_at = now(),
      check_in_source = 'auto_system'
  where session_date <= (now() at time zone 'America/Mexico_City')::date
    and (session_date < (now() at time zone 'America/Mexico_City')::date or (session_date + session_time + interval '50 minutes') < v_now_local)
    and status = 'active'
    and attendance_status is null;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'session_time', to_char(t.session_time, 'HH24:MI'),
        'coach_name',   t.coach_name,
        'expected',     t.expected,
        'checked',      t.checked,
        'is_current',   (v_now_local >= (v_today + t.session_time) - make_interval(mins => v_before)
                         and v_now_local <= (v_today + t.session_time) + make_interval(mins => v_after))
      ) order by t.session_time)
    from (
      select x.session_time,
             max(x.coach_name) as coach_name,
             count(*) as expected,
             count(*) filter (where x.attended) as checked
      from (
        -- Reservas (créditos o VIP ya materializada)
        select b.session_time, b.coach_name,
               (b.attendance_status = 'attended') as attended
        from public.bookings b
        where b.session_date = v_today and b.status <> 'cancelled'

        union all

        -- Membresías VIP sin reserva todavía
        select ss.start_time as session_time,
               coalesce((
                 select string_agg(c.name, '/' order by ssc.is_primary desc)
                 from public.schedule_slot_coaches ssc
                 join public.coaches c on c.id = ssc.coach_id
                 where ssc.schedule_slot_id = ss.id
               ), '') as coach_name,
               false as attended
        from public.membership_schedules ms
        join public.memberships m    on m.id = ms.membership_id
        join public.schedule_slots ss on ss.id = ms.schedule_slot_id
        where m.is_active and ms.is_active and ss.is_active
          and ss.day_of_week = v_isodow
          and not exists (
            select 1 from public.bookings b2
            where b2.user_id = m.user_id
              and b2.session_date = v_today
              and b2.session_time = ss.start_time
              and b2.status <> 'cancelled'
          )
      ) x
      group by x.session_time
    ) t
  ), '[]'::jsonb);
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_checkin_roster(p_time text, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_now_local timestamp := (now() at time zone 'America/Mexico_City');
  v_today  date := coalesce(p_date, (now() at time zone 'America/Mexico_City')::date);
  v_isodow int  := extract(isodow from v_today)::int;
  v_t      time := p_time::time;
begin
  if not public.is_admin() then
    return jsonb_build_object('error', 'NOT_ADMIN');
  end if;

  -- Auto-mark past bookings as unattended (se mantiene en 'active' a propósito)
  update public.bookings
  set attendance_status = 'unattended',
      attendance_marked_at = now(),
      check_in_source = 'auto_system'
  where session_date <= (now() at time zone 'America/Mexico_City')::date
    and (session_date < (now() at time zone 'America/Mexico_City')::date or (session_date + session_time + interval '50 minutes') < v_now_local)
    and status = 'active'
    and attendance_status is null;

  return coalesce((
    select jsonb_agg(sub.r order by (sub.r->>'attended')::boolean asc, lower(sub.r->>'display_name') asc)
    from (
      -- Reservas (créditos o VIP materializada)
      select jsonb_build_object(
        'kind',                   'booking',
        'booking_id',             b.id,
        'membership_schedule_id', null,
        'user_id',                b.user_id,
        'display_name',           coalesce(p.full_name, nullif(b.attendees[1], ''), 'Cliente'),
        'bed_numbers',            to_jsonb(b.bed_numbers),
        'extra_attendees',        greatest(coalesce(b.total_attendees, 1) - 1, 0),
        'attendance_status',      b.attendance_status,
        'attended',               (b.attendance_status = 'attended'),
        'is_membership',          (b.check_in_source = 'qr_membership' or exists (
                                     select 1
                                     from public.membership_schedules ms
                                     join public.memberships m on m.id = ms.membership_id
                                     join public.schedule_slots ss on ss.id = ms.schedule_slot_id
                                     where m.user_id = b.user_id and m.is_active and ms.is_active and ss.is_active
                                       and ss.day_of_week = v_isodow and ss.start_time = v_t
                                   ))
      ) as r
      from public.bookings b
      left join public.profiles p on p.id = b.user_id
      where b.session_date = v_today and b.session_time = v_t and b.status <> 'cancelled'

      union all

      -- Membresías VIP sin reserva todavía
      select jsonb_build_object(
        'kind',                   'membership',
        'booking_id',             null,
        'membership_schedule_id', ms.id,
        'user_id',                m.user_id,
        'display_name',           coalesce(p.full_name, m.client_name, 'VIP'),
        'bed_numbers',            to_jsonb(ms.bed_numbers),
        'extra_attendees',        0,
        'attendance_status',      null,
        'attended',               false,
        'is_membership',          true
      ) as r
      from public.membership_schedules ms
      join public.memberships m    on m.id = ms.membership_id
      join public.schedule_slots ss on ss.id = ms.schedule_slot_id
      left join public.profiles p on p.id = m.user_id
      where m.is_active and ms.is_active and ss.is_active
        and ss.day_of_week = v_isodow and ss.start_time = v_t
        and not exists (
          select 1 from public.bookings b
          where b.user_id = m.user_id
            and b.session_date = v_today
            and b.session_time = v_t
            and b.status <> 'cancelled'
        )
    ) sub
  ), '[]'::jsonb);
end;
$function$;


CREATE OR REPLACE FUNCTION public.checkin_scan_pass(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_secret       text;
  v_parts        text[];
  v_payload_b64  text;
  v_sig          text;
  v_expected_sig text;
  v_payload      jsonb;
  v_uid          uuid;
  v_exp          bigint;
  v_now_epoch    bigint := extract(epoch from now())::bigint;
  v_admin        uuid   := auth.uid();
  v_before       int;
  v_after        int;
  v_now_local    timestamp;
  v_today        date;
  v_isodow       int;
  v_name         text;
  v_member_code  text;
  v_booking      public.bookings%rowtype;
  v_ms           record;
  v_new_id       uuid;
  v_next_time    time;

  -- Para parsing de Hex
  v_uid_hex      text;
  v_exp_hex      text;

  -- Para la próxima clase en general
  v_next_date    date;
  v_next_hour    time;
  v_next_coach   text;
  v_next_beds    integer[];
  v_next_is_mem  boolean;
  v_next_booking jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('status_code', 'NOT_ADMIN', 'message', 'No autorizado');
  end if;

  if p_token is null then
    return jsonb_build_object('status_code', 'INVALID_TOKEN', 'message', 'QR vacio');
  end if;

  -- Determinar formato basado en la longitud y la existencia de puntos '.'
  if length(p_token) = 56 and position('.' in p_token) = 0 then
    -- A. Formato Hex Compacto (56 chars)
    v_uid_hex := substring(p_token from 1 for 32);
    v_exp_hex := substring(p_token from 33 for 8);
    v_sig     := substring(p_token from 41 for 16);

    -- Reconstruir UUID con guiones
    v_uid := (
      substring(v_uid_hex from 1 for 8) || '-' ||
      substring(v_uid_hex from 9 for 4) || '-' ||
      substring(v_uid_hex from 13 for 4) || '-' ||
      substring(v_uid_hex from 17 for 4) || '-' ||
      substring(v_uid_hex from 21 for 12)
    )::uuid;

    -- Decodificar Hex a bigint
    v_exp := ('x' || lpad(v_exp_hex, 8, '0'))::bit(32)::bigint;

    select secret into v_secret from public.checkin_secret where id = true;

    -- Validar firma
    v_expected_sig := substring(
      encode(extensions.hmac(v_uid_hex || v_exp_hex, v_secret, 'sha256'), 'hex')
      from 1 for 16
    );

    if v_sig <> v_expected_sig then
      return jsonb_build_object('status_code', 'INVALID_TOKEN', 'message', 'QR no valido o alterado');
    end if;

  elsif position('.' in p_token) > 0 then
    -- B. Formato Legacy JWT
    v_parts := string_to_array(p_token, '.');
    if array_length(v_parts, 1) <> 2 then
      return jsonb_build_object('status_code', 'INVALID_TOKEN', 'message', 'QR no valido');
    end if;

    v_payload_b64 := v_parts[1];
    v_sig         := v_parts[2];

    select secret into v_secret from public.checkin_secret where id = true;

    v_expected_sig := translate(
      encode(extensions.hmac(v_payload_b64, v_secret, 'sha256'), 'base64'),
      E'+/=\n', '-_');

    if v_sig <> v_expected_sig then
      return jsonb_build_object('status_code', 'INVALID_TOKEN', 'message', 'QR no valido o alterado');
    end if;

    begin
      v_payload := convert_from(
        decode(
          rpad(
            translate(v_payload_b64, '-_', '+/'),
            length(v_payload_b64) + ((4 - length(v_payload_b64) % 4) % 4),
            '='),
          'base64'),
        'utf8')::jsonb;
    exception when others then
      return jsonb_build_object('status_code', 'INVALID_TOKEN', 'message', 'QR no valido');
    end;

    v_uid := (v_payload->>'uid')::uuid;
    v_exp := (v_payload->>'exp')::bigint;

  else
    return jsonb_build_object('status_code', 'INVALID_TOKEN', 'message', 'QR no valido');
  end if;

  -- Comprobación de expiración común
  if v_now_epoch > v_exp then
    return jsonb_build_object(
      'status_code', 'EXPIRED_TOKEN',
      'message',     'El QR expiro. Pidele que lo regenere en la app.',
      'client_id',   v_uid
    );
  end if;

  select coalesce(value, '30')::int into v_before from public.app_settings where key = 'checkin_window_before_minutes';
  select coalesce(value, '30')::int into v_after  from public.app_settings where key = 'checkin_window_after_minutes';
  v_before := coalesce(v_before, 30);
  v_after  := coalesce(v_after, 30);

  v_now_local   := (now() at time zone 'America/Mexico_City');
  v_today       := v_now_local::date;
  v_isodow      := extract(isodow from v_today)::int;
  v_member_code := 'RGE-' || upper(substring(replace(v_uid::text, '-', '') from 1 for 8));

  select full_name into v_name from public.profiles where id = v_uid;

  -- Buscar la próxima clase activa (reserva o membresía) para armar el feedback
  select
    q.session_date,
    q.session_time,
    q.coach_name,
    q.bed_numbers,
    q.is_membership
  into
    v_next_date,
    v_next_hour,
    v_next_coach,
    v_next_beds,
    v_next_is_mem
  from (
    -- Reservas futuras en bookings
    select
      b.session_date,
      b.session_time,
      b.coach_name,
      b.bed_numbers,
      false as is_membership
    from public.bookings b
    where b.user_id = v_uid
      and b.status <> 'cancelled'
      and (b.session_date > v_today or (b.session_date = v_today and b.session_time > v_now_local::time))

    union all

    -- Ocurrencias de membresía para los próximos 7 días
    select
      (v_today + (offset_days || ' day')::interval)::date as session_date,
      ss.start_time as session_time,
      coalesce((
        select string_agg(c.name, '/' order by ssc.is_primary desc)
        from public.schedule_slot_coaches ssc
        join public.coaches c on c.id = ssc.coach_id
        where ssc.schedule_slot_id = ss.id
      ), 'Coach') as coach_name,
      ms.bed_numbers,
      true as is_membership
    from generate_series(0, 7) as offset_days
    join public.memberships m on m.user_id = v_uid
    join public.membership_schedules ms on ms.membership_id = m.id
    join public.schedule_slots ss on ss.id = ms.schedule_slot_id
    where m.is_active = true
      and ms.is_active = true
      and ss.is_active = true
      and ss.day_of_week = extract(isodow from (v_today + (offset_days || ' day')::interval)::date)::int
      and (offset_days > 0 or ss.start_time > v_now_local::time)
  ) q
  order by q.session_date asc, q.session_time asc
  limit 1;

  if v_next_date is not null then
    v_next_booking := jsonb_build_object(
      'session_date', v_next_date,
      'session_time', to_char(v_next_hour, 'HH24:MI'),
      'coach_name',   v_next_coach,
      'bed_numbers',  to_jsonb(v_next_beds),
      'is_membership', v_next_is_mem
    );
  else
    v_next_booking := null;
  end if;

  -- (A) Reserva activa de hoy, sin marcar, dentro de la ventana --------------
  select b.* into v_booking
  from public.bookings b
  where b.user_id = v_uid
    and b.status <> 'cancelled'
    and b.session_date = v_today
    and b.attendance_status is null
    and v_now_local >= (v_today + b.session_time) - make_interval(mins => v_before)
    and v_now_local <= (v_today + b.session_time) + make_interval(mins => v_after)
  order by b.session_time asc
  limit 1;

  if found then
    update public.bookings
      set attendance_status    = 'attended',
          attendance_marked_at = now(),
          checked_in_by        = v_admin,
          check_in_source      = 'qr'
    where id = v_booking.id;

    return jsonb_build_object(
      'status_code',   'OK',
      'message',       'Check-in exitoso',
      'client_name',   coalesce(v_name, 'Cliente'),
      'class_name',    coalesce(v_booking.coach_name, 'Clase'),
      'session_time',  to_char(v_booking.session_time, 'HH24:MI'),
      'member_code',   v_member_code,
      'is_membership', false,
      'client_id',     v_uid,
      'bed_numbers',   to_jsonb(v_booking.bed_numbers)
    );
  end if;

  -- (B) Ya tenia check-in en una clase de la ventana -------------------------
  select b.* into v_booking
  from public.bookings b
  where b.user_id = v_uid
    and b.status <> 'cancelled'
    and b.session_date = v_today
    and b.attendance_status = 'attended'
    and v_now_local >= (v_today + b.session_time) - make_interval(mins => v_before)
    and v_now_local <= (v_today + b.session_time) + make_interval(mins => v_after)
  order by b.session_time asc
  limit 1;

  if found then
    return jsonb_build_object(
      'status_code',   'ALREADY_CHECKED_IN',
      'message',       'Esta clienta ya tenia check-in en esta clase',
      'client_name',   coalesce(v_name, 'Cliente'),
      'class_name',    coalesce(v_booking.coach_name, 'Clase'),
      'session_time',  to_char(v_booking.session_time, 'HH24:MI'),
      'is_membership', (v_booking.check_in_source = 'qr_membership'),
      'client_id',     v_uid,
      'bed_numbers',   to_jsonb(v_booking.bed_numbers)
    );
  end if;

  -- (C) Clase de MEMBRESIA en la ventana (sin reserva existente) -------------
  select
      ss.start_time as start_time,
      ms.bed_numbers as bed_numbers,
      coalesce((
        select string_agg(c.name, '/' order by ssc.is_primary desc)
        from public.schedule_slot_coaches ssc
        join public.coaches c on c.id = ssc.coach_id
        where ssc.schedule_slot_id = ss.id
      ), 'Coach') as coach_names
  into v_ms
  from public.membership_schedules ms
  join public.memberships m   on m.id = ms.membership_id
  join public.schedule_slots ss on ss.id = ms.schedule_slot_id
  where m.user_id = v_uid
    and m.is_active = true
    and ms.is_active = true
    and ss.is_active = true
    and ss.day_of_week = v_isodow
    and v_now_local >= (v_today + ss.start_time) - make_interval(mins => v_before)
    and v_now_local <= (v_today + ss.start_time) + make_interval(mins => v_after)
    and not exists (
      select 1 from public.bookings b
      where b.user_id = v_uid
        and b.session_date = v_today
        and b.session_time = ss.start_time
        and b.status <> 'cancelled'
    )
  order by ss.start_time asc
  limit 1;

  if found then
    insert into public.bookings (
      user_id, session_date, session_time, coach_name, bed_numbers,
      attendees, total_attendees, credits_used, status,
      attendance_status, attendance_marked_at, checked_in_by, check_in_source
    ) values (
      v_uid, v_today, v_ms.start_time, v_ms.coach_names, v_ms.bed_numbers,
      '{}'::text[], greatest(coalesce(array_length(v_ms.bed_numbers, 1), 1), 1), 0, 'active',
      'attended', now(), v_admin, 'qr_membership'
    )
    returning id into v_new_id;

    return jsonb_build_object(
      'status_code',   'OK',
      'message',       'Check-in exitoso (membresia VIP)',
      'client_name',   coalesce(v_name, 'Cliente'),
      'class_name',    v_ms.coach_names,
      'session_time',  to_char(v_ms.start_time, 'HH24:MI'),
      'member_code',   v_member_code,
      'is_membership', true,
      'client_id',     v_uid,
      'bed_numbers',   to_jsonb(v_ms.bed_numbers)
    );
  end if;

  -- (D) Hay clase mas tarde hoy (booking o membresia) fuera de la ventana ----
  select min(t) into v_next_time
  from (
    select b.session_time as t
    from public.bookings b
    where b.user_id = v_uid
      and b.status <> 'cancelled'
      and b.session_date = v_today
      and b.attendance_status is null
      and (v_today + b.session_time) > v_now_local

    union all

    select ss.start_time as t
    from public.membership_schedules ms
    join public.memberships m    on m.id = ms.membership_id
    join public.schedule_slots ss on ss.id = ms.schedule_slot_id
    where m.user_id = v_uid
      and m.is_active = true
      and ms.is_active = true
      and ss.is_active = true
      and ss.day_of_week = v_isodow
      and (v_today + ss.start_time) > v_now_local
  ) q;

  if v_next_time is not null then
    return jsonb_build_object(
      'status_code',  'NO_CLASS_IN_WINDOW',
      'message',      'Fuera de horario de check-in. Su proxima clase es a las ' || to_char(v_next_time, 'HH24:MI'),
      'client_name',  coalesce(v_name, 'Cliente'),
      'session_time', to_char(v_next_time, 'HH24:MI'),
      'client_id',    v_uid,
      'next_booking', v_next_booking
    );
  end if;

  -- (E) Sin clases hoy -------------------------------------------------------
  return jsonb_build_object(
    'status_code',  'NO_BOOKING_TODAY',
    'message',      'Sin clases programadas para hoy',
    'client_name',  coalesce(v_name, 'Cliente'),
    'client_id',    v_uid,
    'next_booking', v_next_booking
  );
end;
$function$;
