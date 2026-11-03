/**
 * The census, read in the agent's own browser (PROPOSAL-FORM-WIDGETS-DESIGN.md 3.5; David
 * 2026-10-31: the form is always submitted with what a carrier's quote needs, filled from the
 * census where it can). The file is never sent anywhere. What leaves this file for the stored
 * answer is `facts`: counts only. Names and row numbers come back only in `issues`, for the
 * agent's screen; they are never stored.
 *
 * Any layout. Columns are found by their HEADINGS, the header row within the first 25 rows, with
 * the aliases LinkSheet's census reader uses (`extractCensusFromRows` in Medical.gs) plus the
 * ancillary template's columns, matched by WHOLE WORDS (so "Coverage" is never "age").
 * Files: CSV or tab-separated text, and Excel .xlsx, unzipped by the browser itself
 * (DecompressionStream; node's zlib in the tests), so no library. Old .xls, PDF and scans are
 * refused with a reason: the agent answers by hand or saves the file as .xlsx or CSV.
 *
 *   CensusReader.fromFile(name, arrayBuffer, inflateRaw?) -> Promise<{ sheets: [{ name, rows }], date1904 } | { error }>
 *   CensusReader.parseCsv(text)                    -> rows (arrays of cell text)
 *   CensusReader.read(rows, { effectiveDate, date1904, eligible }) -> { ok, error, facts, derived, issues }
 *     (`eligible` = the form's count: see basis(), for a census that lists only the employees enrolling)
 *   CensusReader.fromXlsxParts(partText) / fromText(name, text) -> the same as fromFile, at once (Apps Script)
 *   read(rows, { ..., people: true }) adds people: [{ dob, age, gender, salary }] per employee, for the
 *     quote builder only (it prices from them in memory); the form never asks for it, so never stores it
 *   CensusReader.readSheets(sheets, opts)          -> the first sheet that reads, else the first error
 *   CensusReader.pickBand(options, value)          -> the option whose lower bound is the highest <= value
 *
 * `derived` = the answers the census settles: group { age65, age70, outOfState, extraterritorial } and
 * per line { share, enrolled, children, assumed? } ('yes' / 'no' only when the census decides it whatever
 * the rows it cannot read say; otherwise left out, so the question is still asked), and `basis`
 * (the eligible count the shares are of: basis()). Life and disability lines (a "Basic Life", "STD" ...
 * column: ELECTIONS) carry { share, enrolled } only; meetsMinimum() turns one into a carrier's yes / no.
 *
 * Runs in the browser (window.CensusReader) and in node (module.exports) for the tests.
 */
(function (root) {
  'use strict';

  var LINES = ['Dental', 'Vision']; // the lines a census tier column can speak for
  // Life and disability (David 11-03): one column each saying who enrolls, never a tier. It answers only
  // that line's enrollment minimum (meetsMinimum), and never counts toward `enrolledNone` (dental and
  // vision's "no enrollment column = everyone enrolls"), so an LTD column alone changes nothing there.
  var ELECTIONS = { basicLife: 'Basic Life/AD&D', suppLife: 'Supplemental Life/AD&D', std: 'Short Term Disability',
    ltd: 'Long Term Disability' };
  // The headings Link's 2-50 census template carries for them (David 11-03), each read as its line (a test):
  // three added, and "Vol Life Amount", already there, for supplemental life (an amount = enrolling; a second
  // supplemental column would lose to it, the first match). LinkSheet matches census headings by SUBSTRING
  // (extractCensusFromRows: "age", "coverage", "tier", "enrollment", "status" ...), so these hold none of its
  // words (a test reads Medical.gs).
  var TEMPLATE_COLUMNS = { basicLife: 'Basic Life (Y/N)', suppLife: 'Vol Life Amount', std: 'STD (Y/N)', ltd: 'LTD (Y/N)' };
  var NOT_EMPLOYEE = ['spouse', 'sp', 'child', 'children', 'ch', 'dependent', 'dependents', 'dep', 'beneficiary'];

  // ---------------------------------------------------------------- files

  /** A picked file -> its sheets of rows. `inflateRaw(bytes) -> Promise<bytes>` is for node. */
  function fromFile(name, buffer, inflateRaw) {
    var bytes = new Uint8Array(buffer);
    var lower = String(name || '').toLowerCase();
    if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) {
      return Promise.resolve({ error: 'This is an older Excel file (.xls). Save it as .xlsx or CSV and choose it again.' });
    }
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return Promise.resolve({ error: 'A PDF cannot be read here. Choose the census as a spreadsheet (.xlsx or CSV), ' +
        'or answer the questions yourself.' });
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
      return readXlsx_(bytes, inflateRaw || browserInflate_).catch(function (e) {
        return { error: 'This Excel file could not be opened (' + e.message + '). Save it as .xlsx or CSV and choose it again.' };
      });
    }
    if (/\.(xlsx|xlsm|xls|pdf|png|jpe?g|heic|docx?)$/.test(lower)) {
      return Promise.resolve({ error: 'This file type cannot be read here. Choose the census as .xlsx or CSV.' });
    }
    return Promise.resolve({ sheets: [{ name: name || 'file', rows: parseCsv(decodeText_(bytes)) }], date1904: false });
  }

  function decodeText_(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes); // a CSV saved by older Excel
    }
  }

  /** CSV (or tab- or semicolon-separated) text -> rows. Quotes, doubled quotes and line breaks in quotes. */
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = (text.split(/\r?\n/).filter(function (l) { return l.trim(); })[0]) || '';
    var delim = [',', '\t', ';'].map(function (d) { return [d, first.split(d).length]; })
      .sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [];
    var row = [];
    var cell = '';
    var quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (quoted) {
        if (ch === '"' && text.charAt(i + 1) === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function browserInflate_(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /** The zip's entries by name: { method, data } (data still compressed). */
  function unzip_(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var end = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('not a zip');
    var count = dv.getUint16(end + 10, true);
    var at = dv.getUint32(end + 16, true);
    var out = {};
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip directory');
      var method = dv.getUint16(at + 10, true);
      var size = dv.getUint32(at + 20, true);
      var nameLen = dv.getUint16(at + 28, true);
      var extraLen = dv.getUint16(at + 30, true);
      var commentLen = dv.getUint16(at + 32, true);
      var local = dv.getUint32(at + 42, true);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLen));
      var start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      out[name] = { method: method, data: bytes.subarray(start, start + size) };
      at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** .xlsx -> { sheets: [{ name, rows }], date1904 }: shared and inline strings, numbers, booleans. */
  function readXlsx_(bytes, inflateRaw) {
    var zip = unzip_(bytes);
    var text = function (path) {
      var e = zip[path];
      if (!e) return Promise.resolve('');
      var raw = e.method === 0 ? Promise.resolve(e.data) : e.method === 8 ? inflateRaw(e.data)
        : Promise.reject(new Error('compression ' + e.method));
      return raw.then(function (b) { return new TextDecoder('utf-8').decode(b); });
    };
    return Promise.all([text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'), text('xl/sharedStrings.xml')])
      .then(function (parts) {
        var ix = xlsxIndex_(parts[0], parts[1], parts[2]);
        return Promise.all(ix.sheets.map(function (s) { return text(s.path); })).then(function (xmls) {
          return { date1904: ix.date1904, sheets: ix.sheets.map(function (s, i) { return { name: s.name, rows: sheetRows_(xmls[i], ix.shared) }; }) };
        });
      });
  }

  /** The workbook's own parts -> { date1904, sheets: [{ name, path }], shared strings }. */
  function xlsxIndex_(book, rels, sharedXml) {
    if (!book) throw new Error('no workbook');
    var targets = {};
    each_(/<Relationship\b([^>]*)\/?>/g, rels, function (m) {
      targets[attr_(m[1], 'Id')] = attr_(m[1], 'Target');
    });
    var shared = [];
    each_(/<si>([\s\S]*?)<\/si>/g, sharedXml, function (m) { shared.push(runs_(m[1])); });
    var sheets = [];
    each_(/<sheet\b([^>]*)\/?>/g, book, function (m) {
      var target = targets[attr_(m[1], 'r:id')] || '';
      var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      sheets.push({ name: unescape_(attr_(m[1], 'name')), path: path });
    });
    return { date1904: /<workbookPr\b[^>]*date1904="(1|true)"/.test(book), sheets: sheets, shared: shared };
  }

  /**
   * An .xlsx already unzipped, read at once (Apps Script: Utilities.unzip gives the parts, and there
   * is no TextDecoder or DecompressionStream). partText(path) -> the part's text, '' when absent.
   * For the quote builder (design doc 3.5, D5): the same reader as the form, so they never disagree.
   */
  function fromXlsxParts(partText) {
    try {
      var ix = xlsxIndex_(partText('xl/workbook.xml'), partText('xl/_rels/workbook.xml.rels'), partText('xl/sharedStrings.xml'));
      return { date1904: ix.date1904, sheets: ix.sheets.map(function (s) { return { name: s.name, rows: sheetRows_(partText(s.path), ix.shared) }; }) };
    } catch (e) {
      return { error: 'This Excel file could not be opened (' + e.message + ').' };
    }
  }

  /** CSV or tab-separated text already decoded (Apps Script reads a file's text itself). */
  function fromText(name, text) {
    return { sheets: [{ name: name || 'file', rows: parseCsv(text) }], date1904: false };
  }

  function each_(re, s, fn) {
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(s || ''))) fn(m);
  }

  function attr_(attrs, name) {
    var m = new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"').exec(attrs || '');
    return m ? m[1] : '';
  }

  function unescape_(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (all, e) {
      var k = e.toLowerCase();
      if (k.charAt(0) === '#') return String.fromCodePoint(k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
    });
  }

  /** A string item's text: every <t> run, phonetic runs left out. */
  function runs_(xml) {
    var out = '';
    each_(/<t\b[^>]*>([\s\S]*?)<\/t>/g, String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), function (m) { out += unescape_(m[1]); });
    return out;
  }

  function colIndex_(ref) {
    var letters = String(ref).replace(/[^A-Z]/g, '');
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  /** A worksheet -> rows, placed by their own row numbers (row r is rows[r - 1]). */
  function sheetRows_(xml, shared) {
    var rows = [];
    each_(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, xml, function (rm) {
      var r = parseInt(attr_(rm[1], 'r'), 10) || rows.length + 1;
      var row = [];
      each_(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, rm[2] || '', function (cm) {
        var t = attr_(cm[1], 't');
        var body = cm[2] || '';
        var v = /<v>([\s\S]*?)<\/v>/.exec(body);
        var value = '';
        if (t === 's') value = v ? shared[parseInt(v[1], 10)] || '' : '';
        else if (t === 'inlineStr') value = runs_((/<is>([\s\S]*?)<\/is>/.exec(body) || [])[1] || '');
        else if (t === 'str' || t === 'e') value = v ? unescape_(v[1]) : '';
        else if (t === 'b') value = v ? v[1] === '1' : '';
        else if (v) value = parseFloat(v[1]);
        row[colIndex_(attr_(cm[1], 'r')) >= 0 ? colIndex_(attr_(cm[1], 'r')) : row.length] = value;
      });
      rows[r - 1] = row;
    });
    return rows;
  }

  // ---------------------------------------------------------------- headings

  function norm_(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function has_(h, phrase) {
    return (' ' + h + ' ').indexOf(' ' + phrase + ' ') >= 0;
  }

  function any_(h, phrases) {
    return phrases.some(function (p) { return has_(h, p); });
  }

  var NOT_A_TIER = ['plan', 'carrier', 'premium', 'cost', 'amount', 'rate', 'contribution', 'deduction', 'id', 'number'];
  var NOT_SALARY = ['hourly', 'hour', 'hours', 'frequency', 'type', 'mode', 'period', 'monthly', 'weekly', 'rate', 'class', 'basis'];

  // In this order; each column goes to the first fact that claims it.
  var COLUMNS = [
    ['dentalTier', function (h) { return has_(h, 'dental') && !any_(h, NOT_A_TIER); }],
    ['dentalPlan', function (h) { return has_(h, 'dental') && has_(h, 'plan'); }],
    ['visionTier', function (h) { return has_(h, 'vision') && !any_(h, NOT_A_TIER); }],
    ['visionPlan', function (h) { return has_(h, 'vision') && has_(h, 'plan'); }],
    // Who enrolls in life and disability (an amount counts too: "Vol Life Amount"); the employee's own, never a spouse's.
    ['suppLife', function (h) {
      return any_(h, ['supplemental life', 'supp life', 'voluntary life', 'vol life', 'optional life', 'additional life']) &&
        !any_(h, NOT_EMPLOYEE);
    }],
    ['basicLife', function (h) {
      return any_(h, ['basic life', 'group life', 'life']) && !any_(h, NOT_EMPLOYEE) &&
        !any_(h, ['supplemental', 'supp', 'voluntary', 'vol', 'optional', 'additional']);
    }],
    ['std', function (h) { return any_(h, ['std', 'short term disability']) && !any_(h, NOT_EMPLOYEE); }],
    ['ltd', function (h) { return any_(h, ['ltd', 'long term disability']) && !any_(h, NOT_EMPLOYEE); }],
    ['relationship', function (h) { return any_(h, ['relationship', 'relation', 'dependent type', 'member type']); }],
    ['dob', function (h) { return any_(h, ['date of birth', 'dob', 'd o b', 'birth date', 'birthdate', 'birthday', 'birth']); }],
    ['age', function (h) { return has_(h, 'age') && !has_(h, 'date'); }],
    ['gender', function (h) { return any_(h, ['gender', 'sex']); }],
    ['salary', function (h) {
      return any_(h, ['annual salary', 'salary', 'compensation', 'annual comp', 'annual earnings', 'earnings', 'annual pay',
        'annual wage', 'wages', 'income']) && !any_(h, NOT_SALARY);
    }],
    ['homeZip', function (h) { return has_(h, 'home') && any_(h, ['zip', 'zipcode', 'postal']); }],
    ['zip', function (h) { return any_(h, ['zip', 'zipcode', 'postal']) && !any_(h, ['work', 'employer', 'company', 'office']); }],
    ['first', function (h) { return any_(h, ['first name', 'firstname', 'first', 'fname', 'given name']); }],
    ['last', function (h) { return any_(h, ['last name', 'lastname', 'last', 'lname', 'surname', 'family name']); }],
    ['name', function (h) { return any_(h, ['full name', 'member name', 'employee name', 'name']); }]
  ];

  function mapColumns_(row) {
    var heads = (row || []).map(norm_);
    var cols = {};
    var taken = {};
    COLUMNS.forEach(function (c) {
      for (var i = 0; i < heads.length; i++) {
        if (!taken[i] && heads[i] && c[1](heads[i])) { cols[c[0]] = i; taken[i] = true; return; }
      }
    });
    if (cols.homeZip == null && cols.zip != null) cols.homeZip = cols.zip;
    delete cols.zip;
    return cols;
  }

  /** The heading row: the best-scoring row in the first 25 that names a person and holds a fact. */
  function findHeader_(rows) {
    var best = null;
    for (var r = 0; r < Math.min(rows.length, 25); r++) {
      if (!rows[r]) continue;
      var cols = mapColumns_(rows[r]);
      var named = cols.first != null || cols.last != null || cols.name != null;
      var facts = ['dob', 'age', 'gender', 'salary', 'homeZip', 'relationship', 'dentalTier', 'visionTier', 'dentalPlan', 'visionPlan']
        .concat(Object.keys(ELECTIONS))
        .filter(function (k) { return cols[k] != null; }).length;
      if (!facts || (!named && facts < 3)) continue;
      var score = facts + (named ? 1 : 0);
      if (!best || score > best.score) best = { row: r, cols: cols, score: score };
    }
    return best;
  }

  // ---------------------------------------------------------------- values

  var EE = ['employee', 'ee', 'emp', 'self', 'subscriber', 'sub', 'primary', 'insured', 'e', 'member', 'employee self', 'ee self'];
  var SP = ['spouse', 'sp', 's', 'husband', 'wife', 'domestic partner', 'dp', 'partner', 'civil union partner'];
  var CH = ['child', 'ch', 'c', 'son', 'daughter', 'dependent', 'dep', 'd', 'stepchild', 'step child', 'dependent child',
    'children', 'foster child', 'adopted child', 'grandchild'];

  /** 'EE' | 'SP' | 'CH' | '??' (a word this reader does not know: never a child, LinkSheet binder). */
  function relationship_(v) {
    var s = norm_(v);
    if (EE.indexOf(s) >= 0) return 'EE';
    if (SP.indexOf(s) >= 0) return 'SP';
    if (CH.indexOf(s) >= 0) return 'CH';
    return '??';
  }

  var TIER_NONE = ['', 'waive', 'waived', 'waiver', 'w', 'wv', 'decline', 'declined', 'dec', 'none', 'no', 'n', 'na', 'n+a',
    'notenrolled', 'optout', 'optedout', 'nocoverage', 'notcovered', '0'];
  var TIER_YES = ['y', 'yes', 'x', 'enrolled', 'enroll', 'covered', 'elect', 'elected'];
  var TIERS = {
    ee: ['ee', 'employee', 'employeeonly', 'eeonly', 'single', 'emp', 'e', 'individual', 'eo', 'self', 'subscriber', 'subscriberonly'],
    es: ['es', 'ee+sp', 'ee+s', 'esp', 'e+s', 'emp+sp', 'employee+spouse', 'employeespouse', 'ee+spouse', 'eespouse', 'ee+dp',
      'employee+domesticpartner', 'ee+partner', 'employee+partner'],
    ec: ['ec', 'ee+ch', 'ee+c', 'ee+children', 'ee+child', 'e+c', 'ech', 'emp+ch', 'employee+child', 'employee+children',
      'employeechildren', 'employeechild', 'parent+child', 'parentchild', 'ee+kids', 'ee+dep', 'ee+deps', 'employee+dependent',
      'employee+dependents'],
    fam: ['fam', 'family', 'f', 'ee+fam', 'ee+family', 'employee+family', 'efam', 'ef', 'full', 'fullfamily', 'ee+sp+ch',
      'employee+spouse+children', 'ee+sp+children']
  };

  /** A tier cell -> 'ee' | 'es' | 'ec' | 'fam' | 'none' | 'yes' (enrolled, tier not given) | 'unknown'. */
  function tier_(v) {
    var s = String(v == null ? '' : v).toLowerCase().replace(/\(ren\)/g, 'ren').replace(/&|\band\b|\/|\bwith\b/g, '+')
      .replace(/[^a-z0-9+]/g, '').replace(/\+{2,}/g, '+').replace(/^\+|\+$/g, '');
    if (TIER_NONE.indexOf(s) >= 0 || s === '-') return 'none';
    for (var k in TIERS) if (TIERS[k].indexOf(s) >= 0) return k;
    if (TIER_YES.indexOf(s) >= 0) return 'yes';
    return 'unknown';
  }

  /** An annual salary, or null; `odd` when a number is too small to be a year's pay (hourly or monthly?). */
  function salary_(v) {
    if (v == null || v === '') return { value: null };
    var n = typeof v === 'number' ? v : (function () {
      var s = String(v).toLowerCase().replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '$1');
      var k = /^([0-9.]+)k$/.exec(s);
      return k ? parseFloat(k[1]) * 1000 : /^[0-9.]+$/.test(s) ? parseFloat(s) : NaN;
    })();
    if (!isFinite(n) || n <= 0) return { value: null, bad: String(v) };
    return n < 5000 ? { value: null, odd: n } : { value: n };
  }

  function utc_(y, m, d) {
    var t = Date.UTC(y, m - 1, d);
    var x = new Date(t);
    return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? x : null;
  }

  /** A date cell -> a UTC Date, or null. Excel serial numbers; M/D/YYYY, M/D/YY, YYYY-MM-DD, "Jan 5, 1980". */
  function date_(v, date1904, effYear) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      if (v < 1 || v > 80000) return null;
      var base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
      return new Date(base + Math.round(v) * 86400000);
    }
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (m) return utc_(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
    if (m) {
      var y = +m[3];
      if (m[3].length === 2) y += y <= (effYear % 100) ? 2000 : 1900; // the usual pivot: '05' = 2005, '45' = 1945
      return utc_(y, +m[1], +m[2]);
    }
    if (/^\d+(\.\d+)?$/.test(s)) return date_(parseFloat(s), date1904, effYear); // a serial number typed as text
    var t = Date.parse(s + ' UTC');
    return isNaN(t) ? null : new Date(t);
  }

  function isoDate_(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function ageAt_(dob, eff) {
    var a = eff.getUTCFullYear() - dob.getUTCFullYear();
    if (eff.getUTCMonth() < dob.getUTCMonth() || (eff.getUTCMonth() === dob.getUTCMonth() && eff.getUTCDate() < dob.getUTCDate())) a--;
    return a;
  }

  function gender_(v) {
    var s = norm_(v);
    if (['m', 'male', 'man'].indexOf(s) >= 0) return 'M';
    if (['f', 'female', 'woman'].indexOf(s) >= 0) return 'F';
    return 'U'; // the carrier's census takes U = unknown
  }

  /** The home ZIP's state, as far as the rules need it: 'MI', 'XT' (AK, LA, MS, MT, TX), 'OTHER' or '' (unreadable). */
  function zipState_(v) {
    var s = String(v == null ? '' : v).trim();
    if (typeof v === 'number' && /^\d{3,4}$/.test(s)) s = ('00000' + s).slice(-5); // leading zeros lost in a number cell
    var m = /^(\d{5})(-\d{4})?$/.exec(s);
    if (!m) return '';
    var z3 = parseInt(m[1].slice(0, 3), 10);
    if (z3 >= 480 && z3 <= 499) return 'MI';
    if ((z3 >= 995 && z3 <= 999) || (z3 >= 700 && z3 <= 714) || (z3 >= 386 && z3 <= 397) || (z3 >= 590 && z3 <= 599) ||
      z3 === 733 || (z3 >= 750 && z3 <= 799) || z3 === 885) return 'XT';
    return 'OTHER';
  }

  // ---------------------------------------------------------------- the census

  function read(rows, opts) {
    opts = opts || {};
    rows = rows || [];
    var eff = (opts.effectiveDate && date_(opts.effectiveDate, false, 2000)) || new Date();
    var head = findHeader_(rows);
    if (!head) {
      return { ok: false, error: 'No row of column headings was found in the first 25 rows (for example First Name, Date of Birth, ' +
        'Salary, Dental Tier).' };
    }
    var c = head.cols;
    var cell = function (row, key) { return c[key] == null ? '' : row[c[key]]; };
    var members = c.relationship != null;
    var units = []; // one per employee: { row, name, cells, deps: [rel] }
    var issues = [];
    var unknownRel = 0;
    for (var r = head.row + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.some(function (v) { return String(v == null ? '' : v).trim() !== ''; })) continue;
      var name = [cell(row, 'first'), cell(row, 'last')].join(' ').trim() || String(cell(row, 'name') || '').trim();
      var rel = members ? relationship_(cell(row, 'relationship')) : 'EE';
      if (rel === 'EE') {
        units.push({ row: r + 1, name: name, cells: row, deps: [] });
      } else if (rel === '??') {
        unknownRel++;
        issues.push({ row: r + 1, name: name, problems: ['relationship "' + String(cell(row, 'relationship')).trim() +
          '" not understood: not counted'] });
      } else if (units.length) {
        units[units.length - 1].deps.push({ rel: rel, cells: row });
      }
    }
    if (!units.length) return { ok: false, error: 'No employees were found under the headings.' };

    var lines = {};
    LINES.forEach(function (line) {
      var tierCol = line.toLowerCase() + 'Tier';
      var planCol = line.toLowerCase() + 'Plan';
      var key = c[tierCol] != null ? tierCol : c[planCol] != null ? planCol : '';
      if (!key) return;
      var info = { enrolled: 0, tiers: { ee: 0, es: 0, ec: 0, fam: 0 }, tierUnknown: 0, families: 0, children: 0, familiesNoKids: 0,
        source: key === tierCol ? 'tier' : 'plan', filled: 0 };
      units.forEach(function (u) {
        var v = cell(u.cells, key);
        if ((v == null || String(v).trim() === '') && u.deps.length) {
          u.deps.forEach(function (d) { if (v == null || String(v).trim() === '') v = cell(d.cells, key); });
        }
        if (String(v == null ? '' : v).trim() !== '') info.filled++;
        var t = key === tierCol ? tier_(v) : tier_(v) === 'none' ? 'none' : 'yes';
        if (t === 'none') return;
        info.enrolled++;
        u.enrolls = true;
        if (info.tiers[t] != null) info.tiers[t]++;
        else {
          info.tierUnknown++;
          if (t === 'unknown') issues.push({ row: u.row, name: u.name, problems: [line + ' "' + String(v).trim() + '" not understood as a tier'] });
        }
        if (members && (t === 'ec' || t === 'fam')) {
          var kids = u.deps.filter(function (d) { return d.rel === 'CH'; }).length;
          if (kids) { info.families++; info.children += kids; } else info.familiesNoKids++;
        }
      });
      if (!info.filled) return; // an empty column says nothing (never "nobody enrolls")
      delete info.filled;
      lines[line] = info;
    });
    // Life and disability: who enrolls, from the employee's row (a dependent's when it is blank, as above).
    // Blank, "N", "waive", "0" = not enrolling; anything else (Y, an amount, a plan) = enrolling.
    var dvLines = Object.keys(lines);
    Object.keys(ELECTIONS).forEach(function (key) {
      if (c[key] == null) return;
      var enrolled = 0;
      var filled = 0;
      units.forEach(function (u) {
        var v = cell(u.cells, key);
        u.deps.forEach(function (d) { if (v == null || String(v).trim() === '') v = cell(d.cells, key); });
        if (String(v == null ? '' : v).trim() !== '') filled++;
        if (tier_(v) !== 'none') enrolled++;
      });
      if (filled) lines[ELECTIONS[key]] = { enrolled: enrolled, source: 'election' };
    });

    var age = { known: 0, age65: 0, age70: 0 };
    var zip = { known: 0, outsideMI: 0, xterr: 0 };
    var missing = { age: 0, salary: 0, gender: 0 };
    var salaryOdd = 0;
    var people = []; // only when opts.people (the quote builder); the form never asks for it
    units.forEach(function (u) {
      var problems = [];
      var a = null;
      var d = c.dob != null ? date_(cell(u.cells, 'dob'), opts.date1904, eff.getUTCFullYear()) : null;
      if (d) a = ageAt_(d, eff);
      else if (c.age != null && String(cell(u.cells, 'age')).trim() !== '') a = Math.floor(parseFloat(cell(u.cells, 'age')));
      if (a == null || !isFinite(a) || a < 14 || a > 100) {
        a = null;
        d = null;
        missing.age++;
        problems.push('no readable date of birth or age');
      } else {
        age.known++;
        if (a >= 65) age.age65++;
        if (a >= 70) age.age70++;
      }
      var s = salary_(cell(u.cells, 'salary'));
      if (opts.people) {
        people.push({ dob: d ? isoDate_(d) : '', age: a, gender: gender_(cell(u.cells, 'gender')), salary: s.value == null ? null : s.value });
      }
      if (s.value == null) {
        missing.salary++;
        if (s.odd) { salaryOdd++; problems.push('salary ' + s.odd + ' looks hourly or monthly, not a year\'s pay'); }
        else if (c.salary != null) problems.push('no annual salary');
      }
      if (gender_(cell(u.cells, 'gender')) === 'U') missing.gender++;
      var st = zipState_(cell(u.cells, 'homeZip'));
      if (st) {
        zip.known++;
        if (st !== 'MI') zip.outsideMI++;
        if (st === 'XT') zip.xterr++;
      }
      if (problems.length) issues.push({ row: u.row, name: u.name, problems: problems });
    });
    if (c.salary == null) issues.unshift({ row: head.row + 1, name: '', problems: ['no salary column (needed for pay-based coverage)'] });

    var eligible = units.length;
    var facts = {
      eligible: eligible,
      layout: members ? 'members' : 'employees',
      found: Object.keys(c).filter(function (k) { return ['first', 'last', 'name'].indexOf(k) < 0; }).sort(),
      lines: lines,
      // employees enrolling in none of the dental / vision coverages the file shows; null = it shows none
      // (life and disability columns never count here: ELECTIONS)
      enrolledNone: dvLines.length ? units.filter(function (u) { return !u.enrolls; }).length : null,
      age: age,
      zip: zip,
      missing: missing,
      salaryOdd: salaryOdd,
      unknownRelationships: unknownRel
    };
    var out = { ok: true, facts: facts, derived: derive(facts, opts.eligible), issues: issues, headerRow: head.row + 1 };
    if (opts.people) out.people = people;
    return out;
  }

  /**
   * The eligible count the census's shares are of: the form's Company Size (FTE), `formEligible`,
   * whenever the form gives one (the census only counts the people it lists). David 11-01:
   *   - listed = the form's count, with an enrollment column: as before;
   *   - fewer listed: the rest are eligible and not enrolling (a census may list only those
   *     enrolling: "if all are enrolled agent will have to indicate how many FTE there are");
   *   - more listed (`over`): some on it are not eligible, so it settles no share;
   *   - no enrollment column: everyone on it is taken as enrolling ("assume all enrolling, ask for FTE").
   * Any of the last three = `confirm`: the agent confirms the number before sending ("flag that the
   * FTE doesnt match. Make the agent confirm the right number").
   * -> { eligible, listed, over, confirm }
   */
  function basis(f, formEligible) {
    var form = Number(formEligible);
    var n = form > 0 ? form : f.eligible; // no form count yet: the census's own, nothing to confirm against
    return { eligible: n, listed: f.eligible, over: f.eligible > n,
      confirm: form > 0 && (n !== f.eligible || f.enrolledNone == null) };
  }

  /**
   * The answers the census settles, as shares of basis()'s eligible count. A share is 'yes' or
   * 'no' only when the rows it cannot read (and the employees it does not list) could not change
   * it; otherwise it is left out and the question stays. A census with no enrollment column counts
   * everyone on it as enrolling in each coverage it could speak for (`assumed`).
   */
  function derive(f, formEligible) {
    var b = basis(f, formEligible);
    var n = b.eligible;
    if (b.over) return { group: {}, lines: {}, basis: b }; // some listed are not eligible: no share is known
    var decide = function (count, unknown, test) {
      var low = test(count / n);
      var high = test((count + unknown) / n);
      return low === high ? (low ? 'yes' : 'no') : undefined;
    };
    var group = {};
    var g;
    g = decide(f.age.age65, n - f.age.known, function (x) { return x >= 0.2; });
    if (g) group.age65 = g;
    g = decide(f.age.age70 || 0, n - f.age.known, function (x) { return x > 0; }); // anyone 70+
    if (g) group.age70 = g;
    if (f.found.indexOf('homeZip') >= 0) {
      g = decide(f.zip.outsideMI, n - f.zip.known, function (x) { return x > 0.25; });
      if (g) group.outOfState = g;
      g = decide(f.zip.xterr, n - f.zip.known, function (x) { return x > 0.10; });
      if (g) group.extraterritorial = g;
    }
    var lines = {};
    Object.keys(f.lines).forEach(function (line) {
      var l = f.lines[line];
      var out = { enrolled: l.enrolled, share: Math.round(l.enrolled / n * 1000) / 10 };
      if (f.layout === 'members' && l.families && !l.familiesNoKids) out.children = l.children / l.families > 3 ? 'yes' : 'no';
      if (l.source === 'tier' && !l.tierUnknown) out.tiers = Object.assign({}, l.tiers);
      lines[line] = out;
    });
    if (f.enrolledNone == null) {
      LINES.forEach(function (line) { lines[line] = { enrolled: f.eligible, share: Math.round(f.eligible / n * 1000) / 10, assumed: true }; });
    }
    return { group: group, lines: lines, basis: b };
  }

  /**
   * A life or disability line's enrollment minimum, from the census (David 11-03): 'yes' when its
   * enrolled count meets both the share of `eligible` (basis(): the form's size) and the count, else
   * 'no'. need = a carrier's { pct, count } (its pack's askMinimums). '' = nothing to go on.
   * Counts, not the rounded share, so exactly 75% of 12 (9) is 75%.
   */
  function meetsMinimum(dl, eligible, need) {
    if (!dl || dl.enrolled == null || !need || !(eligible > 0)) return '';
    return dl.enrolled >= need.count && dl.enrolled * 100 >= need.pct * eligible ? 'yes' : 'no';
  }

  /**
   * The carrier's option for a value: each option's lower bound is its first number ("Under 35%",
   * "Fewer than 5" = 0); the option with the highest bound not above the value wins.
   */
  function pickBand(options, value) {
    var best = null;
    (options || []).forEach(function (o) {
      var t = String(o).toLowerCase();
      var num = /(\d+(?:\.\d+)?)/.exec(t);
      var lo = /^\s*(under|fewer|less|below)\b/.test(t) ? 0 : num ? parseFloat(num[1]) : null;
      if (lo == null || lo > value) return;
      if (!best || lo > best.lo) best = { lo: lo, option: o };
    });
    return best ? best.option : '';
  }

  /** The first sheet that reads as a census (most workbooks: the first). */
  function readSheets(sheets, opts) {
    var first = null;
    for (var i = 0; i < (sheets || []).length; i++) {
      var res = read(sheets[i].rows, opts);
      if (res.ok) { res.sheet = sheets[i].name; return res; }
      first = first || res;
    }
    return first || { ok: false, error: 'The file is empty.' };
  }

  var api = { fromFile: fromFile, fromXlsxParts: fromXlsxParts, fromText: fromText, parseCsv: parseCsv, read: read, readSheets: readSheets, basis: basis, derive: derive, pickBand: pickBand,
    meetsMinimum: meetsMinimum, ELECTIONS: ELECTIONS, TEMPLATE_COLUMNS: TEMPLATE_COLUMNS,
    tier: tier_, relationship: relationship_, zipState: zipState_ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CensusReader = api;
})(typeof window !== 'undefined' ? window : this);
