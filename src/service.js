import { command, KEYBOARD } from './commands.js';
import { accrue, reminderDue, status } from './model.js';

// Business mutations, polling offset and outgoing responses commit atomically.
export function handleUpdate(store, update, ownerId, clock) {
  return store.transaction(() => {
    if (update.update_id < store.get('offset', 0)) return;
    const message = update.message;
    if (message?.from?.id === ownerId && message.chat?.type === 'private' &&
        message.chat.id === ownerId && typeof message.text === 'string') {
      const result = command(store.get('state'), message.text, clock);
      if (result.state) store.set('state', result.state);
      const queue = store.get('outbox', []);
      queue.push({ chat_id: ownerId, text: result.text, reply_markup: KEYBOARD });
      store.set('outbox', queue);
    }
    store.set('offset', update.update_id + 1);
  });
}
export function tick(store, ownerId, clock) {
  store.transaction(() => {
    const state = store.get('state');
    if (!state) return;
    accrue(state, clock);
    const time = reminderDue(state, clock);
    if (time) {
      const queue = store.get('outbox', []);
      queue.push({ chat_id: ownerId, text: '⏰ Пора позаниматься! Отметь каждую готовую тему кнопкой «✅ +1».\n\n' + status(state, clock), reply_markup: KEYBOARD });
      store.set('outbox', queue);
      state.sent[clock.day + '/' + time] = true;
    }
    // Only recent notification markers are needed; full completion history stays.
    for (const key of Object.keys(state.sent)) if (key.slice(0, 10) < clock.day) delete state.sent[key];
    store.set('state', state);
  });
}
export async function drain(store, api) {
  for (;;) {
    const queue = store.get('outbox', []);
    if (!queue.length) return;
    try { await api('sendMessage', queue[0]); }
    catch (error) {
      // Forbidden (bot blocked) and invalid chats cannot recover by retrying.
      if (error.code !== 403 && error.code !== 400) throw error;
      console.error('Outgoing message rejected by Telegram, code', error.code);
    }
    store.transaction(() => {
      const current = store.get('outbox', []);
      current.shift();
      store.set('outbox', current);
    });
  }
}
