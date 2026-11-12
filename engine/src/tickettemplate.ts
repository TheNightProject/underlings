import { loadSettings } from './data/store.js';

export interface TicketTemplate {
  headings: string[];
  guidance: string;
}

export function ticketTemplateOf(text: string | null | undefined): TicketTemplate {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  const headings = lines.filter((line) => line.startsWith('#')).map((line) => line.replace(/^#+\s*/, '').trim()).filter(Boolean);
  return { headings: [...new Set(headings)], guidance: lines.filter((line) => !line.startsWith('#')).join(' ') };
}

export function ticketTemplate(): TicketTemplate {
  return ticketTemplateOf(loadSettings().jira.ticketTemplate);
}

export function sectionPattern(headings: string[]): RegExp | null {
  if (!headings.length) return null;
  const names = headings.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?:#+\\s*)?\\**\\s*(${names})\\s*:?\\s*\\**$`, 'i');
}
