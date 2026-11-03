/**
 * The link between a widget and its form, shared by the ancillary widget (widget.js) and the
 * medical widget (medical.js), so the live probe pins Jotform's reply shape in ONE place.
 *
 *   WidgetBridge.create({ preview, readTimeoutMs, debug }) -> bridge
 *     mode                 'jotform' | 'preview'
 *     start(onReady)       onReady({ value }): the form is ready (value = an earlier answer)
 *     setting(name, dflt)  a widget setting (Jotform: the widget's wand; preview: the host page)
 *     readFields(ids, cb)  cb({ <id>: <string> }) or cb(null) when the form gives no answer
 *     writeField(id, text) fill another question (the summary Long Text)
 *     sendValue(text)      the widget question's own answer, kept current on every change
 *     onSubmit(fn)         fn() -> { valid, value } at submit
 *     onShow(fn), resize(h)
 *
 * getFieldsValueById / setFieldsValueById are in Jotform's widget library but NOT its docs:
 * the reply shape is unknown until the live probe, so every raw reply goes to debug() and is
 * read by field-values.js. A read with no answer in readTimeoutMs gives null, and the widget
 * lets the visitor type the answers instead. The preview (?preview=1) is the local page in
 * preview/, which answers in a GUESSED Jotform shape through window.parent.QuotePreview.
 */
(function (root) {
  'use strict';

  function previewBridge_(o) {
    var host = root.parent && root.parent.QuotePreview;
    if (!host) throw new Error('preview=1 but no QuotePreview on the parent page');
    return {
      mode: 'preview',
      start: function (onReady) { onReady({ value: host.initialValue || '' }); },
      setting: function (name, dflt) {
        var v = host.settings[name];
        return v == null || v === '' ? dflt : String(v);
      },
      readFields: function (ids, cb) {
        // The preview answers in a GUESSED Jotform shape, so the same parser runs here.
        var resp = host.readFields(ids);
        o.debug('preview readFields raw reply', { ids: ids, resp: resp });
        cb(resp == null ? null : root.FieldValues.extract(resp, ids));
      },
      writeField: function (id, value) { host.writeField(id, value); },
      sendValue: function (value) { host.receiveValue(value); },
      onSubmit: function (fn) { host.onSubmit = fn; },
      onShow: function () {},
      resize: function (h) { host.resize(h); }
    };
  }

  function jotformBridge_(o) {
    var JF = root.JFCustomWidget;
    if (!JF) throw new Error('Jotform widget library did not load');
    return {
      mode: 'jotform',
      start: function (onReady) { JF.subscribe('ready', onReady); },
      setting: function (name, dflt) {
        var v = JF.getWidgetSetting(name);
        return v == null || v === '' ? dflt : String(v);
      },
      readFields: function (ids, cb) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          o.debug('getFieldsValueById: no answer in ' + o.readTimeoutMs + ' ms', { ids: ids });
          cb(null);
        }, o.readTimeoutMs);
        try {
          JF.getFieldsValueById(ids, function (resp) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            o.debug('getFieldsValueById raw reply', { ids: ids, resp: resp });
            cb(root.FieldValues.extract(resp, ids));
          });
        } catch (err) {
          done = true;
          clearTimeout(timer);
          o.debug('getFieldsValueById threw', String(err));
          cb(null);
        }
      },
      writeField: function (id, value) {
        try {
          JF.setFieldsValueById([{ id: String(id), value: value }]);
          o.debug('setFieldsValueById', { id: id, chars: value.length });
        } catch (err) {
          o.debug('setFieldsValueById threw', String(err));
        }
      },
      sendValue: function (value) { JF.sendData({ value: value }); },
      onSubmit: function (fn) {
        JF.subscribe('submit', function () { JF.sendSubmit(fn()); });
      },
      onShow: function (fn) { JF.subscribe('show', fn); },
      resize: function (h) { JF.requestFrameResize({ height: h }); }
    };
  }

  function create(opts) {
    var o = { readTimeoutMs: opts.readTimeoutMs || 3000, debug: opts.debug || function () {} };
    return opts.preview ? previewBridge_(o) : jotformBridge_(o);
  }

  root.WidgetBridge = { create: create };
})(window);
