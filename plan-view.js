/**
 * Finding plans in the quote widget: click-through filters with live counts, and sorting,
 * across every carrier on a line. VIEW ONLY: it never changes a price, a tick or the answer
 * the form receives.
 *
 * A line declares facets (the engine's shared LINE_FACETS, plus `carrier`) and every plan
 * carries attrs with the same keys:
 *   facets: [{ key, label, kind, sort?, filter?, yes?, no? }]
 *     kind   'amount'  a number, 'unlimited' (above any number), or 0/null (none)
 *            'choice'  a short text value
 *            'flag'    true / false
 *     sort   true adds "<label>: high to low" and "low to high"
 *     filter 'atLeast' one threshold: "$1,500 or more" ... "Unlimited"
 *            'atMost'  one threshold: "$2,000 or less" (a deductible, an out-of-pocket maximum)
 *            'hasAny'  one of: with (more than 0) / without
 *            'flag'    one of: yes / no
 *            'choice'  ANY NUMBER of values (a plan matches one of them): the carrier, a network
 *     order  (choice) the values' order on the buttons, e.g. Platinum, Gold, Silver, Bronze
 *     steps  (atMost) round thresholds instead of every value; a step that keeps every plan or
 *            none is left out
 *   view = { sort, filters: { key: value | [values] }, search? }
 *     search typed words ("s30", "hsa g25"): every word must appear in the plan's name or one of
 *            its features (any order, any case). Plans whose NAME has a word whole ("G25", not
 *            only "G251") come first, so the top match is the plan the visitor typed.
 *
 * Filters on different features narrow together (AND); values ticked within one choice
 * feature widen (OR). facetCounts() says how many plans each button would leave, given the
 * other features' choices, so a visitor clicks through without dead ends. A ticked plan is
 * never hidden. Price sort: the monthly premium once headcounts or volumes are in, otherwise
 * the Employee-only (or per-unit) rate.
 *
 * Runs in the browser (window.PlanView) and in node (module.exports) for the tests.
 */
(function (root) {
  'use strict';

  function amountValue_(v) {
    if (v === 'unlimited') return Infinity;
    if (v == null || v === '') return 0;
    return Number(v);
  }

  function amountLabel_(v) {
    if (v === 'unlimited') return 'Unlimited';
    if (!amountValue_(v)) return 'None';
    return '$' + Number(v).toLocaleString('en-US');
  }

  function attr_(p, key) {
    return p.attrs ? p.attrs[key] : undefined;
  }

  function distinct_(plans, key) {
    var seen = {};
    var out = [];
    plans.forEach(function (p) {
      var v = attr_(p, key);
      if (v === undefined || v === null) return; // not applicable to this plan
      var k = String(v);
      if (!seen[k]) {
        seen[k] = true;
        out.push(v);
      }
    });
    return out;
  }

  /** The sort choices and filter buttons for one line. A filter with one value is left out. */
  function viewOptions(facets, plans) {
    facets = facets || [];
    plans = plans || [];
    var sort = [
      { value: 'listed', label: 'As listed' },
      { value: 'price-asc', label: 'Price: low to high' },
      { value: 'price-desc', label: 'Price: high to low' }
    ];
    var filters = [];
    facets.forEach(function (f) {
      if (f.sort) {
        sort.push({ value: 'facet:' + f.key + ':desc', label: f.label + ': high to low' });
        sort.push({ value: 'facet:' + f.key + ':asc', label: f.label + ': low to high' });
      }
      if (!f.filter) return;
      var values = distinct_(plans, f.key);
      var options = [];
      if (f.filter === 'atLeast') {
        values.filter(function (v) { return amountValue_(v) > 0; })
          .sort(function (a, b) { return amountValue_(a) - amountValue_(b); })
          .forEach(function (v) {
            options.push({ value: String(v), label: v === 'unlimited' ? 'Unlimited' : amountLabel_(v) + ' or more' });
          });
        if (options.length < 2) return;
      } else if (f.filter === 'atMost') {
        var nums = values.map(amountValue_);
        (f.steps ? f.steps.filter(function (st) {
          return nums.some(function (n) { return n <= st; }) && nums.some(function (n) { return n > st; });
        }) : values.slice().sort(function (a, b) { return amountValue_(a) - amountValue_(b); }))
          .forEach(function (v) {
            options.push({ value: String(v), label: Number(v) === 0 ? '$0' : '$' + Number(v).toLocaleString('en-US') + ' or less' });
          });
        if (options.length < 2) return;
      } else if (f.filter === 'hasAny') {
        var some = values.some(function (v) { return amountValue_(v) > 0; });
        var none = plans.some(function (p) { return !amountValue_(attr_(p, f.key)); });
        if (!some || !none) return;
        options.push({ value: 'yes', label: f.yes || 'With ' + f.label.toLowerCase() });
        options.push({ value: 'no', label: f.no || 'Without ' + f.label.toLowerCase() });
      } else if (f.filter === 'flag') {
        var hasTrue = values.some(function (v) { return v === true; });
        var hasFalse = values.some(function (v) { return v === false; });
        if (!hasTrue || !hasFalse) return;
        options.push({ value: 'yes', label: f.yes || 'Yes' });
        options.push({ value: 'no', label: f.no || 'No' });
      } else if (f.filter === 'choice') {
        if (values.length < 2) return;
        if (f.kind === 'amount') values.sort(function (a, b) { return amountValue_(a) - amountValue_(b); });
        else if (f.order) {
          var rank = function (v) { var i = f.order.indexOf(v); return i < 0 ? f.order.length : i; };
          values.sort(function (a, b) { return rank(a) - rank(b); });
        }
        values.forEach(function (v) {
          // A choice among amounts shows the amount itself ("$0" exam copay, not "None").
          var label = f.kind !== 'amount' ? String(v)
            : v === 'unlimited' ? 'Unlimited' : '$' + Number(v || 0).toLocaleString('en-US');
          options.push({ value: String(v), label: label });
        });
      }
      filters.push({ key: f.key, label: f.label, filter: f.filter, kind: f.kind,
        multi: f.filter === 'choice', options: options });
    });
    return { sort: sort, filters: filters };
  }

  /** The typed search as lower-case words ([] = no search). */
  function words_(view) {
    return String((view && view.search) || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  }

  function searchText_(p) {
    var parts = [p.name || ''];
    Object.keys(p.attrs || {}).forEach(function (k) {
      var v = p.attrs[k];
      if (typeof v === 'string') parts.push(v);
    });
    return parts.join(' ').toLowerCase();
  }

  function searchMatch_(p, words) {
    if (!words.length) return true;
    var text = searchText_(p);
    return words.every(function (w) { return text.indexOf(w) >= 0; });
  }

  /** How many typed words the plan's name holds whole ("s30" in "Silver S30", not in "S301"). */
  function searchRank_(p, words) {
    var name = ' ' + String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    return words.filter(function (w) { return name.indexOf(' ' + w + ' ') >= 0; }).length;
  }

  /** The chosen values of one filter as a list ([] = any). */
  function chosen_(view, key) {
    var v = view && view.filters ? view.filters[key] : undefined;
    if (v == null || v === '') return [];
    return Array.isArray(v) ? v : [v];
  }

  function matchesOne_(plan, f, wanted) {
    var v = attr_(plan, f.key);
    if (f.filter === 'atLeast') return amountValue_(v) >= amountValue_(wanted === 'unlimited' ? wanted : Number(wanted));
    if (f.filter === 'atMost') return v != null && v !== '' && amountValue_(v) <= Number(wanted);
    if (f.filter === 'hasAny') return wanted === 'yes' ? amountValue_(v) > 0 : !amountValue_(v);
    if (f.filter === 'flag') return wanted === 'yes' ? v === true : v === false;
    return v !== undefined && v !== null && String(v) === wanted;
  }

  /** True when the plan passes this feature's choice (any of the chosen values). */
  function matches_(plan, f, view) {
    var wanted = chosen_(view, f.key);
    if (!wanted.length) return true;
    return wanted.some(function (w) { return matchesOne_(plan, f, w); });
  }

  /**
   * How many plans each button would show: for every filter, the plans passing all OTHER
   * filters, counted per option (and `any` = all of them). Ticked plans count as always shown.
   */
  function facetCounts(plans, facets, view) {
    var out = {};
    var active = (facets || []).filter(function (f) { return f.filter; });
    var words = words_(view);
    active.forEach(function (f) {
      var pool = plans.filter(function (p) {
        return searchMatch_(p, words) && active.every(function (g) { return g.key === f.key || matches_(p, g, view); });
      });
      var counts = { any: pool.length };
      distinct_(plans, f.key).concat(f.steps || []).forEach(function (v) {
        counts[String(v)] = pool.filter(function (p) { return matchesOne_(p, f, String(v)); }).length;
      });
      if (f.filter === 'hasAny' || f.filter === 'flag') {
        ['yes', 'no'].forEach(function (w) {
          counts[w] = pool.filter(function (p) { return matchesOne_(p, f, w); }).length;
        });
      }
      out[f.key] = counts;
    });
    return out;
  }

  /**
   * The order and visibility of one line's plans.
   *   view    { sort: 'listed' | 'price-asc' | 'price-desc' | 'facet:<key>:asc|desc', filters }
   *   priceOf plan -> number (or null: sorts last)
   *   keep    { planId: true } for ticked plans: never hidden
   * Returns { order: [planId], hidden: { planId: true }, outside: { planId: true }, shown, filtered,
   * carriersShown, top }. `outside` = the kept plans the choices would have hidden, so a widget can
   * list them apart from the matches (still shown, never hidden).
   * Ties keep the listed order. With a search, the best name matches come first and `top` is the
   * first shown plan that is not kept (ticked): the one Enter would pick.
   */
  function applyView(plans, facets, view, priceOf, keep) {
    view = view || {};
    keep = keep || {};
    facets = facets || [];
    var active = facets.filter(function (f) { return f.filter && chosen_(view, f.key).length; });
    var words = words_(view);
    var hidden = {};
    var outside = {};
    plans.forEach(function (p) {
      if (searchMatch_(p, words) && active.every(function (f) { return matches_(p, f, view); })) return;
      if (keep[p.id]) outside[p.id] = true;
      else hidden[p.id] = true;
    });

    var listed = plans.map(function (p, i) { return { p: p, i: i }; });
    var sort = view.sort || 'listed';
    var key = null;
    var dir = 1;
    if (sort === 'price-asc' || sort === 'price-desc') {
      dir = sort === 'price-asc' ? 1 : -1;
      key = function (p) { var v = priceOf ? priceOf(p) : null; return v == null ? null : v; };
    } else if (sort.indexOf('facet:') === 0) {
      var parts = sort.split(':');
      dir = parts[2] === 'asc' ? 1 : -1;
      key = function (p) { return attr_(p, parts[1]) !== undefined ? amountValue_(attr_(p, parts[1])) : null; };
    }
    if (key) {
      listed.sort(function (a, b) {
        var ka = key(a.p);
        var kb = key(b.p);
        if (ka == null && kb == null) return a.i - b.i;
        if (ka == null) return 1;
        if (kb == null) return -1;
        if (ka !== kb) return (ka < kb ? -1 : 1) * dir;
        return a.i - b.i;
      });
    }
    if (words.length) {
      var rank = {};
      listed.forEach(function (x) { rank[x.p.id] = searchRank_(x.p, words); });
      listed = listed.map(function (x, j) { return { p: x.p, i: x.i, j: j }; }).sort(function (a, b) {
        return rank[b.p.id] - rank[a.p.id] || a.j - b.j;
      });
    }
    var order = listed.map(function (x) { return x.p.id; });
    var top = null;
    for (var t = 0; t < order.length; t++) {
      if (!hidden[order[t]] && !keep[order[t]]) { top = order[t]; break; }
    }
    var carriers = {};
    plans.forEach(function (p) { if (!hidden[p.id] && p.carrier) carriers[p.carrier] = true; });
    return {
      order: order,
      hidden: hidden,
      outside: outside,
      shown: order.filter(function (id) { return !hidden[id]; }).length,
      filtered: active.length > 0 || words.length > 0,
      top: words.length ? top : null,
      carriersShown: Object.keys(carriers).length
    };
  }

  var api = { viewOptions: viewOptions, facetCounts: facetCounts, applyView: applyView, amountLabel: amountLabel_ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlanView = api;
})(typeof window !== 'undefined' ? window : this);
