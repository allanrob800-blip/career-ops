(function () {
  'use strict';

  var LEGAL = ['sas', 'sasu', 'sa', 'sarl', 'inc', 'ltd', 'llc', 'gmbh', 'bv', 'ag', 'plc', 'corp', 'corporation', 'group', 'groupe'];
  var ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com',
    'welcometothejungle.com', 'teamtailor.com', 'recruitee.com', 'personio.de', 'personio.com', 'linkedin.com', 'indeed.com', 'indeed.fr'];
  // Job boards and recruiting platforms: a sender domain there is a whole board's mail, never one employer.
  var JOB_BOARDS = ['apec.fr', 'hellowork.com', 'francetravail.fr', 'pole-emploi.fr', 'jobteaser.com', 'welcomekit.co', 'cadremploi.fr',
    'meteojob.com', 'monster.fr', 'glassdoor.fr', 'glassdoor.com', 'jobvite.com', 'icims.com', 'taleo.net', 'successfactors.com',
    'successfactors.eu', 'myworkdayjobs.com', 'workday.com', 'werecruit.io', 'njoyn.com', 'talent-soft.com', 'teamtailor.com',
    'recruitee.com', 'taleez.com', 'flatchr.io', 'digitalrecruiters.com'];
  var SECOND_LEVEL = ['co', 'com', 'org', 'net', 'gouv', 'ac'];
  var JOB_WORDS = ['candidature', 'entretien', 'recrutement', 'recruteur', 'poste', "offre d'emploi", 'interview',
    'application', 'hiring', 'recruiter', 'assessment', 'test technique'];
  var EVENT_WORDS = ['entretien', 'interview', 'visio', 'echange', 'rencontre'];
  // Phrases that contain a keyword but are not about a job (removed before the keywords are looked for).
  var NOT_JOB = ['la poste'];

  function plain(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeCompany(name) {
    var words = plain(name).split(' ').filter(Boolean);
    while (words.length > 1 && LEGAL.indexOf(words[words.length - 1]) !== -1) words.pop();
    return words.join(' ');
  }

  function registrable(host) {
    var labels = host.split('.');
    if (labels.length <= 2) return host;
    var tld = labels[labels.length - 1];
    var sld = labels[labels.length - 2];
    if (tld.length === 2 && SECOND_LEVEL.indexOf(sld) !== -1) return labels.slice(-3).join('.');
    return labels.slice(-2).join('.');
  }

  function domainsFromUrl(url) {
    var host = '';
    try {
      var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(String(url || '').trim());
      if (!m) return [];
      host = m[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
    } catch (e) {
      return [];
    }
    if (!host || host.indexOf('.') === -1 || /[^a-z0-9.-]/.test(host)) return [];
    var dom = registrable(host);
    return isJobBoardDomain(dom) ? [] : [dom];
  }

  function isJobBoardDomain(dom) {
    var d = String(dom || '').toLowerCase();
    return ATS_HOSTS.indexOf(d) !== -1 || JOB_BOARDS.indexOf(d) !== -1;
  }

  function senderDomain(sender) {
    var s = String(sender || '').toLowerCase();
    var i = s.lastIndexOf('@');
    if (i === -1) return '';
    return s.slice(i + 1).replace(/[^a-z0-9.-].*$/, '').replace(/\.$/, '');
  }

  function hasWord(haystack, needle) {
    return (' ' + haystack + ' ').indexOf(' ' + needle + ' ') !== -1;
  }

  function matchCompany(fields, companies) {
    fields = fields || {};
    companies = companies || [];
    var sd = senderDomain(fields.sender);
    var i, j;
    if (sd) {
      for (i = 0; i < companies.length; i++) {
        var doms = companies[i].domains || [];
        for (j = 0; j < doms.length; j++) {
          var d = String(doms[j]).toLowerCase();
          if (d && (sd === d || sd.slice(-(d.length + 1)) === '.' + d)) return companies[i].name;
        }
      }
    }
    var texts = [fields.senderName, fields.subject, fields.text]
      .filter(function (t) { return t; })
      .map(normalizeCompany);
    for (i = 0; i < companies.length; i++) {
      var n = companies[i].norm;
      if (!n || n.length < 3) continue;
      for (j = 0; j < texts.length; j++) {
        if (hasWord(texts[j], n)) return companies[i].name;
      }
    }
    return null;
  }

  // Keywords are whole words (or whole phrases) of the normalized text: « applications » or « posted » are no hit.
  function words(s) {
    var t = ' ' + plain(s) + ' ';
    NOT_JOB.forEach(function (p) { t = t.split(' ' + p + ' ').join(' '); });
    return t.trim();
  }

  function isJobRelated(fields) {
    fields = fields || {};
    var texts = [words(fields.subject), words(fields.text)];
    return JOB_WORDS.some(function (w) {
      var k = plain(w);
      return texts.some(function (t) { return hasWord(t, k); });
    });
  }

  function isInterviewEvent(fields, companies) {
    if (matchCompany(fields, companies) !== null) return true;
    var title = words((fields || {}).subject);
    return EVENT_WORDS.some(function (w) { return hasWord(title, w); });
  }

  globalThis.CapMatch = {
    normalizeCompany: normalizeCompany,
    domainsFromUrl: domainsFromUrl,
    matchCompany: matchCompany,
    isJobRelated: isJobRelated,
    isJobBoardDomain: isJobBoardDomain,
    isInterviewEvent: isInterviewEvent
  };
})();
