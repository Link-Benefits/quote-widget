/**
 * Rating engine for the Jotform quote widget: ancillary lines, MANY CARRIERS per line.
 *
 * NO RATES in this file (David 11-02: the invented "Sample Carrier" plans are gone). Every plan
 * comes from a carrier pack passed in (`opts.carriers`, from ../private-rates/), which is NEVER
 * written into this public file. With no pack, every line says no carrier in this tool rates it.
 * The contract:
 *
 *   quote({ groupSize, zip, sic }, { carriers: [pack] }) ->
 *     { ok, errors[], warnings[], engine, inputs, tiers[], lines[] }
 *     ok/errors = the group answers are well formed. Whether a CARRIER can offer a line is
 *     per offering (`unavailable` says why); a line is unavailable only when none can.
 *   pack = { carrier, lines: { <line>: offering } }       (one file per carrier)
 *   offering = { method, source, eligibility, bands?, participation?, standalone?, plans[] }
 *   lines[i] = { line, method, unit?, basis?, volumeLabel?, volumeHint?, facets[],
 *                offerings: [{ carrier, source, unavailable?, bands?, ... }],
 *                plans: [{ id, carrier, name, detail?, attrs, minEnrolled?, rates | ratesByBand | rate }],
 *                unavailable? }
 *
 *   lineTotals(quotedLine, { counts } | { volume },
 *              { groupSize, inputs, chosen: [{ line, carrier }], contribution: 'er' | 'vol' }) ->
 *     { ok, errors[], warnings[], counts?, enrolled?, volume?, bands{carrier: {band, basis}},
 *       band?, bandBasis?, planRates{id: rates|null}, planNotes{id: text},
 *       carrierWarnings{carrier: [text]}, carrierNotes{carrier: text}, plans: [{ id, monthly, annual }] }
 *
 * A carrier that prices FROM THE GROUP gives its offering price(plan, ctx) ->
 * { rates, assumed?, missing? } | { why, missing? }, asks (keys of ASKS, or asks(inputs) ->
 * keys), and optionally a designer (build-your-own:
 * fields(inputs) -> [{ key, label, options | options(designSoFar) }], base, plan(design)).
 * quote() lists the designer's plan from opts.designs, fitted to the group (fitDesign).
 * price() reads the visitor's answers in ctx.answers = { group: {...}, line: {...} } and names
 * the ones it still needs in `missing` (lineTotals gathers them per carrier: carrierMissing).
 * offering.requires = { line, maxEligible, note }: below that size the carrier sells this line
 * only beside its own `line` (a warning, like standalone).
 * offering.later = true: the carrier prices this line AFTER the form is sent (from the census,
 * or as age-band rates), so its plans carry no rate here: price() returns { later: text } and
 * the plan is a design to request. A line whose open offerings are all `later` asks no volume.
 *
 * FEATURES are shared per line (LINE_FACETS): every carrier describes its plans with the same
 * keys, so one filter ("annual max $1,500 or more") works across all carriers. The tests
 * refuse a carrier plan with a missing or unknown feature. `carrier` is a feature too.
 *
 * How each line prices (David, 2026-10-20):
 *   per tier x headcount ......... Dental, Vision, Accident, Hospital Confinement
 *   per $1,000 of volume ......... Basic Life/AD&D; Supplemental Life/AD&D and Critical
 *                                  Illness on ELECTED volume
 *   per $10 of weekly benefit .... Short Term Disability (elected covered benefit)
 *   per $100 of monthly payroll .. Long Term Disability (monthly covered payroll)
 *
 * Line names are HubSpot's `ancillary_plans` ("Requested coverage") values, exactly: the
 * tests compare them with the estate's LINES list.
 *
 * The widget page is PUBLIC: anyone can read this file, so it may only ever hold numbers
 * the product is allowed to publish (see the binder).
 *
 * Runs in the browser (window.RatingEngine) and in node (module.exports) for the tests.
 */
(function (root) {
  'use strict';

  var ENGINE_VERSION = 'prototype-4';
  var MAX_PER_TIER = 9999;
  var MAX_VOLUME = 1e10;

  var TIERS = [
    { key: 'ee', label: 'Employee only' },
    { key: 'es', label: 'Employee + spouse' },
    { key: 'ec', label: 'Employee + child(ren)' },
    { key: 'fam', label: 'Family' }
  ];

  // The features every carrier's plans are described by (plan-view.js turns them into the
  // sort and filter buttons). kind: 'amount' (a number, 'unlimited', or 0/null = none),
  // 'choice' (short text) or 'flag' (true/false).
  var CARRIER_FACET = { key: 'carrier', label: 'Carrier', kind: 'choice', filter: 'choice' };
  var LINE_FACETS = {
    Dental: [
      { key: 'annualMax', label: 'Annual max', kind: 'amount', sort: true, filter: 'atLeast' },
      { key: 'childOrtho', label: 'Child ortho', kind: 'amount', sort: true, filter: 'hasAny',
        yes: 'With child ortho', no: 'No ortho' },
      { key: 'majorServices', label: 'Major services', kind: 'flag', filter: 'flag', yes: 'Covered', no: 'Not covered' },
      { key: 'implants', label: 'Implants', kind: 'flag', filter: 'flag', yes: 'Covered', no: 'Not covered' },
      { key: 'perioEndo', label: 'Perio/endo paid as', kind: 'choice', filter: 'choice' },
      { key: 'network', label: 'Network', kind: 'choice', filter: 'choice' },
      { key: 'deductible', label: 'Deductible', kind: 'amount', sort: true, filter: 'choice' },
      // Pediatric dental as an ACA essential health benefit (children under 19).
      { key: 'pediatricEhb', label: 'Pediatric EHB', kind: 'flag', filter: 'flag', yes: 'EHB compliant', no: 'Not EHB' }
    ],
    Vision: [
      { key: 'coverage', label: 'Coverage', kind: 'choice', filter: 'choice' },
      { key: 'allowance', label: 'Frame and contact allowance', kind: 'amount', sort: true, filter: 'atLeast' },
      { key: 'examCopay', label: 'Exam copay', kind: 'amount', sort: true, filter: 'choice' },
      { key: 'materialsCopay', label: 'Materials copay', kind: 'amount', sort: true, filter: 'choice' },
      { key: 'enhancedLenses', label: 'Enhanced lens options', kind: 'flag', filter: 'flag',
        yes: 'Included', no: 'Not included' }
    ]
  };

  // The questions a carrier may ask (offering.asks). 'group' ones are asked once above the
  // lines, 'line' ones in the line's section; 'input' = a group answer read from the form.
  // Wording is carrier-neutral: this file is public. `short` names the answer in messages.
  // About people they are ATTESTATIONS (David, 2026-10-30): a yes/no or a band set at the
  // carrier's own cut-off, never a count. The census, read in the form (census-reader.js; David
  // 10-31), fills the ones it can; an answer the agent changes is kept beside the census value.
  // A 'choice' takes its options here or from the asking offering (offering.askOptions[key]).
  // A group yes/no question with `clean` (the answer that raises no underwriting concern) and `risk`
  // (the concern, in a few words) can be answered with the others by one "None of these apply" click
  // (David 11-02): the agent's own answer, never a default.
  var ASKS = {
    effectiveDate: { scope: 'input', kind: 'date', label: 'Effective date', short: 'effective date' },
    // Asked as the concern, like every other one here (David 11-02), so "None of these apply" reads true.
    newBusiness: { scope: 'group', kind: 'yesno', label: 'In business less than 1 year before the effective date?',
      short: 'in business under 1 year', clean: 'no', risk: 'in business less than 1 year' },
    cannabis: { scope: 'group', kind: 'yesno', label: 'Any involvement in the cannabis industry?', short: 'cannabis',
      clean: 'no', risk: 'cannabis industry' },
    familyShare: { scope: 'group', kind: 'yesno',
      label: 'Are more than 75% of the employees members of one family (spouses, siblings, children, parents)?',
      short: 'family members', clean: 'no', risk: 'over 75% one family' },
    outOfState: { scope: 'group', kind: 'yesno', label: 'Do more than 25% of the eligible employees live outside Michigan?',
      short: 'over 25% outside Michigan', clean: 'no', risk: 'over 25% outside Michigan' },
    extraterritorial: { scope: 'group', kind: 'yesno',
      label: 'Do more than 10% of them live in Alaska, Louisiana, Mississippi, Montana or Texas?',
      short: 'over 10% in AK, LA, MS, MT or TX', clean: 'no', risk: 'over 10% in AK, LA, MS, MT or TX' },
    age65: { scope: 'group', kind: 'yesno', label: 'Are 20% or more of the eligible employees 65 or older?',
      short: '20% or more aged 65+', clean: 'no', risk: '20% or more aged 65+' },
    age70: { scope: 'group', kind: 'yesno', label: 'Is any eligible employee 70 or older?', short: 'anyone aged 70+',
      clean: 'no', risk: 'anyone aged 70+' },
    contribution: { scope: 'line', kind: 'contribution', label: 'Who pays for {line}?', short: 'who pays' },
    inForce: { scope: 'line', kind: 'yesno', label: 'Does the group have {line} coverage today?',
      short: '{line} coverage today' },
    participation: { scope: 'line', kind: 'choice', label: 'Share of eligible employees enrolling in {line}',
      short: '{line} enrollment share' },
    enrolling: { scope: 'line', kind: 'choice', label: 'How many employees will enroll in {line}?',
      options: ['Fewer than 5', '5 - 9', '10 or more'], short: 'how many enroll in {line}' },
    // A design's enrollment minimum (David 11-02), asked ON DEMAND: only while a ticked plan uses it (the
    // price's `uses`). The carrier words it from its own numbers (offering.askLabels).
    minContrib: { scope: 'line', kind: 'yesno', onDemand: true,
      label: 'If employees share the cost: will enough eligible employees enroll in {line} for the carrier\'s minimum?',
      short: '{line} minimum enrollment (employees share the cost)' },
    minVol: { scope: 'line', kind: 'yesno', onDemand: true,
      label: 'Voluntary: will enough eligible employees enroll in {line} for the carrier\'s minimum?',
      short: '{line} minimum enrollment (voluntary)' },
    children: { scope: 'line', kind: 'yesno',
      label: 'Do the {line} enrollees with children have more than 3 children each, on average?',
      short: 'children per family' }
  };

  // The lines, in HubSpot's order, and how each prices. A carrier pack brings the plans.
  var LINE_DEFS = [
    { line: 'Dental', method: 'tier' },
    { line: 'Vision', method: 'tier' },
    { line: 'Basic Life/AD&D', method: 'volume', unit: 1000, basis: 'per $1,000 of life volume',
      volumeLabel: 'Total life volume',
      volumeHint: 'Employees x benefit, e.g. 12 x $25,000 = $300,000.' },
    { line: 'Short Term Disability', method: 'volume', unit: 10, basis: 'per $10 of weekly benefit',
      volumeLabel: 'Total weekly covered benefit',
      volumeHint: "The sum of each covered employee's weekly benefit." },
    { line: 'Long Term Disability', method: 'volume', unit: 100, basis: 'per $100 of monthly covered payroll',
      volumeLabel: 'Total monthly covered payroll',
      volumeHint: "The sum of covered employees' monthly pay, up to the plan maximum." },
    { line: 'Supplemental Life/AD&D', method: 'volume', unit: 1000, basis: 'per $1,000 of elected volume',
      volumeLabel: 'Total elected volume',
      volumeHint: 'The sum of the amounts employees elect.' },
    { line: 'Accident', method: 'tier' },
    { line: 'Critical Illness', method: 'volume', unit: 1000, basis: 'per $1,000 of elected volume',
      volumeLabel: 'Total elected volume',
      volumeHint: 'The sum of the amounts employees elect.' },
    { line: 'Hospital Confinement', method: 'tier' },
    { line: 'IDI', method: 'request' }
  ];

  function findBand_(bands, n) {
    for (var i = 0; i < bands.length; i++) {
      if (n >= bands[i].from && n <= bands[i].to) return bands[i];
    }
    return null;
  }

  function cents_(x) {
    return Math.round(x * 100) / 100;
  }

  /** Cleans the raw form answers. Returns { inputs, errors }. */
  function normalize_(raw) {
    raw = raw || {};
    var errors = [];
    var sizeText = String(raw.groupSize == null ? '' : raw.groupSize).trim();
    var zip = String(raw.zip == null ? '' : raw.zip).trim().slice(0, 5);
    var sic = String(raw.sic == null ? '' : raw.sic).replace(/\D/g, '');

    var groupSize = /^\d+$/.test(sizeText) ? parseInt(sizeText, 10) : NaN;
    if (!sizeText) errors.push('Enter the number of employees.');
    else if (isNaN(groupSize)) errors.push('Number of employees must be a whole number.');

    if (!zip) errors.push('Enter the ZIP code.');
    else if (!/^\d{5}$/.test(zip)) errors.push('ZIP code must be 5 digits.');

    if (!sic) errors.push('Enter the SIC code.');
    else if (sic.length !== 4) errors.push('SIC code must be 4 digits.');

    // Optional: blank is "not given yet" (a carrier that needs it says so), never an error.
    var dateText = String(raw.effectiveDate == null ? '' : raw.effectiveDate).trim();
    var effectiveDate = dateText ? parseDate_(dateText) : '';
    if (dateText && !effectiveDate) errors.push('Effective date must be a date like 01/01/2027.');

    var inputs = { groupSize: groupSize, zip: zip, sic: sic };
    if (effectiveDate) inputs.effectiveDate = effectiveDate;
    return { inputs: inputs, errors: errors };
  }

  /** "01/01/2027", "1-1-2027" or "2027-01-01" -> "2027-01-01"; anything else (or no such day) -> ''. */
  function parseDate_(text) {
    var y, mo, d;
    var m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
      if (!m) return '';
      mo = +m[1]; d = +m[2]; y = +m[3];
    }
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  /**
   * The visitor's answers, cleaned: yes/no -> 'yes' | 'no' | '' (not answered); a number ->
   * a whole number or null (blank or not a whole number). Unknown keys pass unchanged.
   */
  function cleanAnswers_(raw) {
    var out = {};
    Object.keys(raw || {}).forEach(function (k) {
      var v = raw[k];
      var kind = ASKS[k] ? ASKS[k].kind : '';
      if (kind === 'yesno') out[k] = v === 'yes' || v === 'no' ? v : '';
      else if (kind === 'number') {
        var t = String(v == null ? '' : v).trim();
        out[k] = /^\d+$/.test(t) ? parseInt(t, 10) : null;
      } else out[k] = v;
    });
    return out;
  }

  /** opts.answers -> { group, lines: { line: answers } }, each cleaned. */
  function answersOf_(answers) {
    answers = answers || {};
    var lines = {};
    Object.keys(answers.lines || {}).forEach(function (l) { lines[l] = cleanAnswers_(answers.lines[l]); });
    return { group: cleanAnswers_(answers.group), lines: lines };
  }

  function isMichiganZip_(zip) {
    var z3 = parseInt(zip.slice(0, 3), 10);
    return z3 >= 480 && z3 <= 499;
  }

  /** Why an offering cannot be quoted for this group, or '' when it can. */
  function unavailable_(o, inputs) {
    var e = o.eligibility || {};
    if ((e.minSize && inputs.groupSize < e.minSize) || (e.maxSize && inputs.groupSize > e.maxSize)) {
      return e.why || 'Not available for a group of ' + inputs.groupSize + '.';
    }
    if (e.michiganOnly && !isMichiganZip_(inputs.zip)) return e.why || 'Michigan groups only.';
    return '';
  }

  /** Every line with each carrier's offering. */
  function config_(opts) {
    opts = opts || {};
    var carriers = opts.carriers || [];
    return LINE_DEFS.map(function (l) {
      var cl = { line: l.line, method: l.method, offerings: [] };
      if (l.method === 'volume') {
        cl.unit = l.unit;
        cl.basis = l.basis;
        cl.volumeLabel = l.volumeLabel;
        cl.volumeHint = l.volumeHint;
      }
      carriers.forEach(function (pack) {
        var o = pack.lines && pack.lines[l.line];
        if (!o) return;
        cl.offerings.push(Object.assign({}, o, { carrier: pack.carrier }));
      });
      return cl;
    });
  }

  /** The line as the widget sees it before a quote: name, method, carriers, no prices. */
  function lineShape_(cl) {
    var out = {
      line: cl.line,
      method: cl.method,
      carriers: cl.offerings.map(function (o) { return o.carrier; }),
      facets: [CARRIER_FACET].concat(LINE_FACETS[cl.line] || []),
      offerings: [],
      plans: []
    };
    if (cl.method === 'volume') {
      out.unit = cl.unit;
      out.basis = cl.basis;
      out.volumeLabel = cl.volumeLabel;
      out.volumeHint = cl.volumeHint;
    }
    return out;
  }

  /** One plan as quoted: the carrier on it and in its features, and its rates. */
  function planQuote_(o, p) {
    var plan = { id: p.id, carrier: o.carrier, name: p.name, attrs: Object.assign({ carrier: o.carrier }, p.attrs || {}) };
    if (p.detail) plan.detail = p.detail;
    if (p.label) plan.label = p.label; // a pre-built plan's tier (e.g. Good / Better / Best)
    if (p.slot) plan.slot = p.slot; // which pre-built plan, whatever its settings
    if (p.settings) plan.settings = Object.assign({}, p.settings); // that plan's own settings, as fitted to the group
    if (p.minEnrolled) plan.minEnrolled = p.minEnrolled;
    // A carrier that prices from the group (price()) keeps what it needs on the plan.
    if (p.design) plan.design = Object.assign({}, p.design);
    if (p.code) plan.code = p.code;
    if (p.custom) plan.custom = true;
    if (p.census) plan.census = Object.assign({}, p.census); // what each person's census row must hold (design doc 3.5)
    // The carrier's own table: rates as filed.
    if (p.rate != null) plan.rate = p.rate;
    if (p.rates) plan.rates = Object.assign({}, p.rates);
    if (p.ratesByBand) {
      plan.ratesByBand = {};
      (o.bands || []).forEach(function (b) {
        var src = p.ratesByBand[b.fromBand || b.key];
        if (!src) return;
        var r = {};
        TIERS.forEach(function (t) { r[t.key] = b.load ? cents_(src[t.key] * b.load) : src[t.key]; });
        plan.ratesByBand[b.key] = r;
      });
    }
    return plan;
  }

  /**
   * A build-your-own design fitted to this group: field by field, a value the carrier's rules
   * do not allow this group (or none yet) becomes the first allowed option.
   */
  function fitDesign(designer, design, inputs) {
    var out = {};
    designer.fields(inputs).forEach(function (f) {
      var opts = typeof f.options === 'function' ? f.options(out) : f.options;
      var want = design && design[f.key] != null ? design[f.key] : designer.base[f.key];
      out[f.key] = opts.indexOf(want) >= 0 ? want : opts[0];
    });
    return out;
  }

  /**
   * The plans an offering lists for this group: its menu, its PRE-BUILT plans for the line's settings
   * (offering.prebuilt, David 11-02: every line starts with them), plus the build-your-own design.
   * -> { plans, featured: { id: true } } (the pre-built ones, listed first in their own order; one
   * already on the menu is listed once).
   */
  function offeringPlans_(o, line, inputs, opts, lineAnswers) {
    var plans = o.plans.slice();
    var featured = {};
    if (o.prebuilt) {
      var settings = opts.prebuilt && opts.prebuilt[line] ? opts.prebuilt[line][o.carrier] : null;
      // The pre-built plans first, in their own order; the same plan on the menu is listed once, as the pre-built one.
      var pre = o.prebuilt.plans({ inputs: inputs, answers: lineAnswers || {} }, settings || {});
      pre.forEach(function (p) { featured[p.id] = true; });
      plans = pre.concat(plans.filter(function (p) { return !featured[p.id]; }));
    }
    if (o.designer) {
      var wanted = opts.designs && opts.designs[line] ? opts.designs[line][o.carrier] : null;
      plans.push(o.designer.plan(fitDesign(o.designer, wanted, inputs)));
    }
    return { plans: plans, featured: featured };
  }

  /**
   * Prices every line for one group: each carrier offering that can take the group adds its
   * plans to the line's list. opts = { carriers, designs: { line: { carrier: design } },
   * prebuilt: { line: { carrier: settings } } (the pre-built plans' settings, e.g. EHB),
   * contribution: { line: 'er' | 'vol' }, answers: { group: {...}, lines: { line: {...} } } }.
   * A line's answers.contribution wins over opts.contribution.
   */
  function quote(raw, opts) {
    opts = opts || {};
    var n = normalize_(raw);
    var answers = answersOf_(opts.answers);
    var result = {
      ok: false,
      errors: n.errors.slice(),
      warnings: [],
      engine: ENGINE_VERSION,
      inputs: n.inputs,
      tiers: TIERS.map(function (t) { return { key: t.key, label: t.label }; }),
      lines: []
    };
    if (result.errors.length) return result;

    result.lines = config_(opts).map(function (cl) {
      var out = lineShape_(cl);
      var reasons = [];
      cl.offerings.forEach(function (o) {
        var off = { carrier: o.carrier, source: o.source || '' };
        var why = unavailable_(o, n.inputs);
        if (why) {
          off.unavailable = why;
          reasons.push(cl.offerings.length > 1 ? o.carrier + ': ' + why : why);
        } else {
          if (o.bands) off.bands = o.bands.map(function (b) { return { key: b.key, from: b.from, to: b.to }; });
          if (o.participation) off.participation = o.participation;
          if (o.standalone) off.standalone = o.standalone;
          if (o.requires) off.requires = o.requires;
          if (o.later) off.later = true;
          if (o.asks) off.asks = typeof o.asks === 'function' ? o.asks(n.inputs) : o.asks.slice();
          if (o.askOptions) off.askOptions = o.askOptions;
          if (o.askLabels) off.askLabels = o.askLabels;
          if (o.price) off.price = o.price;
          if (o.designer) off.designer = o.designer;
          if (o.prebuilt) off.prebuilt = o.prebuilt;
          var lineAnswers = answers.lines[cl.line] || {};
          var contribution = lineAnswers.contribution || (opts.contribution && opts.contribution[cl.line]) || 'er';
          var listed = offeringPlans_(o, cl.line, n.inputs, opts, lineAnswers);
          listed.plans.forEach(function (p) {
            var q = planQuote_(o, p);
            if (listed.featured[p.id]) q.featured = true;
            if (o.price) { // priced from the group: rates before any headcount (participation assumed)
              var r = o.price(q, { inputs: n.inputs, enrolled: 0, contribution: contribution,
                answers: { group: answers.group, line: lineAnswers } });
              q.rates = r.rates || null;
              if (r.why) q.priceWhy = r.why;
              if (r.later) q.later = r.later;
            }
            out.plans.push(q);
          });
        }
        out.offerings.push(off);
      });
      var anyOpen = out.offerings.some(function (o) { return !o.unavailable; });
      if (!anyOpen) {
        out.unavailable = reasons.join(' ') ||
          'No carrier in this tool rates ' + cl.line + ': it goes to the carriers as a request.';
      }
      out.later = anyOpen && out.offerings.every(function (o) { return o.unavailable || o.later; });
      return out;
    });
    result.ok = true;
    return result;
  }

  /** Headcount per tier as typed. Blank = 0. */
  function parseCounts_(raw) {
    raw = raw || {};
    var errors = [];
    var counts = {};
    var enrolled = 0;
    TIERS.forEach(function (t) {
      var text = String(raw[t.key] == null ? '' : raw[t.key]).trim();
      var n = 0;
      if (text !== '') {
        if (!/^\d+$/.test(text)) errors.push(t.label + ': enter a whole number.');
        else n = parseInt(text, 10);
        if (n > MAX_PER_TIER) errors.push(t.label + ': ' + n + ' is too many.');
      }
      counts[t.key] = n;
      enrolled += n;
    });
    return { counts: counts, enrolled: enrolled, errors: errors };
  }

  /** A dollar amount as typed ("$300,000" is fine). Blank = not entered (null). */
  function parseVolume_(raw, label) {
    var text = String(raw == null ? '' : raw).replace(/[$,\s]/g, '');
    if (text === '') return { volume: null, errors: [] };
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return { volume: null, errors: [label + ': enter a dollar amount.'] };
    var v = parseFloat(text);
    if (v > MAX_VOLUME) return { volume: null, errors: [label + ': that amount is too large.'] };
    return { volume: v, errors: [] };
  }

  /** A plan's open questions (missing) and the on-demand ones it uses, per carrier; only a ticked plan's when ticked is given. */
  function gather_(result, carrier, planId, r, ticked) {
    if (ticked && !ticked[planId]) return;
    [['missing', 'carrierMissing'], ['uses', 'carrierUses']].forEach(function (pair) {
      (r[pair[0]] || []).forEach(function (k) {
        var m = result[pair[1]][carrier] || (result[pair[1]][carrier] = []);
        if (m.indexOf(k) < 0) m.push(k);
      });
    });
  }

  function addNote_(result, planId, text) {
    result.planNotes[planId] = result.planNotes[planId] ? result.planNotes[planId] + ' ' + text : text;
  }

  /**
   * Premiums for one quoted line. Tier: each tier's rate x headcount, rounded to the cent,
   * summed. Volume: rate x volume / unit, rounded to the cent. Annual = monthly x 12.
   * Nothing entered yet is not an error: ok stays false with no errors.
   *
   * Each carrier's own rules apply to its own plans: its band (rates by ENROLLED count, or
   * by the employee count until a headcount is entered), its participation and stand-alone
   * rules (carrierWarnings, also put on each of its plans as a note) and per-plan minimums.
   * "Stand-alone" and "requires" count other lines ticked with the SAME carrier (ctx.chosen).
   * ctx.answers = { group, line } (the visitor's answers for this line); the answers a carrier
   * still needs are gathered in carrierMissing { carrier: [ask key] }, and the on-demand questions its plans
   * use in carrierUses; with ctx.ticked ({ plan id: true }) only from the ticked plans.
   */
  function lineTotals(quotedLine, input, ctx) {
    input = input || {};
    if (typeof ctx === 'number') ctx = { groupSize: ctx };
    ctx = ctx || {};
    var chosen = ctx.chosen || [];
    var given = ctx.answers || {};
    var answers = { group: cleanAnswers_(given.group), line: cleanAnswers_(given.line) };
    var contribution = answers.line.contribution || ctx.contribution || 'er';
    var result = { ok: false, errors: [], warnings: [], plans: [], planRates: {}, planNotes: {},
      bands: {}, carrierWarnings: {}, carrierNotes: {}, carrierMissing: {}, carrierUses: {} };
    if (quotedLine.unavailable) return result;
    var open = (quotedLine.offerings || []).filter(function (o) { return !o.unavailable; });

    if (quotedLine.method === 'tier') {
      var c = parseCounts_(input.counts);
      result.counts = c.counts;
      result.enrolled = c.enrolled;
      result.errors = c.errors;
      var g = ctx.groupSize;
      if (g && c.enrolled > g) {
        result.warnings.push(quotedLine.line + ': ' + c.enrolled + ' employees enrolling is more than the ' + g +
          ' employees entered.');
      }

      open.forEach(function (o) {
        var plans = quotedLine.plans.filter(function (p) { return p.carrier === o.carrier; });
        var warn = [];
        var band = null;
        var bandOk = true;
        if (o.bands) {
          var basis = c.enrolled || g || 0;
          band = findBand_(o.bands, Math.max(basis, 1));
          if (band) {
            result.bands[o.carrier] = { band: band.key, basis: c.enrolled ? 'enrolled' : 'employees' };
            if (result.band == null) {
              result.band = band.key;
              result.bandBasis = result.bands[o.carrier].basis;
            }
          } else {
            bandOk = false;
            warn.push(o.carrier + ': ' + basis + ' enrolled is beyond its rate table.');
          }
        }
        plans.forEach(function (p) {
          if (o.price) {
            // A carrier pricing from the group: again with this headcount (participation) and the
            // visitor's contribution answer. "Assumed" notes are the carrier's, once per line.
            var r = o.price(p, { inputs: ctx.inputs || { groupSize: g }, enrolled: c.enrolled, counts: c.counts,
              contribution: contribution, answers: answers });
            result.planRates[p.id] = r.rates || null;
            if (r.why) addNote_(result, p.id, r.why);
            if (r.assumed) result.carrierNotes[o.carrier] = r.assumed;
            gather_(result, o.carrier, p.id, r, ctx.ticked);
          } else {
            result.planRates[p.id] = !bandOk ? null : band ? p.ratesByBand[band.key] : p.rates;
          }
          if (p.minEnrolled && c.enrolled > 0 && c.enrolled < p.minEnrolled.count) addNote_(result, p.id, p.minEnrolled.note);
        });
        var part = o.participation;
        if (part && g && c.enrolled > 0 && c.enrolled < part.share * g) {
          warn.push(part.note + ' ' + c.enrolled + ' of ' + g + ' is below that.');
        }
        var alone = o.standalone;
        if (alone && c.enrolled >= alone.from && c.enrolled <= alone.to) {
          var others = ctx.otherLinesChosen != null ? ctx.otherLinesChosen : chosen.filter(function (x) {
            return x.line !== quotedLine.line && x.carrier === o.carrier;
          }).length;
          if (!others) warn.push(alone.note);
        }
        var req = o.requires;
        if (req && g && g <= req.maxEligible && !chosen.some(function (x) {
          return x.line === req.line && x.carrier === o.carrier;
        })) warn.push(req.note);
        if (warn.length) {
          result.carrierWarnings[o.carrier] = warn;
          plans.forEach(function (p) { addNote_(result, p.id, warn.join(' ')); });
        }
      });
      if (result.errors.length || c.enrolled === 0) return result;

      result.plans = quotedLine.plans.filter(function (p) { return result.planRates[p.id]; }).map(function (p) {
        var rates = result.planRates[p.id];
        var monthly = 0;
        TIERS.forEach(function (t) { monthly += cents_(rates[t.key] * c.counts[t.key]); });
        monthly = cents_(monthly);
        return { id: p.id, monthly: monthly, annual: cents_(monthly * 12) };
      });
      result.ok = true;
      return result;
    }

    if (quotedLine.method === 'volume') {
      // A carrier pricing from the group: its rules (a reason, or what it still needs) and, for a
      // carrier that prices later, the note on each plan. No rate here.
      open.forEach(function (o) {
        if (!o.price) return;
        quotedLine.plans.filter(function (p) { return p.carrier === o.carrier; }).forEach(function (p) {
          var r = o.price(p, { inputs: ctx.inputs || { groupSize: ctx.groupSize }, enrolled: 0, contribution: contribution,
            answers: answers, design: p.design });
          if (r.why) addNote_(result, p.id, r.why);
          gather_(result, o.carrier, p.id, r, ctx.ticked);
        });
      });
      var v = parseVolume_(input.volume, quotedLine.volumeLabel || quotedLine.line);
      result.volume = v.volume;
      result.errors = v.errors;
      if (v.errors.length || !v.volume) return result;
      result.plans = quotedLine.plans.filter(function (p) { return typeof p.rate === 'number'; }).map(function (p) {
        var monthly = cents_(p.rate * v.volume / quotedLine.unit);
        return { id: p.id, monthly: monthly, annual: cents_(monthly * 12) };
      });
      result.ok = true;
      return result;
    }

    return result; // 'request': no price
  }

  /** The lines the widget can show before any quote exists. */
  function lines(opts) {
    return config_(opts).map(lineShape_);
  }

  function tiers() {
    return TIERS.map(function (t) { return { key: t.key, label: t.label }; });
  }

  var api = {
    quote: quote,
    lineTotals: lineTotals,
    fitDesign: fitDesign,
    lines: lines,
    tiers: tiers,
    ASKS: ASKS,
    ENGINE_VERSION: ENGINE_VERSION,
    LINE_FACETS: LINE_FACETS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RatingEngine = api;
})(typeof window !== 'undefined' ? window : this);
