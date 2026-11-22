/*
 * TorrServer Failover - плагин для Lampa
 *
 * Использует две ссылки на TorrServer, которые уже есть в настройках Лампы
 * (Настройки -> TorrServer -> «Основная ссылка» и «Дополнительная ссылка»).
 * Если основная не отвечает, плагин сам включает дополнительную.
 * Когда основная снова заработает, он возвращается на неё.
 *
 * Как это работает:
 *  - Лампа берёт адрес сервера из настройки torrserver_use_link («Использовать ссылку»).
 *    Плагин переключает именно её, поэтому остальной код Лампы ничего не замечает.
 *  - Сервер проверяется тем же запросом, которым проверяет его сама Лампа (POST /settings).
 *  - Проверка идёт при запуске, раз в минуту, при возврате в приложение,
 *    а также при ошибке подключения к серверу или загрузки «Моих торрентов».
 *  - В настройки TorrServer добавляется переключатель плагина и строка «Статус серверов».
 */
(function () {
    'use strict';

    if (window.torrserver_failover_loaded) return;
    window.torrserver_failover_loaded = true;

    var PROBE_TIMEOUT = 4000;  // сколько ждём ответа от сервера при проверке, мс
    var CHECK_EVERY   = 60000; // как часто проверять в фоне, мс

    var generation = 0; // растёт при Torserver.clear(): отменяет ожидающие повторы запросов
    var pending    = {};
    var timer      = null;

    // ---------------------------------------------------------------- утилиты

    function tr(key) {
        return Lampa.Lang.translate(key);
    }

    function enabled() {
        return Lampa.Storage.field('torrserver_failover') !== false;
    }

    function normalize(url) {
        url = ((url || '') + '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');

        if (!url) return '';
        if (!/^https?:\/\//i.test(url)) url = (window.location.protocol === 'https:' ? 'https://' : 'http://') + url;

        return url;
    }

    // [основная, дополнительная]
    function links() {
        return [
            normalize(Lampa.Storage.get('torrserver_url', '')),
            normalize(Lampa.Storage.get('torrserver_url_two', ''))
        ];
    }

    // какая ссылка включена сейчас: 1 или 2 (так же, как читает Лампа)
    function current() {
        return Lampa.Storage.field('torrserver_use_link') === 'two' ? 2 : 1;
    }

    function playerOpened() {
        return !!(Lampa.Player && typeof Lampa.Player.opened === 'function' && Lampa.Player.opened());
    }

    function modalOpened() {
        try { return !!(window.$ && window.$('.modal').length); } catch (e) { return false; }
    }

    function authHeader() {
        if (!Lampa.Storage.field('torrserver_auth')) return null;

        try {
            var raw = Lampa.Storage.get('torrserver_login', '') + ':' + Lampa.Storage.value('torrserver_password', '');

            return 'Basic ' + btoa(unescape(encodeURIComponent(raw)));
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------ проверка сервера

    // callback(true), если сервер отвечает так, как нужно Лампе
    function probe(base, callback) {
        var finished = false;
        var guard    = null;
        var xhr      = new XMLHttpRequest();

        function end(ok) {
            if (finished) return;

            finished = true;
            clearTimeout(guard);
            callback(ok);
        }

        try {
            var auth = authHeader();

            xhr.open('POST', base + '/settings', true);
            xhr.timeout = PROBE_TIMEOUT;

            if (auth) xhr.setRequestHeader('Authorization', auth);

            xhr.onload = function () {
                var ok = false;

                if (xhr.status === 200) {
                    try { ok = typeof JSON.parse(xhr.responseText).CacheSize !== 'undefined'; } catch (e) { ok = false; }
                }

                end(ok);
            };
            xhr.onerror = xhr.ontimeout = xhr.onabort = function () { end(false); };

            // подстраховка для старых веб-вью, где нет xhr.timeout
            guard = setTimeout(function () {
                try { xhr.abort(); } catch (e) {}

                end(false);
            }, PROBE_TIMEOUT + 1000);

            xhr.send(JSON.stringify({ action: 'get' }));
        } catch (e) {
            end(false);
        }
    }

    // Находит первую рабочую ссылку (основная проверяется раньше дополнительной).
    // dead - номер ссылки, которая точно не работает: её не проверяем.
    // callback(1 | 2 | 0), 0 - не работает ни одна.
    function pick(dead, callback) {
        var key = dead || 0;

        if (pending[key]) return pending[key].push(callback);

        pending[key] = [callback];

        var urls  = links();
        var order = [1, 2].filter(function (n) { return n !== dead; });

        function finish(best) {
            var list = pending[key];

            delete pending[key];

            list.forEach(function (fn) { fn(best); });
        }

        (function next(i) {
            if (i >= order.length) return finish(0);

            probe(urls[order[i] - 1], function (ok) {
                if (ok) finish(order[i]);
                else next(i + 1);
            });
        })(0);
    }

    // ----------------------------------------------------------------- переключение

    function switchTo(n) {
        Lampa.Storage.set('torrserver_use_link', n === 2 ? 'two' : 'one');

        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(tr(n === 2 ? 'tsfo_to_two' : 'tsfo_to_one'));
    }

    // В фоне не трогаем ссылку, пока играет плеер, а возвращаться на основную
    // начинаем только когда нет открытых окон (там может быть торрент, добавленный на запасной сервер).
    function allowed(best, background) {
        if (!background) return true;
        if (playerOpened()) return false;
        if (best === 1 && modalOpened()) return false;

        return true;
    }

    // opts: { dead: номер нерабочей ссылки, background: проверка в фоне }
    // callback(best, now): best - рабочая ссылка (0 - никакой), now - включённая после проверки
    function failover(opts, callback) {
        var urls = links();

        callback = callback || function () {};

        if (!enabled() || !urls[0] || !urls[1]) return callback(0, current());

        pick(opts.dead, function (best) {
            if (best && best !== current() && allowed(best, opts.background)) switchTo(best);

            callback(best, current());
        });
    }

    // -------------------------------------------------------- перехват Torserver

    function patch() {
        var T = Lampa.Torserver;

        if (!T || T.torrserver_failover) return;

        T.torrserver_failover = true;

        var connected = T.connected;
        var my        = T.my;
        var clear     = T.clear;

        // экран закрыли или запрос сбросили: повторять запрос уже не нужно
        T.clear = function () {
            generation++;

            return clear.apply(T, arguments);
        };

        // открытие торрента: сервер не ответил -> пробуем другую ссылку и повторяем
        T.connected = function (success, fail) {
            var gen    = generation;
            var active = current();

            connected.call(T, success, function () {
                var args = arguments;

                failover({ dead: active }, function (best, now) {
                    if (gen !== generation) return;

                    if (now !== active) connected.call(T, success, fail);
                    else fail.apply(null, args);
                });
            });
        };

        // «Мои торренты»: ошибка (или пустой список) -> проверяем, жив ли сервер
        T.my = function (success, fail) {
            var gen = generation;

            my.call(T, success, function () {
                var args   = arguments;
                var active = current();

                failover({}, function (best, now) {
                    if (gen !== generation) return;

                    if (now !== active) my.call(T, success, fail);
                    else fail.apply(null, args);
                });
            });
        };
    }

    // ------------------------------------------------------------ фоновые проверки

    function tick() {
        if (document.hidden || playerOpened()) return;

        failover({ background: true });
    }

    function startTimers() {
        if (timer) return;

        timer = setInterval(tick, CHECK_EVERY);

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) tick();
        });

        // поменяли ссылки в настройках - сразу проверяем
        if (Lampa.Storage.listener && Lampa.Storage.listener.follow) {
            Lampa.Storage.listener.follow('change', function (e) {
                if (e.name === 'torrserver_url' || e.name === 'torrserver_url_two') setTimeout(function () { failover({}); }, 300);
            });
        }

        setTimeout(tick, 1500);
    }

    // ------------------------------------------------------------------ настройки

    function addLang() {
        Lampa.Lang.add({
            tsfo_name: {
                ru: 'Автопереключение серверов',
                uk: 'Автоперемикання серверів',
                en: 'Server auto-switch'
            },
            tsfo_descr: {
                ru: 'Если основная ссылка не отвечает, включится дополнительная. Когда основная заработает, плагин вернётся на неё.',
                uk: 'Якщо основне посилання не відповідає, увімкнеться додаткове. Коли основне запрацює, плагін повернеться на нього.',
                en: 'If the main link does not respond, the additional one is used. When the main one is back, it switches back.'
            },
            tsfo_status: {
                ru: 'Статус серверов',
                uk: 'Статус серверів',
                en: 'Server status'
            },
            tsfo_checking: {
                ru: 'Проверка…',
                uk: 'Перевірка…',
                en: 'Checking…'
            },
            tsfo_main: { ru: 'Основная', uk: 'Основне', en: 'Main' },
            tsfo_extra: { ru: 'Дополнительная', uk: 'Додаткове', en: 'Additional' },
            tsfo_up: { ru: 'работает', uk: 'працює', en: 'online' },
            tsfo_down: { ru: 'не отвечает', uk: 'не відповідає', en: 'offline' },
            tsfo_empty: { ru: 'не задана', uk: 'не задано', en: 'not set' },
            tsfo_active: { ru: 'Сейчас', uk: 'Зараз', en: 'Active' },
            tsfo_to_two: {
                ru: 'TorrServer: основная ссылка не отвечает, включена дополнительная',
                uk: 'TorrServer: основне посилання не відповідає, увімкнено додаткове',
                en: 'TorrServer: main link is down, switched to the additional one'
            },
            tsfo_to_one: {
                ru: 'TorrServer: основная ссылка снова работает, включена основная',
                uk: 'TorrServer: основне посилання знову працює, увімкнено основне',
                en: 'TorrServer: main link is back, switched to the main one'
            }
        });
    }

    // строка «Статус серверов»: пишет в описание, какие ссылки отвечают
    function renderStatus(item) {
        var descr = item.find('.settings-param__descr');
        var urls  = links();
        var names = [tr('tsfo_main'), tr('tsfo_extra')];
        var out   = [tr('tsfo_empty'), tr('tsfo_empty')];
        var left  = 0;

        function show() {
            descr.text(names[0] + ': ' + out[0] + '  ·  ' + names[1] + ': ' + out[1] + '  ·  ' + tr('tsfo_active') + ': ' + names[current() - 1].toLowerCase());
        }

        [0, 1].forEach(function (i) {
            if (!urls[i]) return;

            left++;

            probe(urls[i], function (ok) {
                out[i] = ok ? tr('tsfo_up') : tr('tsfo_down');

                if (!--left) show();
            });
        });

        if (!left) show();
    }

    function addSettings() {
        Lampa.SettingsApi.addParam({
            component: 'server',
            param: {
                name: 'torrserver_failover',
                type: 'trigger',
                default: true
            },
            field: {
                name: tr('tsfo_name'),
                description: tr('tsfo_descr')
            },
            onChange: function () {
                setTimeout(function () { failover({}); }, 100);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'server',
            param: {
                name: 'torrserver_failover_status',
                type: 'static'
            },
            field: {
                name: tr('tsfo_status'),
                description: tr('tsfo_checking')
            },
            onRender: renderStatus
        });
    }

    // ---------------------------------------------------------------------- старт

    function start() {
        addLang();
        addSettings();
        patch();
        startTimers();
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') start();
    });
})();
