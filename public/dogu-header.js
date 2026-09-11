/* 공통 UI 파일. 이 파일은 원본에서 복사되어 배포된다.
   각 사이트 폴더에서 직접 수정하지 말 것 — 원본을 고치고 다시 복사할 것. */

/* =========================================================
   dogu.gg 공통 헤더 — 마크업 생성 + 게임 스위처 + 검색창 포커스 드롭다운
   의존성 없음. 전역 `DoguUI` 하나만 만든다. 사용법은 DOGU_UI.md 참고.
   ========================================================= */
(function (global) {
    'use strict';

    /* 게임 스위처 목록. 순서·주소는 DOGU_UI_PLAN.md 의 규격 그대로다. 여기서만 고친다.
       아이콘은 각 사이트 public/ 의 header_{key}.png (256×256 투명 PNG, 여백 맞춰 둔 것) —
       경로 앞부분은 mountHeader 의 opts.iconBase 로 받는다 (er: App.url('/')) */
    var GAMES = [
        { key: 'lol',   name: '리그 오브 레전드', icon: 'header_lol.png',   href: 'https://pixlol.kr', external: true },
        { key: 'er',    name: '이터널 리턴',     icon: 'header_er.png',    href: '/er' },
        { key: 'maple', name: '메이플스토리',    icon: 'header_maple.png', href: '/maple' },
        { key: 'loa',   name: '로스트아크',      icon: 'header_loa.png',   href: '/loa' },
        { key: 'tft',   name: '전략적 팀 전투(TFT)', icon: 'header_tft.png', href: '/tft' }
    ];

    var TEXT = {
        searching: '찾는 중…',
        noMatch: '일치하는 이름이 없습니다.',
        favorites: '★ 즐겨찾기',
        recents: '🕘 최근 검색',
        hint: '각각 10개까지 저장됩니다.',
        empty: '저장된 항목이 없습니다.',
        searchIcon: '⌕',
        buttonLabel: '.GG',
        notFoundTitle: '404',
        notFoundBody: '요청하신 페이지를 찾을 수 없습니다.',
        comingTitle: '준비 중',
        comingBody: '아직 만드는 중인 페이지입니다. 조금만 기다려 주세요.',
        backHome: '← 홈으로 돌아가기',
        copied: function (email) { return '이메일 주소(' + email + ')가 클립보드에 복사되었습니다.'; },
        copyFailed: function (email) { return '복사에 실패했습니다. 직접 복사해 주세요: ' + email; }
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function el(target) {
        if (!target) return null;
        return typeof target === 'string' ? document.querySelector(target) : target;
    }

    /* 로고 조각. brand = 'DOGU' / tld = '.GG' (pixlol 은 'PIXLOL' / '.KR') */
    /* mascot: 히어로 로고 왼쪽에 붙는 사이트 마스코트(파비콘) 경로. 히어로만 쓰고 헤더는 안 쓴다 (2026-08-25) —
       헤더는 로고 바로 오른쪽에 게임 스위처 아이콘이 이미 있어서 아이콘 둘이 글자를 끼게 된다 */
    function brandHtml(opts, cls, mascot) {
        return '<a class="' + cls + '" href="' + esc(opts.home || '/') + '"' + linkAttr(opts) + '>' +
            (mascot ? '<img class="dogu-hero-mascot" src="' + esc(mascot) + '" alt="" width="64" height="64" draggable="false">' : '') +
            esc(opts.brand || 'DOGU') + '<em>' + esc(opts.tld || '.GG') + '</em></a>';
    }

    /* 내부 링크에 사이트 라우터용 속성(예: data-link)을 붙인다 */
    function linkAttr(opts) {
        return opts.linkAttr ? ' ' + opts.linkAttr : '';
    }

    /* ---------- 게임 스위처 ---------- */
    /* 아이콘 경로 앞부분. 정식 이름은 opts.iconBase 이고 '/tft/' 처럼 슬래시로 끝난다.
       한때 tft 복사본이 opts.icons('/tft') 로 갈라졌던 적이 있어 둘 다 받고 끝 슬래시를 맞춘다.
       둘 다 없으면 null → 글자 타일 폴백 */
    function iconBaseOf(opts) {
        var base = opts.iconBase != null ? opts.iconBase : opts.icons;
        if (base == null) return null;
        base = String(base);
        return base === '' || /\/$/.test(base) ? base : base + '/';
    }

    /* 아이콘 <img>. width/height 를 속성으로 박아 이미지가 늦게 와도 칸이 안 밀린다.
       아이콘 자체에 여백이 맞춰져 있으니 padding·crop 을 더하지 않는다.
       iconBase 가 없으면 액센트색 글자 타일(.dogu-game-mark)로 그린다 */
    function gameIcon(g, size, base) {
        if (base == null) {
            return '<span class="dogu-game-mark" aria-hidden="true">' + esc(g.name.charAt(0)) + '</span>';
        }
        return '<img class="dogu-game-icon" src="' + esc(base + g.icon) + '" alt="' + esc(g.name) + '"' +
            ' width="' + size + '" height="' + size + '" decoding="async">';
    }

    function switcherHtml(site, iconBase, opts) {
        var cur = GAMES.filter(function (g) { return g.key === site; })[0] || GAMES[1];
        var items = GAMES.map(function (g) {
            var inner = gameIcon(g, 32, iconBase) + '<span class="dogu-game-name">' + esc(g.name) + '</span>';
            if (g.key === cur.key) {
                return '<span class="dogu-game-item active" aria-current="page">' + inner + '</span>';
            }
            /* ★ GAMES 의 내부 주소('/er' 등)는 dogu.gg 기준 상대 경로다. dogu.gg 밖에서 도는
               사이트(pixlol)는 opts.gamesOrigin('https://dogu.gg')을 줘서 절대 주소로 만든다 —
               안 그러면 pixlol.kr/er 로 가서 SPA 가 받아 "다른 게임을 눌러도 제자리" 가 된다 (2026-08-24) */
            var href = (g.external || !opts || !opts.gamesOrigin)
                ? g.href
                : String(opts.gamesOrigin).replace(/\/$/, '') + g.href;
            return '<a class="dogu-game-item" href="' + esc(href) + '"' +
                ((g.external || (opts && opts.gamesOrigin)) ? ' rel="noopener"' : '') + ' title="' + esc(g.name) + '">' + inner + '</a>';
        }).join('');
        return '<div class="dogu-switcher" id="dogu-switcher">' +
            '<button class="dogu-switcher-btn" type="button" id="dogu-switcher-btn" aria-haspopup="true" aria-expanded="false" title="' + esc(cur.name) + '">' +
            gameIcon(cur, 22, iconBase) + '<span class="dogu-game-name">' + esc(cur.name) + '</span>' +
            '<span class="dogu-caret">▼</span></button>' +
            '<div class="dogu-switcher-list" role="menu">' + items + '</div></div>';
    }

    /* onOpen: 스위처를 열기 직전에 부른다 — 모바일 햄버거 메뉴를 접는 데 쓴다 (2026-08-25).
       두 버튼 다 stopPropagation 으로 클릭을 삼켜서 서로의 "바깥 클릭 → 닫힘" 리스너가 안 돌기 때문에
       한쪽을 열 때 다른 쪽을 명시적으로 닫아야 둘이 겹쳐 펼쳐지지 않는다. 닫기 함수를 돌려준다 */
    function bindSwitcher(root, onOpen) {
        var picker = root.querySelector('#dogu-switcher');
        var btn = root.querySelector('#dogu-switcher-btn');
        if (!picker || !btn) return function () {};
        function close() {
            picker.classList.remove('open');
            btn.setAttribute('aria-expanded', 'false');
        }
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = !picker.classList.contains('open');
            if (willOpen && onOpen) onOpen();
            picker.classList.toggle('open', willOpen);
            btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        document.addEventListener('click', close);
        return close;
    }

    /* ---------- 헤더 ---------- */
    /* 하위 메뉴 (2026-08-27). nav[].sub = [{ key, label, href }] 를 주면 그 탭이 드롭다운이 된다.
       - **부모에 href 를 안 주면 링크가 아니다** (<span>) — "부모를 눌러도 아무 데도 안 감" 을 사이트가 고를 수 있게.
         href 를 주면 예전처럼 링크가 된다
       - 여는 건 CSS 의 :hover / :focus-within 이라 여는 JS 가 없다. 폰(<=768px)은 접지 않고 들여써서 다 펼친다
       - sub 를 안 넘기면 마크업이 예전과 한 글자도 다르지 않다 (다른 사이트 무영향) */
    function navHtml(items, opts) {
        return (items || []).map(function (it) {
            var sub = it.sub || [];
            var cls = 'dogu-nav-item' + (sub.length ? ' dogu-nav-parent' : '') + (it.active ? ' active' : '');
            var navAttr = it.key ? ' data-nav="' + esc(it.key) + '"' : '';
            var label = esc(it.label) + (sub.length ? '<span class="dogu-nav-caret" aria-hidden="true">▾</span>' : '');
            var head = (sub.length && !it.href)
                ? '<span class="' + cls + '" tabindex="0" aria-haspopup="true"' + navAttr + '>' + label + '</span>'
                : '<a class="' + cls + '" href="' + esc(it.href) + '"' + linkAttr(opts) + navAttr +
                  (sub.length ? ' aria-haspopup="true"' : '') + '>' + label + '</a>';
            if (!sub.length) return head;
            return '<span class="dogu-nav-group">' + head + '<span class="dogu-nav-sub">' + sub.map(function (s) {
                return '<a class="dogu-nav-sub-item' + (s.active ? ' active' : '') + '" href="' + esc(s.href) + '"' +
                    linkAttr(opts) + (s.key ? ' data-nav="' + esc(s.key) + '"' : '') + '>' + esc(s.label) + '</a>';
            }).join('') + '</span></span>';
        }).join('');
    }

    /* ★ .dogu-nav 는 overflow-x: auto 라 그대로 두면 드롭다운이 그 안에서 잘린다 —
       하위 메뉴가 있는 사이트에서만 overflow 를 푼다 (CSS 의 .dogu-nav.has-sub) */
    function hasSub(items) {
        return (items || []).some(function (n) { return n.sub && n.sub.length; });
    }

    function headerHtml(opts) {
        return '<div class="dogu-gnb-utility"><div class="dogu-wrap dogu-gnb-utility-inner">' +
            brandHtml(opts, 'dogu-brand') +
            switcherHtml(opts.site, iconBaseOf(opts), opts) +
            /* ★ 모바일 전용 햄버거 (2026-08-24). 768px 이하에서만 보인다 — 2단 네비를 숨기고
               이 버튼이 세로 메뉴(.dogu-gnb-main)를 펼친다. 데스크톱은 CSS 가 숨겨서 무영향 */
            '<button class="dogu-menu-btn" type="button" id="dogu-menu-btn" aria-label="메뉴" aria-expanded="false" aria-controls="dogu-nav">' +
                '<span class="dogu-menu-bar"></span><span class="dogu-menu-bar"></span><span class="dogu-menu-bar"></span>' +
            '</button>' +
        '</div></div>' +
        '<div class="dogu-gnb-main"><div class="dogu-wrap dogu-gnb-main-inner">' +
            '<a class="dogu-nav-home" href="' + esc(opts.home || '/') + '"' + linkAttr(opts) + ' title="홈">⌂</a>' +
            '<nav class="dogu-nav' + (hasSub(opts.nav) ? ' has-sub' : '') + '" id="dogu-nav">' + navHtml(opts.nav, opts) + '</nav>' +
            '<span class="dogu-gnb-aside" id="dogu-gnb-aside">' + (opts.aside || '') + '</span>' +
        '</div></div>';
    }

    /* ---------- 검색 제출 ---------- */
    function submitFrom(input, opts) {
        var q = (input.value || '').trim();
        if (!q) {
            var box = input.closest('.dogu-search-box');
            if (box) {
                box.classList.remove('shake');
                void box.offsetWidth;
                box.classList.add('shake');
            }
            input.focus();
            return;
        }
        if (opts.search && typeof opts.search.onSubmit === 'function') {
            opts.search.onSubmit(q, input);
        }
    }

    /* ---------- 히어로 검색 + 드롭다운 ---------- */
    /* query 가 비어 있으면 즐겨찾기/최근 탭, 차 있으면 자동완성 결과를 보여준다 */
    var dropdownState = { tab: 'favorites', opts: null, root: null, query: '', items: null, loading: false, seq: 0 };

    function heroHtml(opts) {
        var s = opts.search || {};
        var placeholder = s.placeholder || '검색어를 입력해주세요.';
        /* 버튼 안 내용. 기본 ".GG" 글자, pixlol 만 돋보기(TEXT.searchIcon) */
        var button = s.button == null ? '<span class="dogu-search-btn-gg">' + TEXT.buttonLabel + '</span>' : s.button;
        var note = s.note == null
            ? '<span class="dogu-search-shortcut"><kbd>/</kbd> 키를 눌러 바로 검색할 수 있습니다.</span>'
            : s.note;
        return '<div class="dogu-wrap dogu-hero-inner">' +
            brandHtml(opts, 'dogu-hero-mark', opts.mascot) +
            '<div class="dogu-search-wrapper">' +
                '<form class="dogu-search-box" id="dogu-search-box" autocomplete="off">' +
                    '<input type="text" class="dogu-search-input" id="dogu-search-input" placeholder="' + esc(placeholder) + '" autocomplete="off">' +
                    '<button class="dogu-search-btn" type="submit" aria-label="검색" title="검색">' + button + '</button>' +
                '</form>' +
                '<div class="dogu-search-error" id="dogu-search-error"></div>' +
                (note ? '<p class="dogu-search-note">' + note + '</p>' : '') +
                '<div class="dogu-search-dropdown" id="dogu-search-dropdown">' +
                    '<div class="dogu-dropdown-header">' +
                        '<span class="dogu-dropdown-tab active" data-tab="favorites">' + TEXT.favorites + '</span>' +
                        '<span class="dogu-dropdown-tab" data-tab="recents">' + TEXT.recents + '</span>' +
                        '<span class="dogu-dropdown-hint">' + TEXT.hint + '</span>' +
                    '</div>' +
                    '<div class="dogu-dropdown-list" id="dogu-dropdown-list"></div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderDropdownList() {
        var root = dropdownState.root;
        var s = dropdownState.opts && dropdownState.opts.search;
        if (!root || !s) return;
        var listEl = root.querySelector('#dogu-dropdown-list');
        var header = root.querySelector('.dogu-dropdown-header');
        var suggesting = !!dropdownState.query;

        /* 자동완성 중에는 탭(즐겨찾기/최근)이 의미가 없어 숨긴다 */
        if (header) header.style.display = suggesting ? 'none' : '';

        if (suggesting) {
            if (dropdownState.loading && !dropdownState.items) {
                listEl.innerHTML = '<div class="dogu-dropdown-empty">' + TEXT.searching + '</div>';
                return;
            }
            var found = dropdownState.items || [];
            if (!found.length) {
                listEl.innerHTML = '<div class="dogu-dropdown-empty">' + TEXT.noMatch + '</div>';
                return;
            }
            listEl.innerHTML = found.map(function (it) {
                var fk = it.key != null ? it.key : it.label;
                return '<div class="dogu-dropdown-row">' +
                    '<a class="dogu-dropdown-link" href="' + esc(it.href || '#') + '"' + linkAttr(dropdownState.opts) +
                        ' data-dogu-key="' + esc(fk) + '">' + esc(it.label) +
                        (it.sub ? '<em class="dogu-dropdown-sub">' + esc(it.sub) + '</em>' : '') +
                    '</a>' +
                '</div>';
            }).join('');
            return;
        }

        var source = dropdownState.tab === 'favorites' ? s.favorites : s.recents;
        var items = (source && typeof source.all === 'function') ? source.all() : [];
        if (!items.length) {
            listEl.innerHTML = '<div class="dogu-dropdown-empty">' + TEXT.empty + '</div>';
            return;
        }
        var label = s.itemLabel || function (it) { return typeof it === 'string' ? it : it.label || it.nickname || it.name; };
        var key = s.itemKey || label;
        var href = s.itemHref || function () { return '#'; };
        listEl.innerHTML = items.map(function (it) {
            var k = key(it);
            return '<div class="dogu-dropdown-row">' +
                '<a class="dogu-dropdown-link" href="' + esc(href(it)) + '"' + linkAttr(dropdownState.opts) +
                    ' data-dogu-key="' + esc(k) + '">' + esc(label(it)) + '</a>' +
                '<button class="dogu-dropdown-del" type="button" data-dogu-del="' + esc(k) + '" title="삭제">✕</button>' +
            '</div>';
        }).join('');
        root.querySelectorAll('.dogu-dropdown-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === dropdownState.tab);
        });
    }

    function bindHero(root, opts) {
        var form = root.querySelector('#dogu-search-box');
        var input = root.querySelector('#dogu-search-input');
        var dropdown = root.querySelector('#dogu-search-dropdown');
        var s = opts.search || {};
        dropdownState.opts = opts;
        dropdownState.root = root;

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            submitFrom(input, opts);
        });

        /* 포커스 드롭다운: 포커스 들어오면 열고, 나가면 닫는다.
           드롭다운 안을 mousedown 하면 input 이 blur 되면서 닫히므로 preventDefault 로 막는다 */
        input.addEventListener('focus', function () {
            var fq = (input.value || '').trim();
            if (!fq) { dropdownState.query = ''; dropdownState.items = null; }
            if (!s.favorites && !s.recents && !dropdownState.query) return;
            renderDropdownList();
            dropdown.classList.add('open');
        });
        input.addEventListener('blur', function () { dropdown.classList.remove('open'); });
        dropdown.addEventListener('mousedown', function (e) { e.preventDefault(); });

        dropdown.addEventListener('click', function (e) {
            var tab = e.target.closest('.dogu-dropdown-tab');
            if (tab) {
                dropdownState.tab = tab.dataset.tab;
                renderDropdownList();
                return;
            }
            var del = e.target.closest('[data-dogu-del]');
            if (del) {
                var source = dropdownState.tab === 'favorites' ? s.favorites : s.recents;
                if (source && typeof source.remove === 'function') source.remove(del.dataset.doguDel);
                renderDropdownList();
                return;
            }
            var link = e.target.closest('.dogu-dropdown-link');
            if (link) {
                if (typeof s.onPick === 'function') {
                    e.preventDefault();
                    s.onPick(link.dataset.doguKey);
                }
                dropdown.classList.remove('open');
                input.blur();
            }
        });

        /* 자동완성. 사이트가 search.suggest(q) 를 주면 켜진다 (없으면 예전 그대로 동작).
           호출이 잦으면 안 되니 200ms 디바운스를 걸고, 늦게 온 응답이 최신 결과를
           덮어쓰지 않게 seq 로 순서를 지킨다. */
        var sugTimer = null;
        input.addEventListener('input', function () {
            var q = (input.value || '').trim();
            if (typeof s.suggest !== 'function' || !q) {
                dropdownState.query = '';
                dropdownState.items = null;
                if (s.favorites || s.recents) { renderDropdownList(); dropdown.classList.add('open'); }
                return;
            }

            /* 아직은 기존 탭을 그대로 두고 열어만 둔다. 자동완성으로 넘어가는 건
               디바운스가 끝난 뒤다 — 그래야 짧은 입력에서 "찾는 중…"이 깜빡이지 않는다 */
            dropdown.classList.add('open');

            if (sugTimer) clearTimeout(sugTimer);
            var mine = ++dropdownState.seq;
            sugTimer = setTimeout(function () {
                var out = s.suggest(q);

                /* ★ null/undefined = "이 입력은 자동완성 대상이 아니다" (너무 짧다 등).
                   빈 배열([])과 구분한다 — 빈 배열은 "찾아봤는데 없음"이라 그렇게 표시해야 하고,
                   null 은 아무 일도 없었던 것처럼 즐겨찾기/최근을 그대로 둬야 한다. */
                if (out == null) {
                    dropdownState.query = '';
                    dropdownState.items = null;
                    dropdownState.loading = false;
                    renderDropdownList();
                    return;
                }

                dropdownState.query = q;
                dropdownState.loading = true;
                dropdownState.items = null;
                renderDropdownList();

                Promise.resolve(out).then(function (list) {
                    if (mine !== dropdownState.seq) return;   // 더 최신 입력이 있었다
                    dropdownState.loading = false;
                    dropdownState.items = list || [];
                    renderDropdownList();
                }, function () {
                    if (mine !== dropdownState.seq) return;
                    dropdownState.loading = false;
                    dropdownState.items = [];
                    renderDropdownList();
                });
            }, 200);
        });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { dropdown.classList.remove('open'); input.blur(); }
        });
    }

    /* `/` 단축키 — 입력 중이 아닐 때 누르면 히어로 검색창으로 포커스 */
    var slashBound = false;
    function bindSlash() {
        if (slashBound) return;
        slashBound = true;
        document.addEventListener('keydown', function (e) {
            if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
            var t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            var target = document.querySelector('#dogu-search-input');
            if (!target || target.offsetParent === null) return;
            e.preventDefault();
            target.focus();
            target.select();
        });
    }

    /* ---------- 토스트 (푸터 복사 안내용 최소 구현) ---------- */
    var toastTimer = null;
    function showToast(message) {
        var t = document.getElementById('dogu-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'dogu-toast';
            t.className = 'dogu-toast';
            document.body.appendChild(t);
        }
        t.textContent = message;
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
    }

    /* 이메일을 클립보드에 복사하고 안내를 띄운다. 사이트가 자기 토스트를 쓰고 싶으면 opts.notify 로 넘긴다 */
    function copyEmail(email, opts) {
        var notify = typeof opts.notify === 'function' ? opts.notify : showToast;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(email).then(function () {
                notify(TEXT.copied(email));
            }, function () {
                notify(TEXT.copyFailed(email));
            });
        } else {
            notify(TEXT.copyFailed(email));
        }
    }

    /* ---------- 푸터 · 404 · 준비중 ---------- */
    function footerHtml(opts) {
        var links = opts.links || {};
        var notices = [].concat(opts.notice || []);
        return '<div class="dogu-wrap dogu-footer-inner">' +
            brandHtml(opts, 'dogu-brand') +
            '<div class="dogu-footer-links">' +
                '<a href="' + esc(links.terms || '#') + '"' + linkAttr(opts) + '>이용약관</a>' +
                '<a href="' + esc(links.privacy || '#') + '"' + linkAttr(opts) + '>개인정보 처리방침</a>' +
                /* 버그제보 = 이메일 주소 클립보드 복사 (mailto 아님). 주소는 opts.contact */
                '<a href="#" id="dogu-feedback" role="button">버그제보 및 피드백</a>' +
                /* 사이트가 더 붙이는 링크 (2026-08-26, pixlol 「PC 버전」). opts.extraLinks = [{ id, text, href, onClick }].
                   공통 셋 뒤에만 붙고 문구는 사이트 몫이다 — 없으면 아무것도 안 그린다 */
                [].concat(opts.extraLinks || []).map(function (l) {
                    return '<a href="' + esc(l.href || '#') + '"' + (l.id ? ' id="' + esc(l.id) + '"' : '') + ' role="button">' + esc(l.text || '') + '</a>';
                }).join('') +
            '</div>' +
            notices.map(function (n) { return '<div class="dogu-footer-note">' + n + '</div>'; }).join('') +
            (opts.contact ? '<div class="dogu-footer-note">Contact: ' + esc(opts.contact) + '</div>' : '') +
        '</div>';
    }

    function docHtml(title, body, opts) {
        return '<div class="dogu-wrap"><div class="dogu-doc-panel">' +
            '<h2 class="dogu-doc-title">' + esc(title) + '</h2>' +
            '<p>' + esc(body) + '</p>' +
            '<p><a class="dogu-doc-link" href="' + esc(opts.home || '/') + '"' + linkAttr(opts) + '>' + TEXT.backHome + '</a></p>' +
        '</div></div>';
    }

    /* 히어로 상자 규격 검사 (개발자 콘솔 경고만, 화면에는 영향 없음).
       히어로는 헤더 바로 밑·화면 폭 전체·패딩 0 인 상자에 들어가야 5개 사이트에서 같은 자리에 그려진다.
       사이트 `main { padding: 0 20px }` 나 `.page-container { padding-top: 22px }` 안에 두면
       검색창이 좁아지거나 내려앉는데(loa·tft·pixlol 에서 실제로), 스크린샷만으로는 눈치채기 어려워 여기서 잡는다 */
    function warnHeroHost(host) {
        if (!host || typeof console === 'undefined' || !console.warn) return;
        /* 마운트 직후엔 #hero 가 아직 display:none 인 페이지 안에 있을 수 있어(라우터가 나중에 켠다)
           폭이 0 으로 잰다. 패딩은 숨겨져 있어도 계산되므로 바로 보고, 폭은 보일 때까지 몇 번 기다린다 */
        var tries = 0;
        function check() {
            try {
                var rect = host.getBoundingClientRect();
                if (rect.width === 0 && tries++ < 20) { setTimeout(check, 500); return; }
                var viewport = document.documentElement.clientWidth;
                var problems = [];
                var node = host;
                while (node && node !== document.body) {
                    var cs = getComputedStyle(node);
                    if (parseFloat(cs.paddingLeft) || parseFloat(cs.paddingRight) || parseFloat(cs.paddingTop)) {
                        problems.push(describe(node) + ' padding ' + cs.padding);
                    }
                    node = node.parentElement;
                }
                if (rect.width > 0 && Math.round(rect.width) < viewport - 1) {
                    problems.push('상자 폭 ' + Math.round(rect.width) + 'px < 화면 ' + viewport + 'px');
                }
                if (problems.length) {
                    console.warn('[dogu-ui] 히어로 상자가 규격(화면 폭 전체 · 패딩 0)을 벗어났다 → 검색창 위치·폭이 다른 사이트와 달라진다. ' +
                        'DOGU_UI.md 5절 참고: ' + problems.join(' / '));
                }
            } catch (e) { /* 측정 실패는 무시 */ }
        }
        function describe(n) {
            return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).trim().split(/\s+/).join('.') : '');
        }
        setTimeout(check, 0);
    }

    /* ---------- 공개 API ---------- */
    var DoguUI = {
        GAMES: GAMES,
        TEXT: TEXT,
        esc: esc,

        /* 헤더. container 를 안 주면 body 맨 앞에 끼운다 */
        mountHeader: function (opts) {
            opts = opts || {};
            var host = el(opts.container);
            var header = document.createElement('header');
            header.className = 'dogu-gnb';
            header.id = 'dogu-gnb';
            header.innerHTML = headerHtml(opts);
            if (host) host.appendChild(header);
            else document.body.insertBefore(header, document.body.firstChild);
            /* 모바일 햄버거: 버튼이 dogu-menu-open 을 토글하고, 바깥/메뉴 항목 클릭이 닫는다
               (네비 클릭은 각 사이트 라우터가 preventDefault 만 하고 전파는 살려 두므로
                document 리스너까지 올라와 저절로 닫힌다).
               게임 스위처와는 상호 배타 — 하나를 열면 다른 하나는 접힌다 (2026-08-25) */
            /* 링크가 아닌 부모 탭(하위 메뉴만 여는 자리)은 클릭을 삼킨다 — 안 그러면
               폰에서 라벨을 누르는 것만으로 아래 document 리스너가 메뉴를 닫는다 (2026-08-27) */
            header.querySelectorAll('span.dogu-nav-parent').forEach(function (t) {
                t.addEventListener('click', function (e) { e.stopPropagation(); });
            });
            /* ★ 폰 세로 메뉴에서 묶음은 기본 접힘 — 부모를 누르면 펼친다 (2026-08-31).
               하위 항목까지 20줄이라 패널이 화면을 넘었다 (maple). 데스크톱은 그대로 —
               이 핸들러는 dogu-menu-open 일 때만 동작하고, 부모가 <a>(랭킹처럼 자기
               페이지가 있는 탭)여도 폰에서는 이동 대신 펼치기만 한다.
               토글 클래스(dogu-sub-open)는 CSS 의 menu-open 규칙에서만 쓴다 */
            header.querySelectorAll('.dogu-nav-group > .dogu-nav-parent').forEach(function (t) {
                t.addEventListener('click', function (e) {
                    if (!header.classList.contains('dogu-menu-open')) return;
                    e.preventDefault();
                    e.stopPropagation();       /* document 리스너의 closeMenu 로 번지지 않게 */
                    var g = t.parentNode;
                    var open = !g.classList.contains('dogu-sub-open');
                    g.classList.toggle('dogu-sub-open', open);
                    t.setAttribute('aria-expanded', open ? 'true' : 'false');
                });
            });
            /* 하위 항목을 눌러 페이지가 바뀐 뒤에도 드롭다운이 남아 있던 것 (2026-08-28). SPA 라 DOM 이 안 바뀌어
               누른 <a> 의 포커스(:focus-within)와 마우스(:hover)가 그대로라서다. 포커스를 빼고, 마우스가 그룹을
               벗어날 때까지 .dogu-sub-hold 로 hover 를 막는다 (CSS 의 :not(.dogu-sub-hold)). 부모 탭을 다시 누르면
               바로 푼다. 폰 세로 메뉴(dogu-menu-open)는 hover 와 무관한 규칙이라 영향 없다 */
            header.querySelectorAll('.dogu-nav-group').forEach(function (g) {
                g.addEventListener('click', function (e) {
                    var t = e.target;
                    var sub = t && t.closest ? t.closest('.dogu-nav-sub-item') : null;
                    if (sub) { sub.blur(); g.classList.add('dogu-sub-hold'); }
                    else g.classList.remove('dogu-sub-hold');
                });
                g.addEventListener('mouseleave', function () { g.classList.remove('dogu-sub-hold'); });
            });
            var menuBtn = header.querySelector('#dogu-menu-btn');
            function closeMenu() {
                header.classList.remove('dogu-menu-open');
                if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
                /* 다음에 열 때 묶음이 다시 접힌 상태로 시작하게 */
                header.querySelectorAll('.dogu-nav-group.dogu-sub-open').forEach(function (g) {
                    g.classList.remove('dogu-sub-open');
                    var t = g.querySelector('.dogu-nav-parent');
                    if (t) t.setAttribute('aria-expanded', 'false');
                });
            }
            var closeSwitcher = bindSwitcher(header, closeMenu);
            if (menuBtn) {
                menuBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var willOpen = !header.classList.contains('dogu-menu-open');
                    if (willOpen) closeSwitcher();
                    header.classList.toggle('dogu-menu-open', willOpen);
                    menuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
                });
                document.addEventListener('click', closeMenu);
            }
            return header;
        },

        /* 히어로(로고 + 알약 검색창 + 포커스 드롭다운). container 필수 */
        mountHero: function (container, opts) {
            opts = opts || {};
            var host = el(container);
            var hero = document.createElement('div');
            hero.className = 'dogu-hero';
            hero.innerHTML = heroHtml(opts);
            host.appendChild(hero);
            bindHero(hero, opts);
            bindSlash();
            warnHeroHost(host);
            return hero;
        },

        mountFooter: function (container, opts) {
            opts = opts || {};
            var host = el(container);
            var footer = document.createElement('footer');
            footer.className = 'dogu-footer';
            footer.innerHTML = footerHtml(opts);
            if (host) host.appendChild(footer);
            else document.body.appendChild(footer);
            var fb = footer.querySelector('#dogu-feedback');
            if (fb) {
                fb.addEventListener('click', function (e) {
                    e.preventDefault();
                    copyEmail(opts.contact || '', opts);
                });
            }
            /* extraLinks 의 onClick 을 id 로 찾아 건다 (href 만 있는 링크는 그냥 링크다) */
            [].concat(opts.extraLinks || []).forEach(function (l) {
                if (!l.id || typeof l.onClick !== 'function') return;
                var a = footer.querySelector('#' + l.id);
                if (a) a.addEventListener('click', function (e) { e.preventDefault(); l.onClick(e); });
            });
            return footer;
        },

        /* 404 · 준비중 — 마크업 문자열만 준다. 사이트의 페이지 컨테이너 안에 넣어 쓴다 */
        notFoundHtml: function (opts) { return docHtml(TEXT.notFoundTitle, TEXT.notFoundBody, opts || {}); },
        comingSoonHtml: function (opts) { return docHtml(TEXT.comingTitle, TEXT.comingBody, opts || {}); },

        /* 홈/비홈 오버레이 농도 전환. 사이트 라우터가 페이지 바뀔 때 부른다 */
        setHome: function (isHome) { document.body.classList.toggle('dogu-home', !!isHome); },

        /* 2단 네비 활성 표시 갱신 (data-nav 키 기준) */
        setActiveNav: function (key) {
            document.querySelectorAll('#dogu-nav .dogu-nav-item').forEach(function (a) {
                /* 하위 메뉴의 어느 항목이 켜지면 부모 탭도 같이 켠다 (2026-08-27) */
                var par = a.parentNode;
                var group = (par && par.classList && par.classList.contains('dogu-nav-group')) ? par : null;
                var subOn = !!(key && group) && [].slice.call(group.querySelectorAll('.dogu-nav-sub-item')).some(function (s) {
                    return s.dataset.nav === key;
                });
                /* key 가 없는 페이지(약관 등)에서는 아무 탭도 켜지 않는다. 묶음 부모 <span> 은
                   data-nav 가 없어서 undefined === undefined 로 전부 켜지던 버그 (2026-08-28) */
                a.classList.toggle('active', (key != null && a.dataset.nav === key) || subOn);
            });
            document.querySelectorAll('#dogu-nav .dogu-nav-sub-item').forEach(function (a) {
                a.classList.toggle('active', key != null && a.dataset.nav === key);
            });
        },

        /* ---------- 6b. 표 스크롤 힌트 · 빈 상태 · 스켈레톤 (2026-09-11, DOGU_UI.md 15절) ---------- */
        /* wrap(.dogu-scroll-wrap) 이 오른쪽으로 더 스크롤될 수 있을 때만 .has-more(페이드) 를 붙인다. 표를 다시 그린 뒤 다시 불러도 안전(리스너 중복 없음) */
        scrollHint: function (wrap) {
            var w = el(wrap);
            if (!w) return;
            function update() { w.classList.toggle('has-more', w.scrollWidth - w.clientWidth - w.scrollLeft > 4); }
            if (!w.__doguScrollHint) {
                w.__doguScrollHint = true;
                w.addEventListener('scroll', update, { passive: true });
                window.addEventListener('resize', update);
            }
            update();
        },
        /* 빈 상태·오류 상자. opts = { icon, title, body, retry: { text, id } } — retry 를 주면 <button id> 를 그리고 클릭은 사이트가 건다 */
        emptyHtml: function (opts) {
            opts = opts || {};
            return '<div class="dogu-empty" role="status">' +
                (opts.icon ? '<div class="dogu-empty-icon" aria-hidden="true">' + esc(opts.icon) + '</div>' : '') +
                (opts.title ? '<div class="dogu-empty-title">' + esc(opts.title) + '</div>' : '') +
                (opts.body ? '<p>' + esc(opts.body) + '</p>' : '') +
                /* 링크 슬롯 — 「← 통계로」「원문 보기」 같은 것 (pixlol 요청, 2026-09-11). 내부 링크면 linkAttr(data-link) 을 같이 */
                (opts.link ? '<p><a class="dogu-empty-link" href="' + esc(opts.link.href || '#') + '"' + linkAttr(opts) + (opts.link.external ? ' target="_blank" rel="noopener"' : '') + '>' + esc(opts.link.text || '') + '</a></p>' : '') +
                (opts.retry ? '<button type="button" class="dogu-empty-retry"' + (opts.retry.id ? ' id="' + esc(opts.retry.id) + '"' : '') + '>' + esc(opts.retry.text || '다시 시도') + '</button>' : '') +
            '</div>';
        },
        /* 표·목록 자리막이 n 줄 */
        skelRowsHtml: function (n) {
            var s = '';
            for (var i = 0; i < (n || 6); i++) s += '<span class="dogu-skel"></span>';
            return '<div class="dogu-skel-rows" aria-hidden="true">' + s + '</div>';
        },

        setAside: function (html) {
            var a = document.querySelector('#dogu-gnb-aside');
            if (a) a.innerHTML = html || '';
        },

        /* 즐겨찾기/최근 목록이 바뀐 뒤 드롭다운이 열려 있으면 다시 그린다 */
        refreshDropdown: renderDropdownList,
        showToast: showToast,
        copyEmail: copyEmail,

        showSearchError: function (msg) {
            var e = document.querySelector('#dogu-search-error');
            if (!e) return;
            e.textContent = msg || '';
            e.classList.toggle('show', !!msg);
        }
    };

    global.DoguUI = DoguUI;
})(window);
