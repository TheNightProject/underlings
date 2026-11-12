export const MOOD_MINUTES = { impatient: 5, grumpy: 20, angry: 45 };

export const waitsOnYou = (a) => a.state === 'waiting' || a.state === 'blocked';
