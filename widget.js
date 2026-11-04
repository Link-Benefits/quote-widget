/**
 * Jotform quote widget (ancillary): reads group size, ZIP, SIC and the requested coverage
 * from the form, prices each requested line with rating-engine.js, and hands the chosen
 * plans back to the form.
 *
 * Two bridges, one widget:
 *   - jotform: the real form, through Jotform's JFCustomWidget library.
 *   - preview: ?preview=1 inside preview/index.html (same origin), for local testing.
 *
 * PROTOTYPE. getFieldsValueById / setFieldsValueById exist in Jotform's library but are
 * NOT in its documentation, and their reply shape is unknown. The jotform bridge parses
 * defensively, logs every raw reply to the debug panel (widget setting debug = on), and
 * falls back to letting the visitor type the answers when a read gets no answer.
 *
 * The visitor gives, per line: a headcount per tier (Dental, Vision, Accident, Hospital
 * Confinement; one shared headcount, or the line's own), or a dollar volume (life, critical
 * illness, disability). IDI has no group rate: it can only be ticked for a quote. Each line lists
 * every carrier's plans; "Find a plan" narrows them by shared features (plan-view.js).
 *
 * What the form receives:
 *   - the widget's own answer: JSON v5 { engine, inputs, today, fields, fieldLines,
 *     lines[{ carriers[], plans[{ carrier }] }], packageMonthly, ... }; a custom RFP: { mode: 'custom', today,
 *     fields, fieldLines, built }. `fields` = HubSpot property -> value, what the relay writes
 *     (quote type, carriers, funding, the custom RFP's options).
 *   - optionally, a readable summary in the field named by summaryField.
 * Everything written is plain ASCII on purpose (relay, Zapier and HubSpot compare it).
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var PREVIEW = params.get('preview') === '1';
  // Built into our own form (form-mockup/, David 11-03): the form sets its host here BEFORE this script
  // runs, puts this widget's markup on its page, then calls host.boot(). No frame, no Jotform.
  var NATIVE = (window.QuoteNative && window.QuoteNative.ancillary) || null;
  var READ_TIMEOUT_MS = 3000;
  var IDI_REQUEST = 'IDI-REQUEST';
  var OUTSIDE_HEAD = 'outside-head'; // the plan list's divider (a data-plan no plan id takes)

  var state = {
    debug: false,
    fieldIds: { groupSize: '', zip: '', sic: '', coverage: '', effectiveDate: '', quoteType: '', carriers: '',
      funding: {} }, // funding: line -> question id
    // Answers settled by questions earlier in the form (never asked again): line -> { inForce },
    // the form's funding answers as typed (line -> text), its quote type and its carriers (as
    // written), while the form still asks them (David 10-31: they move into the widget).
    formAnswers: { lines: {}, funding: {}, quoteType: '', carriers: [] },
    requestedCarriers: null, // lower-case carrier names ticked earlier in the form; null = not read
    // HubSpot's `ancillary_carriers` values (settings, so no carrier is named in this public code):
    // carrierOptions = the carriers an agent may ask for a custom RFP; smallGroupCarriers = the ones
    // that quote groups up to maxGroupSize (Proposal form: one carrier, D9), never asked.
    carrierOptions: [],
    smallGroupCarriers: [],
    carriers: {}, // custom RFP: carrier -> true, as picked
    summaryField: '',
    inputsFrom: 'typed', // 'form' when the group answers came from the form
    quote: null,
    shown: {}, // line -> true: ticked under "Coverage to price"
    counts: {}, // the shared headcount per tier, as typed ('' = 0)
    ownCounts: {}, // line -> its own headcount, while "different headcount" is ticked
    volumes: {}, // line -> dollar volume as typed
    selected: {}, // plan id -> true
    totals: {}, // line -> RatingEngine.lineTotals()
    view: {}, // line -> { sort, filters } for the plan list (view only)
    // Pre-built plans (David 11-02): every line starts with them, ticked. prebuilt = line -> { carrier:
    // settings } (e.g. EHB, out of network); prefilled = line -> true once its pre-built plans were ticked
    // (never again, so an untick stays); expand = line -> { all, byo }: "see all plans" / "build your own" open.
    prebuilt: {},
    prefilled: {},
    expand: {},
    // "Who pays?" in HubSpot's values (RFP_OPTIONS.FUNDING), both modes: line -> value.
    funding: {},
    // line -> 'er' | 'vol' for a carrier that prices by it: the extra click when the funding band
    // straddles its 50% line, or the whole question on a line HubSpot keeps no funding for.
    contribution: {},
    // The carriers' questions (RatingEngine.ASKS), as typed: group ones once, line ones per line.
    answers: { group: {}, lines: {} },
    asksShown: '', // the group questions on screen (rebuilt only when that set changes)
    // Groups above this size get a custom RFP from their uploaded plans, not this widget's quotes
    // (setting maxGroupSize; Proposal form: 50 FTE, David 2026-10-30). 0 = no limit.
    maxGroupSize: 0,
    // Groups below this size get no ancillary quote at all (setting minGroupSize; Proposal form: 5,
    // David 2026-10-31: "We dont want to stay in the game o custom quoting 2-4 groups"). 0 = none.
    minGroupSize: 0,
    rfpBuilt: {}, // the custom RFP, per line: { options: [design] (rfp-options.js) }
    // The census read in the browser (census-reader.js; design doc 3.5): { facts, derived, issues,
    // sheet, fileName, asOf } or { error }. Only `facts` (counts) is stored; the file stays here.
    census: null,
    agent: null, // { name, agency } read from the form's first page (agentField, agencyField), for the quote builder
    censusFilled: { group: {}, lines: {} }, // the value the census gave each answer: { value, detail }
    anyToday: '', // "Does the group have any of this coverage today?": 'yes' | 'no' | '' (not answered)
    todayShown: '', // what "coverage today" shows (rebuilt only when it changes)
    designs: {} // line -> { carrier: design } for build-your-own plans
  };

  var el = {};
  var lineRefs = {}; // line -> { msg, totals: { planId: refs } } for the sections on screen

  // ---------------------------------------------------------------- bridge

  // The form link (Jotform or the local preview) is shared with the medical widget: bridge.js.

  // ---------------------------------------------------------------- helpers

  var money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  var wholeMoney = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2
  });
  var rateMoney = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3
  });
  // Carriers: each public pack on this page (designs and rules, no rates: metlife-plans.js, D8 option
  // (a), David 11-02), replaced by the same carrier's PRIVATE pack (../private-rates/<name>.js, with
  // rates) only in the local preview (?preview=1&rates=<name>,<name>). A published widget has no such
  // folder and never asks for it. A line no pack offers is sent to the carriers as a request.
  var CARRIERS = [];
  function carrierPacks_() {
    var priv = window.PRIVATE_CARRIERS || [];
    var same = function (a) { return function (b) { return b.carrier === a.carrier; }; };
    var out = (window.PUBLIC_CARRIERS || []).map(function (p) { return priv.filter(same(p))[0] || p; });
    priv.forEach(function (p) { if (!out.some(same(p))) out.push(p); });
    return out;
  }
  var LINES = window.RatingEngine.lines(); // in HubSpot's order (re-set once rates load)
  var TIERS = window.RatingEngine.tiers();
  var ASKS = window.RatingEngine.ASKS;

  function engineOpts_() {
    var contribution = {};
    LINES.forEach(function (l) { if (contributionOf_(l.line)) contribution[l.line] = contributionOf_(l.line); });
    return { carriers: requestedCarriers_(), designs: state.designs, prebuilt: state.prebuilt, contribution: contribution,
      answers: engineAnswers_() };
  }

  /** The line's "Who pays?" values in HubSpot's words (RFP_OPTIONS.FUNDING), or null when HubSpot keeps none. */
  function fundingSpec_(line) {
    return (window.RFP_OPTIONS && window.RFP_OPTIONS.FUNDING[line]) || null;
  }

  // Dental and vision: one question, employer paid or voluntary (David 11-02: "ask if it is voluntary or Employer paid";
  // enrollment is then assumed by the carrier). HubSpot keeps its bands ("leave HubSpot bands as-is, just change widget"):
  // employer paid is written as dental "50% - 80%", vision "50% - 100%"; voluntary as "0% - 50%".
  var SIMPLE_FUNDING = { Dental: { er: '50% - 80% employer paid', vol: '0% - 50% employer paid' },
    Vision: { er: '50% - 100% employer paid', vol: '0% - 50% employer paid' } };

  /** The form's own funding answer for the line, when the form still asks it and it is one of HubSpot's values. */
  function formFunding_(line) {
    var spec = fundingSpec_(line);
    var text = state.formAnswers.funding[line] || '';
    return spec && spec.options.indexOf(text) >= 0 ? text : '';
  }

  /** The line's funding as answered: the form's (locked), else the widget's own "Who pays?". */
  function fundingOf_(line) {
    return formFunding_(line) || (fundingSpec_(line) && state.funding[line]) || '';
  }

  /**
   * 'er' (employer pays 50% or more), 'vol' or '' (not answered), for a carrier that prices by it:
   * the funding band, else the extra click when the band straddles 50% ("0% - 50%" includes exactly
   * 50%, which is employer-paid). A line HubSpot keeps no funding for asks er / vol directly.
   */
  function contributionOf_(line) {
    if (!fundingSpec_(line)) return state.contribution[line] || '';
    var f = fundingOf_(line);
    if (!f) return '';
    // Dental and vision: "0% - 50%" is voluntary, with no "exactly 50%?" click (SIMPLE_FUNDING).
    return window.FieldValues.contributionFromFunding(f) || (SIMPLE_FUNDING[line] ? 'vol' : state.contribution[line] || '');
  }

  /**
   * The carriers to price: those ticked earlier in the form while it still asks, else the ones that
   * quote small groups (setting smallGroupCarriers), else all.
   */
  function requestedCarriers_() {
    var want = state.requestedCarriers || (state.smallGroupCarriers.length
      ? state.smallGroupCarriers.map(function (c) { return c.toLowerCase(); }) : null);
    if (!want) return CARRIERS;
    return CARRIERS.filter(function (c) { return want.indexOf(String(c.carrier).toLowerCase()) >= 0; });
  }

  /** One line's answers for the engine: its own questions, "who pays" and coverage today; the form's answers win. */
  function lineAnswers_(line) {
    var a = Object.assign({}, state.answers.lines[line] || {});
    delete a.inForce; // coverage today comes from inForceOf_ (the "any of it today?" question decides first)
    if (inForceOf_(line)) a.inForce = inForceOf_(line);
    if (contributionOf_(line)) a.contribution = contributionOf_(line);
    return Object.assign(a, state.formAnswers.lines[line] || {});
  }

  function engineAnswers_() {
    var lines = {};
    LINES.forEach(function (l) { lines[l.line] = lineAnswers_(l.line); });
    return { group: state.answers.group, lines: lines };
  }

  // ---------------------------------------------------------------- the form's questions the widget asks
  // David 10-31: "Move everything that makes sense into the widget." Coverage today (the form's
  // "Type of Ancillary Quote") and the carriers are asked here; the form's answers, while it still
  // asks them (quoteTypeField, carriersField), are shown locked. Coverage today is ONE question
  // first ("any of it today?"); only a yes asks line by line (David 10-31: "make that change").

  /** The lines "coverage today" is asked for: the requested ones (every custom RFP line when none is known). */
  function todayLines_() {
    if (declined_()) return [];
    var shown = shownLines_().map(function (l) { return l.line; });
    return shown.length || !customRfp_() ? shown : rfpLines_();
  }

  /** The form's quote type as an answer to "any of it today?": 'yes' | 'no' | '' (not read). */
  function formAny_() {
    var Q = window.RFP_OPTIONS ? window.RFP_OPTIONS.QUOTE_TYPES : [];
    var t = String(state.formAnswers.quoteType || '').trim().toLowerCase();
    return t && t === String(Q[1] || '').toLowerCase() ? 'no' : t && t === String(Q[0] || '').toLowerCase() ? 'yes' : '';
  }

  /** "Does the group have any of this coverage today?": the form's answer, else the widget's ('' = not yet). */
  function anyToday_() {
    return formAny_() || state.anyToday;
  }

  /** 'yes' | 'no' | '' (not answered): does the group have this line today? A "no" to "any of it" = no on every line. */
  function inForceOf_(line) {
    var form = (state.formAnswers.lines[line] || {}).inForce;
    if (form) return form;
    var any = anyToday_();
    if (any === 'no') return 'no';
    return any === 'yes' ? (state.answers.lines[line] || {}).inForce || '' : '';
  }

  function todayAnswers_() {
    var out = {};
    todayLines_().forEach(function (line) { out[line] = inForceOf_(line); });
    return out;
  }

  /** HubSpot's `ancillary_quote_type`: the form's answer while it asks, else from coverage today ('' = not yet). */
  function quoteType_() {
    var R = window.RFP_OPTIONS;
    var form = state.formAnswers.quoteType || '';
    if (R && R.QUOTE_TYPES.indexOf(form) >= 0) return form;
    return R ? R.quoteType(todayAnswers_()) : '';
  }

  /** HubSpot's `ancillary_carriers`: the form's, else the small-group carriers, else (custom RFP) the ones picked. */
  function carriers_() {
    if (state.formAnswers.carriers.length) return state.formAnswers.carriers.slice();
    if (!customRfp_()) return state.smallGroupCarriers.slice();
    return state.carrierOptions.filter(function (c) { return state.carriers[c]; });
  }

  function groupFields_() {
    return { ancillary_quote_type: quoteType_(), ancillary_carriers: carriers_() };
  }

  /** What stops the form sending the widget's group answers: [] = fine. Both modes. */
  function groupProblems_() {
    var out = [];
    var lines = todayLines_();
    var any = anyToday_();
    var open = lines.filter(function (line) { return !inForceOf_(line); });
    if (lines.length && !any) out.push('Say whether the group has any of this coverage today.');
    else if (open.length) out.push('Say which coverage the group has today: ' + open.join(', ') + '.');
    else if (any === 'yes' && !formAny_() && !lines.some(function (line) { return inForceOf_(line) === 'yes'; })) {
      out.push('You said the group has coverage today: mark which.');
    }
    if (customRfp_() && (state.formAnswers.carriers.length || state.carrierOptions.length) && !carriers_().length) {
      out.push('Pick the carriers to ask for quotes.');
    }
    return out;
  }

  /** A question's wording for messages ("in business 1 year", "Dental coverage today"). */
  function askShort_(key, line) {
    var a = ASKS[key];
    return a ? a.short.replace('{line}', line || '') : key;
  }

  function lineShape_(name) {
    return LINES.filter(function (l) { return l.line === name; })[0] || null;
  }

  /** The quoted version of a line (with prices), or null without a good quote. */
  function quotedLine_(name) {
    var q = state.quote;
    if (!q || !q.ok) return null;
    return q.lines.filter(function (l) { return l.line === name; })[0] || null;
  }

  function shownLines_() {
    return LINES.filter(function (l) { return state.shown[l.line]; });
  }

  function usesOwnCounts_(name) {
    return state.ownCounts[name] != null;
  }

  function debug_(label, data) {
    if (!state.debug || !el.debugLog) return;
    var line = new Date().toISOString().slice(11, 19) + '  ' + label;
    if (data !== undefined) {
      try { line += '\n' + JSON.stringify(data, null, 2); } catch (e) { line += '\n' + String(data); }
    }
    el.debugLog.textContent += line + '\n\n';
  }

  function node_(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * PREVIEW ONLY (David 11-03: "note on the test widget which questions will be pulled directly from
   * questions that already exist on the jotform"): a tag naming the form question an answer is read
   * from (its id in the widget's settings: on the Proposal form, the q number). Agents never see it.
   */
  function formTag_(id) {
    return PREVIEW && id ? node_('span', 'qw-formtag', 'From the Jotform: q' + id) : null;
  }

  /** "From your answers above.", tagged with its form question in the preview. */
  function fromAbove_(id) {
    var p = node_('p', 'qw-ask-hint', 'From your answers above.');
    var tag = formTag_(id);
    if (tag) p.appendChild(tag);
    return p;
  }

  /**
   * PREVIEW ONLY: tags on the group details and the coverage read from the form, and a line naming
   * what is read with no question of its own here (agent, agency, carriers asked for).
   */
  function markFormQuestions_() {
    if (!PREVIEW || el.formNote) return;
    var f = state.fieldIds;
    [[el.size, f.groupSize], [el.zip, f.zip], [el.sic, f.sic], [el.date, f.effectiveDate]].forEach(function (x) {
      var tag = formTag_(x[1]);
      if (tag) x[0].parentNode.insertBefore(tag, x[0]);
    });
    var cov = formTag_(f.coverage);
    if (cov) document.getElementById('qw-coverage-title').appendChild(cov);
    var unseen = [[f.agent, 'agent name'], [f.agency, 'agency'], [f.carriers, 'carriers asked for (only those are priced)']]
      .filter(function (x) { return x[0]; }).map(function (x) { return x[1] + ' q' + x[0]; });
    el.formNote = node_('p', 'qw-formtag-note', 'Preview only: a blue tag marks an answer read from a question already on ' +
      'the Jotform; the widget never asks it again. Everything untagged is asked here.' +
      (unseen.length ? ' Also read, with nothing to show here: ' + unseen.join('; ') + '.' : ''));
    el.note.parentNode.insertBefore(el.formNote, el.note.nextSibling);
  }

  function showMessages_(box, messages) {
    box.textContent = '';
    box.hidden = !messages.length;
    messages.forEach(function (msg) { box.appendChild(node_('p', null, msg)); });
  }

  function countsText_(counts) {
    var out = {};
    TIERS.forEach(function (t) { out[t.key] = counts && counts[t.key] ? String(counts[t.key]) : ''; });
    return out;
  }

  // ---------------------------------------------------------------- start

  var bridge;

  /** Sets the carriers; in the preview, first loads each ../private-rates/<name>.js (one per carrier). */
  function loadPrivateRates_(then) {
    var names = PREVIEW ? (params.get('rates') || '').split(',').filter(function (n) {
      return /^[a-z0-9-]+$/.test(n);
    }) : [];
    var left = names.length;
    var done = function () {
      if (--left > 0) return;
      CARRIERS = carrierPacks_();
      LINES = window.RatingEngine.lines(engineOpts_());
      then();
    };
    if (!left) {
      left = 1;
      return done();
    }
    names.forEach(function (name) {
      var s = document.createElement('script');
      s.src = '../private-rates/' + name + '.js';
      s.async = false; // run in the listed order (a carrier's data file before the carrier)
      s.onload = done;
      s.onerror = done;
      document.head.appendChild(s);
    });
  }

  function boot_() {
    ['real', 'size', 'zip', 'sic', 'date', 'refresh', 'note', 'today', 'today-note', 'today-list', 'custom', 'main',
      'coverage', 'census', 'census-file', 'census-out', 'asks', 'asks-list', 'shared',
      'shared-note', 'counts', 'enrolled', 'errors', 'warn', 'lines', 'foot', 'package', 'debug', 'debug-log'].forEach(function (id) {
      el[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById('qw-' + id);
    });

    try {
      bridge = window.WidgetBridge.create({ preview: PREVIEW, host: NATIVE, readTimeoutMs: READ_TIMEOUT_MS, debug: debug_ });
    } catch (err) {
      showMessages_(el.errors, ['This price tool could not start. ' + err.message]);
      return;
    }
    if (NATIVE) {
      // The form's own Census step is the one place to pick the file: it hands it over (host.readCensus).
      el.censusFile.hidden = true;
      Array.prototype.forEach.call(el.census.querySelectorAll('.qw-census-template'), function (n) { n.hidden = true; });
      var intro = el.census.querySelector('.qw-note-top');
      if (intro) intro.textContent = 'From the census you uploaded on the Census step, read here in your browser: it answers ' +
        'most of the questions below. Only counts are kept. You can change any answer it fills.';
      NATIVE.readCensus = readCensusFile_;
    }

    bridge.start(function (ready) {
      state.debug = bridge.setting('debug', '') === 'on';
      el.debug.hidden = !state.debug;
      debug_('ready (' + bridge.mode + ')', ready);
      state.fieldIds = {
        groupSize: bridge.setting('groupSizeField', ''),
        zip: bridge.setting('zipField', ''),
        sic: bridge.setting('sicField', ''),
        coverage: bridge.setting('coverageField', ''),
        effectiveDate: bridge.setting('effectiveDateField', ''),
        quoteType: bridge.setting('quoteTypeField', ''),
        carriers: bridge.setting('carriersField', ''),
        funding: window.FieldValues.fieldMap(bridge.setting('fundingFields', '')),
        agent: bridge.setting('agentField', ''),   // the form's first page (Proposal form: q4 Agent Name, q8 Agency Name):
        agency: bridge.setting('agencyField', '')  // read for the quote builder, never asked (David 11-01)
      };
      markFormQuestions_();
      state.summaryField = bridge.setting('summaryField', '');
      state.maxGroupSize = parseInt(bridge.setting('maxGroupSize', '0'), 10) || 0;
      state.minGroupSize = parseInt(bridge.setting('minGroupSize', '0'), 10) || 0;
      state.carrierOptions = window.FieldValues.labels(bridge.setting('carrierOptions', ''));
      state.smallGroupCarriers = window.FieldValues.labels(bridge.setting('smallGroupCarriers', ''));
      restore_(ready && ready.value);

      buildCoverage_();
      buildCounters_(el.counts, state.counts, 'shared', recompute_);
      el.censusFile.addEventListener('change', readCensus_);
      renderCensus_(); // a census read before (editing a submission) says so
      el.refresh.addEventListener('click', readFromForm_);
      [el.size, el.zip, el.sic, el.date].forEach(function (input) {
        input.addEventListener('input', function () {
          if (!input.readOnly) requote_();
        });
      });
      bridge.onSubmit(submitAnswer_);
      bridge.onShow(readFromForm_);
      watchHeight_();
      readFromForm_();
    });
  }

  /** Puts back the "Who pays?" answers from a stored answer's HubSpot fields. */
  function restoreFunding_(fields) {
    if (!fields || !window.RFP_OPTIONS) return;
    Object.keys(window.RFP_OPTIONS.FUNDING).forEach(function (line) {
      var v = fields[window.RFP_OPTIONS.FUNDING[line].key];
      if (typeof v === 'string' && window.RFP_OPTIONS.FUNDING[line].options.indexOf(v) >= 0) state.funding[line] = v;
    });
  }

  /** Puts back "coverage today" (the "any of it?" answer and the lines) and the custom RFP's picked carriers. */
  function restoreGroup_(a) {
    var seen = [];
    Object.keys(a.today || {}).forEach(function (line) {
      if (a.today[line] === 'yes' || a.today[line] === 'no') {
        (state.answers.lines[line] = state.answers.lines[line] || {}).inForce = a.today[line];
        seen.push(a.today[line]);
      }
    });
    // An answer saved before "any of it today?" existed (same day) says it through its lines.
    state.anyToday = a.todayAny === 'yes' || a.todayAny === 'no' ? a.todayAny
      : seen.indexOf('yes') >= 0 ? 'yes' : seen.length ? 'no' : '';
    var picked = (a.fields && a.fields.ancillary_carriers) || [];
    if (a.mode === 'custom' && Array.isArray(picked)) {
      picked.forEach(function (c) { if (state.carrierOptions.indexOf(c) >= 0) state.carriers[c] = true; });
    }
  }

  /** Puts back an earlier answer (a visitor editing a submission). */
  function restore_(value) {
    if (!value) return;
    try {
      var a = JSON.parse(value);
      if (a.v === 4 || a.v === 5) restoreGroup_(a);
      if ((a.v === 4 || a.v === 5) && a.mode === 'custom') {
        restoreFunding_(a.fields);
        Object.keys(a.built || {}).forEach(function (line) {
          if (!window.RFP_OPTIONS || !window.RFP_OPTIONS.lines[line] || !Array.isArray(a.built[line])) return;
          state.rfpBuilt[line] = { options: a.built[line].slice(0, window.RFP_OPTIONS.MAX_OPTIONS).map(function (d) {
            return window.RFP_OPTIONS.fit(line, d);
          }) };
        });
        return;
      }
      if ([2, 3, 4, 5].indexOf(a.v) < 0 || !Array.isArray(a.lines)) return;
      restoreFunding_(a.fields);
      restoreCensus_(a.census);
      if (a.answers && a.answers.group) state.answers.group = Object.assign({}, a.answers.group);
      a.lines.forEach(function (l) {
        if (!lineShape_(l.line)) return;
        state.shown[l.line] = true;
        state.prefilled[l.line] = true; // an edited submission keeps its own ticks
        (l.plans || []).forEach(function (p) { state.selected[p.id] = true; });
        if (l.prebuilt) state.prebuilt[l.line] = l.prebuilt;
        if (l.contribution) state.contribution[l.line] = l.contribution;
        if (l.answers) state.answers.lines[l.line] = Object.assign({}, l.answers);
        if (l.method === 'tier' && l.counts) {
          if (l.ownHeadcount) state.ownCounts[l.line] = countsText_(l.counts);
          else state.counts = countsText_(l.counts);
        }
        if (l.method === 'volume' && l.volume != null) state.volumes[l.line] = String(l.volume);
      });
    } catch (e) {
      debug_('earlier answer not readable', String(e));
    }
  }

  // ---------------------------------------------------------------- reading the form

  /** Reads the group answers (and the requested coverage) from the form. */
  function readFromForm_() {
    var f = state.fieldIds;
    var groupIds = [f.groupSize, f.zip, f.sic].filter(Boolean);
    if (groupIds.length < 3) {
      setInputMode_('typed', 'Enter your group details to see prices.');
      requote_();
      return;
    }
    el.note.textContent = 'Reading your answers from the form...';
    var fundingIds = Object.keys(f.funding).map(function (line) { return f.funding[line]; });
    var extra = [f.coverage, f.effectiveDate, f.quoteType, f.carriers, f.agent, f.agency].concat(fundingIds).filter(Boolean);
    bridge.readFields(groupIds.concat(extra), function (values) {
      if (!values) {
        setInputMode_('typed', 'Enter your group details to see prices.');
        requote_();
        return;
      }
      el.size.value = values[f.groupSize] || '';
      el.zip.value = values[f.zip] || '';
      el.sic.value = values[f.sic] || '';
      if (f.effectiveDate) el.date.value = values[f.effectiveDate] || '';
      applyFormAnswers_(values);
      if (f.coverage && values[f.coverage]) showFromText_(values[f.coverage]);
      var blank = !el.size.value && !el.zip.value && !el.sic.value;
      setInputMode_('form', blank
        ? 'Fill in the number of employees, ZIP code and SIC code above, then press Refresh.'
        : 'From your answers above. Changed one? Press Refresh.');
      requote_();
    });
  }

  /**
   * Earlier answers that settle the carriers' questions, while the form still asks them: the quote
   * type (a first-time buyer has nothing in force on any line), the carriers asked for, and each
   * line's funding (fundingFields). Once the form drops those questions the widget asks them
   * itself (David 10-30 funding, 10-31 the rest). A blank or unreadable answer settles nothing.
   */
  function applyFormAnswers_(values) {
    var f = state.fieldIds;
    var fv = window.FieldValues;
    var lines = {};
    var funding = {};
    var inForce = f.quoteType ? fv.inForceFromQuoteType(values[f.quoteType]) : '';
    LINES.forEach(function (l) {
      if (inForce) lines[l.line] = { inForce: inForce };
      var id = f.funding[l.line];
      var text = id ? String(values[id] || '').trim() : '';
      if (text) funding[l.line] = text;
    });
    var picked = f.carriers ? fv.labels(values[f.carriers]) : [];
    state.formAnswers = { lines: lines, funding: funding, carriers: picked,
      quoteType: f.quoteType ? String(values[f.quoteType] || '').trim() : '' };
    state.requestedCarriers = picked.length ? picked.map(function (c) { return c.toLowerCase(); }) : null;
    var agent = { name: ascii_(f.agent ? values[f.agent] : ''), agency: ascii_(f.agency ? values[f.agency] : '') };
    state.agent = agent.name || agent.agency ? agent : null;
    debug_('answers from the form', { lines: lines, funding: funding, carriers: state.requestedCarriers, agent: state.agent });
  }

  /** Text for the answer in plain ASCII (relay, Zapier and HubSpot compare it): accents dropped, the rest removed. */
  function ascii_(text) {
    var s = String(text == null ? '' : text);
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function setInputMode_(mode, note) {
    state.inputsFrom = mode;
    [el.size, el.zip, el.sic].forEach(function (input) { input.readOnly = mode === 'form'; });
    // The date comes from the form only when the widget was told its question; else it is typed.
    el.date.readOnly = mode === 'form' && !!state.fieldIds.effectiveDate;
    el.refresh.hidden = ![state.fieldIds.groupSize, state.fieldIds.zip, state.fieldIds.sic].every(Boolean);
    if (NATIVE) {
      // Inside our own form the answers sit on its earlier steps and are re-read each time this one opens:
      // no echo of them here and no Refresh. The boxes stay (hidden): the prices read them.
      el.size.closest('.qw-inputs').hidden = mode === 'form';
      if (mode === 'form' && /^From your answers/.test(note)) note = '';
    }
    el.note.textContent = note;
  }

  /** The form's "Requested coverage" answer -> the ticked lines. Unknown names are ignored. */
  function showFromText_(text) {
    var items = String(text).split(/\r?\n|;|,/).map(function (s) { return s.trim().toLowerCase(); });
    var shown = {};
    LINES.forEach(function (l) {
      var name = l.line.toLowerCase();
      if (items.some(function (i) { return i && i.indexOf(name) === 0; })) shown[l.line] = true;
    });
    debug_('requested coverage from the form', { text: text, lines: Object.keys(shown) });
    if (!Object.keys(shown).length) return;
    state.shown = shown;
    dropHiddenSelections_();
    syncCoverageChips_();
  }

  // ---------------------------------------------------------------- building the screen

  function buildCoverage_() {
    el.coverage.textContent = '';
    LINES.forEach(function (l) {
      var chip = node_('label', 'qw-chip');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.value = l.line;
      box.checked = !!state.shown[l.line];
      box.addEventListener('change', function () {
        if (box.checked) state.shown[l.line] = true;
        else delete state.shown[l.line];
        chip.classList.toggle('is-on', box.checked);
        dropHiddenSelections_();
        renderLines_();
        recompute_();
      });
      chip.classList.toggle('is-on', box.checked);
      chip.appendChild(box);
      chip.appendChild(node_('span', null, l.line));
      el.coverage.appendChild(chip);
    });
  }

  function syncCoverageChips_() {
    Array.prototype.forEach.call(el.coverage.querySelectorAll('input'), function (box) {
      box.checked = !!state.shown[box.value];
      box.parentNode.classList.toggle('is-on', box.checked);
    });
  }

  function dropHiddenSelections_() {
    LINES.forEach(function (l) {
      if (state.shown[l.line]) return;
      delete state.prefilled[l.line]; // shown again later: it starts with its pre-built plans again
      var q = quotedLine_(l.line);
      (q ? q.plans : []).forEach(function (p) { delete state.selected[p.id]; });
      if (l.method === 'request') delete state.selected[IDI_REQUEST];
    });
  }

  /** One stepper per tier (minus, number, plus) writing into `store`. Blank and 0 = nobody. */
  function buildCounters_(container, store, prefix, onChange) {
    container.textContent = '';
    TIERS.forEach(function (t) {
      var wrap = node_('div', 'qw-count');
      var id = 'count-' + prefix + '-' + t.key;
      var label = node_('label', 'qw-count-label', t.label);
      label.htmlFor = id;

      var input = document.createElement('input');
      input.id = id;
      input.inputMode = 'numeric';
      input.autocomplete = 'off';
      input.maxLength = 4;
      input.placeholder = '0';
      input.value = store[t.key] && store[t.key] !== '0' ? String(store[t.key]) : '';
      input.addEventListener('input', function () {
        store[t.key] = input.value;
        onChange();
      });

      var step = function (delta) {
        var n = /^\d+$/.test(input.value.trim()) ? parseInt(input.value, 10) : 0;
        n = Math.max(0, n + delta);
        input.value = n ? String(n) : '';
        store[t.key] = input.value;
        onChange();
      };
      var minus = node_('button', 'qw-step', '-');
      minus.type = 'button';
      minus.setAttribute('aria-label', 'One fewer: ' + t.label);
      minus.addEventListener('click', function () { step(-1); });
      var plus = node_('button', 'qw-step', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', 'One more: ' + t.label);
      plus.addEventListener('click', function () { step(1); });

      var stepper = node_('div', 'qw-stepper');
      stepper.appendChild(minus);
      stepper.appendChild(input);
      stepper.appendChild(plus);
      wrap.appendChild(label);
      wrap.appendChild(stepper);
      container.appendChild(wrap);
    });
  }

  /** Rebuilds the line sections. Only on a new quote or a coverage change, never per keystroke. */
  function renderLines_() {
    el.lines.textContent = '';
    lineRefs = {};
    if (!state.quote || !state.quote.ok) return;
    shownLines_().forEach(function (shape) {
      var ql = quotedLine_(shape.line);
      prefill_(ql);
      el.lines.appendChild(buildLine_(ql));
    });
  }

  /**
   * A line seen for the first time starts with its pre-built plans ticked (David 11-02), except one a
   * carrier's rule refuses (it says why on its card). Once per line, so the agent's unticks stay.
   */
  function prefill_(ql) {
    if (!ql || ql.unavailable || state.prefilled[ql.line]) return;
    ql.plans.forEach(function (p) { if (p.featured && !p.priceWhy) state.selected[p.id] = true; });
    state.prefilled[ql.line] = true;
  }

  function expanded_(line, part) { return !!(state.expand[line] && state.expand[line][part]); }

  function setExpanded_(line, part, open) {
    (state.expand[line] = state.expand[line] || {})[part] = open;
  }

  /**
   * A setting of a carrier's pre-built plans changed: one for all of them (slot = '', e.g. EHB on) or
   * one plan's own (slot = that plan, e.g. Better to MAC). The ticks move with the plans, so "Better"
   * stays ticked as "Better with EHB".
   */
  function setPrebuilt_(ql, o, key, value, slot) {
    var line = ql.line;
    var old = (state.prebuilt[line] || {})[o.carrier] || {};
    var settings = JSON.parse(JSON.stringify(old));
    var ctx = { inputs: state.quote.inputs, answers: lineAnswers_(line) };
    var before = o.prebuilt.plans(ctx, old);
    if (slot) ((settings.plans = settings.plans || {})[slot] = settings.plans[slot] || {})[key] = value;
    else settings[key] = value;
    var after = o.prebuilt.plans(ctx, settings);
    var ticked = before.map(function (p) { return !!state.selected[p.id]; });
    before.forEach(function (p) { delete state.selected[p.id]; });
    after.forEach(function (p, i) { if (ticked[i]) state.selected[p.id] = true; });
    (state.prebuilt[line] = state.prebuilt[line] || {})[o.carrier] = settings;
    requote_();
  }

  /** The pre-built plans' settings (switches and choices) and the carrier's facts, above the plans. */
  /**
   * One setting as a control: a switch (kind 'switch') or a dropdown (anything else; greyed when it
   * has one choice), with the carrier's reason or note under it. change(value) applies it.
   */
  function settingControl_(f, id, current, change) {
    var row = node_('div', 'qw-prebuilt-row');
    if (f.kind === 'switch') {
      var sw = node_('label', 'qw-switch');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = !f.why && !!current;
      box.disabled = !!f.why;
      box.addEventListener('change', function () { change(box.checked); });
      sw.appendChild(box);
      sw.appendChild(node_('span', null, f.label));
      row.appendChild(sw);
    } else {
      var label = node_('label', 'qw-view-item');
      label.appendChild(node_('span', null, f.label));
      var select = document.createElement('select');
      select.id = id;
      f.options.forEach(function (op) {
        var opt = node_('option', null, op.label);
        opt.value = op.value;
        select.appendChild(opt);
      });
      select.value = f.options.some(function (op) { return op.value === current; }) ? current : f.default;
      select.disabled = f.options.length < 2;
      select.addEventListener('change', function () { change(select.value); });
      label.appendChild(select);
      row.appendChild(label);
    }
    var note = f.why || f.note;
    if (note) row.appendChild(node_('p', 'qw-hint', note));
    return row;
  }

  /** The settings for all of a carrier's plans on the line (e.g. pediatric EHB) and its facts, above the plans. */
  function buildPrebuiltSettings_(ql, sec) {
    (ql.offerings || []).forEach(function (o) {
      if (o.unavailable || !o.prebuilt) return;
      var ctx = { inputs: state.quote.inputs, answers: lineAnswers_(ql.line) };
      var facts = typeof o.prebuilt.facts === 'function' ? o.prebuilt.facts(ctx) : o.prebuilt.facts || [];
      if (!o.prebuilt.settings && !facts.length) return;
      var box = node_('div', 'qw-prebuilt');
      var given = (state.prebuilt[ql.line] || {})[o.carrier] || {};
      (o.prebuilt.settings ? o.prebuilt.settings(ctx) : []).forEach(function (f) {
        var id = 'pre-' + safeId_(ql.line) + '-' + safeId_(o.carrier) + '-' + f.key;
        box.appendChild(settingControl_(f, id, given[f.key] != null ? given[f.key] : f.default, function (v) {
          setPrebuilt_(ql, o, f.key, v);
          refocus_(id);
        }));
      });
      facts.forEach(function (t) { box.appendChild(node_('p', 'qw-hint', t)); });
      sec.appendChild(box);
    });
  }

  /**
   * Whether a plan follows the line's settings for every plan (e.g. pediatric EHB on: only EHB plans),
   * so "see all plans" lists the plans that match them. A plan of another carrier, or a design, always does.
   */
  function followsSettings_(ql) {
    var tests = [];
    (ql.offerings || []).forEach(function (o) {
      if (o.unavailable || !o.prebuilt || !o.prebuilt.settings) return;
      var given = (state.prebuilt[ql.line] || {})[o.carrier] || {};
      o.prebuilt.settings({ inputs: state.quote.inputs, answers: lineAnswers_(ql.line) }).forEach(function (f) {
        if (!f.matches) return;
        var v = f.why ? f.default : given[f.key] != null ? given[f.key] : f.default;
        tests.push(function (p) { return p.carrier !== o.carrier || p.custom || f.matches(p, v); });
      });
    });
    return function (p) { return tests.every(function (t) { return t(p); }); };
  }

  /** The plans "see all plans" lists and counts: every carrier plan that follows the line's settings (no design). */
  function seeAllPlans_(ql) {
    var follows = followsSettings_(ql);
    return ql.plans.filter(function (p) { return !p.custom && follows(p); });
  }

  /** A pre-built plan's own settings on its card (David 11-02: e.g. one plan MAC, another 90th). */
  function buildPlanSettings_(ql, p, card) {
    var o = (ql.offerings || []).filter(function (x) {
      return x.carrier === p.carrier && !x.unavailable && x.prebuilt && x.prebuilt.planSettings;
    })[0];
    if (!o || !p.featured || !p.slot) return;
    var box = node_('div', 'qw-plan-settings');
    o.prebuilt.planSettings({ inputs: state.quote.inputs, answers: lineAnswers_(ql.line) }).forEach(function (f) {
      var id = 'pre-' + safeId_(ql.line) + '-' + safeId_(p.slot) + '-' + f.key;
      box.appendChild(settingControl_(f, id, (p.settings || {})[f.key], function (v) {
        setPrebuilt_(ql, o, f.key, v, p.slot);
        refocus_(id);
      }));
    });
    card.appendChild(box);
  }

  function buildLine_(ql) {
    var refs = { totals: {}, rates: {}, notes: {}, band: null };
    lineRefs[ql.line] = refs;
    var sec = node_('section', 'qw-line');
    var head = node_('div', 'qw-line-head');
    head.appendChild(node_('h3', 'qw-line-name', ql.line));
    head.appendChild(node_('span', 'qw-line-basis', ql.later ? 'Priced after the form is sent'
      : ql.method === 'tier' ? 'Priced per tier' : ql.method === 'volume' ? 'Priced ' + ql.basis : 'Individually underwritten'));
    sec.appendChild(head);
    // Where each carrier's rates come from, and which carriers cannot take this group.
    var sources = node_('ul', 'qw-sources');
    (ql.offerings || []).forEach(function (o) {
      var li = node_('li', o.unavailable ? 'is-out' : 'is-real');
      li.appendChild(node_('strong', null, o.carrier + ': '));
      li.appendChild(document.createTextNode(o.unavailable ? 'not available. ' + o.unavailable : o.source));
      sources.appendChild(li);
    });
    if (sources.children.length) sec.appendChild(sources);
    buildContribution_(ql, sec);
    refs.asksBox = node_('div', 'qw-line-asks');
    sec.appendChild(refs.asksBox);
    buildLineAsks_(ql, refs.asksBox);

    if (ql.unavailable) {
      // No carrier here at all: the line is still requested, so this is information, not a refusal.
      var none = !(ql.offerings || []).length;
      var why = node_('div', 'qw-line-msg' + (none ? '' : ' is-error'));
      why.appendChild(node_('p', null, (none ? '' : 'Not available: ') + ql.unavailable));
      sec.appendChild(why);
      return sec;
    }

    if (ql.method === 'tier') {
      var own = node_('label', 'qw-own');
      var ownBox = document.createElement('input');
      ownBox.type = 'checkbox';
      ownBox.checked = usesOwnCounts_(ql.line);
      own.appendChild(ownBox);
      own.appendChild(node_('span', null, 'Different headcount for ' + ql.line));
      var ownCounters = node_('div', 'qw-counts qw-own-counts');
      ownCounters.hidden = !ownBox.checked;
      if (ownBox.checked) buildCounters_(ownCounters, state.ownCounts[ql.line], ql.line, recompute_);
      ownBox.addEventListener('change', function () {
        if (ownBox.checked) {
          state.ownCounts[ql.line] = countsText_(window.RatingEngine.lineTotals(ql, { counts: state.counts }).counts);
          buildCounters_(ownCounters, state.ownCounts[ql.line], ql.line, recompute_);
        } else {
          delete state.ownCounts[ql.line];
          ownCounters.textContent = '';
        }
        ownCounters.hidden = !ownBox.checked;
        recompute_();
      });
      sec.appendChild(own);
      sec.appendChild(ownCounters);
      if ((ql.offerings || []).some(function (o) { return o.bands; })) {
        refs.band = node_('p', 'qw-hint qw-band');
        sec.appendChild(refs.band);
      }
    }

    if (ql.later) {
      var by = (ql.offerings || []).filter(function (o) { return !o.unavailable; }).map(function (o) { return o.carrier; }).join(', ');
      sec.appendChild(node_('p', 'qw-hint', ql.method === 'tier'
        ? 'Pick the designs to request: ' + by + ' prices them after the form is sent, from the census. No price shows here.'
        : 'Pick the designs to request: ' + by + ' prices them after the form is sent, so no amounts are needed here.'));
    }
    if (ql.method === 'volume' && !ql.later) {
      var vol = node_('label', 'qw-vol');
      vol.appendChild(node_('span', 'qw-vol-label', ql.volumeLabel));
      var input = document.createElement('input');
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.placeholder = '$0';
      input.value = state.volumes[ql.line] || '';
      input.addEventListener('input', function () {
        state.volumes[ql.line] = input.value;
        recompute_();
      });
      vol.appendChild(input);
      sec.appendChild(vol);
      sec.appendChild(node_('p', 'qw-hint', ql.volumeHint));
    }

    refs.msg = node_('div', 'qw-line-msg');
    refs.msg.hidden = true;
    sec.appendChild(refs.msg);

    buildPrebuiltSettings_(ql, sec);
    buildDesigners_(ql, sec);
    // "See all plans" only when the line has more than its pre-built plans (life lines: build your own only).
    // Last before the plans, so its filters sit on the list they narrow.
    if (ql.plans.length > 1 && ql.plans.some(function (p) { return !p.featured && !p.custom; })) buildFinder_(ql, sec, refs);

    var plans = node_('div', 'qw-line-plans');
    refs.plansBox = plans;
    refs.cards = {};
    if (ql.method === 'request') {
      plans.appendChild(planCard_(IDI_REQUEST, 'Ask us to quote IDI', null, '', function (card) {
        card.appendChild(node_('p', 'qw-hint',
          'Individual disability income is underwritten person by person, so it has no group rate here.'));
      }));
    }
    ql.plans.forEach(function (p) {
      plans.appendChild(refs.cards[p.id] = planCard_(p.id, p.name, p.carrier, p.featured && p.label, function (card) {
        if (p.detail) card.appendChild(node_('p', 'qw-hint qw-plan-detail', p.detail));
        buildPlanSettings_(ql, p, card);
        if (ql.method === 'tier' && !ql.later) {
          // Banded rates depend on the enrolled count, so recompute_ fills the cells.
          var grid = node_('dl', 'qw-rates');
          refs.rates[p.id] = {};
          TIERS.forEach(function (t) {
            var cell = node_('div', 'qw-rate');
            cell.appendChild(node_('dt', null, t.label));
            var dd = node_('dd', null, p.rates ? money.format(p.rates[t.key]) : '');
            refs.rates[p.id][t.key] = dd;
            cell.appendChild(dd);
            grid.appendChild(cell);
          });
          card.appendChild(grid);
          var note = node_('p', 'qw-plan-note');
          note.hidden = true;
          card.appendChild(note);
          refs.notes[p.id] = note;
        } else if (ql.later || p.later || typeof p.rate !== 'number') {
          // A plan a rule refuses says why in its note (no "priced later" beside it).
          if (p.later || !p.priceWhy) card.appendChild(node_('p', 'qw-hint qw-plan-detail', p.later || 'Priced after the form is sent.'));
          var later = node_('p', 'qw-plan-note');
          later.hidden = true;
          card.appendChild(later);
          refs.notes[p.id] = later;
          return;
        } else {
          card.appendChild(node_('p', 'qw-vrate', 'Rate ' + rateMoney.format(p.rate) + ' ' + ql.basis));
        }
        var total = node_('div', 'qw-total');
        total.hidden = true;
        total.appendChild(node_('span', 'qw-total-label', 'Total premium'));
        var amt = node_('strong', 'qw-total-amt');
        var annual = node_('span', 'qw-total-annual');
        total.appendChild(amt);
        total.appendChild(annual);
        card.appendChild(total);
        refs.totals[p.id] = { box: total, amt: amt, annual: annual };
      }));
    });
    // While "see all plans" filters, the ticked plans that do not match go under this line (applyView_).
    refs.outsideHead = node_('p', 'qw-outside-head', 'Ticked, but not a match for your choices (still quoted until you untick it)');
    refs.outsideHead.setAttribute('data-plan', OUTSIDE_HEAD);
    refs.outsideHead.hidden = true;
    plans.appendChild(refs.outsideHead);
    sec.appendChild(plans);
    return sec;
  }

  /** After a rebuild, puts the keyboard back where the visitor was. */
  function refocus_(id) {
    var n = document.getElementById(id);
    if (n) n.focus();
  }

  function safeId_(s) {
    return String(s).replace(/[^A-Za-z0-9]+/g, '');
  }

  /**
   * "Who pays?" (David 10-30: the form's funding questions move into the widget). A line HubSpot
   * keeps funding for asks it in HubSpot's own values; a carrier that prices by employer
   * contribution reads it, and a band that straddles its 50% line ("0% - 50%") asks one more
   * click. A line whose plans carry their own "Who pays" (a carrier's STD / LTD designs) takes it
   * from the ticked plans instead (fundingFromPlans_). A line HubSpot keeps no funding for asks
   * only when a carrier prices by it.
   */
  function buildContribution_(ql, sec) {
    var askers = (ql.offerings || []).filter(function (o) {
      return !o.unavailable && o.asks && o.asks.indexOf('contribution') >= 0;
    }).map(function (o) { return o.carrier; });
    var spec = fundingSpec_(ql.line);
    if (spec ? designFunded_(ql) : !askers.length) return;
    var box = node_('div', 'qw-ask');
    box.setAttribute('data-ask', 'contribution');
    box.setAttribute('data-line', ql.line);
    box.appendChild(node_('span', 'qw-facet-label', 'Who pays for ' + ql.line + '?' +
      (askers.length ? ' (' + askers.join(', ') + ' prices by it)' : '')));
    var priced = 'Priced as employer-paid until you pick.';
    if (!spec) {
      box.appendChild(choiceChips_('contrib-' + safeId_(ql.line), [['er', 'Employer pays 50% or more'],
        ['vol', 'Employees pay most (voluntary)']], state.contribution[ql.line] || '', false,
        function (v) { state.contribution[ql.line] = v; }));
      if (!state.contribution[ql.line]) box.appendChild(node_('p', 'qw-ask-hint', priced));
      sec.appendChild(box);
      return;
    }
    var fixed = formFunding_(ql.line);
    var simple = SIMPLE_FUNDING[ql.line];
    if (simple && !fixed) {
      box.appendChild(choiceChips_('fund-' + safeId_(ql.line), [['er', 'Employer paid'], ['vol', 'Voluntary']],
        contributionOf_(ql.line), false, function (v) {
          state.funding[ql.line] = simple[v];
          state.contribution[ql.line] = v;
        }));
      box.appendChild(node_('p', 'qw-ask-hint', contributionOf_(ql.line) ? 'Employer paid = the employer pays 50% or more.' : priced));
      sec.appendChild(box);
      return;
    }
    var funding = fundingOf_(ql.line);
    box.appendChild(choiceChips_('fund-' + safeId_(ql.line), spec.options.map(function (o) { return [o, o]; }), funding,
      !!fixed, function (v) {
        state.funding[ql.line] = v;
        delete state.contribution[ql.line]; // a new band settles it again, or asks again
      }));
    if (fixed) box.appendChild(fromAbove_(state.fieldIds.funding[ql.line]));
    if (askers.length && funding && !simple && !window.FieldValues.contributionFromFunding(funding)) {
      box.appendChild(node_('span', 'qw-facet-label qw-ask-sub', 'Exactly 50%, or less?'));
      box.appendChild(choiceChips_('contrib-' + safeId_(ql.line), [['er', 'Exactly 50%'], ['vol', 'Less than 50%']],
        state.contribution[ql.line] || '', false, function (v) { state.contribution[ql.line] = v; }));
      box.appendChild(node_('p', 'qw-ask-hint', askers.join(', ') + ' prices 50% or more as employer-paid, less as voluntary.'));
    } else if (askers.length && !funding) box.appendChild(node_('p', 'qw-ask-hint', priced));
    sec.appendChild(box);
  }

  /** One row of single-choice chips ([value, text]); a pick re-prices and keeps the focus on the chip. */
  function choiceChips_(idBase, choices, current, locked, pick) {
    var chips = node_('div', 'qw-fchips');
    choices.forEach(function (c) {
      var b = node_('button', 'qw-fchip', c[1]);
      b.type = 'button';
      b.id = idBase + '-' + safeId_(c[0]);
      b.classList.toggle('is-on', current === c[0]);
      b.setAttribute('aria-pressed', current === c[0] ? 'true' : 'false');
      b.disabled = locked;
      b.addEventListener('click', function () {
        if (current === c[0]) return;
        pick(c[0]);
        requote_();
        refocus_(b.id);
      });
      chips.appendChild(b);
    });
    return chips;
  }

  /** True when the line's plans carry their own "Who pays" (a carrier's designs, e.g. STD / LTD). */
  function designFunded_(ql) {
    return (ql.offerings || []).some(function (o) {
      return !o.unavailable && o.designer && o.designer.base && o.designer.base.contribution != null;
    });
  }

  /**
   * HubSpot's funding for a line whose plans carry their own "Who pays": every ticked plan
   * 100% employer-paid = "100% Employer paid", every one voluntary = "Voluntary". '' when they
   * differ or are contributory (50% - 99%), which HubSpot has no value for: the plans' designs,
   * in the answer, still say it.
   */
  function fundingFromPlans_(s) {
    var spec = fundingSpec_(s.line);
    var seen = {};
    s.plans.forEach(function (p) { if (p.design && p.design.contribution) seen[p.design.contribution] = true; });
    var kinds = Object.keys(seen);
    if (!spec || kinds.length !== 1) return '';
    var v = /^\s*non\s*contributory/i.test(kinds[0]) ? '100% Employer paid' : /^\s*voluntary/i.test(kinds[0]) ? 'Voluntary' : '';
    return spec.options.indexOf(v) >= 0 ? v : '';
  }

  /** A ticked line's funding for HubSpot: from its plans (fundingFromPlans_) or its "Who pays?". */
  function lineFunding_(s) {
    return designFunded_(s.quoted) ? fundingFromPlans_(s) : fundingOf_(s.line);
  }

  /**
   * The line's own questions (ASKS scope 'line'), asked by an open carrier. Not "who pays"
   * (buildContribution_) and not "coverage today" (renderToday_ asks it for every requested line).
   */
  /**
   * The on-demand questions a ticked plan on the line uses (ASKS onDemand, e.g. a voluntary design's
   * enrollment minimum: David 11-02), in ASKS order: [key], from the line's last totals.
   */
  function onDemandKeys_(ql) {
    var uses = (state.totals[ql.line] || {}).carrierUses || {};
    var keys = {};
    Object.keys(uses).forEach(function (c) { uses[c].forEach(function (k) { keys[k] = true; }); });
    return Object.keys(ASKS).filter(function (k) { return keys[k] && ASKS[k].onDemand; });
  }

  /** The line's own questions (into `box`, rebuilt when the on-demand ones change): each asking carrier's wording when it has one. */
  function buildLineAsks_(ql, box) {
    box.textContent = '';
    var who = {};
    var add = function (k, carrier) {
      who[k] = who[k] || [];
      if (who[k].indexOf(carrier) < 0) who[k].push(carrier);
    };
    (ql.offerings || []).forEach(function (o) {
      if (o.unavailable) return;
      (o.asks || []).forEach(function (k) {
        if (k === 'contribution' || k === 'inForce' || !ASKS[k] || ASKS[k].scope !== 'line') return;
        add(k, o.carrier);
      });
    });
    var demand = onDemandKeys_(ql);
    var uses = (state.totals[ql.line] || {}).carrierUses || {};
    demand.forEach(function (k) {
      Object.keys(uses).forEach(function (c) { if (uses[c].indexOf(k) >= 0) add(k, c); });
    });
    var refs = lineRefs[ql.line];
    if (refs) refs.asksSig = demand.join();
    var keys = Object.keys(ASKS).filter(function (k) { return who[k]; });
    if (!keys.length) return;
    var store = state.answers.lines[ql.line] || (state.answers.lines[ql.line] = {});
    var fromForm = state.formAnswers.lines[ql.line] || {};
    keys.forEach(function (k) {
      var opts = null;
      var label = null;
      (ql.offerings || []).forEach(function (o) {
        if (o.unavailable || who[k].indexOf(o.carrier) < 0) return;
        if (!opts && o.askOptions && o.askOptions[k]) opts = o.askOptions[k];
        if (!label && o.askLabels && o.askLabels[k]) label = o.askLabels[k];
      });
      box.appendChild(askControl_(k, ql.line, store, who[k], fromForm[k] ? fromForm[k] : null, opts, label));
    });
  }

  /**
   * Build-your-own: every option the carrier's tool offers, limited the way its tool limits
   * them for this group (designer.fields). The design is priced as one more plan card
   * ("..., your design"), which is never hidden by Find a plan.
   */
  function buildDesigners_(ql, sec) {
    (ql.offerings || []).forEach(function (o) {
      if (o.unavailable || !o.designer) return;
      var plan = ql.plans.filter(function (p) { return p.carrier === o.carrier && p.custom; })[0];
      if (!plan) return;
      var chosen = state.designs[ql.line] && state.designs[ql.line][o.carrier];
      var box = node_('details', 'qw-designer');
      box.open = !!chosen || expanded_(ql.line, 'byo');
      // Closed, the design and its card stay out of the way (a ticked design always shows).
      box.addEventListener('toggle', function () {
        setExpanded_(ql.line, 'byo', box.open);
        applyView_(ql.line);
      });
      var sum = node_('summary', 'qw-finder-sum');
      sum.appendChild(node_('span', 'qw-finder-title', o.designer.title || 'Build your own ' + o.carrier + ' plan'));
      sum.appendChild(node_('span', 'qw-finder-count', 'every option ' + o.carrier + ' offers this group'));
      box.appendChild(sum);
      var grid = node_('div', 'qw-designer-grid');
      var soFar = {};
      o.designer.fields(state.quote.inputs).forEach(function (f) {
        var options = typeof f.options === 'function' ? f.options(soFar) : f.options;
        soFar[f.key] = plan.design[f.key];
        var item = node_('label', 'qw-view-item');
        item.appendChild(node_('span', null, f.label));
        var select = document.createElement('select');
        select.id = 'design-' + safeId_(ql.line) + '-' + safeId_(o.carrier) + '-' + f.key;
        options.forEach(function (v) {
          var opt = node_('option', null, v);
          opt.value = v;
          select.appendChild(opt);
        });
        select.value = plan.design[f.key];
        select.disabled = options.length < 2;
        select.addEventListener('change', function () {
          var d = Object.assign({}, plan.design);
          d[f.key] = select.value;
          state.designs[ql.line] = state.designs[ql.line] || {};
          state.designs[ql.line][o.carrier] = d;
          requote_();
          refocus_(select.id);
        });
        item.appendChild(select);
        grid.appendChild(item);
      });
      box.appendChild(grid);
      box.appendChild(node_('p', 'qw-hint', 'Priced below as "' + plan.name + '": tick it like any other plan.'));
      sec.appendChild(box);
    });
  }

  /**
   * "Find a plan": one row of buttons per shared feature (plan-view.js), each with a live
   * count, across every carrier on the line, plus a Sort menu. Within a choice feature (the
   * carrier, the network) the visitor can pick several; a threshold or yes/no feature takes
   * one, and clicking it again lets it go. View only: prices and ticks never change.
   */
  function buildFinder_(ql, sec, refs) {
    // Filters come from the plans "see all" can show: a feature a line setting decides (EHB) gets no row.
    var opts = window.PlanView.viewOptions(ql.facets, seeAllPlans_(ql));
    var view = state.view[ql.line] || (state.view[ql.line] = { sort: 'listed', filters: {} });
    var box = node_('details', 'qw-finder');
    // Closed, the line shows its pre-built plans (and any ticked); open, every plan, with the filters.
    box.open = expanded_(ql.line, 'all');
    box.addEventListener('toggle', function () {
      setExpanded_(ql.line, 'all', box.open);
      applyView_(ql.line);
    });
    var sum = node_('summary', 'qw-finder-sum');
    sum.appendChild(node_('span', 'qw-finder-title', 'See all plans and filter'));
    refs.findCount = node_('span', 'qw-finder-count');
    sum.appendChild(refs.findCount);
    box.appendChild(sum);

    refs.chips = {};
    opts.filters.forEach(function (f) {
      var row = node_('div', 'qw-facet');
      row.appendChild(node_('span', 'qw-facet-label', f.label + (f.multi ? ' (pick any)' : '')));
      var chips = node_('div', 'qw-fchips');
      refs.chips[f.key] = {};
      var make = function (value, label) {
        var b = node_('button', 'qw-fchip');
        b.type = 'button';
        b.appendChild(node_('span', null, label));
        var count = node_('span', 'qw-fcount');
        b.appendChild(count);
        b.addEventListener('click', function () {
          toggleFilter_(view, f, value);
          applyView_(ql.line);
        });
        chips.appendChild(b);
        refs.chips[f.key][value] = { btn: b, count: count, filter: f };
      };
      make('', 'Any');
      f.options.forEach(function (o) { make(o.value, o.label); });
      row.appendChild(chips);
      box.appendChild(row);
    });

    var foot = node_('div', 'qw-finder-foot');
    var item = node_('label', 'qw-view-item');
    item.appendChild(node_('span', null, 'Sort by'));
    var select = document.createElement('select');
    opts.sort.forEach(function (o) {
      var opt = node_('option', null, o.label);
      opt.value = o.value;
      select.appendChild(opt);
    });
    select.value = view.sort;
    select.addEventListener('change', function () {
      view.sort = select.value;
      applyView_(ql.line);
    });
    item.appendChild(select);
    foot.appendChild(item);
    refs.clear = node_('button', 'qw-linkbtn', 'Clear choices');
    refs.clear.type = 'button';
    refs.clear.addEventListener('click', function () {
      view.filters = {};
      applyView_(ql.line);
    });
    foot.appendChild(refs.clear);
    box.appendChild(foot);
    sec.appendChild(box);
  }

  /** A click on a feature button: pick it, or let it go (choice features keep several). */
  function toggleFilter_(view, f, value) {
    if (value === '') {
      delete view.filters[f.key];
      return;
    }
    if (f.multi) {
      var cur = (view.filters[f.key] || []).slice();
      var i = cur.indexOf(value);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(value);
      if (cur.length) view.filters[f.key] = cur;
      else delete view.filters[f.key];
    } else if (view.filters[f.key] === value) {
      delete view.filters[f.key];
    } else {
      view.filters[f.key] = value;
    }
  }

  /**
   * Puts one line's plan cards in the chosen order, hides the filtered-out ones, updates counts. While
   * "see all plans" filters, the matches come first; a ticked plan that does not match goes under a
   * divider, dimmed: still shown (a ticked plan never hides), but no longer above the matches (David
   * 11-03: the ticked pre-built plans on top made the filters look broken).
   */
  function applyView_(line) {
    var refs = lineRefs[line];
    var ql = quotedLine_(line);
    if (!refs || !refs.cards || !ql || !ql.plans.length) return;
    var view = state.view[line] || { sort: 'listed', filters: {} };
    var showAll = expanded_(line, 'all');
    var byo = expanded_(line, 'byo');
    var anyFeatured = ql.plans.some(function (p) { return p.featured; });
    var follows = followsSettings_(ql);
    var listed = seeAllPlans_(ql); // what "see all plans" lists and counts (never the build-your-own design)
    var t = state.totals[line];
    var priceOf = function (p) {
      var pt = t && t.ok ? t.plans.filter(function (x) { return x.id === p.id; })[0] : null;
      if (pt) return pt.monthly;
      if (ql.method === 'tier') {
        var r = ratesUsed_(line, p);
        return r ? r.ee : null;
      }
      return p.rate != null ? p.rate : null;
    };
    var keep = {};
    // Ticked plans are never hidden; nor is the build-your-own design while its panel is open.
    ql.plans.forEach(function (p) { if (state.selected[p.id] || (p.custom && byo)) keep[p.id] = true; });
    var res = window.PlanView.applyView(ql.plans, ql.facets, showAll ? view : { sort: view.sort, filters: {} }, priceOf, keep);
    var outside = {}; // ticked plans the choices would hide (the design stays with the matches)
    ql.plans.forEach(function (p) { if (showAll && res.outside[p.id] && !p.custom) outside[p.id] = true; });
    var below = res.order.filter(function (id) { return outside[id]; });
    var want = res.order.filter(function (id) { return !outside[id]; });
    if (refs.outsideHead) want = want.concat([OUTSIDE_HEAD], below);

    // Move cards only when the order changed, so a focused checkbox is not disturbed.
    var current = Array.prototype.map.call(refs.plansBox.children, function (c) { return c.getAttribute('data-plan'); })
      .filter(function (id) { return want.indexOf(id) >= 0; });
    if (current.join('|') !== want.join('|')) {
      want.forEach(function (id) { refs.plansBox.appendChild(id === OUTSIDE_HEAD ? refs.outsideHead : refs.cards[id]); });
    }
    if (refs.outsideHead) refs.outsideHead.hidden = !below.length;
    // Shown: the pre-built plans (every plan on a line without any), the ticked ones, the design while
    // "build your own" is open, and, while "see all plans" is open, every plan the filters and settings keep.
    ql.plans.forEach(function (p) {
      var show = keep[p.id] || (!p.custom && (showAll ? !res.hidden[p.id] && follows(p) : p.featured || !anyFeatured));
      refs.cards[p.id].hidden = !show;
      refs.cards[p.id].classList.toggle('is-outside', !!outside[p.id]);
    });
    if (!refs.findCount) return; // no "see all plans" on this line

    // Each button: how many plans it would leave, given the other choices.
    var counts = window.PlanView.facetCounts(listed, ql.facets, view);
    Object.keys(refs.chips || {}).forEach(function (key) {
      var picked = view.filters[key];
      var list = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      Object.keys(refs.chips[key]).forEach(function (value) {
        var c = refs.chips[key][value];
        var n = (counts[key] || {})[value === '' ? 'any' : value] || 0;
        var on = value === '' ? !list.length : list.indexOf(value) >= 0;
        c.count.textContent = String(n);
        c.btn.classList.toggle('is-on', on);
        c.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        c.btn.disabled = !on && n === 0;
      });
    });

    var carriers = {};
    listed.forEach(function (p) { carriers[p.carrier] = true; });
    var nCarriers = Object.keys(carriers).length;
    var of = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };
    // A match = passes the choices (a ticked plan that does not is listed apart, not counted).
    var matched = listed.filter(function (p) { return !res.hidden[p.id] && !outside[p.id]; });
    var matchedCarriers = {};
    matched.forEach(function (p) { matchedCarriers[p.carrier] = true; });
    refs.findCount.textContent = res.filtered
      ? matched.length + ' of ' + of(listed.length, 'option') + ' match, from ' + of(Object.keys(matchedCarriers).length, 'carrier')
      : of(listed.length, 'option') + ' from ' + of(nCarriers, 'carrier');
    refs.clear.hidden = !res.filtered;
  }

  function planCard_(id, name, carrier, label, fill) {
    var card = node_('label', 'qw-plan');
    card.setAttribute('data-plan', id);
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!state.selected[id];
    box.addEventListener('change', function () {
      if (box.checked) state.selected[id] = true;
      else delete state.selected[id];
      card.classList.toggle('is-on', box.checked);
      recompute_(); // a tick can change another line's rules (vision on its own)
    });
    card.classList.toggle('is-on', box.checked);
    var head = node_('div', 'qw-plan-head');
    head.appendChild(box);
    head.appendChild(node_('span', 'qw-plan-name', name));
    if (label) head.appendChild(node_('span', 'qw-tier', label));
    if (carrier) head.appendChild(node_('span', 'qw-carrier', carrier));
    card.appendChild(head);
    fill(card);
    return card;
  }

  // ---------------------------------------------------------------- pricing

  function requote_() {
    var q = window.RatingEngine.quote({ groupSize: el.size.value, zip: el.zip.value, sic: el.sic.value,
      effectiveDate: el.date.value }, engineOpts_());
    state.quote = q;
    debug_('quote', { inputs: q.inputs, ok: q.ok, errors: q.errors });
    renderLines_();
    recompute_();
    if (state.census && state.census.facts) renderCensus_(); // a new company size can change which count its shares are of
  }

  // ---------------------------------------------------------------- the carriers' questions

  /** The group questions asked by an open carrier on a shown line: [{ key, carriers }], in ASKS order. */
  function groupAsks_() {
    var q = state.quote;
    var who = {};
    if (!q || !q.ok) return [];
    shownLines_().forEach(function (shape) {
      var ql = quotedLine_(shape.line);
      (ql ? ql.offerings : []).forEach(function (o) {
        if (o.unavailable) return;
        (o.asks || []).forEach(function (k) {
          if (!ASKS[k] || ASKS[k].scope !== 'group') return;
          who[k] = who[k] || [];
          if (who[k].indexOf(o.carrier) < 0) who[k].push(o.carrier);
        });
      });
    });
    return Object.keys(ASKS).filter(function (k) { return who[k]; }).map(function (k) { return { key: k, carriers: who[k] }; });
  }

  /** "About the group": rebuilt only when the set of questions changes, so typing keeps its place. */
  function renderAsks_() {
    var asks = groupAsks_();
    el.asks.hidden = !asks.length;
    var shown = asks.map(function (a) { return a.key + ':' + a.carriers.join('/'); }).join('|');
    if (shown === state.asksShown) {
      refreshNoneApply_(); // an answer given since can close the last open question
      return;
    }
    state.asksShown = shown;
    el.asksList.textContent = '';
    el.asksList.appendChild(noneApply_());
    asks.forEach(function (a) {
      el.asksList.appendChild(askControl_(a.key, '', state.answers.group, a.carriers));
    });
    refreshNoneApply_();
  }

  /** The open group yes/no questions one click can answer (ASKS `clean`), in ASKS order. */
  function openCleanAsks_() {
    return groupAsks_().map(function (a) { return a.key; }).filter(function (k) {
      return ASKS[k].kind === 'yesno' && ASKS[k].clean && !state.answers.group[k];
    });
  }

  /**
   * "None of these apply" (David 11-02): one click answers every OPEN underwriting yes/no question
   * about the group with its no-concern answer. Each stays listed and can be changed; one already
   * answered (by the agent or the census) is never touched.
   */
  function noneApply_() {
    var box = node_('div', 'qw-none-apply');
    var btn = node_('button', 'qw-btn', 'None of these apply');
    btn.type = 'button';
    btn.id = 'qw-none-apply';
    btn.addEventListener('click', function () {
      openCleanAsks_().forEach(function (k) { state.answers.group[k] = ASKS[k].clean; });
      state.asksShown = ''; // repaint the questions with their answers
      renderAsks_();
      recompute_();
    });
    box.appendChild(btn);
    el.noneApplyNote = node_('span', 'qw-hint');
    box.appendChild(el.noneApplyNote);
    el.noneApply = box;
    return box;
  }

  function refreshNoneApply_() {
    if (!el.noneApply) return;
    var open = openCleanAsks_();
    el.noneApply.hidden = !open.length;
    el.noneApplyNote.textContent = open.length
      ? ' if none is true: ' + open.map(function (k) { return ASKS[k].risk; }).join('; ') + '.' : '';
  }

  // ---------------------------------------------------------------- the census (design doc 3.5)

  /** The picked file, read here (census-reader.js). The input is cleared so the same file can be picked again after a fix. */
  function readCensus_() {
    var file = el.censusFile.files && el.censusFile.files[0];
    if (!file) return;
    el.censusFile.value = '';
    readCensusFile_(file);
  }

  /** Reads one census file (the picker above, or our own form's Census step: host.readCensus). */
  function readCensusFile_(file) {
    var asOf = (state.quote && state.quote.ok && state.quote.inputs.effectiveDate) || '';
    // The form's size: the shares are of it when the census lists only the employees enrolling (CensusReader.basis).
    var size = (state.quote && state.quote.ok && state.quote.inputs.groupSize) || 0;
    state.census = { busy: true, fileName: file.name };
    renderCensus_();
    file.arrayBuffer().then(function (buf) { return window.CensusReader.fromFile(file.name, buf); }).then(function (res) {
      if (res.error) { state.census = { error: res.error, fileName: file.name }; return; }
      var r = window.CensusReader.readSheets(res.sheets, { effectiveDate: asOf, date1904: res.date1904, eligible: size });
      state.census = r.ok ? { facts: r.facts, derived: r.derived, issues: r.issues, sheet: res.sheets.length > 1 ? r.sheet : '',
        fileName: file.name, asOf: asOf } : { error: r.error, fileName: file.name };
      if (r.ok) applyCensus_();
    }).catch(function (e) {
      state.census = { error: 'The file could not be read (' + e.message + ').', fileName: file.name };
    }).then(function () {
      state.asksShown = ''; // rebuild the questions with their census notes
      requote_();
      renderCensus_();
    });
  }

  /** True when an open carrier on the line asks this question (a carrier may assume it instead). */
  function lineAsks_(line, key) {
    var ql = quotedLine_(line);
    return !!ql && (ql.offerings || []).some(function (o) { return !o.unavailable && o.asks && o.asks.indexOf(key) >= 0; });
  }

  /** The asking carrier's enrollment-share options for a line (its askOptions), or null. */
  function shareOptions_(line) {
    var ql = quotedLine_(line);
    var o = ql && (ql.offerings || []).filter(function (x) { return !x.unavailable && x.askOptions && x.askOptions.participation; })[0];
    return o ? o.askOptions.participation : null;
  }

  /** Fills the answers the census settles; each remembers the census value, shown beside the question. */
  function applyCensus_() {
    var c = state.census;
    var f = c.facts;
    var d = c.derived;
    var filled = { group: {}, lines: {} };
    var details = {
      age65: f.age.age65 + ' of ' + f.age.known + ' with a birth date ' + (f.age.age65 === 1 ? 'is' : 'are') + ' 65 or older',
      age70: (f.age.age70 || 0) + ' of ' + f.age.known + ' with a birth date ' + (f.age.age70 === 1 ? 'is' : 'are') + ' 70 or older',
      outOfState: f.zip.outsideMI + ' of ' + f.zip.known + ' with a home ZIP live outside Michigan',
      extraterritorial: f.zip.xterr + ' of ' + f.zip.known + ' with a home ZIP live in AK, LA, MS, MT or TX'
    };
    Object.keys(d.group).forEach(function (k) {
      state.answers.group[k] = d.group[k];
      filled.group[k] = { value: d.group[k], detail: details[k] };
    });
    Object.keys(d.lines).forEach(function (line) {
      var dl = d.lines[line];
      var store = state.answers.lines[line] || (state.answers.lines[line] = {});
      var fl = filled.lines[line] = {};
      var put = function (k, v, detail) { if (v) { store[k] = v; fl[k] = { value: v, detail: detail }; } };
      var opts = shareOptions_(line);
      var enrolled = dl.enrolled + ' of ' + d.basis.eligible + ' eligible enrolling (' + dl.share + '%' +
        (dl.assumed ? ': no enrollment column, so everyone listed' : '') + ')';
      if (opts) put('participation', window.CensusReader.pickBand(opts, dl.share), enrolled);
      if (lineAsks_(line, 'enrolling')) put('enrolling', window.CensusReader.pickBand(ASKS.enrolling.options, dl.enrolled), enrolled);
      if (dl.children) put('children', dl.children, f.lines[line].children + ' children in ' + f.lines[line].families + ' families');
      if (dl.tiers) state.ownCounts[line] = countsText_(dl.tiers); // the tier headcounts, for premium totals
      // Life and disability (David 11-03): a column saying who enrolls answers the line's minimum
      // questions (minContrib / minVol), at each priced carrier's own minimum (its askMinimums). The
      // question still shows only while a design uses it; carriers that would disagree leave it asked.
      if (f.lines[line].source !== 'election') return;
      minimumFills_(line, dl, d.basis.eligible).forEach(function (m) { put(m.key, m.value, m.detail); });
    });
    state.censusFilled = filled;
  }

  /** The census's answer to each of a life or disability line's minimum questions: [{ key, value, detail }]. */
  function minimumFills_(line, dl, eligible) {
    var needs = {};
    requestedCarriers_().forEach(function (pack) {
      var mins = ((pack.lines || {})[line] || {}).askMinimums || {};
      Object.keys(mins).forEach(function (k) { if (mins[k] && mins[k].key) (needs[k] = needs[k] || []).push(mins[k]); });
    });
    var out = [];
    Object.keys(needs).forEach(function (k) {
      var votes = needs[k].map(function (n) { return window.CensusReader.meetsMinimum(dl, eligible, n); });
      if (!votes[0] || votes.some(function (v) { return v !== votes[0]; })) return;
      var one = needs[k].length === 1 ? needs[k][0] : null;
      out.push({ key: k, value: votes[0], detail: dl.enrolled + ' of ' + eligible + ' eligible enrolling (' + dl.share + '%)' +
        (votes[0] === 'yes' ? ': meets the minimum' : ': below the minimum') +
        (one ? ' of ' + one.pct + '% and at least ' + one.count : '') });
    });
    return out;
  }

  /** The census value behind an answer, or null. */
  function censusFill_(key, line) {
    var f = state.censusFilled;
    return (line ? (f.lines[line] || {})[key] : f.group[key]) || null;
  }

  function censusNote_(cf, current) {
    var label = { yes: 'Yes', no: 'No' };
    return current && current !== cf.value
      ? 'Changed from the census, which says ' + (label[cf.value] || cf.value) + ' (' + cf.detail + ').'
      : 'From your census: ' + cf.detail + '.';
  }

  /** The company size on screen now (the form's Company Size (FTE)), or 0. */
  function formSize_() {
    return (state.quote && state.quote.ok && state.quote.inputs.groupSize) || 0;
  }

  /**
   * The eligible count, when the census does not settle it (CensusReader.basis; David 11-01: "flag that
   * the FTE doesnt match. Make the agent confirm the right number"): what differs, and a button that
   * confirms the company size. Its shares were worked out with the size of the moment it was read.
   */
  function renderEligible_(box) {
    var c = state.census;
    var f = c.facts;
    var b = c.derived.basis;
    var size = formSize_();
    if (size && window.CensusReader.basis(f, size).eligible !== b.eligible) {
      box.appendChild(node_('p', 'qw-census-confirm', 'The company size changed after this census was read: choose the file again.'));
      return;
    }
    if (!b.confirm) return;
    var why = f.enrolledNone == null ? 'It shows no dental or vision enrollment, so everyone on it is taken as enrolling in those.'
      : b.over ? 'If ' + b.eligible + ' is right, some people on it are not eligible (part-time, for example), so it fills no ' +
        'share below: answer those yourself, or take those people off and choose it again.'
        : (f.enrolledNone === 0 ? 'Everyone on it is enrolling, so it may list only the employees enrolling: the ' : 'The ') +
          (b.eligible - b.listed) + ' not listed count as eligible and not enrolling.';
    var p = node_('div', 'qw-census-confirm');
    p.appendChild(node_('p', null, (b.listed !== b.eligible ? 'It lists ' + b.listed + (b.listed === 1 ? ' person' : ' people') +
      ' and the company size says ' + b.eligible + ' eligible employees. ' : 'The company size says ' + b.eligible +
      ' eligible employees. ') + why));
    if (c.confirmed === b.eligible) {
      p.appendChild(node_('p', 'qw-hint', 'Confirmed: ' + b.eligible + ' eligible employees.'));
    } else {
      var btn = node_('button', 'qw-fchip', 'Yes, ' + b.eligible + ' eligible employees is right');
      btn.type = 'button';
      btn.id = 'qw-eligible-confirm';
      btn.addEventListener('click', function () {
        c.confirmed = b.eligible;
        renderCensus_();
        recompute_();
      });
      p.appendChild(btn);
      // Not "the first page": on the Proposal form the size is on page 2 (found 11-03), and the own-form mock-up moves it.
      p.appendChild(node_('p', 'qw-hint', 'If not, correct the company size earlier in the form, then press Refresh above.'));
    }
    box.appendChild(p);
  }

  /** What still stops the submit about the eligible count (renderEligible_). [] = fine. */
  function eligibleProblems_() {
    var c = state.census;
    var size = formSize_();
    if (!c || !c.facts || !size) return [];
    var b = c.derived.basis;
    if (window.CensusReader.basis(c.facts, size).eligible !== b.eligible) {
      return ['The company size changed after the census was read: choose the census again.'];
    }
    if (!b.confirm || c.confirmed === b.eligible) return [];
    return ['Confirm the number of eligible employees in the census section (' + (b.listed !== b.eligible ? 'the census lists ' +
      b.listed + '; the company size says ' + b.eligible : 'the census shows no enrollment') + '), or correct the company size ' +
      'earlier in the form.'];
  }

  /** What the census section shows: what was read, and the rows to check (screen only). */
  function renderCensus_() {
    var c = state.census;
    var box = el.censusOut;
    box.textContent = '';
    box.hidden = !c;
    box.classList.toggle('is-error', !!(c && c.error));
    if (!c) return;
    if (c.busy) { box.appendChild(node_('p', null, 'Reading ' + c.fileName + '...')); return; }
    if (c.error) { box.appendChild(node_('p', null, c.fileName + ': ' + c.error)); return; }
    var f = c.facts;
    var parts = Object.keys(f.lines).map(function (l) {
      var dl = c.derived.lines[l]; // none when more are listed than are eligible
      return l + ' ' + f.lines[l].enrolled + ' enrolling' + (dl ? ' (' + dl.share + '%)' : '');
    });
    var head = node_('p');
    head.appendChild(node_('strong', null, c.restored ? 'Census read earlier: ' : 'Read ' + c.fileName + (c.sheet ? ', sheet ' + c.sheet : '') + ': '));
    head.appendChild(document.createTextNode(f.eligible + (f.eligible === 1 ? ' employee' : ' employees') +
      (parts.length ? '. ' + parts.join(', ') : '') + '.' + (c.asOf ? ' Ages as of ' + c.asOf + '.' : ' Ages as of today: enter the effective date and choose the file again for exact ages.')));
    box.appendChild(head);
    renderEligible_(box);
    // Counted: the questions shown whatever is ticked. A minimum question shows only while a design asks it.
    var mins = 0;
    var n = Object.keys(state.censusFilled.group).length + Object.keys(state.censusFilled.lines).reduce(function (s, l) {
      return s + Object.keys(state.censusFilled.lines[l]).filter(function (k) {
        if (ASKS[k] && ASKS[k].onDemand) { mins++; return false; }
        return true;
      }).length;
    }, 0);
    var what = [n ? n + ' answers below' : '', mins ? 'the life and disability enrollment minimums (shown when a design asks)' : '']
      .filter(Boolean).join(' and ');
    if (what) {
      box.appendChild(node_('p', 'qw-hint', what.charAt(0).toUpperCase() + what.slice(1) +
        ' are filled from it ("From your census"); change any you know better.'));
    }
    var gaps = [];
    if (f.missing.age) gaps.push(f.missing.age + ' without a readable birth date or age');
    if (f.missing.salary) gaps.push(f.missing.salary + ' without an annual salary');
    if (f.missing.gender) gaps.push(f.missing.gender + ' without a gender (sent as U, unknown)');
    if (gaps.length) box.appendChild(node_('p', 'qw-hint', 'Employees ' + gaps.join(', ') + '.'));
    if (c.issues && c.issues.length) {
      var det = node_('details', 'qw-census-rows');
      det.appendChild(node_('summary', null, 'Rows to check (' + c.issues.length + '): shown only here, never saved'));
      var ul = node_('ul');
      c.issues.slice(0, 50).forEach(function (i) {
        ul.appendChild(node_('li', null, 'Row ' + i.row + (i.name ? ', ' + i.name : '') + ': ' + i.problems.join('; ')));
      });
      det.appendChild(ul);
      box.appendChild(det);
    }
    // What it still stops (censusProblems_) shows with the other warnings, as plans are ticked.
  }

  /**
   * Plans priced from each person's census row (plan.census: employer-paid life and disability):
   * what still stops the submit. A census is needed, read, with every eligible employee's age
   * (and salary, where pay sets the benefit). [] = fine.
   */
  function censusProblems_() {
    var age = [];
    var pay = [];
    selection_().forEach(function (s) {
      s.plans.forEach(function (p) {
        if (!p.census) return;
        if (p.census.age && age.indexOf(p.name) < 0) age.push(p.name);
        if (p.census.salary && pay.indexOf(p.name) < 0) pay.push(p.name);
      });
    });
    if (!age.length && !pay.length) return [];
    var c = state.census;
    var all = age.concat(pay.filter(function (n) { return age.indexOf(n) < 0; }));
    if (!c || !c.facts) {
      return [all.join(', ') + (all.length === 1 ? ' is' : ' are') + ' priced from each employee\'s age' + (pay.length ? ' and salary' : '') +
        ': choose the census above (Excel or CSV), or untick ' + (all.length === 1 ? 'it' : 'them') + '.'];
    }
    var out = [];
    var b = c.derived.basis;
    if (b.listed !== b.eligible) { // the rows priced must be exactly the eligible employees
      out.push(all.join(', ') + (all.length === 1 ? ' is' : ' are') + ' priced from each eligible employee\'s census row, and this census ' +
        'lists ' + b.listed + ' for ' + b.eligible + ' eligible. ' + (b.over ? 'Take off those not eligible' :
        'Add the employees missing (marked waive)') + ' and choose it again, or untick ' + (all.length === 1 ? 'it.' : 'them.'));
    }
    var fix = ' Fix the census (the rows are listed above) and choose it again, or untick ';
    if (age.length && c.facts.missing.age) {
      out.push(c.facts.missing.age + ' employee' + (c.facts.missing.age === 1 ? ' has' : 's have') + ' no readable birth date or age, ' +
        'which ' + age.join(', ') + (age.length === 1 ? ' needs.' : ' need.') + fix + (age.length === 1 ? 'it.' : 'them.'));
    }
    if (pay.length && c.facts.missing.salary) {
      out.push(c.facts.missing.salary + ' employee' + (c.facts.missing.salary === 1 ? ' has' : 's have') + ' no annual salary, ' +
        'which ' + pay.join(', ') + (pay.length === 1 ? ' needs.' : ' need.') + fix + (pay.length === 1 ? 'it.' : 'them.'));
    }
    return out;
  }

  /** What the answer keeps of the census: counts, and each answer changed from it. Never a person. */
  function censusAnswer_() {
    var c = state.census;
    if (!c || !c.facts) return null;
    var f = c.facts;
    var filled = { group: {}, lines: {} };
    var changed = [];
    Object.keys(state.censusFilled.group).forEach(function (k) {
      var cf = state.censusFilled.group[k];
      filled.group[k] = cf.value;
      var v = state.answers.group[k];
      if (v && v !== cf.value) changed.push({ answer: k, census: cf.value, typed: v });
    });
    Object.keys(state.censusFilled.lines).forEach(function (line) {
      filled.lines[line] = {};
      Object.keys(state.censusFilled.lines[line]).forEach(function (k) {
        var cf = state.censusFilled.lines[line][k];
        filled.lines[line][k] = cf.value;
        var v = (state.answers.lines[line] || {})[k];
        if (v && v !== cf.value) changed.push({ line: line, answer: k, census: cf.value, typed: v });
      });
    });
    return { read: true, asOf: c.asOf || '', eligible: f.eligible, layout: f.layout, found: f.found, lines: f.lines, age: f.age,
      zip: f.zip, missing: f.missing, salaryOdd: f.salaryOdd, unknownRelationships: f.unknownRelationships,
      enrolledNone: f.enrolledNone, eligibleUsed: c.derived.basis.eligible, eligibleConfirmed: c.confirmed || null,
      filled: filled, changed: changed };
  }

  /** Puts back a census read earlier (editing a submission): its counts and what it filled; the file is not needed again. */
  function restoreCensus_(a) {
    if (!a || !a.read || typeof a.eligible !== 'number') return;
    var facts = { eligible: a.eligible, layout: a.layout, found: a.found || [], lines: a.lines || {}, age: a.age || { known: 0, age65: 0, age70: 0 },
      zip: a.zip || { known: 0, outsideMI: 0, xterr: 0 }, missing: a.missing || { age: 0, salary: 0, gender: 0 },
      salaryOdd: a.salaryOdd || 0, unknownRelationships: a.unknownRelationships || 0,
      enrolledNone: typeof a.enrolledNone === 'number' ? a.enrolledNone : null };
    state.census = { facts: facts, derived: window.CensusReader.derive(facts, a.eligibleUsed), issues: [], restored: true, asOf: a.asOf || '',
      confirmed: typeof a.eligibleConfirmed === 'number' ? a.eligibleConfirmed : null };
    var filled = { group: {}, lines: {} };
    Object.keys((a.filled || {}).group || {}).forEach(function (k) { filled.group[k] = { value: a.filled.group[k], detail: 'read earlier' }; });
    Object.keys((a.filled || {}).lines || {}).forEach(function (line) {
      filled.lines[line] = {};
      Object.keys(a.filled.lines[line]).forEach(function (k) { filled.lines[line][k] = { value: a.filled.lines[line][k], detail: 'read earlier' }; });
    });
    state.censusFilled = filled;
  }

  /**
   * One question (ASKS[key]) bound to store[key]. Yes/no or a choice = chips (one click);
   * number = a small box. An answer re-prices in place (recompute_): nothing is rebuilt under
   * the visitor's cursor. `fixed` = the answer an earlier form question already gave: shown,
   * locked, not asked. `options` = a choice's options (the asking carrier's, else ASKS').
   */
  function askControl_(key, line, store, carriers, fixed, options, wording) {
    var ask = ASKS[key];
    var box = node_('div', 'qw-ask');
    var id = 'ask-' + safeId_(line) + '-' + key;
    var label = node_(ask.kind === 'number' ? 'label' : 'span', 'qw-facet-label', wording || ask.label.replace('{line}', line));
    label.appendChild(node_('span', 'qw-ask-who', ' (' + carriers.join(', ') + ' asks)'));
    box.appendChild(label);
    box.setAttribute('data-ask', key);
    box.setAttribute('data-line', line);
    var cf = !fixed && censusFill_(key, line);
    var cnote = cf ? node_('p', 'qw-ask-hint qw-census-hint', censusNote_(cf, store[key])) : null;
    if (ask.kind === 'yesno' || ask.kind === 'choice') {
      var chips = node_('div', 'qw-fchips');
      var choices = ask.kind === 'yesno' ? [['yes', 'Yes'], ['no', 'No']]
        : (options || ask.options || []).map(function (o) { return [o, o]; });
      choices.forEach(function (c) {
        var b = node_('button', 'qw-fchip', c[1]);
        b.type = 'button';
        b.id = id + '-' + safeId_(c[0]);
        b.disabled = !!fixed;
        var paint = function () {
          var v = fixed || store[key];
          b.classList.toggle('is-on', v === c[0]);
          b.setAttribute('aria-pressed', v === c[0] ? 'true' : 'false');
        };
        paint();
        b.addEventListener('click', function () {
          store[key] = c[0];
          Array.prototype.forEach.call(chips.children, function (x) {
            var on = x === b;
            x.classList.toggle('is-on', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          if (cnote) cnote.textContent = censusNote_(cf, store[key]);
          recompute_();
        });
        chips.appendChild(b);
      });
      box.appendChild(chips);
      if (fixed) box.appendChild(fromAbove_(state.fieldIds.quoteType)); // a line's answer from the form = in force, from the quote type
      if (cnote) box.appendChild(cnote);
    } else {
      var input = node_('input', 'qw-ask-num');
      input.id = id;
      input.inputMode = 'numeric';
      input.autocomplete = 'off';
      input.value = store[key] == null ? '' : String(store[key]);
      label.htmlFor = id;
      input.addEventListener('input', function () {
        store[key] = input.value.trim();
        recompute_();
      });
      box.appendChild(input);
      if (ask.hint) box.appendChild(node_('p', 'qw-ask-hint', ask.hint));
    }
    return box;
  }

  /** Totals for every shown line, written into the sections in place (keeps focus). */
  /** True when the group is above the widget's size limit: a custom RFP, not a quote here. */
  function customRfp_() {
    var q = state.quote;
    return !!(state.maxGroupSize && q && q.ok && q.inputs.groupSize > state.maxGroupSize);
  }

  /** True when the group is below the widget's minimum: no ancillary quote, nothing asked. */
  function declined_() {
    var q = state.quote;
    return !!(state.minGroupSize && q && q.ok && q.inputs.groupSize < state.minGroupSize);
  }

  /**
   * "Coverage the group has today", in both modes (the form's "Type of Ancillary Quote"): one
   * question first, "any of this coverage today?"; a no is one click for every line (most small
   * groups), a yes asks Yes / No per requested line (a carrier's rules are per line). Rebuilt only
   * when what it shows changes, so a click keeps its place.
   */
  function renderToday_() {
    var lines = state.quote && state.quote.ok ? todayLines_() : [];
    var custom = customRfp_();
    var any = anyToday_();
    var shown = (custom ? 'c' : 'q') + '|' + any + '|' + lines.map(function (l) { return l + ':' + inForceOf_(l); }).join('|');
    el.today.hidden = !lines.length;
    if (shown === state.todayShown) return;
    state.todayShown = shown;
    el.todayList.textContent = '';
    el.todayNote.textContent = custom
      ? 'Coverage the group has today is quoted from the plans, rates and renewal you upload with this form; ' +
        'the rest gets options to build below.'
      : 'The carriers\' rules differ for coverage the group already has.';
    var fixedAny = formAny_();
    var top = node_('div', 'qw-ask qw-today-any');
    top.classList.toggle('is-needed', !any);
    top.appendChild(node_('span', 'qw-facet-label', 'Does the group have any of this coverage today? (' + lines.join(', ') + ')'));
    top.appendChild(choiceChips_('today-any', [['yes', 'Yes'], ['no', 'No']], any, !!fixedAny,
      function (v) { state.anyToday = v; }));
    if (fixedAny) top.appendChild(fromAbove_(state.fieldIds.quoteType));
    el.todayList.appendChild(top);
    if (any !== 'yes') return;
    el.todayList.appendChild(node_('p', 'qw-ask-hint qw-today-which', 'Which of them?'));
    lines.forEach(function (line) {
      var fixed = (state.formAnswers.lines[line] || {}).inForce || '';
      var row = node_('div', 'qw-ask');
      row.classList.toggle('is-needed', !inForceOf_(line));
      row.appendChild(node_('span', 'qw-facet-label', line));
      row.appendChild(choiceChips_('today-' + safeId_(line), [['yes', 'Yes'], ['no', 'No']], inForceOf_(line), !!fixed,
        function (v) { (state.answers.lines[line] = state.answers.lines[line] || {}).inForce = v; }));
      if (fixed) row.appendChild(fromAbove_(state.fieldIds.quoteType));
      el.todayList.appendChild(row);
    });
  }

  /**
   * The custom RFP's lines: the requested ones that have a builder (all of them when no coverage
   * is known; none when only other coverage, e.g. Accident, was requested).
   */
  function rfpLines_() {
    var lines = window.RFP_OPTIONS ? Object.keys(window.RFP_OPTIONS.lines) : [];
    if (!Object.keys(state.shown).length) return lines;
    return lines.filter(function (l) { return state.shown[l]; });
  }

  /**
   * Above the limit, the custom RFP replaces the whole quoting area: the carriers to ask, then per
   * requested line who pays and, for a line the group does not have today, "Build your own": up to
   * MAX_OPTIONS options (David 10-30), each built from rfp-options.js, so every option is one of
   * HubSpot's values. A line the group has today is quoted from the form's uploads.
   */
  function renderMode_() {
    var custom = customRfp_();
    var declined = declined_();
    el.main.hidden = custom || declined;
    el.custom.hidden = !custom && !declined;
    if (declined) {
      el.custom.textContent = '';
      el.custom.appendChild(node_('strong', null, 'Ancillary coverage is not quoted for this group'));
      el.custom.appendChild(node_('p', null, 'Link quotes ancillary coverage for groups of ' + state.minGroupSize +
        ' or more employees; this group has ' + state.quote.inputs.groupSize + '. Nothing more is needed here, and the ' +
        'rest of the form goes on as usual.'));
      return;
    }
    if (!custom) return;
    el.custom.textContent = '';
    el.custom.appendChild(node_('strong', null, 'A custom RFP for ' + state.quote.inputs.groupSize + ' employees'));
    el.custom.appendChild(node_('p', null, 'Groups over ' + state.maxGroupSize + ' employees are quoted by the carriers ' +
      'you ask.'));
    var pick = rfpCarriers_();
    if (pick) el.custom.appendChild(pick);
    var today = todayLines_().filter(function (line) { return inForceOf_(line) === 'yes'; });
    if (today.length) {
      el.custom.appendChild(node_('p', null, 'Coverage today (' + today.join(', ') + '): upload its plan summaries, current ' +
        'rates and latest renewal with this form, and describe any changes you want in the notes.'));
    }
    if (window.RFP_OPTIONS) {
      el.custom.appendChild(node_('p', 'qw-rfp-head', 'Who pays, and for coverage the group does not have today the plans ' +
        'to quote: up to ' + window.RFP_OPTIONS.MAX_OPTIONS + ' options per coverage.'));
      rfpLines_().forEach(function (line) { el.custom.appendChild(rfpLine_(line, inForceOf_(line) === 'no')); });
    }
    el.customErrors = node_('div', 'qw-errors');
    el.customErrors.setAttribute('role', 'alert');
    el.customErrors.hidden = true;
    el.custom.appendChild(el.customErrors);
  }

  /**
   * "Carriers to ask": HubSpot's `ancillary_carriers` values from the setting carrierOptions (the
   * form's carrier question moved here, David 10-31). The form's answer, while it asks, is shown
   * locked. null when there is nothing to offer.
   */
  function rfpCarriers_() {
    var fixed = state.formAnswers.carriers;
    var opts = fixed.length ? fixed : state.carrierOptions;
    if (!opts.length) return null;
    var box = node_('div', 'qw-ask');
    box.classList.toggle('is-needed', !carriers_().length);
    box.appendChild(node_('span', 'qw-facet-label', 'Carriers to ask for quotes (pick any)'));
    var chips = node_('div', 'qw-fchips');
    opts.forEach(function (c) {
      var b = node_('button', 'qw-fchip', c);
      b.type = 'button';
      b.id = 'rfp-carrier-' + safeId_(c);
      b.disabled = !!fixed.length;
      var paint = function () {
        var on = !!fixed.length || !!state.carriers[c];
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      };
      paint();
      b.addEventListener('click', function () {
        if (state.carriers[c]) delete state.carriers[c]; else state.carriers[c] = true;
        paint();
        box.classList.toggle('is-needed', !carriers_().length);
        emit_();
      });
      chips.appendChild(b);
    });
    box.appendChild(chips);
    box.appendChild(fixed.length ? fromAbove_(state.fieldIds.carriers) : node_('p', 'qw-ask-hint', 'Every carrier picked gets the same request.'));
    return box;
  }

  /** The requested coverages whose "Who pays?" is still blank (the form required it: q265 / q267). */
  function rfpUnpaid_() {
    return rfpLines_().filter(function (line) { return fundingSpec_(line) && !fundingOf_(line); });
  }

  /** One coverage of the custom RFP: who pays, then (`build`) its built options and "Add an option". */
  function rfpLine_(line, build) {
    var R = window.RFP_OPTIONS;
    var spec = R.lines[line];
    var b = state.rfpBuilt[line] || (state.rfpBuilt[line] = { options: [] });
    var sec = node_('div', 'qw-rfp-line');
    sec.id = 'rfp-' + safeId_(line);
    sec.appendChild(node_('h4', 'qw-h', line));
    if (fundingSpec_(line)) sec.appendChild(rfpFunding_(line));
    if (!build) {
      sec.appendChild(node_('p', 'qw-hint', inForceOf_(line) === 'yes' ? 'The group has it today: quoted from the uploads.'
        : 'Answer "coverage today" above: a coverage the group does not have gets options to build.'));
      return sec;
    }
    b.options.forEach(function (d, i) { sec.appendChild(rfpOption_(line, i)); });
    if (!b.options.length) sec.appendChild(node_('p', 'qw-hint', 'No options yet: add at least one for the carriers to quote.'));
    var full = b.options.length >= R.MAX_OPTIONS;
    var add = node_('button', 'qw-btn qw-rfp-add', full ? R.MAX_OPTIONS + ' options, the most per coverage'
      : b.options.length ? 'Add another option' : 'Add an option');
    add.type = 'button';
    add.id = 'rfp-add-' + safeId_(line);
    add.disabled = full;
    add.addEventListener('click', function () {
      // A new option starts as a copy of the last one, so the agent changes only what differs.
      b.options.push(R.fit(line, b.options[b.options.length - 1]));
      redrawRfpLine_(line, 'rfp-' + safeId_(line) + '-' + (b.options.length - 1) + '-' + spec.fields[0].key);
      emit_();
    });
    sec.appendChild(add);
    return sec;
  }

  /**
   * Who pays: HubSpot's funding values as chips; clicking the chosen one again lets it go. The
   * form's own answer, while the form still asks it, is shown locked.
   */
  function rfpFunding_(line) {
    var fixed = formFunding_(line);
    var box = node_('div', 'qw-ask');
    box.classList.toggle('is-needed', !fundingOf_(line));
    box.appendChild(node_('span', 'qw-facet-label', 'Who pays?'));
    var chips = node_('div', 'qw-fchips');
    fundingSpec_(line).options.forEach(function (o) {
      var c = node_('button', 'qw-fchip', o);
      c.type = 'button';
      c.disabled = !!fixed;
      c.addEventListener('click', function () {
        if (state.funding[line] === o) delete state.funding[line]; else state.funding[line] = o;
        box.classList.toggle('is-needed', !fundingOf_(line));
        Array.prototype.forEach.call(chips.children, function (x) {
          var on = state.funding[line] === x.textContent;
          x.classList.toggle('is-on', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        emit_();
      });
      var on = fundingOf_(line) === o;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      chips.appendChild(c);
    });
    box.appendChild(chips);
    if (fixed) box.appendChild(fromAbove_(state.fieldIds.funding[line]));
    return box;
  }

  /** One built option: a menu per part (each offering only what the earlier parts allow), its name, Remove. */
  function rfpOption_(line, i) {
    var R = window.RFP_OPTIONS;
    var b = state.rfpBuilt[line];
    var d = b.options[i];
    var card = node_('div', 'qw-rfp-option');
    var head = node_('div', 'qw-rfp-option-head');
    head.appendChild(node_('strong', null, 'Option ' + (i + 1)));
    var rm = node_('button', 'qw-linkbtn', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove ' + line + ' option ' + (i + 1));
    rm.addEventListener('click', function () {
      b.options.splice(i, 1);
      redrawRfpLine_(line, 'rfp-add-' + safeId_(line));
      emit_();
    });
    head.appendChild(rm);
    card.appendChild(head);
    var grid = node_('div', 'qw-designer-grid');
    R.fieldsOf(line, d).forEach(function (f) {
      var item = node_('label', 'qw-view-item');
      item.appendChild(node_('span', null, f.label));
      var select = document.createElement('select');
      select.id = 'rfp-' + safeId_(line) + '-' + i + '-' + f.key;
      f.options.forEach(function (v) {
        var opt = node_('option', null, v);
        opt.value = v;
        select.appendChild(opt);
      });
      select.value = d[f.key];
      select.disabled = f.options.length < 2;
      select.addEventListener('change', function () {
        var next = Object.assign({}, d);
        next[f.key] = select.value;
        b.options[i] = R.fit(line, next); // a later part the new choice rules out moves to its first allowed value
        redrawRfpLine_(line, select.id);
        emit_();
      });
      item.appendChild(select);
      grid.appendChild(item);
    });
    card.appendChild(grid);
    var same = -1;
    b.options.slice(0, i).forEach(function (o, j) { if (same < 0 && JSON.stringify(o) === JSON.stringify(d)) same = j; });
    card.appendChild(node_('p', 'qw-hint', same >= 0 ? 'Same as option ' + (same + 1) + ': change a part, or remove it.'
      : R.lines[line].name(d)));
    return card;
  }

  /** Redraws one coverage of the custom RFP in place and puts the focus back. */
  function redrawRfpLine_(line, focusId) {
    var old = document.getElementById('rfp-' + safeId_(line));
    if (old) old.parentNode.replaceChild(rfpLine_(line, true), old); // only the builder redraws
    if (focusId) refocus_(focusId);
  }

  /**
   * What the custom RFP stores (rfp-options.js answer()): the quote type and carriers, then per
   * requested line who pays and, for a line the group does not have today, the built options.
   */
  function rfpAnswer_() {
    if (!window.RFP_OPTIONS) return { fields: {}, lines: [] };
    var built = {};
    rfpLines_().forEach(function (line) {
      var b = state.rfpBuilt[line];
      built[line] = { options: inForceOf_(line) === 'no' && b ? b.options : [], funding: fundingOf_(line) };
    });
    return window.RFP_OPTIONS.answer(built, groupFields_());
  }

  function recompute_() {
    var q = state.quote;
    if (!q) return;
    renderMode_();
    renderToday_();
    renderAsks_(); // the shown lines decide which group questions are asked
    state.totals = {};
    var warnings = [];
    // Ticked (line, carrier) pairs: a carrier's "not on its own" rule counts its OTHER lines.
    var chosen = [];
    selection_().forEach(function (s) {
      s.plans.forEach(function (p) {
        if (p.carrier && !chosen.some(function (c) { return c.line === s.line && c.carrier === p.carrier; })) {
          chosen.push({ line: s.line, carrier: p.carrier });
        }
      });
    });
    shownLines_().forEach(function (shape) {
      var ql = quotedLine_(shape.line);
      if (!ql) return;
      var input = ql.method === 'tier'
        ? { counts: usesOwnCounts_(ql.line) ? state.ownCounts[ql.line] : state.counts }
        : { volume: state.volumes[ql.line] };
      var t = window.RatingEngine.lineTotals(ql, input, { groupSize: q.inputs.groupSize, chosen: chosen,
        inputs: q.inputs, contribution: contributionOf_(ql.line) || 'er', ticked: state.selected,
        answers: { group: state.answers.group, line: lineAnswers_(ql.line) } });
      state.totals[ql.line] = t;
      var refs = lineRefs[ql.line];
      // A question asked on demand (a design's enrollment minimum) comes and goes with the ticks.
      if (refs && refs.asksBox && onDemandKeys_(ql).join() !== refs.asksSig) buildLineAsks_(ql, refs.asksBox);
      if (!refs || !refs.msg) return;
      // A carrier's rule warnings sit on its plans; the line repeats them once a plan of
      // that carrier is ticked.
      var tickedCarriers = {};
      ql.plans.forEach(function (p) { if (state.selected[p.id]) tickedCarriers[p.carrier] = true; });
      var carrierMsgs = [];
      Object.keys(t.carrierWarnings || {}).forEach(function (c) {
        if (tickedCarriers[c]) carrierMsgs = carrierMsgs.concat(t.carrierWarnings[c]);
      });
      Object.keys(t.carrierMissing || {}).forEach(function (c) {
        if (tickedCarriers[c]) carrierMsgs.push(c + ' still needs: ' + missingText_(t.carrierMissing[c], ql.line) + '.');
      });
      var info = Object.keys(t.carrierNotes || {}).map(function (c) { return c + ': ' + t.carrierNotes[c]; });
      showMessages_(refs.msg, t.errors.concat(t.warnings, carrierMsgs, info));
      refs.msg.classList.toggle('is-error', t.errors.length > 0);
      if (refs.band) {
        var many = (ql.offerings || []).filter(function (o) { return o.bands; }).length > 1;
        var parts = Object.keys(t.bands || {}).map(function (c) {
          return (many ? c + ': rates' : 'Rates') + ' for ' + t.bands[c].band + ' enrolled';
        });
        var byEmployees = Object.keys(t.bands || {}).some(function (c) { return t.bands[c].basis === 'employees'; });
        refs.band.textContent = parts.length
          ? parts.join('; ') + (byEmployees ? ' (by the employee count until a headcount is entered).' : '.') : '';
      }
      Object.keys(refs.rates).forEach(function (planId) {
        var rates = t.planRates[planId];
        TIERS.forEach(function (tier) {
          refs.rates[planId][tier.key].textContent = rates ? money.format(rates[tier.key]) : '-';
        });
        var note = refs.notes[planId];
        note.textContent = t.planNotes[planId] || '';
        note.hidden = !t.planNotes[planId];
      });
      Object.keys(refs.notes).forEach(function (planId) {
        if (refs.rates[planId]) return; // tier cards: done above
        var n = refs.notes[planId];
        n.textContent = t.planNotes[planId] || '';
        n.hidden = !t.planNotes[planId];
      });
      Object.keys(refs.totals).forEach(function (planId) {
        var r = refs.totals[planId];
        var pt = t.ok ? t.plans.filter(function (p) { return p.id === planId; })[0] : null;
        r.box.hidden = !pt;
        if (pt) {
          r.amt.textContent = money.format(pt.monthly) + ' a month';
          r.annual.textContent = money.format(pt.annual) + ' a year';
        }
      });
      applyView_(ql.line); // a price sort follows the new totals
    });

    // A carrier's rules across its ticked lines (pack.checkSelection): shown, and they stop the submit.
    state.packProblems = packProblems_();
    warnings = warnings.concat(state.packProblems, eligibleProblems_(), censusProblems_());
    el.census.hidden = !q.ok || customRfp_() || declined_(); // first on the page now, outside the quote part

    // "(needed)" on exactly the questions some carrier still needs ('<line>|<key>'; group = '|<key>').
    var needed = {};
    Object.keys(state.totals).forEach(function (line) {
      var tm = state.totals[line].carrierMissing || {};
      Object.keys(tm).forEach(function (c) {
        tm[c].forEach(function (k) { needed[(ASKS[k] && ASKS[k].scope === 'line' ? line : '') + '|' + k] = true; });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.qw-ask[data-ask]'), function (box) {
      box.classList.toggle('is-needed', !!needed[box.getAttribute('data-line') + '|' + box.getAttribute('data-ask')]);
    });

    // Group-level messages. Nothing entered yet is not an error: the note says what to do.
    var untouched = !el.size.value.trim() && !el.zip.value.trim() && !el.sic.value.trim();
    showMessages_(el.errors, q.ok || untouched ? [] : q.errors);
    showMessages_(el.warn, warnings);

    // The shared headcount shows while a ticked tier line uses it.
    var sharing = shownLines_().filter(function (l) { return l.method === 'tier' && !usesOwnCounts_(l.line); });
    el.shared.hidden = !q.ok || !sharing.length;
    var qlOf = function (l) { return quotedLine_(l.line) || {}; };
    var totalled = sharing.filter(function (l) { return !qlOf(l).later && !qlOf(l).unavailable; });
    var priceLater = sharing.filter(function (l) { return qlOf(l).later; });
    var names = function (ls) { return ls.map(function (l) { return l.line; }).join(', '); };
    el.sharedNote.textContent = totalled.length ? 'Optional: only for a premium total on ' + names(totalled) +
        '. The enrollment answers in each line are enough to price, and the census confirms them after the form is sent.'
      : priceLater.length ? 'Optional: ' + names(priceLater) + ' are priced after the form is sent, from the census. ' +
        'A headcount here replaces the enrollment assumed until then.' : '';
    var shared = window.RatingEngine.lineTotals({ method: 'tier', plans: [] }, { counts: state.counts });
    el.enrolled.textContent = shared.enrolled
      ? shared.enrolled + (shared.enrolled === 1 ? ' employee' : ' employees') + ' enrolling.'
      : totalled.length ? 'Add how many employees are enrolling in each tier to see total premiums.' : 'No headcount entered.';

    renderBanners_();
    renderFoot_();
    emit_();
  }

  /** Says which shown lines show a carrier's rates (a design priced after the form is sent shows none). */
  function renderBanners_() {
    if (customRfp_() || declined_()) { // no rates shown, so no rate banner
      el.real.hidden = true;
      return;
    }
    var realLines = [];
    shownLines_().forEach(function (shape) {
      var ql = quotedLine_(shape.line);
      var real = (ql ? ql.offerings : []).filter(function (o) { return !o.later && !o.unavailable; })
        .map(function (o) { return o.carrier; });
      if (real.length) realLines.push(shape.line + ' (' + real.join(', ') + ')');
    });
    el.real.hidden = !realLines.length;
    // Each carrier's own source line (old test rates, or current) sits on its line section.
    el.real.textContent = 'Carrier rates on: ' + realLines.join(', ') +
      '. For testing only. Confidential: for agent use, do not distribute.';
  }

  /** Selected plans per shown line: [{ line, quoted, plans: [plan] }]. */
  function selection_() {
    var out = [];
    shownLines_().forEach(function (shape) {
      var ql = quotedLine_(shape.line);
      if (!ql) return;
      var plans = ql.method === 'request'
        ? (state.selected[IDI_REQUEST] ? [{ id: IDI_REQUEST, name: 'Quote requested' }] : [])
        : ql.plans.filter(function (p) { return state.selected[p.id]; });
      if (plans.length) out.push({ line: ql.line, quoted: ql, plans: plans });
    });
    return out;
  }

  /**
   * The tier rates a plan is priced at now (a carrier's band follows the enrolled count).
   * null when its carrier cannot price this headcount (beyond its table).
   */
  function ratesUsed_(line, plan) {
    var t = state.totals[line];
    if (t && t.planRates && Object.prototype.hasOwnProperty.call(t.planRates, plan.id)) return t.planRates[plan.id];
    return plan.rates || null;
  }

  function planTotal_(line, planId) {
    var t = state.totals[line];
    if (!t || !t.ok) return null;
    return t.plans.filter(function (p) { return p.id === planId; })[0] || null;
  }

  /** The package total: only with exactly one priced plan per ticked line. */
  function package_(sel) {
    var priced = sel.filter(function (s) { return s.quoted.method !== 'request' && !s.quoted.later; });
    if (!priced.length) return { total: null, why: '' };
    if (priced.some(function (s) { return s.plans.length > 1; })) {
      return { total: null, why: 'Pick one plan per line to see a package total.' };
    }
    var monthly = 0;
    for (var i = 0; i < priced.length; i++) {
      var pt = planTotal_(priced[i].line, priced[i].plans[0].id);
      if (!pt) return { total: null, why: 'Add the headcount or volume for every ticked plan to see a package total.' };
      monthly += pt.monthly;
    }
    monthly = Math.round(monthly * 100) / 100;
    return { total: { monthly: monthly, annual: Math.round(monthly * 12 * 100) / 100 }, why: '' };
  }

  function renderFoot_() {
    var sel = selection_();
    var plans = sel.reduce(function (n, s) { return n + s.plans.length; }, 0);
    if (!state.quote || !state.quote.ok) {
      el.foot.textContent = '';
      el.package.hidden = true;
      return;
    }
    el.foot.textContent = !shownLines_().length ? 'Tick the coverage you want priced.'
      : plans === 0 ? 'Tick the plans you would like quoted. Rates are monthly.'
        : plans + (plans === 1 ? ' plan' : ' plans') + ' ticked across ' + sel.length +
          (sel.length === 1 ? ' line.' : ' lines.') + ' Rates are monthly.';
    var pk = package_(sel);
    el.package.hidden = !pk.total && !pk.why;
    el.package.textContent = '';
    if (pk.total) {
      el.package.appendChild(node_('span', 'qw-total-label', 'Package total'));
      el.package.appendChild(node_('strong', 'qw-total-amt', money.format(pk.total.monthly) + ' a month'));
      el.package.appendChild(node_('span', 'qw-total-annual', money.format(pk.total.annual) + ' a year'));
    } else if (pk.why) {
      el.package.appendChild(node_('span', 'qw-total-label', pk.why));
    }
  }

  // ---------------------------------------------------------------- the form's copy

  function missingText_(keys, line) {
    return keys.map(function (k) { return askShort_(k, line); }).join(', ');
  }

  /** Each carrier's rules across ALL its ticked lines (e.g. how many new voluntary coverages). */
  function packProblems_() {
    var out = [];
    requestedCarriers_().forEach(function (pack) {
      if (!pack.checkSelection) return;
      var lines = [];
      selection_().forEach(function (s) {
        var mine = s.plans.filter(function (p) { return p.carrier === pack.carrier; });
        if (mine.length) lines.push({ line: s.line, answers: lineAnswers_(s.line), designs: mine.map(function (p) { return p.design || null; }) });
      });
      (pack.checkSelection(lines) || []).forEach(function (m) { out.push(pack.carrier + ': ' + m); });
    });
    return out;
  }

  /** What a ticked plan's carrier still needs, per line: ['<carrier> (Dental): cannabis, ...']. */
  function missingForTicked_() {
    var out = [];
    selection_().forEach(function (s) {
      var t = state.totals[s.line] || {};
      Object.keys(t.carrierMissing || {}).forEach(function (c) {
        if (!s.plans.some(function (p) { return p.carrier === c; })) return;
        out.push(c + ' (' + s.line + '): ' + missingText_(t.carrierMissing[c], s.line));
      });
    });
    return out;
  }

  /** The answers to show and store: only the questions some carrier on a ticked line asks. */
  function askedAnswers_(keys, store) {
    var out = {};
    keys.forEach(function (k) {
      var v = store[k];
      if (v != null && String(v).trim() !== '') out[k] = String(v).trim();
    });
    return out;
  }

  function lineAskKeys_(ql) {
    var keys = [];
    (ql.offerings || []).forEach(function (o) {
      (o.asks || []).forEach(function (k) {
        if (k !== 'contribution' && ASKS[k] && ASKS[k].scope === 'line' && keys.indexOf(k) < 0) keys.push(k);
      });
    });
    onDemandKeys_(ql).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); // asked while a ticked plan uses it
    return keys;
  }

  /** The carriers behind a line's ticked plans: [{ carrier, source, band? }]. */
  function tickedCarriers_(s) {
    var t = state.totals[s.line] || {};
    var out = [];
    (s.quoted.offerings || []).forEach(function (o) {
      if (!s.plans.some(function (p) { return p.carrier === o.carrier; })) return;
      var c = { carrier: o.carrier, source: o.source };
      if (t.bands && t.bands[o.carrier]) c.band = t.bands[o.carrier].band;
      out.push(c);
    });
    return out;
  }

  /**
   * The widget's answer (v5: v4 + "coverage today" and the quote type and carriers in `fields`).
   * Empty (= not answered) with nothing to store, or a bad entry on a ticked line.
   */
  function answerJson_() {
    var q = state.quote;
    if (declined_()) {
      // Below minGroupSize: no carrier is asked, so no HubSpot field is written (the relay decides
      // what the deal records; design doc section 5).
      return JSON.stringify({ v: 5, mode: 'declined', engine: q.engine, inputs: q.inputs, inputsFrom: state.inputsFrom,
        minGroupSize: state.minGroupSize, fields: {}, fieldLines: [], quotedAt: new Date().toISOString() });
    }
    if (customRfp_()) {
      // No plans: the request goes to the carriers as a custom RFP (the form's uploads, or the options built here).
      var rfp = rfpAnswer_();
      var built = {}; // the built options as designs, to put back when the submission is edited
      rfpLines_().forEach(function (line) {
        if (inForceOf_(line) === 'no' && state.rfpBuilt[line] && state.rfpBuilt[line].options.length) {
          built[line] = state.rfpBuilt[line].options;
        }
      });
      return JSON.stringify({ v: 5, mode: 'custom', engine: q.engine, inputs: q.inputs, inputsFrom: state.inputsFrom,
        maxGroupSize: state.maxGroupSize, todayAny: anyToday_(), today: todayAnswers_(), fields: rfp.fields,
        fieldLines: rfp.lines, built: built,
        quotedAt: new Date().toISOString() });
    }
    var sel = selection_();
    if (!q || !q.ok) return '';
    if (sel.some(function (s) { return state.totals[s.line] && state.totals[s.line].errors.length; })) return '';
    var hs = quoteFields_(sel);
    if (!sel.length && !Object.keys(hs.fields).length) return '';
    var pk = package_(sel);
    var groupAnswers = askedAnswers_(groupAsks_().map(function (a) { return a.key; }), state.answers.group);
    return JSON.stringify({
      v: 5,
      engine: q.engine,
      inputs: q.inputs,
      inputsFrom: state.inputsFrom,
      agent: state.agent || null, // { name, agency } from the form's first page, for the quote builder (David 11-01)
      answers: { group: groupAnswers },
      todayAny: anyToday_(), // "any of this coverage today?": 'yes' | 'no' | '' (not answered)
      today: todayAnswers_(), // coverage today per requested line: 'yes' | 'no' | '' (not answered)
      census: censusAnswer_(), // the census read in the browser: counts and changed answers only (design doc 3.5)
      fields: hs.fields, // HubSpot property -> value (design doc 3.2): quote type, carriers, each ticked line's funding
      fieldLines: hs.lines,
      lines: sel.map(function (s) {
        var ql = s.quoted;
        var t = state.totals[s.line] || {};
        var out = { line: s.line, method: ql.method, carriers: tickedCarriers_(s) };
        if (lineFunding_(s)) out.funding = lineFunding_(s);
        if ((ql.offerings || []).some(function (o) { return o.asks && o.asks.indexOf('contribution') >= 0; })) {
          out.contribution = lineAnswers_(s.line).contribution || null; // null = not answered
        }
        var lineAnswers = askedAnswers_(lineAskKeys_(ql), lineAnswers_(s.line));
        if (Object.keys(lineAnswers).length) out.answers = lineAnswers;
        // The answers a ticked carrier still needs (the form will not submit while any remain).
        Object.keys(t.carrierMissing || {}).forEach(function (c) {
          if (!s.plans.some(function (p) { return p.carrier === c; })) return;
          (out.missing = out.missing || {})[c] = t.carrierMissing[c].slice();
        });
        if (state.prebuilt[s.line]) out.prebuilt = state.prebuilt[s.line]; // the pre-built plans' settings, to put back
        if (ql.method === 'tier') {
          out.counts = t.counts || null;
          out.enrolled = t.enrolled || 0;
          out.ownHeadcount = usesOwnCounts_(s.line);
        }
        if (ql.method === 'volume') {
          out.volume = t.volume == null ? null : t.volume;
          out.unit = ql.unit;
          out.basis = ql.basis;
        }
        out.plans = s.plans.map(function (p) {
          var pt = planTotal_(s.line, p.id);
          var plan = { id: p.id, name: p.name };
          if (p.design) plan.design = p.design; // the plan as the carrier's tool defines it
          if (p.custom) plan.custom = true;
          if (p.carrier) plan.carrier = p.carrier;
          if (ql.method === 'tier') plan.rates = ratesUsed_(s.line, p);
          if (p.rate != null) plan.rate = p.rate;
          if (p.later) plan.later = p.later;
          if (ql.method !== 'request') {
            plan.monthly = pt ? pt.monthly : null;
            plan.annual = pt ? pt.annual : null;
          }
          return plan;
        });
        return out;
      }),
      packageMonthly: pk.total ? pk.total.monthly : null,
      packageAnnual: pk.total ? pk.total.annual : null,
      quotedAt: new Date().toISOString()
    });
  }

  /** HubSpot's fields: the quote type, the carriers and each ticked line's funding, as rfp-options.js answer() writes them (design doc 3.2). */
  function quoteFields_(sel) {
    var built = {};
    sel.forEach(function (s) {
      if (lineFunding_(s)) built[s.line] = { options: [], funding: lineFunding_(s) };
    });
    return window.RFP_OPTIONS ? window.RFP_OPTIONS.answer(built, groupFields_()) : { fields: {}, lines: [] };
  }

  /** The requested lines that have something to tick (a plan, or a quote request). */
  function tickable_() {
    return shownLines_().filter(function (shape) {
      var ql = quotedLine_(shape.line);
      return ql && !ql.unavailable && (ql.method === 'request' || ql.plans.length);
    }).map(function (shape) { return shape.line; });
  }

  function summaryText_() {
    var q = state.quote;
    if (declined_()) {
      return 'ANCILLARY NOT QUOTED: ' + q.inputs.groupSize + ' employees (Link quotes ' + state.minGroupSize + ' or more).';
    }
    var today = todayAnswers_();
    var todayText = anyToday_() === 'no' && Object.keys(today).length ? 'none'
      : Object.keys(today).map(function (l) { return l + ' ' + (today[l] || 'not answered'); }).join('; ');
    if (customRfp_()) {
      var picked = rfpAnswer_().lines;
      var has = Object.keys(today).filter(function (l) { return today[l] === 'yes'; });
      return ['CUSTOM RFP: ' + q.inputs.groupSize + ' employees (over ' + state.maxGroupSize + ').' +
        (has.length ? ' Coverage today (' + has.join(', ') + '): quoted from the uploaded plans, rates and renewal.' : '')]
        .concat(todayText ? ['Coverage today: ' + todayText] : [], picked).join('\n');
    }
    if (!answerJson_()) return '';
    var lines = [];
    if (todayText) lines.push('Coverage today: ' + todayText);
    var group = window.RFP_OPTIONS ? window.RFP_OPTIONS.answer({}, groupFields_()).lines : [];
    lines = lines.concat(group);
    var sel = selection_();
    if (q.inputs.effectiveDate) lines.push('Effective date: ' + q.inputs.effectiveDate);
    var answersText = function (answers, line) {
      return Object.keys(answers).map(function (k) { return askShort_(k, line) + ': ' + answers[k]; }).join('; ');
    };
    var ga = askedAnswers_(groupAsks_().map(function (a) { return a.key; }), state.answers.group);
    if (Object.keys(ga).length) lines.push('About the group: ' + answersText(ga));
    var ca = censusAnswer_();
    if (ca) {
      lines.push('Census (read in the browser): ' + ca.eligible + ' employees' +
        (ca.eligibleUsed !== ca.eligible || ca.enrolledNone == null ? ' (' + (ca.enrolledNone == null ? 'no enrollment column; ' : '') +
          ca.eligibleUsed + ' eligible' + (ca.eligibleConfirmed === ca.eligibleUsed ? ', confirmed by the agent' : ', NOT confirmed') + ')' : '') +
        Object.keys(ca.lines).map(function (l) {
        return '; ' + l + ' ' + ca.lines[l].enrolled + ' enrolling';
      }).join('') + (ca.missing.age || ca.missing.salary ? '; missing ' + [ca.missing.age ? ca.missing.age + ' birth dates' : '',
        ca.missing.salary ? ca.missing.salary + ' salaries' : ''].filter(Boolean).join(', ') : ''));
      ca.changed.forEach(function (x) {
        lines.push('  Changed from the census: ' + askShort_(x.answer, x.line || '') + ': census ' + x.census + ', agent ' + x.typed);
      });
    }
    var still = missingForTicked_();
    if (still.length) lines.push('NOT ANSWERED YET: ' + still.join('. '));
    sel.forEach(function (s) {
      var ql = s.quoted;
      var t = state.totals[s.line] || {};
      if (ql.method === 'request') {
        lines.push(s.line + ': quote requested');
        return;
      }
      var asked = (ql.offerings || []).some(function (o) { return o.asks && o.asks.indexOf('contribution') >= 0; });
      var funding = lineFunding_(s);
      var c = lineAnswers_(s.line).contribution;
      var pays = funding ? '. Who pays: ' + funding + (asked && c && !window.FieldValues.contributionFromFunding(funding)
        ? (c === 'er' ? ' (exactly 50%)' : ' (less than 50%)') : '')
        : fundingSpec_(s.line) && !designFunded_(ql) ? '. Who pays: not answered'
        : asked ? '. ' + ({ vol: 'Voluntary (employer pays less than 50%)', er: 'Employer pays 50% or more' }[c] ||
          'Who pays: not answered') : '';
      var la = askedAnswers_(lineAskKeys_(ql), lineAnswers_(s.line));
      if (Object.keys(la).length) pays += '. ' + answersText(la, s.line);
      if (ql.method === 'tier') {
        lines.push(s.line + '. Headcount: ' + (t.enrolled ? TIERS.map(function (tier) {
          return t.counts[tier.key] + ' ' + tier.label;
        }).join(', ') + ' (' + t.enrolled + ')' : 'not given') + pays);
      } else if (ql.later) {
        lines.push(s.line + '. Priced after the form is sent' + pays);
      } else {
        lines.push(s.line + '. ' + ql.volumeLabel + ': ' + (t.volume ? wholeMoney.format(t.volume) : 'not given'));
      }
      tickedCarriers_(s).forEach(function (c) {
        lines.push('  ' + c.carrier + ': ' + c.source + (c.band ? '. Band: ' + c.band + ' enrolled' : ''));
      });
      s.plans.forEach(function (p) {
        var pt = planTotal_(s.line, p.id);
        var used = ql.method === 'tier' ? ratesUsed_(s.line, p) : null;
        var rate = ql.later || ql.method !== 'tier' ? (typeof p.rate === 'number' && !ql.later ? 'Rate ' + rateMoney.format(p.rate) + ' ' + ql.basis
          : (p.detail ? p.detail + '. ' : '') + (p.later || 'Priced after the form is sent.'))
          : used ? 'Rates: ' + TIERS.map(function (tier) { return tier.label + ' ' + money.format(used[tier.key]); }).join('; ')
            : 'No rate for this headcount';
        var name = p.carrier && p.name.indexOf(p.carrier) !== 0 ? '[' + p.carrier + '] ' + p.name : p.name;
        if (p.custom && p.detail) name += ' (' + p.detail + ')';
        lines.push('  ' + name + ': ' + (pt
          ? money.format(pt.monthly) + ' a month, ' + money.format(pt.annual) + ' a year. ' : '') + rate);
      });
    });
    var pk = package_(sel);
    if (pk.total) {
      lines.push('Package: ' + money.format(pk.total.monthly) + ' a month, ' + money.format(pk.total.annual) + ' a year');
    }
    return lines.join('\n');
  }

  /** Keeps the form's copy current on every change, so nothing waits for submit. */
  function emit_() {
    bridge.sendValue(answerJson_());
    if (state.summaryField) bridge.writeField(state.summaryField, summaryText_());
  }

  /** Refused (valid: false) with nothing ticked, or while a ticked plan's carrier still needs an answer. */
  function submitAnswer_() {
    var json = answerJson_();
    if (declined_()) {
      debug_('submit', { valid: true, mode: 'declined' }); // nothing to ask: the rest of the form goes on
      return { valid: true, value: json };
    }
    var group = groupProblems_(); // coverage today and the carriers (the form required both: q51, q264)
    if (customRfp_()) {
      // Refused while a requested coverage's "Who pays?" is blank (it was required on the form: q265 / q267).
      var unpaid = rfpUnpaid_();
      var cmsgs = group.concat(unpaid.length ? ['Answer who pays for ' + unpaid.join(', ') + '.'] : []);
      if (el.customErrors) showMessages_(el.customErrors, cmsgs);
      debug_('submit', { valid: !cmsgs.length, mode: 'custom', unpaid: unpaid, group: group });
      return { valid: !cmsgs.length, value: json };
    }
    var still = missingForTicked_();
    var rules = state.packProblems || [];
    var msgs = group.slice();
    if (!selection_().length && tickable_().length) msgs.push('Tick the plans to quote.');
    if (still.length) msgs.push('Answer these before sending: ' + still.join('. ') + '.');
    msgs = msgs.concat(rules, eligibleProblems_(), censusProblems_());
    if (msgs.length) showMessages_(el.errors, msgs);
    var ok = !!json && !msgs.length;
    debug_('submit', { valid: ok, chars: json.length, missing: still, rules: rules, group: group });
    return { valid: ok, value: json };
  }

  function watchHeight_() {
    if (NATIVE) return; // in the form's own page: no frame to size
    var last = 0;
    // The body's own height, never documentElement.scrollHeight: that one is at least the
    // frame's height, so every resize would feed the next and the frame only ever grows.
    var send = function () {
      var h = Math.ceil(document.body.getBoundingClientRect().height) + 4;
      if (Math.abs(h - last) > 2) {
        last = h;
        bridge.resize(h);
      }
    };
    if (window.ResizeObserver) new ResizeObserver(send).observe(document.body);
    send();
  }

  // On the real form loadPrivateRates_ calls straight through, so Jotform's "ready" is still
  // subscribed during the first run.
  var start = function () { loadPrivateRates_(boot_); };
  if (NATIVE) NATIVE.boot = start; // the form starts it once this widget's markup is on its page
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
