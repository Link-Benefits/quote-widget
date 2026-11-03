/**
 * Reads Jotform's answer to getFieldsValueById into { <requested id>: <string> }.
 *
 * getFieldsValueById is in Jotform's widget library but NOT in its documentation, so its
 * reply shape is unknown until the live probe. This accepts an array of { id|qid|selector|
 * name, value } items, an object holding such an array, or an object keyed by id. Ids match
 * on their first run of digits, so "input_5", "q5_zip" and "5" are all question 5. An
 * Address field answers with parts: the postal code is taken; a Full Name field's parts are
 * joined. Returns null when nothing requested was found.
 *
 * Runs in the browser (window.FieldValues) and in node (module.exports) for the tests.
 */
(function (root) {
  'use strict';

  function bare_(k) {
    var m = String(k == null ? '' : k).match(/\d+/);
    return m ? m[0] : '';
  }

  function valueText_(v) {
    if (v == null) return '';
    if (typeof v !== 'object') return String(v);
    var zipKey = ['postal', 'zip', 'zipcode', 'postalCode'].filter(function (k) { return v[k] != null; })[0];
    if (zipKey) return String(v[zipKey]);
    // A Date field: { month, day, year } (its shape in a submission; guessed for a live read).
    if (v.year != null && v.month != null && v.day != null) return v.month + '/' + v.day + '/' + v.year;
    // A Full Name field: { first, last } (prefix, middle, suffix when the form has them; guessed for a live read).
    if (v.first != null || v.last != null) {
      return ['prefix', 'first', 'middle', 'last', 'suffix'].map(function (k) { return String(v[k] == null ? '' : v[k]).trim(); })
        .filter(Boolean).join(' ');
    }
    if (Array.isArray(v)) return v.join('\n'); // checkbox answers: one per line
    return '';
  }

  function isLeaf_(v) {
    if (v == null || typeof v !== 'object') return true;
    if (Array.isArray(v)) return false;
    return 'value' in v || 'postal' in v || 'zip' in v || ('year' in v && 'month' in v) || 'first' in v || 'last' in v;
  }

  function extract(resp, ids) {
    var out = {};
    var wanted = {};
    ids.forEach(function (id) { wanted[bare_(id)] = id; });

    function take(key, value) {
      var id = wanted[bare_(key)];
      if (id != null && out[id] == null) out[id] = valueText_(value);
    }

    function walk(node, depth) {
      if (node == null || depth > 4) return;
      if (Array.isArray(node)) {
        node.forEach(function (item) {
          if (item && typeof item === 'object' && 'value' in item) {
            var key = item.id != null ? item.id : item.qid != null ? item.qid : item.selector || item.name;
            take(key, item.value);
          } else {
            walk(item, depth + 1);
          }
        });
        return;
      }
      if (typeof node === 'object') {
        Object.keys(node).forEach(function (k) {
          var v = node[k];
          if (wanted[bare_(k)] != null && isLeaf_(v)) take(k, v && typeof v === 'object' && 'value' in v ? v.value : v);
          else walk(v, depth + 1);
        });
      }
    }

    walk(resp, 0);
    return Object.keys(out).length ? out : null;
  }

  // ---------------------------------------------------------------- earlier answers -> the widget's questions
  // An answer the visitor already gave earlier in the form is read, never asked again
  // (David, 2026-10-30). Each reader returns '' when the form's answer cannot settle it.

  /** "Type of quote": a first-time buyer has no coverage in force on any line -> 'no'; else ''. */
  function inForceFromQuoteType(text) {
    return /first\s*time/i.test(String(text || '')) ? 'no' : '';
  }

  /**
   * A funding answer -> 'er' (employer pays 50% or more), 'vol' (less than 50%) or '' when the
   * band straddles 50% ("0% - 50% employer paid" includes exactly 50%, which is employer-paid).
   */
  function contributionFromFunding(text) {
    var t = String(text || '').toLowerCase();
    if (/^\s*voluntary/.test(t)) return 'vol';
    var band = t.match(/(\d+)\s*%\s*-\s*(\d+)\s*%/);
    if (band) return +band[1] >= 50 ? 'er' : +band[2] < 50 ? 'vol' : '';
    var one = t.match(/(\d+)\s*%\s*employer/);
    return one ? (+one[1] >= 50 ? 'er' : 'vol') : '';
  }

  /** A setting like "Dental=265;Vision=267" -> { Dental: '265', Vision: '267' }. */
  function fieldMap(text) {
    var out = {};
    String(text || '').split(/[;,]/).forEach(function (pair) {
      var m = pair.match(/^\s*(.+?)\s*=\s*(\S+)\s*$/);
      if (m) out[m[1]] = m[2];
    });
    return out;
  }

  /** A checkbox answer (one label per line, or ; / , separated) -> its labels, lower case. */
  function choices(text) {
    return labels(text).map(function (s) { return s.toLowerCase(); });
  }

  /**
   * A checkbox answer or a list setting ("A|B", one per line, or ; / , separated) -> its
   * labels as written (HubSpot compares values, so the case is kept), each once.
   */
  function labels(text) {
    var out = [];
    String(text || '').split(/\r?\n|;|,|\|/).forEach(function (s) {
      s = s.trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  var api = { extract: extract, inForceFromQuoteType: inForceFromQuoteType,
    contributionFromFunding: contributionFromFunding, fieldMap: fieldMap, choices: choices, labels: labels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FieldValues = api;
})(typeof window !== 'undefined' ? window : this);
