/* Owner view of the public mini test. Everything from the API is rendered with textContent. */
(function () {
  'use strict';
  var KEY = 'avc.accessCode';
  var $ = function (id) { return document.getElementById(id); };
  var codeInput = $('code'), errBox = $('err'), list = $('list'), rows = $('rows'), reportBox = $('report');

  function h(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = String(v);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v); else e.setAttribute(k, String(v));
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  var str = function (v) { return typeof v === 'string' ? v : ''; };
  var arr = function (v) { return Array.isArray(v) ? v : []; };
  var score = function (v) { return typeof v === 'number' ? v + '/100' : '—'; };
  function when(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function fail(msg) { errBox.textContent = msg; errBox.hidden = false; }

  try { codeInput.value = localStorage.getItem(KEY) || ''; } catch (e) { /* storage unavailable */ }

  function api(path) {
    var code = codeInput.value.trim();
    return fetch(path, { headers: { 'x-access-code': code, accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) throw new Error(r.status === 401 ? 'Погрешен код за пристап.' : (data && data.error) || 'Грешка ' + r.status);
        try { localStorage.setItem(KEY, code); } catch (e) { /* not persisted */ }
        return data;
      });
    });
  }

  function contactText(l) { return [str(l.name), str(l.email), str(l.phone)].filter(Boolean).join(' · '); }

  function loadList() {
    errBox.hidden = true;
    if (!codeInput.value.trim()) { fail('Внеси го кодот за пристап.'); return Promise.resolve(); }
    return api('/api/owner/checks').then(function (data) {
      rows.textContent = '';
      var checks = arr(data && data.checks);
      if (!checks.length) rows.appendChild(h('tr', null, [h('td', { colspan: '6', class: 'muted', text: 'Сè уште нема проверки.' })]));
      checks.forEach(function (c) {
        var leads = arr(c.leads);
        var open = function () { location.hash = c.id; };
        rows.appendChild(h('tr', { class: 'row' + (leads.length ? ' has-lead' : ''), tabindex: '0', onclick: open, onkeydown: function (ev) { if (ev.key === 'Enter') open(); } }, [
          h('td', { text: when(c.created_at) }),
          h('td', null, [h('strong', { text: str(c.business_name) }), h('br'), h('span', { class: 'muted', text: str(c.domain) })]),
          h('td', { text: [str(c.category), str(c.city)].filter(Boolean).join(' · ') }),
          h('td', { text: c.answered > 0 ? score(c.visibility_score) : 'AI не одговори' }),
          h('td', { text: score(c.readiness_score) }),
          h('td', { class: leads.length ? 'lead' : 'muted', text: leads.length ? leads.map(contactText).join(' | ') : 'нема' })
        ]));
      });
      list.hidden = false;
    }).catch(function (e) { fail(e.message); });
  }

  function renderReport(data) {
    var r = data.report || {}, biz = r.business || {}, leads = arr(data.leads);
    reportBox.textContent = '';
    reportBox.appendChild(h('h2', { text: 'Извештај: ' + (str(biz.name) || str(biz.domain)) }));
    reportBox.appendChild(h('p', { class: 'muted', text: [str(biz.domain), str(biz.category), str(biz.city), when(r.checkedAt)].filter(Boolean).join(' · ') }));
    reportBox.appendChild(h('div', { class: 'noprint' }, [
      h('button', { type: 'button', onclick: function () { window.print(); }, text: 'Печати / PDF' }), ' ',
      h('button', { type: 'button', class: 'ghost', onclick: function () { location.hash = ''; reportBox.hidden = true; }, text: '← Назад кон листата' })
    ]));
    reportBox.appendChild(h('div', { class: 'card' }, [h('h3', { text: 'Контакт' }),
      leads.length ? h('ul', null, leads.map(function (l) { return h('li', { text: contactText(l) + ' (' + when(l.created_at) + ')' }); })) : h('p', { class: 'muted', text: 'Не оставил контакт.' })]));
    var m = r.mentions || {}, vis = r.visibility || {};
    reportBox.appendChild(h('div', { class: 'scores' }, [
      h('div', null, [h('span', { class: 'muted', text: 'AI видливост' }), h('b', { text: typeof vis.score === 'number' ? vis.score : '—' }), str(vis.bandText)]),
      h('div', null, [h('span', { class: 'muted', text: 'Подготвеност на сајтот' }), h('b', { text: typeof (r.readiness || {}).score === 'number' ? r.readiness.score : '—' })]),
      h('div', null, [h('span', { class: 'muted', text: 'Спомнат' }), h('b', { text: (m.count || 0) + ' од ' + (m.total || 5) }), 'Gemini одговори на ' + (m.answered || 0)])
    ]));
    var comps = arr(r.competitors);
    if (comps.length) reportBox.appendChild(h('p', null, [h('strong', { text: 'Кого спомна AI: ' }), comps.map(function (c) { return str(c.name) + ' (' + c.mentions + '×)'; }).join(', ')]));

    var recs = arr(r.recommendations), todo = recs.filter(function (x) { return x.status !== 'done'; }), done = recs.filter(function (x) { return x.status === 'done'; });
    reportBox.appendChild(h('h2', { text: 'Што треба да се поправи (' + todo.length + ')' }));
    todo.forEach(function (x) {
      reportBox.appendChild(h('div', { class: 'card' }, [
        h('span', { class: 'pill ' + str(x.priority), text: str(x.priorityText) }), h('h3', { text: str(x.title) })
      ].concat(arr(x.why).map(function (w) { return h('p', { class: 'muted', text: str(w) }); }), [
        arr(x.steps).length ? h('ol', null, arr(x.steps).map(function (s) { return h('li', { text: str(s) }); })) : null
      ])));
    });
    if (done.length) reportBox.appendChild(h('p', { class: 'muted', text: 'Веќе е направено: ' + done.map(function (x) { return str(x.title); }).join('; ') }));

    reportBox.appendChild(h('h2', { text: 'Одговор по одговор' }));
    reportBox.appendChild(h('div', { class: 'scroll' }, [h('table', null, [
      h('thead', null, [h('tr', null, ['Прашање', 'Спомнат', 'Позиција', 'Други спомнати'].map(function (t) { return h('th', { text: t }); }))]),
      h('tbody', null, arr(r.prompts).map(function (p) {
        return h('tr', null, [
          h('td', { text: str(p.prompt) }),
          h('td', { class: !p.answered ? 'muted' : p.mentioned ? 'yes' : 'no', text: !p.answered ? 'нема одговор' : p.mentioned ? 'Да' : 'Не' }),
          h('td', { text: p.position ? '#' + p.position : p.mentioned ? 'во текстот' : '—' }),
          h('td', { text: arr(p.competitors).join(', ') || '—' })
        ]);
      }))
    ])]));

    reportBox.appendChild(h('h2', { text: 'Проверки на сајтот' }));
    if (str(r.auditError)) reportBox.appendChild(h('p', { class: 'err', text: 'Сајтот не можеше да се провери: ' + r.auditError }));
    arr(r.readinessChecks).forEach(function (c) {
      reportBox.appendChild(h('p', null, [h('span', { class: 'pill ' + str(c.state), text: str(c.stateText) }), ' ', h('strong', { text: str(c.label) }), ' — ', h('span', { class: 'muted', text: str(c.detail) })]));
    });

    var d = r.drafts || {};
    reportBox.appendChild(h('h2', { text: 'Готов код' }));
    reportBox.appendChild(h('h3', { text: 'schema.org (JSON-LD)' })); reportBox.appendChild(h('pre', { text: str(d.schema) }));
    reportBox.appendChild(h('h3', { text: 'llms.txt' })); reportBox.appendChild(h('pre', { text: str(d.llmsTxt) }));
    reportBox.hidden = false;
    reportBox.scrollIntoView();
  }

  function route() {
    var id = location.hash.replace(/^#/, '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) { reportBox.hidden = true; return; }
    errBox.hidden = true;
    if (!codeInput.value.trim()) { fail('Внеси го кодот за пристап, па кликни „Прикажи“.'); return; }
    api('/api/owner/report?id=' + encodeURIComponent(id)).then(renderReport).catch(function (e) { fail(e.message); });
  }

  $('load').addEventListener('click', function () { loadList().then(route); });
  codeInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') loadList().then(route); });
  window.addEventListener('hashchange', route);
  if (codeInput.value.trim()) loadList().then(route);
})();
