// Shared page-test fixtures: the fixture snapshot documents and fictitious Outlook items.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_ROOT } from '../helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT = join(HERE, '..', '..', 'export.mjs');

export const NOW = '2026-11-27T10:00:00+01:00'; // Friday morning, Paris

// Fixture docs only: the data root is forced to the fixtures, never the real one.
export function fixtureDocs() {
  const env = { ...process.env, CAREER_OPS_ROOT: FIXTURE_ROOT };
  for (const k of ['CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER', 'CAREER_OPS_PROFILE']) delete env[k];
  const out = JSON.parse(execFileSync(process.execPath, [EXPORT], { env, encoding: 'utf8' }));
  return Object.fromEntries(out.docs.map((d) => [d.path, d.data]));
}

// Shape observed for outlook_email_search: one object per e-mail, then a trailer object. All senders are fictitious.
export const EMAILS = [
  {
    uri: 'mail:///messages/AAMk-acme-1', id: 'AAMk-acme-1', subject: 'Suite à notre échange', sender: 'rh@acme.fr', senderName: 'Service RH',
    recipients: ['camille@exemple.test'], receivedDateTime: '2026-11-26T09:12:00Z', sentDateTime: '2026-11-26T09:11:40Z',
    summary: 'Bonjour, merci pour le temps accordé mardi. Nous revenons vers vous avant la fin de la semaine.',
    hasAttachments: false, importance: 'normal', isRead: false, webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk-acme-1', internetMessageId: '<1@acme.fr>', offset: 0,
  },
  {
    uri: 'mail:///messages/AAMk-promo-1', id: 'AAMk-promo-1', subject: 'Black Friday : -50 % sur tout le site', sender: 'promo@boutique-exemple.test', senderName: 'Boutique Exemple',
    recipients: ['camille@exemple.test'], receivedDateTime: '2026-11-27T06:00:00Z', sentDateTime: '2026-11-27T06:00:00Z',
    summary: 'Profitez de nos remises jusqu\'à dimanche soir.',
    hasAttachments: false, importance: 'normal', isRead: true, webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk-promo-1', internetMessageId: '<2@boutique-exemple.test>', offset: 1,
  },
  {
    uri: 'mail:///messages/AAMk-inconnu-1', id: 'AAMk-inconnu-1', subject: 'Votre candidature', sender: 'talent@societe-inconnue.test', senderName: 'Équipe Talent',
    recipients: ['camille@exemple.test'], receivedDateTime: '2026-11-25T15:40:00Z', sentDateTime: '2026-11-25T15:40:00Z',
    summary: 'Nous avons bien reçu votre dossier et l\'étudions avec attention.',
    hasAttachments: false, importance: 'normal', isRead: true, webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk-inconnu-1', internetMessageId: '<3@societe-inconnue.test>', offset: 2,
  },
  { moreResults: true, nextOffset: 25, totalResultCount: 40, note: 'More results are available.' },
];

// The event shape was not observed (empty calendar): documented {dateTime, timeZone} wall-clock pairs.
export const EVENTS = [
  {
    id: 'evt-foxtrot', subject: 'Entretien Foxtrot : Head of Product',
    start: { dateTime: '2026-11-30T14:00:00.0000000', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-11-30T15:00:00.0000000', timeZone: 'Europe/Paris' },
    location: { displayName: 'Visio Teams' }, webLink: 'https://outlook.office365.com/calendar/item/evt-foxtrot',
  },
  {
    id: 'evt-dentiste', subject: 'Dentiste',
    start: { dateTime: '2026-12-01T09:00:00.0000000', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-12-01T09:30:00.0000000', timeZone: 'Europe/Paris' },
    location: 'Cabinet', webLink: 'https://outlook.office365.com/calendar/item/evt-dentiste',
  },
  {
    id: 'evt-acme', subject: 'Point avec Acme',
    start: { dateTime: '2026-11-27T15:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-27T16:00:00.0000000', timeZone: 'UTC' },
    location: 'Salle Horizon, 3e étage',
  },
  { moreResults: false },
];
