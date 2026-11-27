import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../page/js/match.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const M = ctx.CapMatch;

test('normalizeCompany strips accents, case and legal suffixes', () => {
  assert.equal(M.normalizeCompany('Société Générale SA'), 'societe generale');
  assert.equal(M.normalizeCompany('ACME, Inc.'), 'acme');
});
test('domainsFromUrl drops ATS hosts', () => {
  assert.deepEqual([...M.domainsFromUrl('https://jobs.acme.fr/x')], ['acme.fr']);
  assert.deepEqual([...M.domainsFromUrl('https://boards.greenhouse.io/acme/1')], []);
  assert.deepEqual([...M.domainsFromUrl('not a url')], []);
  assert.deepEqual([...M.domainsFromUrl('https://jobs.acme.co.uk/x')], ['acme.co.uk']);
});
test('matchCompany prefers sender domain, then whole-word name', () => {
  const cs = [{ name: 'Acme', norm: 'acme', domains: ['acme.fr'] }, { name: 'Bo', norm: 'bo', domains: [] }];
  assert.equal(M.matchCompany({ sender: 'rh@mail.acme.fr' }, cs), 'Acme');
  assert.equal(M.matchCompany({ sender: 'Marie <rh@acme.fr>' }, cs), 'Acme');
  assert.equal(M.matchCompany({ subject: 'Votre candidature chez ACME SAS' }, cs), 'Acme');
  assert.equal(M.matchCompany({ subject: 'Acmeville news' }, cs), null);
  assert.equal(M.matchCompany({ subject: 'bo bo' }, cs), null); // norm < 3 ignoré
});
test('isJobRelated and isInterviewEvent', () => {
  assert.equal(M.isJobRelated({ subject: 'Suite à votre candidature' }), true);
  assert.equal(M.isJobRelated({ subject: 'Black Friday -50 %' }), false);
  assert.equal(M.isInterviewEvent({ subject: 'Échange avec Marie' }, []), true);
});

test('domainsFromUrl drops the extended job-board list', () => {
  for (const u of ['https://www.apec.fr/x', 'https://www.hellowork.com/x', 'https://candidat.francetravail.fr/x', 'https://x.wd3.myworkdayjobs.com/y',
    'https://career5.successfactors.eu/x', 'https://jobs.welcomekit.co/x', 'https://acme.teamtailor.com/jobs/1', 'https://acme.taleez.com/x']) {
    assert.deepEqual([...M.domainsFromUrl(u)], [], u);
  }
  assert.equal(M.isJobBoardDomain('apec.fr'), true);
  assert.equal(M.isJobBoardDomain('acme.fr'), false);
});

test('keywords match whole words only; « call » is not an interview word', () => {
  assert.equal(M.isJobRelated({ subject: 'La Poste : votre colis arrive' }), false); // the postal service, not a job
  assert.equal(M.isJobRelated({ subject: 'Un poste de chef de projet' }), true);
  assert.equal(M.isJobRelated({ subject: 'New applications for your app store listing' }), false);
  assert.equal(M.isJobRelated({ subject: 'Posted: weekly digest' }), false);
  assert.equal(M.isJobRelated({ subject: 'Re: your application' }), true);
  assert.equal(M.isJobRelated({ subject: 'Invitation à un entretien' }), true);
  assert.equal(M.isJobRelated({ text: "Nouvelle offre d'emploi chez Acme" }), true);
  assert.equal(M.isJobRelated({ subject: 'Votre test technique' }), true);
  assert.equal(M.isInterviewEvent({ subject: 'Call with the bank' }, []), false);
  assert.equal(M.isInterviewEvent({ subject: 'Recall: dentist' }, []), false);
  assert.equal(M.isInterviewEvent({ subject: 'Interviewing tips webinar' }, []), false);
  assert.equal(M.isInterviewEvent({ subject: 'Entretien téléphonique' }, []), true);
  assert.equal(M.isInterviewEvent({ subject: 'Visio avec Marie' }, []), true);
});
