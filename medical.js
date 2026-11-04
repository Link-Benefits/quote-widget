/**
 * The Proposal form's Priority Health small group medical widget: the screen. The rules are
 * in medical-engine.js; the plan menu (ph-sg-menu.js) and the ZIP table (mi-zip-county.js)
 * are GENERATED. PROPOSAL-FORM-WIDGETS-DESIGN.md section 2.
 *
 * It reads the effective date and the company address's ZIP from the form (settings
 * effectiveDateField, zipField), or lets the visitor type them when the form gives no answer.
 * The date picks the plan year's menu; the employer's county hides the plans not sold there
 * (a ZIP on a county line asks which county). "Search plans" narrows the list as you type
 * ("s30", "hsa g25"; Enter ticks the top match and clears the box), "Find a plan" narrows it
 * too (view only), a ticked plan is never hidden, and the form will not submit a ticked plan
 * that is not on the year's menu or not sold in the county.
 *
 * Once a plan is ticked it asks how Priority Health should quote it (HubSpot's `medical_funding`
 * values: the form's q316, moved here 10-31).
 *
 * Its answer (MedicalMenu answer()) holds HubSpot's `medical_plans` (the ticked names) and
 * `medical_funding`. Nothing else: no county, no person, no price.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var PREVIEW = params.get('preview') === '1';
  // Built into our own form (form-mockup/, David 11-03): as in widget.js, the form sets this host first,
  // puts the markup on its page, then calls host.boot().
  var NATIVE = (window.QuoteNative && window.QuoteNative.medical) || null;
  var READ_TIMEOUT_MS = 3000;
  var M = window.MedicalMenu.create(window.PH_SG_MENU, window.MI_ZIP_COUNTY);

  var state = {
    debug: false,
    fieldIds: { effectiveDate: '', zip: '' },
    summaryField: '',
    selected: [], // plan names, in tick order
    funding: [], // HubSpot's medical_funding values picked (MedicalMenu.FUNDING)
    pickedCounty: '', // the visitor's answer on a ZIP that crosses a county line
    view: { sort: 'listed', filters: {}, search: '' }, // Find a plan and the search box (view only)
    showOff: false, // also list the plans not sold here (greyed, cannot be ticked)
    year: null, // { year, known } from the effective date
    builtFor: null, // the plan year the cards were built for
    place: null,
    county: ''
  };
  var el = {};
  var refs = { cards: {}, chips: {}, notes: {} };
  var bridge;

  function node_(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function debug_(label, data) {
    if (!state.debug || !el.debugLog) return;
    var line = new Date().toISOString().slice(11, 19) + '  ' + label;
    if (data !== undefined) {
      try { line += '\n' + JSON.stringify(data, null, 2); } catch (e) { line += '\n' + String(data); }
    }
    el.debugLog.textContent += line + '\n\n';
  }

  function showMessages_(box, messages) {
    box.textContent = '';
    box.hidden = !messages.length;
    messages.forEach(function (msg) { box.appendChild(node_('p', null, msg)); });
  }

  function money_(n) {
    return n == null ? '-' : '$' + Number(n).toLocaleString('en-US');
  }

  // ---------------------------------------------------------------- start

  function boot_() {
    ['date', 'zip', 'refresh', 'note', 'place', 'county', 'county-note', 'county-chips', 'errors', 'menu', 'title',
      'menu-note', 'search', 'search-hint', 'finder', 'plans', 'offline', 'offline-text', 'offline-toggle', 'picked',
      'funding', 'funding-title', 'funding-chips', 'debug', 'debug-log']
      .forEach(function (id) {
        el[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById('qm-' + id);
      });
    try {
      bridge = window.WidgetBridge.create({ preview: PREVIEW, host: NATIVE, readTimeoutMs: READ_TIMEOUT_MS, debug: debug_ });
    } catch (err) {
      showMessages_(el.errors, ['This plan picker could not start. ' + err.message]);
      return;
    }
    bridge.start(function (ready) {
      state.debug = bridge.setting('debug', '') === 'on';
      el.debug.hidden = !state.debug;
      debug_('ready (' + bridge.mode + ')', ready);
      state.fieldIds = { effectiveDate: bridge.setting('effectiveDateField', ''), zip: bridge.setting('zipField', '') };
      state.summaryField = bridge.setting('summaryField', '');
      if (ready && ready.value) { // a visitor editing a submission
        var earlier = M.parse(ready.value);
        state.selected = earlier.names;
        state.funding = earlier.funding;
      }
      buildFunding_();
      el.refresh.addEventListener('click', readFromForm_);
      [el.date, el.zip].forEach(function (input) {
        input.addEventListener('input', function () { if (!input.readOnly) update_(); });
      });
      el.search.addEventListener('input', function () {
        state.view.search = el.search.value;
        applyView_(state.builtFor);
      });
      el.search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          tickTop_();
        } else if (e.key === 'Escape') {
          el.search.value = '';
          state.view.search = '';
          applyView_(state.builtFor);
        }
      });
      el.offlineToggle.addEventListener('click', function () {
        state.showOff = !state.showOff;
        update_();
      });
      bridge.onSubmit(submit_);
      bridge.onShow(readFromForm_);
      watchHeight_();
      readFromForm_();
    });
  }

  /** The effective date and the ZIP from the form; typed by the visitor when the form gives no answer. */
  function readFromForm_() {
    var f = state.fieldIds;
    var ids = [f.effectiveDate, f.zip].filter(Boolean);
    if (!ids.length) {
      setMode_('typed', 'Enter the effective date and the business ZIP code.');
      update_();
      return;
    }
    el.note.textContent = 'Reading your answers from the form...';
    bridge.readFields(ids, function (values) {
      if (!values) {
        setMode_('typed', 'Enter the effective date and the business ZIP code.');
        update_();
        return;
      }
      if (f.effectiveDate) el.date.value = values[f.effectiveDate] || '';
      if (f.zip) el.zip.value = values[f.zip] || '';
      setMode_('form', 'From your answers above. Changed one? Press Refresh.');
      update_();
    });
  }

  function setMode_(mode, note) {
    el.date.readOnly = mode === 'form' && !!state.fieldIds.effectiveDate;
    el.zip.readOnly = mode === 'form' && !!state.fieldIds.zip;
    el.refresh.hidden = !(state.fieldIds.effectiveDate || state.fieldIds.zip);
    if (NATIVE) { // as in widget.js: no echo of the form's own answers, no Refresh (the boxes stay, hidden)
      el.date.closest('.qw-inputs').hidden = mode === 'form';
      if (mode === 'form' && /^From your answers/.test(note)) note = '';
    }
    el.note.textContent = note;
  }

  // ---------------------------------------------------------------- everything after a change

  function update_() {
    var iso = window.MedicalMenu.dateOf(el.date.value);
    state.year = iso ? M.yearFor(iso) : null;
    state.place = M.place(el.zip.value);
    var year = state.year && state.year.known ? state.year.year : null;
    state.county = year ? M.county(state.place, state.pickedCounty, year) : '';
    var errors = [];
    if (el.date.value.trim() && !iso) errors.push('Effective date must be a date like 01/01/2027.');
    if (state.place.status === 'invalid') errors.push('ZIP code must be 5 digits.');
    showMessages_(el.errors, errors);

    renderPlace_(year);
    renderMenu_(year);
    emit_();
  }

  /** What the ZIP says about where plans are sold, and the county question on a county line. */
  function renderPlace_(year) {
    var pl = state.place;
    var msg = '';
    el.county.hidden = true;
    if (year && pl.status === 'unknown') {
      msg = 'ZIP ' + pl.zip + ' is not a Michigan ZIP code we know, so the area could not be checked and nothing is hidden. ' +
        partnersText_(year);
    } else if (year && pl.status === 'many' && M.needsCounty(pl, year)) {
      el.county.hidden = false;
      el.countyNote.textContent = 'ZIP ' + pl.zip + ' crosses into ' + pl.counties.length + ' counties, and they do not sell the same ' +
        'plans. Pick the county of the business address.';
      el.countyChips.textContent = '';
      pl.counties.forEach(function (c) {
        var b = node_('button', 'qw-fchip', c[0] + (c[0] === 'Outside Michigan' ? '' : ' County'));
        b.type = 'button';
        b.appendChild(node_('span', 'qw-fcount', Math.round(c[1] * 100) + '% of the ZIP'));
        var on = state.county === c[0];
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.addEventListener('click', function () {
          state.pickedCounty = c[0];
          update_();
        });
        el.countyChips.appendChild(b);
      });
      if (!state.county) msg = 'Until the county is picked, every plan shows.';
    }
    el.place.textContent = msg;
    el.place.hidden = !msg;
  }

  /** "Southeast MI Partners plans are sold only in ...", from that year's filed areas. */
  function partnersText_(year) {
    var areas = window.PH_SG_MENU.areas;
    var seen = {};
    var out = [];
    M.plans(year).forEach(function (p) {
      var region = p.attrs.partners;
      if (region === 'Full network' || seen[region] || !areas[p.area]) return;
      seen[region] = true;
      out.push(region + ' plans are sold only in ' + areas[p.area].counties.join(', ') + ' counties.');
    });
    return out.join(' ');
  }

  // ---------------------------------------------------------------- the plan list

  function renderMenu_(year) {
    var y = state.year;
    if (!year) {
      el.menu.hidden = true;
      state.builtFor = null;
      var why = !el.date.value.trim() ? 'Enter the effective date: it picks the plan year.'
        : y && !y.known ? 'There is no Priority Health small group menu for ' + y.year + ' here yet.' : '';
      if (why) el.note.textContent = why;
      renderPicked_(null);
      return;
    }
    el.menu.hidden = false;
    if (state.builtFor !== year) buildMenu_(year);
    applyView_(year);
    renderPicked_(year);
  }

  function buildMenu_(year) {
    state.builtFor = year;
    var plans = M.plans(year);
    el.title.textContent = 'Priority Health small group plans, ' + year;
    el.menuNote.textContent = 'Tick every plan to quote. The ' + year + ' menu follows the effective date.';
    refs = { cards: {}, chips: {}, notes: {} };
    buildFinder_(plans);
    el.plans.textContent = '';
    plans.forEach(function (p) { el.plans.appendChild(refs.cards[p.id] = planCard_(p)); });
  }

  function planCard_(p) {
    var card = node_('label', 'qw-plan qm-plan');
    card.setAttribute('data-plan', p.id);
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.selected.indexOf(p.name) >= 0;
    box.addEventListener('change', function () {
      var i = state.selected.indexOf(p.name);
      if (box.checked && i < 0) state.selected.push(p.name);
      if (!box.checked && i >= 0) state.selected.splice(i, 1);
      update_();
    });
    var head = node_('div', 'qw-plan-head');
    head.appendChild(box);
    head.appendChild(node_('span', 'qw-plan-name', p.name));
    var tags = node_('span', 'qm-tags');
    var a = p.attrs;
    [a.metal, a.network, a.partners === 'Full network' ? '' : a.partners, a.hsa ? 'HSA' : ''].forEach(function (t) {
      if (t) tags.appendChild(node_('span', 'qm-tag', t));
    });
    if (p.status) tags.appendChild(node_('span', 'qm-tag' + (/new/i.test(p.status) ? ' is-new' : ''), p.status));
    head.appendChild(tags);
    card.appendChild(head);
    var d = p.plan;
    var facts = node_('p', 'qm-facts');
    [['Deductible', money_(d.ded[0]) + ' / ' + money_(d.ded[1])], ['Out-of-pocket max', money_(d.oop[0]) + ' / ' + money_(d.oop[1])],
      ['Coinsurance', d.coins], ['PCP', d.pcp], ['Specialist', d.spec], ['Urgent care', d.urgent], ['ER', d.er],
      ['Rx', d.rx.filter(Boolean).join(' / ')]].forEach(function (f, i) {
      if (i) facts.appendChild(document.createTextNode(' · '));
      facts.appendChild(document.createTextNode(f[0] + ' '));
      facts.appendChild(node_('b', null, f[1] || '-'));
    });
    card.appendChild(facts);
    var note = node_('p', 'qm-why');
    note.hidden = true;
    card.appendChild(note);
    refs.notes[p.id] = { note: note, box: box };
    return card;
  }

  /** Find a plan: the shared plan-view.js buttons (no price sorts: this widget shows no prices). */
  function buildFinder_(plans) {
    var opts = window.PlanView.viewOptions(M.FACETS, plans);
    var view = state.view;
    var box = node_('details', 'qw-finder');
    box.open = true;
    var sum = node_('summary', 'qw-finder-sum');
    sum.appendChild(node_('span', 'qw-finder-title', 'Find a plan'));
    refs.findCount = node_('span', 'qw-finder-count');
    sum.appendChild(refs.findCount);
    box.appendChild(sum);
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
          applyView_(state.builtFor);
        });
        chips.appendChild(b);
        refs.chips[f.key][value] = { btn: b, count: count };
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
    opts.sort.filter(function (o) { return !/^price/.test(o.value); }).forEach(function (o) {
      var opt = node_('option', null, o.label);
      opt.value = o.value;
      select.appendChild(opt);
    });
    select.value = view.sort;
    select.addEventListener('change', function () {
      view.sort = select.value;
      applyView_(state.builtFor);
    });
    item.appendChild(select);
    foot.appendChild(item);
    refs.clear = node_('button', 'qw-linkbtn', 'Clear choices');
    refs.clear.type = 'button';
    refs.clear.addEventListener('click', function () {
      view.filters = {};
      view.search = '';
      el.search.value = '';
      applyView_(state.builtFor);
    });
    foot.appendChild(refs.clear);
    box.appendChild(foot);
    el.finder.textContent = '';
    el.finder.appendChild(box);
  }

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
   * Order, filters and the area: a plan not sold in the county is hidden (or greyed when the
   * visitor asks to see them); a ticked plan always shows, flagged when it cannot be sent.
   */
  function applyView_(year) {
    if (!year || state.builtFor !== year) return;
    var plans = M.plans(year);
    var county = state.county;
    var ticked = {};
    state.selected.forEach(function (n) { ticked[n] = true; });
    var offHere = plans.filter(function (p) { return M.soldIn(p, county) === false; });
    var pool = plans.filter(function (p) { return ticked[p.id] || M.soldIn(p, county) !== false || state.showOff; });
    var res = window.PlanView.applyView(pool, M.FACETS, state.view, null, ticked);
    var shown = {};
    res.order.forEach(function (id) { if (!res.hidden[id]) shown[id] = true; });
    // What Enter would tick: the best shown match that is not ticked yet and is sold here.
    refs.top = null;
    if (res.top !== null) {
      for (var t = 0; t < res.order.length; t++) {
        var id = res.order[t];
        var tp = plans.filter(function (x) { return x.id === id; })[0];
        if (shown[id] && !ticked[id] && M.soldIn(tp, county) !== false) { refs.top = id; break; }
      }
    }
    var typed = state.view.search.trim();
    var hint = 'Enter ticks the top match.';
    if (typed && refs.top) hint = 'Enter ticks: ' + refs.top;
    else if (typed) {
      // Nothing to tick: say when the only matches are plans not sold at this address.
      var all = window.PlanView.applyView(plans, M.FACETS, { filters: {}, search: typed }, null, {});
      var offOnly = all.order.some(function (id) {
        return !all.hidden[id] && !ticked[id] && M.soldIn(plans.filter(function (x) { return x.id === id; })[0], county) === false;
      });
      hint = offOnly ? 'Only plans not sold ' + (county === 'Outside Michigan' ? 'outside Michigan' : 'in ' + county + ' County') +
        ' match "' + typed + '".' : 'No plan to tick matches "' + typed + '".';
    }
    el.searchHint.textContent = hint;

    var current = Array.prototype.map.call(el.plans.children, function (c) { return c.getAttribute('data-plan'); });
    var order = res.order.concat(plans.map(function (p) { return p.id; }).filter(function (id) { return res.order.indexOf(id) < 0; }));
    if (current.join('|') !== order.join('|')) order.forEach(function (id) { el.plans.appendChild(refs.cards[id]); });

    var problems = {};
    M.problems(state.selected, year, county).forEach(function (pr) { problems[pr.name] = pr.why; });
    plans.forEach(function (p) {
      var card = refs.cards[p.id];
      var r = refs.notes[p.id];
      var off = M.soldIn(p, county) === false;
      card.hidden = !shown[p.id];
      card.classList.toggle('is-on', !!ticked[p.id]);
      card.classList.toggle('is-off', off && !ticked[p.id]);
      r.box.checked = !!ticked[p.id];
      r.box.disabled = off && !ticked[p.id];
      var why = problems[p.name] || (off ? 'Not sold ' + (county === 'Outside Michigan' ? 'outside Michigan.' : 'in ' + county + ' County.') : '');
      r.note.textContent = why;
      r.note.hidden = !why;
      r.note.classList.toggle('is-bad', !!problems[p.name]);
    });

    var counts = window.PlanView.facetCounts(pool, M.FACETS, state.view);
    Object.keys(refs.chips).forEach(function (key) {
      var picked = state.view.filters[key];
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
    var n = function (k, w) { return k + ' ' + w + (k === 1 ? '' : 's'); };
    var keptShown = state.selected.some(function (name) { return shown[name]; });
    refs.findCount.textContent = res.filtered
      ? res.shown + ' of ' + n(pool.length, 'plan') + ' match' + (keptShown ? ' (ticked plans always show)' : '')
      : n(pool.length, 'plan');
    refs.clear.hidden = !res.filtered;

    el.offline.hidden = !offHere.length;
    if (offHere.length) {
      el.offlineText.textContent = n(offHere.length, 'plan') + ' not sold ' +
        (county === 'Outside Michigan' ? 'outside Michigan' : 'in ' + county + ' County') + (state.showOff ? ' (greyed below).' : '.');
      el.offlineToggle.textContent = state.showOff ? 'Hide them' : 'Show them';
    }
  }

  /** Enter in the search box: tick the top match, then clear the box for the next code. */
  function tickTop_() {
    var name = refs.top;
    if (!name) return;
    if (state.selected.indexOf(name) < 0) state.selected.push(name);
    el.search.value = '';
    state.view.search = '';
    update_();
    el.searchHint.textContent = 'Ticked: ' + name + '. Type the next code.';
    el.search.focus();
  }

  /** "How should Priority Health quote it?": HubSpot's medical_funding values, pick any (the form's q316). */
  function buildFunding_() {
    var F = window.MedicalMenu.FUNDING;
    el.fundingTitle.textContent = F.label;
    el.fundingChips.textContent = '';
    F.options.forEach(function (o) {
      var b = node_('button', 'qw-fchip', o);
      b.type = 'button';
      var paint = function () {
        var on = state.funding.indexOf(o) >= 0;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      };
      paint();
      b.addEventListener('click', function () {
        var i = state.funding.indexOf(o);
        if (i >= 0) state.funding.splice(i, 1); else state.funding.push(o);
        paint();
        emit_();
      });
      el.fundingChips.appendChild(b);
    });
  }

  /** The ticked plans, with anything that stops the form sending them. */
  function renderPicked_(year) {
    var box = el.picked;
    box.textContent = '';
    box.hidden = !state.selected.length;
    el.funding.hidden = !state.selected.length; // like the form's q316: asked once a plan is ticked
    if (!state.selected.length) return;
    box.appendChild(node_('strong', null, state.selected.length + (state.selected.length === 1 ? ' plan' : ' plans') + ' ticked'));
    var ul = node_('ul');
    state.selected.forEach(function (name) { ul.appendChild(node_('li', null, name)); });
    box.appendChild(ul);
    blockers_().forEach(function (b) { box.appendChild(node_('p', 'qm-why is-bad', b)); });
  }

  // ---------------------------------------------------------------- the form's copy

  /** The ticked names in menu order (the ones not on this year's menu last, as ticked). */
  function names_() {
    var year = state.year && state.year.known ? state.year.year : null;
    if (!year) return state.selected.slice();
    var order = M.plans(year).map(function (p) { return p.name; });
    var on = state.selected.filter(function (n) { return order.indexOf(n) >= 0; })
      .sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return on.concat(state.selected.filter(function (n) { return order.indexOf(n) < 0; }));
  }

  /** Why the form must not send the ticked plans yet ([] = fine). */
  function blockers_() {
    if (!state.selected.length) return [];
    var y = state.year;
    if (!y) return ['Enter the effective date: it decides which plan year the ticked plans must come from.'];
    if (!y.known) return ['There is no ' + y.year + ' plan menu here yet, so the ticked plans cannot be checked.'];
    var out = M.problems(state.selected, y.year, state.county).map(function (p) { return p.name + ': ' + p.why; });
    var pl = state.place;
    if (pl && pl.status === 'many' && !state.county) out.push('Pick the county of the business address.');
    return out;
  }

  function summary_() {
    if (!state.selected.length) return '';
    var y = state.year;
    var lines = ['Priority Health small group plans' + (y ? ', ' + y.year + ' menu' : '') +
      (state.county ? '; business county: ' + state.county : '') + ':'];
    names_().forEach(function (n) { lines.push('  ' + n); });
    lines.push('Funding: ' + (funding_().join('; ') || 'not picked'));
    return lines.join('\n');
  }

  /** The picked funding, in HubSpot's order. */
  function funding_() {
    return window.MedicalMenu.FUNDING.options.filter(function (o) { return state.funding.indexOf(o) >= 0; });
  }

  function emit_() {
    bridge.sendValue(M.answer(names_(), funding_()));
    if (state.summaryField) bridge.writeField(state.summaryField, summary_());
  }

  /** Not submitted while a ticked plan is off the year's menu or not sold in the county. */
  function submit_() {
    var value = M.answer(names_(), funding_());
    var stop = blockers_();
    if (stop.length) showMessages_(el.errors, ['Fix these before sending: ' + stop.join(' ')]);
    debug_('submit', { valid: !stop.length, value: value, blockers: stop });
    return { valid: !stop.length, value: value };
  }

  function watchHeight_() {
    if (NATIVE) return; // in the form's own page: no frame to size
    var last = 0;
    // The body's own height, never documentElement.scrollHeight (that one only ever grows).
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

  if (NATIVE) NATIVE.boot = boot_; // the form starts it once this widget's markup is on its page
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot_);
  else boot_();
})();
