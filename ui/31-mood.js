const MOOD_CHEER_MS = 6000;
const MOOD_WAITS = ['fresh', 'impatient', 'grumpy', 'angry'];
const MOOD_WORDS = {
  happy: 'Happy at work', cheer: 'Answered, and cheering on the way back to work', content: 'Content', sad: 'Sad, its last turn failed',
  fresh: 'waving', impatient: 'getting impatient', grumpy: 'getting grumpy', angry: 'angry',
};
const moodSeen = new Map();

const moodWaiting = (mood) => MOOD_WAITS.includes(mood);

// Without the worker's thresholds a wait never escalates, rather than guess at them.
function moodOf(a, now, limits, answeredAt = 0) {
  if (isNeed(a)) {
    const waited = Math.max(0, (now - (a.since || now)) / 60000);
    return { mood: MOOD_WAITS.filter((m) => m === 'fresh' || (limits && waited >= limits[m])).at(-1), waited };
  }
  if (a.state === 'working') return { mood: now - answeredAt < MOOD_CHEER_MS ? 'cheer' : 'happy', waited: 0 };
  return { mood: a.outcome === 'error' ? 'sad' : 'content', waited: 0 };
}

function moodSpan(minutes) {
  const m = Math.floor(minutes);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

function moodWords({ mood, waited }) {
  if (!moodWaiting(mood)) return MOOD_WORDS[mood];
  return (waited < 1 ? 'Just asked' : 'Waiting ' + moodSpan(waited)) + ', ' + MOOD_WORDS[mood];
}

function agentMood(a, now = Date.now()) {
  const need = isNeed(a);
  const seen = moodSeen.get(a.handle);
  const answeredAt = seen?.need && !need && a.state === 'working' ? now : seen?.answeredAt ?? 0;
  moodSeen.set(a.handle, { need, answeredAt });
  return moodOf(a, now, state?.moods, answeredAt);
}

function agentMoodLine(a) {
  const m = agentMood(a);
  return el('div', { class: 'meta agent-mood', 'data-mood': m.mood }, el('span', { class: 'mood-dot', 'aria-hidden': 'true' }), moodWords(m));
}
