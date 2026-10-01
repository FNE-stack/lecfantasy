// ═══════════════════════════════════════════════════════════════════════════
// push.js — Web Push notifications (works with the browser closed; on iPhone
// only once the site is installed to the home screen, iOS 16.4+).
//
// Subscriptions per member in KV (push:<managerId>). Dead subscriptions (the
// push service answers 404/410) are dropped automatically.
// ═══════════════════════════════════════════════════════════════════════════
import { buildPushPayload } from '@block65/webcrypto-web-push';

function vapid(env) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return null;
  return { subject: env.VAPID_SUBJECT || 'mailto:admin@lecfantasy.invalid',
           publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE };
}
export const pushEnabled = env => !!vapid(env);

export async function subscribe(env, managerId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys) {
    throw new Error('ungültiges Abo');
  }
  const list = (await env.LEAGUE.get(`push:${managerId}`, 'json')) || [];
  const next = list.filter(s => s.endpoint !== sub.endpoint).concat({
    endpoint: sub.endpoint, expirationTime: sub.expirationTime || null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  }).slice(-5);   // a handful of devices per person is plenty
  await env.LEAGUE.put(`push:${managerId}`, JSON.stringify(next));
  return next.length;
}
export async function unsubscribe(env, managerId, endpoint) {
  const list = (await env.LEAGUE.get(`push:${managerId}`, 'json')) || [];
  await env.LEAGUE.put(`push:${managerId}`, JSON.stringify(list.filter(s => s.endpoint !== endpoint)));
}

// message: { title, body, url, tag }
export async function notify(env, managerIds, message) {
  const v = vapid(env);
  if (!v) return { sent: 0, skipped: 'push not configured' };
  let sent = 0, dropped = 0;
  for (const id of managerIds) {
    const list = (await env.LEAGUE.get(`push:${id}`, 'json')) || [];
    const keep = [];
    for (const sub of list) {
      try {
        const payload = await buildPushPayload({ data: message, options: { ttl: 3600, urgency: 'high', topic: (message.tag || 'lf').slice(0, 32) } }, sub, v);
        const r = await fetch(sub.endpoint, payload);
        if (r.status === 404 || r.status === 410) { dropped++; continue; }
        if (r.ok) sent++;
        keep.push(sub);
      } catch (e) { keep.push(sub); }
    }
    if (keep.length !== list.length) await env.LEAGUE.put(`push:${id}`, JSON.stringify(keep));
  }
  return { sent, dropped };
}
export async function subscriberCounts(env, ids) {
  const out = {};
  for (const id of ids) out[id] = ((await env.LEAGUE.get(`push:${id}`, 'json')) || []).length;
  return out;
}
