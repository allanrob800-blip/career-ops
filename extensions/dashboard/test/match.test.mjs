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
