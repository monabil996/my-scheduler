const admin = require('firebase-admin');
const webpush = require('web-push');

// ── Firebase Admin init (once) ──────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: 'my-scheduler-c6ddc',
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ── VAPID setup ─────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:fox.helmy@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function sendPush(pushSub, payload) {
  try {
    await webpush.sendNotification(pushSub, JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    // 410 Gone = subscription expired, clean it up
    if (e.statusCode === 410) return { expired: true };
    return { error: e.message };
  }
}

module.exports = async function handler(req, res) {
  // ── Auth: Vercel sets Authorization: Bearer {CRON_SECRET} for cron calls ──
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const hhmm = `${hh}:${mm}`;
  const today = now.toISOString().split('T')[0];
  const dayAbbr = DAYS[now.getUTCDay()];

  // ── Get all subscribed users ─────────────────────────────────────────────
  const subsSnap = await db.collection('subscribedUsers').get();
  const results = [];

  for (const userDoc of subsSnap.docs) {
    const uid = userDoc.id;
    try {
      const configSnap = await db.doc(`users/${uid}/settings/config`).get();
      if (!configSnap.exists) continue;
      const config = configSnap.data();

      const sub = config.pushSubscription;
      if (!sub?.endpoint) continue;

      const pushSubObj = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys?.p256dh, auth: sub.keys?.auth },
      };

      const reminderHour = (config.time || '08:00').split(':')[0].padStart(2, '0');
      const reminderDays = config.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

      // ── Daily summary notification ────────────────────────────────────────
      if (hh === reminderHour && reminderDays.includes(dayAbbr) && config.lastDailyReminder !== today) {
        const tasksSnap = await db.collection(`users/${uid}/tasks`).get();
        const tasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const active = tasks.filter(t => t.status !== 'done');
        const overdue = active.filter(t => t.dueDate && t.dueDate < today);
        const dueToday = active.filter(t => t.dueDate === today);

        const parts = [];
        if (overdue.length) parts.push(`⚠ ${overdue.length} overdue`);
        if (dueToday.length) parts.push(`📅 ${dueToday.length} due today`);
        parts.push(`${active.length} active tasks`);

        const r = await sendPush(pushSubObj, {
          title: '📋 Daily Reminder',
          body: parts.join(' · '),
          tag: 'daily-reminder',
          url: 'https://my-scheduler-liard.vercel.app',
        });
        results.push({ uid, type: 'daily', ...r });

        if (r.ok) {
          // Mark today's daily reminder as sent
          await db.doc(`users/${uid}/settings/config`).update({ lastDailyReminder: today });
        }
        if (r.expired) {
          // Clean up expired subscription
          await db.doc(`users/${uid}/settings/config`).update({ pushSubscription: null });
          await db.doc(`subscribedUsers/${uid}`).delete();
        }
      }

      // ── Per-task reminders (exact HH:MM match) ────────────────────────────
      const taskRemSnap = await db.collection(`users/${uid}/tasks`)
        .where('remindAt', '==', hhmm)
        .get();

      for (const taskDoc of taskRemSnap.docs) {
        const task = taskDoc.data();
        if (task.status === 'done') continue;
        // Avoid re-sending if already sent today
        if (task.lastReminderDate === today) continue;

        const r = await sendPush(pushSubObj, {
          title: `⏰ ${task.title}`,
          body: task.notes
            ? task.notes.slice(0, 80)
            : `${task.priority} priority · ${task.category}`,
          tag: `task-${taskDoc.id}`,
          url: 'https://my-scheduler-liard.vercel.app',
        });
        results.push({ uid, type: 'task', taskId: taskDoc.id, ...r });

        if (r.ok) {
          await taskDoc.ref.update({ lastReminderDate: today });
        }
      }
    } catch (err) {
      results.push({ uid, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, time: hhmm, day: dayAbbr, processed: subsSnap.size, results });
};
