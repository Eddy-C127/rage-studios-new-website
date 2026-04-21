import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const FCM_SERVER_KEY = Deno.env.get('FCM_SERVER_KEY');

Deno.serve(async (_req) => {
  try {
    const now = new Date().toISOString();

    // Find news due for publishing
    const { data: dueNews, error: fetchError } = await supabase
      .from('news')
      .select('*')
      .lte('scheduled_at', now)
      .is('published_at', null)
      .eq('is_active', true);

    if (fetchError) throw fetchError;
    if (!dueNews || dueNews.length === 0) {
      return new Response(JSON.stringify({ published: 0 }), { status: 200 });
    }

    let published = 0;

    for (const item of dueNews) {
      // Mark as published
      const { error: updateError } = await supabase
        .from('news')
        .update({ published_at: now })
        .eq('id', item.id);

      if (updateError) {
        console.error(`Failed to publish news ${item.id}:`, updateError);
        continue;
      }

      published++;

      // Send push notification if requested and not already sent
      if (item.send_notification && !item.notification_sent && FCM_SERVER_KEY) {
        await sendPushNotification(item);

        await supabase
          .from('news')
          .update({ notification_sent: true })
          .eq('id', item.id);
      }
    }

    return new Response(JSON.stringify({ published }), { status: 200 });
  } catch (err) {
    console.error('publish-scheduled-news error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

async function sendPushNotification(item: any) {
  // Get all active push tokens from user_notification_preferences
  const { data: prefs } = await supabase
    .from('user_notification_preferences')
    .select('push_tokens, primary_device_token')
    .eq('push_notifications_enabled', true);

  if (!prefs || prefs.length === 0) return;

  // Collect unique tokens
  const tokens = new Set<string>();
  for (const pref of prefs) {
    if (pref.primary_device_token) tokens.add(pref.primary_device_token);
    if (Array.isArray(pref.push_tokens)) {
      pref.push_tokens.forEach((t: string) => tokens.add(t));
    }
  }

  if (tokens.size === 0) return;

  const payload = {
    registration_ids: Array.from(tokens),
    notification: {
      title: item.tag ? `[${item.tag}] ${item.title}` : item.title,
      body: item.body,
      icon: '/icons/icon-192x192.png',
      click_action: item.link_url ?? '/'
    },
    data: {
      news_id: item.id,
      link_url: item.link_url ?? '/'
    }
  };

  await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      'Authorization': `key=${FCM_SERVER_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}
