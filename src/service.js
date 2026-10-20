import { command, KEYBOARD } from './commands.js';
import { accrue, reminderDue, status } from './model.js';

export const stateKey = id => 'state:' + id;

// Move the old single-owner state once, without resetting progress.
export function migrateOwner(store, ownerId) {
  store.transaction(() => {
    const legacy = store.get('state');
    if (!legacy) return;
    if (!store.get(stateKey(ownerId))) store.set(stateKey(ownerId), legacy);
    store.delete('state');
  });
}

// Business mutations, polling offset and outgoing responses commit atomically.
export function handleUpdate(store, update, access, clock) {
  return store.transaction(() => {
    if (update.update_id < store.get('offset', 0)) return;
    const message = update.message;
    const userId = message?.from?.id;
    if (access.allowedUserIds.has(userId) && message.chat?.type === 'private' &&
        message.chat.id === userId && typeof message.text === 'string') {
      const result = command(store.get(stateKey(userId)), message.text, clock);
      if (result.state) store.set(stateKey(userId), result.state);
      const queue = store.get('outbox', []);
      queue.push({ chat_id: userId, text: result.text, reply_markup: KEYBOARD });
      store.set('outbox', queue);
    }
    store.set('offset', update.update_id + 1);
  });
}
export function tick(store, access, clock) {
  store.transaction(() => {
    const queue = store.get('outbox', []);
    for (const userId of access.allowedUserIds) {
      const state = store.get(stateKey(userId));
      if (!state) continue; // New users must send /start first.
      accrue(state, clock);
      const time = reminderDue(state, clock);
      if (time) {
        queue.push({ chat_id: userId, text: '⏰ Пора позаниматься! Отметь каждую готовую тему кнопкой «✅ +1».\n\n' + status(state, clock), reply_markup: KEYBOARD });
        state.sent[clock.day + '/' + time] = true;
      }
      for (const key of Object.keys(state.sent)) if (key.slice(0, 10) < clock.day) delete state.sent[key];
      store.set(stateKey(userId), state);
    }
    store.set('outbox', queue);
  });
}
export async function drain(store, api, allowedUserIds) {
  for (;;) {
    const queue = store.get('outbox', []);
    if (!queue.length) return;
    if (!allowedUserIds || allowedUserIds.has(queue[0].chat_id)) {
      try { await api('sendMessage', queue[0]); }
      catch (error) {
        if (error.code !== 403 && error.code !== 400) throw error;
        console.error('Outgoing message rejected by Telegram, code', error.code);
      }
    }
    // Revoked users' queued messages are discarded. Their progress stays saved.
    store.transaction(() => {
      const current = store.get('outbox', []);
      current.shift();
      store.set('outbox', current);
    });
  }
}
