/**
 * The custom RFP for a first-time buyer over the widget's maxGroupSize: "Build your own", up to
 * MAX_OPTIONS options per coverage (David, 2026-10-30: "use the "Build your own" menu, allow them
 * to make options of their choosing to quote. Lets say up to 4 options for each line").
 * Carrier-neutral: every carrier asked gets the same request.
 *
 * Each builder is HubSpot's own option list taken apart into its parts (coinsurance, maximum, ...),
 * so EVERY option an agent can build is exactly one of the HubSpot values the form's first-time-
 * buyer questions (q301-q309) write today, and every one of those values can be built. The relay,
 * the splitters, the RFP emails and the auditor see nothing new. tools/quote-widget-test.js builds
 * every combination and checks the set against tools/hubspot-ancillary-options.json.
 *
 * The stored answer keeps the frozen line keys of PROPOSAL-FORM-WIDGETS-DESIGN.md 3.2 ("Dental plan
 * options: a; b"), led by the group's quote type and carriers in both widget modes (10-31). STD and LTD options are PAIRS (plan + maximum) that HubSpot keeps in two
 * separate fields, so those two lines also write "<line> options as built: 1) ...; 2) ...".
 *
 * Runs in the browser (window.RFP_OPTIONS) and in node (module.exports) for the tests.
 */
(function (root) {
  'use strict';

  var MAX_OPTIONS = 4;
  var noComma = function (s) { return s.replace(/,/g, ''); }; // HubSpot writes "$1000", not "$1,000"

  var LINES = {
    'Dental': {
      fields: [
        { key: 'plan', label: 'Coinsurance (preventive / basic / major)', options: ['100% / 80% / 50%', '100% / 90% / 60%'] },
        { key: 'max', label: 'Annual maximum', options: function (d) {
          return (d.plan === '100% / 90% / 60%' ? [] : ['$1,000']).concat(['$1,500', '$2,000', '$2,500', 'Unlimited']);
        } },
        { key: 'endo', label: 'Endo / perio paid as', options: function (d) {
          return d.plan === '100% / 90% / 60%' ? ['Basic'] : ['Basic', 'Major'];
        } },
        { key: 'ortho', label: 'Orthodontia', options: ['None', 'Children to 19, at 50%'] }
      ],
      base: { plan: '100% / 80% / 50%', max: '$1,500', endo: 'Basic', ortho: 'None' },
      values: function (d) {
        var split = (d.plan === '100% / 90% / 60%' ? '100%/90%/60%/' : '100%/80%/50%/') + (d.ortho === 'None' ? '0%' : '50%');
        return { ftb_dental_options: split + ' in/out ' + (d.max === 'Unlimited' ? 'Unlim.' : noComma(d.max)) +
          ' ann max endo/perio ' + d.endo.toLowerCase() + (d.ortho === 'None' ? '' : ' ortho <19') };
      },
      name: function (d) {
        return d.plan + ', ' + d.max + ' max, endo/perio as ' + d.endo.toLowerCase() + (d.ortho === 'None' ? '' : ', child ortho');
      },
      funding: { key: 'dental_funding', label: 'Dental funding',
        options: ['0% - 50% employer paid', '50% - 80% employer paid', '80% - 100% employer paid'] }
    },
    'Vision': {
      fields: [
        { key: 'copays', label: 'Copays (exam / materials)', options: ['$10 / $25'] },
        { key: 'allowance', label: 'Materials allowance', options: ['$150', '$180', '$200'] },
        { key: 'frames', label: 'Exams / lenses / frames every', options: ['12 / 12 / 12 months', '12 / 12 / 24 months'] }
      ],
      base: { copays: '$10 / $25', allowance: '$150', frames: '12 / 12 / 24 months' },
      values: function (d) {
        return { ftb_vision_options: '$10/$25 copays ' + d.allowance + ' materials ' + d.frames.replace(/ /g, '').replace('months', '') + ' freq' };
      },
      name: function (d) { return d.allowance + ' materials allowance, frames every ' + d.frames.split(' / ')[2]; },
      funding: { key: 'vision_funding', label: 'Vision funding', options: ['0% - 50% employer paid', '50% - 100% employer paid'] }
    },
    'Basic Life/AD&D': {
      fields: [
        { key: 'benefit', label: 'Benefit', options: ['$10,000', '$15,000', '$25,000', '$50,000', '$75,000', '$100,000',
          '1x annual earnings', '1.5x annual earnings', '2x annual earnings'] }
      ],
      base: { benefit: '$25,000' },
      values: function (d) {
        return { ftb_basic_life_options: /^\$/.test(d.benefit) ? '$' + (Number(noComma(d.benefit).slice(1)) / 1000) + 'k' : d.benefit };
      },
      name: function (d) { return d.benefit + (/^\$/.test(d.benefit) ? ' flat' : ''); }
    },
    'Short Term Disability': {
      fields: [
        { key: 'weeks', label: 'Benefits paid for', options: ['13 weeks', '26 weeks'] },
        { key: 'weeklyMax', label: 'Weekly maximum', options: ['$250', '$500', '$750', '$1,000', '$1,500', '$2,000', '$2,500'] }
      ],
      base: { weeks: '13 weeks', weeklyMax: '$500' },
      values: function (d) {
        return { ftb_std_plan: '0/7 elim 60% benefit ' + parseInt(d.weeks, 10) + ' wk duration', ftb_std_weekly_max: noComma(d.weeklyMax) };
      },
      name: function (d) { return '60% of pay to ' + d.weeklyMax + ' a week, ' + d.weeks + ' (from day 1 accident, day 8 sickness)'; },
      asBuilt: 'STD options as built',
      funding: { key: 'std_funding', label: 'STD funding', options: ['Voluntary', '100% Employer paid'] }
    },
    'Long Term Disability': {
      fields: [
        { key: 'wait', label: 'Waiting period', options: ['90 days', '180 days'] },
        { key: 'until', label: 'Benefits paid until', options: ['Social Security retirement age', '5 years', '2 years'] },
        { key: 'monthlyMax', label: 'Monthly maximum', options: ['$1,000', '$2,000', '$3,000', '$4,000', '$6,000', '$8,000', '$10,000'] }
      ],
      base: { wait: '90 days', until: 'Social Security retirement age', monthlyMax: '$6,000' },
      values: function (d) {
        var dur = d.until === '5 years' ? '5 yr' : d.until === '2 years' ? '2 yr' : 'SS ADEA';
        return { ftb_ltd_plan: parseInt(d.wait, 10) + ' day elim 60% benefit ' + dur + ' duration', ftb_ltd_monthly_max: noComma(d.monthlyMax) };
      },
      name: function (d) { return '60% of pay to ' + d.monthlyMax + ' a month, ' + d.wait + ' wait, paid until ' + d.until.replace('Social Security', 'SS'); },
      asBuilt: 'LTD options as built',
      funding: { key: 'ltd_funding', label: 'LTD funding', options: ['Voluntary', '100% Employer paid'] }
    }
  };

  // HubSpot property -> the frozen line key it is written under (design doc 3.2).
  var LINE_KEYS = {
    ancillary_quote_type: 'Ancillary quote type', ancillary_carriers: 'Ancillary carriers',
    ftb_dental_options: 'Dental plan options', dental_funding: 'Dental funding',
    ftb_vision_options: 'Vision plan options', vision_funding: 'Vision funding',
    ftb_basic_life_options: 'Basic life options',
    ftb_std_plan: 'STD plan options', ftb_std_weekly_max: 'STD weekly max', std_funding: 'STD funding',
    ftb_ltd_plan: 'LTD plan options', ftb_ltd_monthly_max: 'LTD monthly max', ltd_funding: 'LTD funding'
  };

  /** The line's fields for a design so far, each with the options allowed given the earlier choices. */
  function fieldsOf(line, design) {
    var soFar = {};
    return LINES[line].fields.map(function (f) {
      var opts = typeof f.options === 'function' ? f.options(soFar) : f.options;
      soFar[f.key] = design && opts.indexOf(design[f.key]) >= 0 ? design[f.key] : opts[0];
      return { key: f.key, label: f.label, options: opts };
    });
  }

  /** A design made whole: a choice the earlier ones rule out becomes the first allowed option. */
  function fit(line, design) {
    var out = {};
    var want = Object.assign({}, LINES[line].base, design || {});
    LINES[line].fields.forEach(function (f) {
      var opts = typeof f.options === 'function' ? f.options(out) : f.options;
      out[f.key] = opts.indexOf(want[f.key]) >= 0 ? want[f.key] : opts[0];
    });
    return out;
  }

  // HubSpot's `ancillary_quote_type` values the widget writes (David 10-31: the form's "Type of
  // Ancillary Quote" q51 moves into the widget as "coverage today", asked per line). The third,
  // "No ancillary coverage requested", is never the widget's: it only shows when ancillary is.
  var QUOTE_TYPES = ['Match or change current', 'First time buyer'];

  /**
   * The quote type from "coverage today" per line ({ line: 'yes' | 'no' | '' }): any line in force
   * = "Match or change current", every line answered "no" = "First time buyer", else '' (not yet).
   */
  function quoteType(inForce) {
    var v = Object.keys(inForce || {}).map(function (l) { return inForce[l]; });
    if (v.indexOf('yes') >= 0) return QUOTE_TYPES[0];
    return v.length && v.every(function (x) { return x === 'no'; }) ? QUOTE_TYPES[1] : '';
  }

  /**
   * The answer from what was built: { line: { options: [design], funding } } ->
   * { fields: { property: value | [values] }, lines: ["<line key>: values"] }. Values keep the
   * options' order; a value two options share is written once. `group` (optional) =
   * { ancillary_quote_type, ancillary_carriers: [values] }, written first.
   */
  function answer(built, group) {
    var fields = {};
    var lines = [];
    ['ancillary_quote_type', 'ancillary_carriers'].forEach(function (k) {
      var v = group && group[k];
      if (Array.isArray(v) ? !v.length : !v) return;
      if (k === 'ancillary_quote_type' && QUOTE_TYPES.indexOf(v) < 0) return;
      fields[k] = Array.isArray(v) ? v.slice() : v;
      lines.push(LINE_KEYS[k] + ': ' + (Array.isArray(v) ? v.join('; ') : v));
    });
    Object.keys(LINES).forEach(function (line) {
      var b = built && built[line];
      if (!b) return;
      var spec = LINES[line];
      var opts = (b.options || []).slice(0, MAX_OPTIONS).map(function (d) { return fit(line, d); });
      opts.forEach(function (d) {
        var v = spec.values(d);
        Object.keys(v).forEach(function (k) {
          var list = fields[k] || (fields[k] = []);
          if (list.indexOf(v[k]) < 0) list.push(v[k]);
        });
      });
      if (b.funding && spec.funding && spec.funding.options.indexOf(b.funding) >= 0) fields[spec.funding.key] = b.funding;
      // This line's properties in the contract's order: its plan fields, then its funding.
      Object.keys(spec.values(spec.base)).concat(spec.funding ? [spec.funding.key] : []).forEach(function (k) {
        if (fields[k] == null) return;
        lines.push(LINE_KEYS[k] + ': ' + (Array.isArray(fields[k]) ? fields[k].join('; ') : fields[k]));
      });
      if (spec.asBuilt && opts.length) {
        lines.push(spec.asBuilt + ': ' + opts.map(function (d, i) { return (i + 1) + ') ' + spec.name(d); }).join('; '));
      }
    });
    return { fields: fields, lines: lines };
  }

  // "Who pays?" per line in HubSpot's own values, for both widget modes (David 10-30: the form's
  // funding questions q265 / q267 / q306 / q307 move into the widget).
  var FUNDING = {};
  Object.keys(LINES).forEach(function (line) { if (LINES[line].funding) FUNDING[line] = LINES[line].funding; });

  var api = { MAX_OPTIONS: MAX_OPTIONS, lines: LINES, LINE_KEYS: LINE_KEYS, FUNDING: FUNDING, QUOTE_TYPES: QUOTE_TYPES,
    quoteType: quoteType, fieldsOf: fieldsOf, fit: fit, answer: answer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RFP_OPTIONS = api;
})(typeof window !== 'undefined' ? window : this);
