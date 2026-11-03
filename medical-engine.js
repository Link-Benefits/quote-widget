/**
 * The Proposal form's Priority Health small group medical widget: its rules, without the
 * screen (medical.js draws it). PROPOSAL-FORM-WIDGETS-DESIGN.md section 2.
 *
 *   MedicalMenu.create(PH_SG_MENU, MI_ZIP_COUNTY) -> api
 *     MedicalMenu.dateOf(text)  "01/01/2027" (or ISO, or M-D-YYYY) -> "2027-01-01"; '' if not a date
 *     yearFor(isoDate)      the plan year a date picks: { year, known } (known = on the menu)
 *     plans(year)           that year's plans: { id (= the plan name), name, attrs, ... }
 *     place(zip)            the ZIP's counties: { zip, status, counties: [[county, share]] }
 *                           status 'blank' | 'invalid' | 'unknown' (not a Michigan ZIP we know)
 *                           | 'one' | 'many'
 *     needsCounty(place, year)  true when the ZIP's counties differ in what is sold there
 *     county(place, picked, year) the county the rules use, or '' when it is not known
 *     soldIn(plan, county)  true | false | null (null = cannot tell: no county, or no filed area)
 *     problems(names, year, county)  [{ name, why }] for ticked plans that cannot be sent
 *     answer(names, funding) the stored answer: JSON { v: 2, fields: { medical_plans, medical_funding }, fieldLines }
 *     parse(text)           a stored answer (v2, or v1 = the names joined "; ") back to { names, funding }
 *     FACETS                the "Find a plan" features (plan-view.js)
 *   MedicalMenu.FUNDING      HubSpot's `medical_funding` values (the form's q316, moved here 10-31)
 *
 * The rule (David, 2026-10-30): a plan is sold by the county of the EMPLOYER'S business
 * address. Service areas are Priority Health's filed ones (whole counties). A plan with no
 * filed area (PPO, in our references) is never hidden.
 *
 * The answer's `fields` hold HubSpot's own values, plain ASCII: `medical_plans` = the plan names
 * (exactly the option values the 11 checkbox questions write today) and `medical_funding`. Never a
 * county, a person or a price. (v1, until 10-31, was the names joined "; " alone.)
 *
 * Runs in the browser (window.MedicalMenu) and in node (module.exports) for the tests.
 */
(function (root) {
  'use strict';

  var PARTNERS = { '': 'Full network', 'Southeast MI': 'Southeast MI Partners', 'West MI': 'West MI Partners' };
  var FACETS = [
    { key: 'network', label: 'Network', kind: 'choice', filter: 'choice', order: ['HMO', 'POS', 'PPO'] },
    { key: 'family', label: 'Plan family', kind: 'choice', filter: 'choice', order: ['Classic', 'HSA', 'HRA', 'Assure'] },
    { key: 'partners', label: 'Partners network', kind: 'choice', filter: 'choice',
      order: ['Full network', 'Southeast MI Partners', 'West MI Partners'] },
    { key: 'metal', label: 'Metal level', kind: 'choice', filter: 'choice', order: ['Platinum', 'Gold', 'Silver', 'Bronze'] },
    { key: 'hsa', label: 'HSA', kind: 'flag', filter: 'flag', yes: 'HSA-eligible', no: 'Not HSA-eligible' },
    { key: 'deductible', label: 'Deductible (single)', kind: 'amount', sort: true, filter: 'atMost',
      steps: [0, 500, 1000, 2000, 3000, 4000, 5000, 7000] },
    { key: 'oopMax', label: 'Out-of-pocket max (single)', kind: 'amount', sort: true, filter: 'atMost',
      steps: [3000, 5000, 6000, 7000, 8000, 9000] },
    { key: 'coinsurance', label: 'Coinsurance', kind: 'choice', filter: 'choice', order: ['0%', '10%', '20%', '30%'] }
  ];
  // How Priority Health quotes the ticked plans: HubSpot's `medical_funding` values, exactly (read
  // 2026-10-31; tools/hubspot-ancillary-options.json). The form's q316 "funding methods" checkbox
  // moves into the widget (David 10-31); like q316, pick any, optional.
  var FUNDING = { key: 'medical_funding', label: 'How should Priority Health quote it? (pick any)',
    options: ['Fully-insured', 'Optimized level-funded'] };

  /** "01/01/2027", "1-1-2027" or "2027-01-01" -> "2027-01-01"; anything else (or no such day) -> ''. */
  function dateOf(text) {
    var t = String(text == null ? '' : text).trim();
    var y, mo, d;
    var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
      if (!m) return '';
      mo = +m[1]; d = +m[2]; y = +m[3];
    }
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  function key_(county) { // "St. Clair" and "Saint Clair" are one county
    return String(county || '').toLowerCase().replace(/^st\.?\s+/, 'saint ').replace(/\s+/g, ' ').trim();
  }

  function create(menu, zipTable) {
    var zips = (zipTable && zipTable.zips) || {};
    var areaSets = {};
    Object.keys(menu.areas || {}).forEach(function (k) {
      var s = {};
      menu.areas[k].counties.forEach(function (c) { s[key_(c)] = true; });
      areaSets[k] = s;
    });
    var byYear = {};

    function plans(year) {
      if (byYear[year]) return byYear[year];
      byYear[year] = (menu.years[year] || []).map(function (p) {
        return {
          id: p.name, name: p.name, year: Number(year), hios: p.hios, area: p.area, status: p.status, plan: p,
          attrs: { network: p.network, family: p.family, partners: PARTNERS[p.partners] || p.partners, metal: p.metal,
            hsa: p.hsa, deductible: p.ded[0], oopMax: p.oop[0], coinsurance: p.coins,
            // Extra words the search box finds ("se s30"); not a "Find a plan" feature.
            searchAlso: p.partners === 'Southeast MI' ? 'SE' : '' }
        };
      });
      return byYear[year];
    }

    function yearFor(iso) {
      var m = String(iso || '').match(/^(\d{4})-\d{2}-\d{2}$/);
      if (!m) return null;
      var y = Number(m[1]);
      return { year: y, known: !!(menu.years[y] && menu.years[y].length) };
    }

    function place(zip) {
      var z = String(zip == null ? '' : zip).trim().slice(0, 5);
      if (!z) return { zip: '', status: 'blank', counties: [] };
      if (!/^\d{5}$/.test(z)) return { zip: z, status: 'invalid', counties: [] };
      var v = zips[z];
      if (!v) return { zip: z, status: 'unknown', counties: [] };
      var counties = Array.isArray(v) ? v.map(function (x) { return [x[0], x[1]]; }) : [[v, 1]];
      return { zip: z, status: counties.length > 1 ? 'many' : 'one', counties: counties };
    }

    function soldIn(plan, county) {
      if (!plan.area || !areaSets[plan.area]) return null;
      if (!county) return null;
      return !!areaSets[plan.area][key_(county)];
    }

    /** What is sold in one county, as a fingerprint (to compare a ZIP's counties). */
    function fingerprint_(county, year) {
      return plans(year).map(function (p) { return soldIn(p, county) ? '1' : '0'; }).join('');
    }

    function needsCounty(pl, year) {
      if (!pl || pl.status !== 'many') return false;
      var first = fingerprint_(pl.counties[0][0], year);
      return pl.counties.some(function (c) { return fingerprint_(c[0], year) !== first; });
    }

    /** The county the rules use: the ZIP's own, the visitor's pick on a border, or '' (not known). */
    function county(pl, picked, year) {
      if (!pl) return '';
      if (pl.status === 'one') return pl.counties[0][0];
      if (pl.status !== 'many') return '';
      var names = pl.counties.map(function (c) { return c[0]; });
      if (picked && names.indexOf(picked) >= 0) return picked;
      return needsCounty(pl, year) ? '' : names[0]; // every county sells the same plans
    }

    function where_(county) {
      return county === 'Outside Michigan' ? 'outside Michigan' : county + ' County';
    }

    function problems(names, year, county) {
      var list = plans(year);
      var out = [];
      (names || []).forEach(function (n) {
        var p = list.filter(function (x) { return x.name === n; })[0];
        if (!p) out.push({ name: n, why: 'Not on the ' + year + ' plan menu (the effective date picks the year).' });
        else if (soldIn(p, county) === false) out.push({ name: n, why: 'Not sold ' + (county === 'Outside Michigan' ? '' : 'in ') + where_(county) + '.' });
      });
      return out;
    }

    /**
     * The stored answer: JSON { v: 2, fields: { medical_plans: [names], medical_funding: [values] },
     * fieldLines: ["Medical plans: a; b", "Medical funding: x"] }, or '' with no plan ticked
     * (the funding question only shows once a plan is). Funding values not HubSpot's are dropped.
     */
    function answer(names, funding) {
      names = (names || []).slice();
      if (!names.length) return '';
      var fund = FUNDING.options.filter(function (o) { return (funding || []).indexOf(o) >= 0; });
      var fields = { medical_plans: names };
      var lines = ['Medical plans: ' + names.join('; ')];
      if (fund.length) {
        fields[FUNDING.key] = fund;
        lines.push('Medical funding: ' + fund.join('; '));
      }
      return JSON.stringify({ v: 2, fields: fields, fieldLines: lines });
    }

    /** A stored answer back to { names, funding }; also reads v1 (the names joined "; ", no funding). */
    function parse(text) {
      var t = String(text || '').trim();
      if (t.charAt(0) === '{') {
        try {
          var f = JSON.parse(t).fields || {};
          var list = function (v) { return (Array.isArray(v) ? v : []).filter(function (s) { return typeof s === 'string' && s; }); };
          return { names: list(f.medical_plans), funding: list(f[FUNDING.key]) };
        } catch (e) {
          return { names: [], funding: [] };
        }
      }
      return { names: t.split(';').map(function (s) { return s.trim(); }).filter(Boolean), funding: [] };
    }

    return { yearFor: yearFor, plans: plans, place: place, needsCounty: needsCounty, county: county,
      soldIn: soldIn, problems: problems, answer: answer, parse: parse, where: where_, FACETS: FACETS };
  }

  var api = { create: create, dateOf: dateOf, FACETS: FACETS, FUNDING: FUNDING };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MedicalMenu = api;
})(typeof window !== 'undefined' ? window : this);
