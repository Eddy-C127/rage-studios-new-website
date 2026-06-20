import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
  import Stripe from 'https://esm.sh/stripe@14.5.0';
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature'
  };

  serve(async (req) => {
    // Manejar OPTIONS para CORS
    if (req.method === 'OPTIONS') {
      return new Response('ok', {
        headers: corsHeaders
      });
    }

    const startTime = Date.now();

    try {
      // Inicializar Stripe y Supabase
      const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')?.trim();

      if (!stripeSecretKey || !supabaseUrl || !supabaseServiceKey) {
        throw new Error('Missing required environment variables');
      }

      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: '2024-11-20.acacia',
        typescript: true,
      });

      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      // PASO 1: Detectar origen de la llamada
      const stripeSignature = req.headers.get('stripe-signature');
      const isWebhookFromStripe = stripeSignature !== null;
      const origin = isWebhookFromStripe ? 'stripe_webhook' : 'manual_frontend';

      console.log(`\n${'='.repeat(60)}`);
      console.log(`📥 Nueva solicitud recibida`);
      console.log(`🔹 Origen: ${origin}`);
      console.log(`🔹 Timestamp: ${new Date().toISOString()}`);
      console.log(`${'='.repeat(60)}\n`);

      let sessionId;
      let eventType;

      // PASO 2: Procesar según origen
      if (isWebhookFromStripe) {
        // ============================================================
        // WEBHOOK REAL DE STRIPE (Automático)
        // ============================================================
        console.log('🔐 Validando firma de Stripe...');

        console.log('🔍 DEBUG - Webhook Secret Info:');
        console.log(`  - Existe: ${!!webhookSecret}`);
        console.log(`  - Length: ${webhookSecret?.length}`);
        console.log(`  - Primeros 10 chars: ${webhookSecret?.substring(0, 10)}`);

        if (!webhookSecret) {
          console.error('❌ STRIPE_WEBHOOK_SECRET no configurado');
          return new Response(JSON.stringify({
            error: 'Webhook secret not configured'
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            },
            status: 500
          });
        }

        console.log('🔍 DEBUG - Request Info:');
        console.log(`  - Stripe Signature existe: ${!!stripeSignature}`);
        console.log(`  - Signature length: ${stripeSignature?.length}`);
        console.log(`  - Signature primeros 30 chars: ${stripeSignature?.substring(0, 30)}`);

        const body = await req.text();

        console.log('🔍 DEBUG - Body Info:');
        console.log(`  - Body length: ${body.length}`);
        console.log(`  - Body primeros 150 chars: ${body.substring(0, 150)}`);
        console.log(`  - Body type: ${typeof body}`);

        let event;
        try {
          // ✅ CORREGIDO: Usar constructEventAsync con await
          event = await stripe.webhooks.constructEventAsync(
            body,
            stripeSignature,
            webhookSecret
          );
          console.log('✅ Firma validada correctamente');
          console.log(`✅ Event ID: ${event.id}`);
          console.log(`✅ Event Type: ${event.type}`);
        } catch (err) {
          console.error('❌ Error validando firma:', err.message);
          console.error('❌ Error stack:', err.stack);
          console.error('❌ Detalles del error:');
          console.error(`   - Error name: ${err.name}`);
          console.error(`   - Webhook secret length usado: ${webhookSecret?.length}`);
          console.error(`   - Signature length recibido: ${stripeSignature?.length}`);
          console.error(`   - Body length: ${body.length}`);

          return new Response(JSON.stringify({
            error: 'Invalid signature',
            details: {
              error_message: err.message,
              webhook_secret_configured: !!webhookSecret,
              signature_received: !!stripeSignature,
              body_length: body.length
            }
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            },
            status: 401
          });
        }

        // Validar tipo de evento
        if (event.type !== 'checkout.session.completed') {
          console.log(`ℹ️ Evento ignorado: ${event.type}`);
          return new Response(JSON.stringify({
            received: true,
            ignored: true,
            reason: 'Event type not supported',
            event_type: event.type
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            },
            status: 200
          });
        }

        const session = event.data.object;
        sessionId = session.id;
        eventType = event.type;

        console.log(`💳 Session ID: ${sessionId}`);
        console.log(`📋 Event Type: ${eventType}`);
      } else {
        // ============================================================
        // LLAMADA MANUAL DESDE FRONTEND (Compatibilidad actual)
        // ============================================================
        console.log('📱 Procesando llamada manual desde frontend...');

        const body = await req.json();
        sessionId = body.session_id;
        eventType = body.type || 'checkout.session.completed';

        if (!sessionId) {
          console.error('❌ session_id no proporcionado');
          return new Response(JSON.stringify({
            error: 'session_id is required'
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            },
            status: 400
          });
        }

        console.log(`💳 Session ID: ${sessionId}`);
      }

      // PASO 3: Obtener sesión de Stripe
      console.log('\n📡 Consultando Stripe...');
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: [
          'line_items',
          'payment_intent'
        ]
      });

      console.log(`💰 Payment Status: ${session.payment_status}`);
      console.log(`💵 Amount: ${session.amount_total ? session.amount_total / 100 : 0} ${session.currency?.toUpperCase()}`);
      console.log(`🔑 Payment Intent: ${session.payment_intent}`);

      // PASO 4: Validar que el pago esté completado
      if (session.payment_status !== 'paid') {
        console.warn(`⚠️ Pago no completado. Status: ${session.payment_status}`);
        return new Response(JSON.stringify({
          received: true,
          processed: false,
          reason: 'Payment not completed',
          payment_status: session.payment_status
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          },
          status: 200
        });
      }

      // PASO 5: Buscar compra en la base de datos
      console.log('\n🔍 Buscando compra en base de datos...');
      const { data: purchase, error: purchaseError } = await supabase
        .from('purchases')
        .select('*, packages(*), credit_batches(*)')
        .eq('stripe_session_id', sessionId)
        .single();

      if (purchaseError || !purchase) {
        console.error('❌ Compra no encontrada:', purchaseError?.message);
        return new Response(JSON.stringify({
          error: 'Purchase not found',
          session_id: sessionId
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          },
          status: 404
        });
      }

      console.log(`✅ Compra encontrada: ${purchase.id}`);
      console.log(`👤 Usuario: ${purchase.user_id}`);
      console.log(`📦 Paquete: ${purchase.packages.title}`);
      console.log(`💵 Monto: $${purchase.amount} MXN`);
      console.log(`📊 Status actual: ${purchase.status}`);

      // PASO 5.1: 🚫 Bloqueo de créditos para usuarios en lista de bloqueo.
      // Red de seguridad: aunque la compra se bloquea antes (create-checkout-session),
      // aquí garantizamos que un usuario en lista de bloqueo NUNCA reciba créditos,
      // incluso si la sesión se creó antes de ser bloqueado.
      const { data: blacklisted } = await supabase
        .from('user_blacklist')
        .select('id')
        .eq('user_id', purchase.user_id)
        .maybeSingle();

      if (blacklisted) {
        console.warn(`🚫 Usuario en lista de bloqueo (${purchase.user_id}). No se asignan créditos.`);
        return new Response(JSON.stringify({
          received: true,
          processed: false,
          reason: 'Account restricted',
          purchase_id: purchase.id
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          },
          status: 200
        });
      }

      // PASO 6: IDEMPOTENCIA - Verificar si ya fue procesado
      console.log('\n🔒 Verificando idempotencia...');
      if (purchase.status === 'completed' && purchase.credit_batches?.length > 0) {
        console.log(`✅ Ya procesado anteriormente`);
        console.log(`📦 Credit batches existentes: ${purchase.credit_batches.length}`);
        console.log(`⏱️ Procesado en: ${purchase.completed_at}`);

        return new Response(JSON.stringify({
          received: true,
          already_processed: true,
          purchase_id: purchase.id,
          completed_at: purchase.completed_at,
          origin
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          },
          status: 200
        });
      }

      // PASO 7: Validar payment_intent_id para prevenir duplicación
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

      if (paymentIntentId) {
        console.log(`🔑 Verificando Payment Intent: ${paymentIntentId}`);

        const { data: existingPurchaseWithSamePI } = await supabase
          .from('purchases')
          .select('*, credit_batches(*)')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .neq('id', purchase.id)
          .single();

        if (existingPurchaseWithSamePI?.credit_batches?.length > 0) {
          console.warn(`⚠️ Ya existe otra compra con el mismo Payment Intent procesada`);
          console.warn(`⚠️ Purchase ID duplicado: ${existingPurchaseWithSamePI.id}`);

          await supabase
            .from('purchases')
            .update({
              stripe_payment_intent_id: paymentIntentId
            })
            .eq('id', purchase.id);

          return new Response(JSON.stringify({
            received: true,
            already_processed: true,
            reason: 'Duplicate payment_intent',
            original_purchase_id: existingPurchaseWithSamePI.id,
            origin
          }), {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            },
            status: 200
          });
        }
      }

      // PASO 8: Validaciones de negocio
      console.log('\n✅ Validaciones de negocio...');

      const expectedAmountInCents = Math.round(purchase.amount * 100);
      if (session.amount_total !== expectedAmountInCents) {
        console.warn(`⚠️ Monto no coincide exactamente`);
        console.warn(`   Esperado: ${expectedAmountInCents} centavos ($${purchase.amount})`);
        console.warn(`   Recibido: ${session.amount_total} centavos ($${session.amount_total ? session.amount_total / 100 : 0})`);
      }

      if (session.metadata?.purchase_id && session.metadata.purchase_id !== purchase.id) {
        console.warn(`⚠️ Purchase ID en metadata no coincide`);
        console.warn(`   En BD: ${purchase.id}`);
        console.warn(`   En metadata: ${session.metadata.purchase_id}`);
      }

      // PASO 9: Procesar el pago - Actualizar compra
      console.log('\n💾 Procesando pago...');
      console.log('📝 Actualizando estado de compra...');

      const { error: updateError } = await supabase
        .from('purchases')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          stripe_payment_intent_id: paymentIntentId || null
        })
        .eq('id', purchase.id);

      if (updateError) {
        console.error('❌ Error actualizando compra:', updateError);
        throw updateError;
      }

      console.log('✅ Compra actualizada a "completed"');

      // PASO 10: Crear lote de créditos
      console.log('💳 Creando lote de créditos...');

      const creditsCount = purchase.packages.is_unlimited
        ? 999999
        : purchase.packages.credits_count || 0;

      const { data: creditBatch, error: creditError } = await supabase
        .from('credit_batches')
        .insert({
          user_id: purchase.user_id,
          purchase_id: purchase.id,
          package_id: purchase.package_id,
          credits_total: creditsCount,
          credits_remaining: creditsCount,
          validity_days: purchase.packages.validity_days,
          is_unlimited: purchase.packages.is_unlimited,
          expiration_activated: false
        })
        .select()
        .single();

      if (creditError) {
        console.error('❌ Error creando credit_batch:', creditError);
        throw creditError;
      }

      console.log(`✅ Credit batch creado: ${creditBatch.id}`);
      console.log(`   Créditos: ${creditsCount}`);
      console.log(`   Vigencia: ${purchase.packages.validity_days} días`);
      console.log(`   Ilimitado: ${purchase.packages.is_unlimited}`);

      // PASO 11: Registrar en historial
      console.log('📋 Registrando en historial...');

      const { error: historyError } = await supabase
        .from('credit_history')
        .insert({
          user_id: purchase.user_id,
          credit_batch_id: creditBatch.id,
          type: 'added',
          amount: creditsCount,
          description: `Créditos asignados por compra de paquete: ${purchase.packages.title}`
        });

      if (historyError) {
        console.error('❌ Error registrando historial:', historyError);
        throw historyError;
      }

      console.log('✅ Historial registrado');

      // PASO 11.1: Marcar cupón como usado (si la compra usó uno)
      try {
        const meta = session.metadata || {};
        if (meta.coupon_source === 'personal' && meta.coupon_id) {
          await supabase
            .from('coupons')
            .update({ status: 'used', used_at: new Date().toISOString(), used_purchase_id: purchase.id })
            .eq('id', meta.coupon_id)
            .eq('status', 'active');
          console.log(`🎟️ Cupón personal marcado como usado: ${meta.coupon_id}`);
        } else if (meta.coupon_source === 'campaign' && meta.campaign_id) {
          await supabase.rpc('increment_coupon_campaign_use', { p_id: meta.campaign_id });
          console.log(`🎟️ Uso de campaña incrementado: ${meta.campaign_id}`);
        }
      } catch (couponErr) {
        // No romper el flujo de compra por un fallo al marcar el cupón
        console.error('⚠️ Error marcando cupón como usado:', couponErr?.message);
      }

      // PASO 12: Respuesta exitosa
      const processingTime = Date.now() - startTime;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ PROCESAMIENTO EXITOSO`);
      console.log(`⏱️ Tiempo total: ${processingTime}ms`);
      console.log(`🔹 Purchase ID: ${purchase.id}`);
      console.log(`🔹 Credit Batch ID: ${creditBatch.id}`);
      console.log(`🔹 Usuario: ${purchase.user_id}`);
      console.log(`🔹 Créditos asignados: ${creditsCount}`);
      console.log(`${'='.repeat(60)}\n`);

      return new Response(JSON.stringify({
        received: true,
        processed: true,
        origin,
        purchase_id: purchase.id,
        credit_batch_id: creditBatch.id,
        credits_assigned: creditsCount,
        processing_time_ms: processingTime
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 200
      });

    } catch (error) {
      const processingTime = Date.now() - startTime;

      console.error(`\n${'='.repeat(60)}`);
      console.error('❌ ERROR EN PROCESAMIENTO');
      console.error(`⏱️ Tiempo hasta el error: ${processingTime}ms`);
      console.error(`📛 Error: ${error.message}`);
      console.error(`📚 Stack: ${error.stack}`);
      console.error(`${'='.repeat(60)}\n`);

      return new Response(JSON.stringify({
        error: error.message,
        processing_time_ms: processingTime
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 400
      });
    }
  });
