export const SCHEDULE = {
  0: ['Украинский', 'Английский'], 1: ['История'], 2: ['Математика'],
  3: ['Украинский', 'Английский'], 4: ['История'], 5: ['Математика'], 6: [],
};

export function localTime(now = new Date(), zone = 'Europe/Kyiv') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute };
}
export function nextDay(day) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function lessons(day) {
  return SCHEDULE[new Date(day + 'T12:00:00Z').getUTCDay()];
}
export function initialState(clock) {
  return {
    started: clock.day, backlog: 16, goal: 3, lessonTime: '18:00',
    reminders: ['12:00', '18:00', '21:00'], paused: false,
    accruedThrough: null, history: {}, sent: {},
  };
}
export function daily(state, day) {
  return state.history[day] ??= { done: 0, added: 0 };
}
// Each date is accrued once; downtime is caught up on the next tick.
export function accrue(state, clock) {
  let day = state.accruedThrough ? nextDay(state.accruedThrough) : state.started;
  while (day < clock.day || (day === clock.day && clock.time >= state.lessonTime)) {
    const count = lessons(day).length;
    state.backlog += count;
    daily(state, day).added += count;
    state.accruedThrough = day;
    day = nextDay(day);
  }
}
export function forecast(state, clock, dailyGoal = state.goal) {
  let remaining = state.backlog;
  let day = clock.day;
  for (let i = 0; i < 3650; i++, day = nextDay(day)) {
    if (!state.accruedThrough || day > state.accruedThrough) remaining += lessons(day).length;
    const capacity = i === 0 ? Math.max(0, dailyGoal - (state.history[day]?.done ?? 0)) : dailyGoal;
    remaining = Math.max(0, remaining - capacity);
    if (!remaining) return { day, days: i + 1 };
  }
  return null;
}
export function complete(state, clock) {
  if (state.backlog === 0) return 'Сейчас нет доступных тем. Новые появятся по расписанию.';
  state.backlog--;
  daily(state, clock.day).done++;
  return '✅ Ещё одна тема сделана!';
}
export function undo(state, clock) {
  const entry = daily(state, clock.day);
  if (!entry.done) return 'Сегодня ещё нечего отменять.';
  entry.done--;
  state.backlog++;
  return 'Последняя отметка за сегодня отменена.';
}
export function reminderDue(state, clock) {
  if (state.paused || !state.backlog || (state.history[clock.day]?.done ?? 0) >= state.goal) return null;
  const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return [...state.reminders].reverse().find(time => {
    const delta = minute(clock.time) - minute(time);
    return delta >= 0 && delta < 15 && !state.sent[clock.day + '/' + time];
  }) ?? null;
}
export function status(state, clock) {
  const done = state.history[clock.day]?.done ?? 0;
  const plan = forecast(state, clock);
  const pending = !state.accruedThrough || state.accruedThrough < clock.day;
  return [
    '📚 ' + clock.day + ' · Киев',
    'Сегодня: ' + done + '/' + state.goal + (done > state.goal ? ' 🔥 сверх плана!' : ''),
    'Осталось доступных тем: ' + state.backlog,
    'Сегодня новые: ' + (lessons(clock.day).join(', ') || 'выходной') +
      (lessons(clock.day).length ? ' · ' + state.lessonTime + ' (' + (pending ? 'ожидаются' : 'учтены') + ')' : ''),
    plan ? '🎯 Догонишь к ' + plan.day + ' (дней, включая сегодня: ' + plan.days + '), если делать по ' + state.goal + '/день.'
      : 'За 10 лет при таком темпе догнать не получится. Увеличь /goal.',
    'Прогноз учитывает новые уроки и оставшуюся цель на сегодня.',
    '🔔 ' + (state.paused ? 'Напоминания выключены' : state.reminders.join(', ') + ' по Киеву'),
  ].join('\n');
}
