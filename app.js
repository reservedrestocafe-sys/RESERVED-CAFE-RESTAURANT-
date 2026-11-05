// app.js — RESERVE
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ── STATE ──────────────────────────────────────────────────────────────────
  const state = {
    inventoryType: 'kitchen',
    role: null,
    chart: null,
    booted: false
  };

  // ── USER ACCOUNTS (Supabase) ────────────────────────────────────────────
  async function getUsers() {
    const { data, error } = await db.from('users').select('*');
    if (error) { console.error('getUsers error:', error); return []; }
    return data;
  }
  async function getUserByCredentials(username, password) {
    const { data, error } = await db.from('users')
      .select('*').eq('username', username).eq('password', password).maybeSingle();
    if (error) { console.error('getUserByCredentials error:', error); return null; }
    return data;
  }
  const OWNER_ONLY = ['dashboard', 'expenses', 'staff', 'reports', 'settings'];

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function cur(n) {
    const s = StorageAPI.getSettings();
    return Calc.currency(n || 0, s.currency || '₱');
  }

  function toLocalYMD(d = new Date()) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function today() { return toLocalYMD(new Date()); }

  function getWeekStart() {
    const d = new Date(), dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return toLocalYMD(mon);
  }

  function getMonthRange() {
    const d = new Date();
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const end = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2,'0')}-${String(lastDay.getDate()).padStart(2,'0')}`;
    return { start, end };
  }

  function getYearRange() {
    const y = new Date().getFullYear();
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }

  function inRange(dateStr, start, end) {
    if (!dateStr) return false;
    const d = String(dateStr).slice(0, 10);
    return (!start || d >= start) && (!end || d <= end);
  }

  // Read final revenue/GP/COGS from a stored sale — respects discount + VAT.
  // Recovers COGS via product recipes if legacy sales recorded 0 cost.
  function saleRevenue(s) { return (s.revenue != null) ? Number(s.revenue) : Calc.saleTotals(s).revenue; }
  function saleCOGS(s) {
    if (s.cogs != null && Number(s.cogs) > 0) return Number(s.cogs);
    const fromLines = (s.lines || []).reduce((sum, l) => sum + (Number(l.cost_price) || 0) * (Number(l.qty) || 0), 0);
    if (fromLines > 0) return fromLines;
    // Attempt recipe fallback for menu sales
    try {
      const inv = StorageAPI.getInventory();
      const recipeCost = (s.lines || []).reduce((sum, l) => {
        const p = StorageAPI.getMenuProductById(l.item_id);
        if (!p?.recipes?.length) return sum + (Number(p?.cost_price) || 0) * (Number(l.qty) || 0);
        const unitCost = p.recipes.reduce((rSum, r) => {
          const item = inv.find(i => i.id === r.inventory_item_id);
          return rSum + (Number(item?.cost_price) || 0) * (Number(r.quantity) || 0);
        }, 0);
        return sum + unitCost * (Number(l.qty) || 0);
      }, 0);
      if (recipeCost > 0) return recipeCost;
    } catch (_) {}
    return (s.cogs != null) ? Number(s.cogs) : Calc.saleTotals(s).cogs;
  }
  function saleGP(s) {
    const rev = saleRevenue(s);
    const cogs = saleCOGS(s);
    if (s.gp != null && Number(s.cogs) > 0) return Number(s.gp);
    return rev - cogs;
  }

  function sumRevenue(sales, start, end) {
    return sales.filter(s => inRange(s.date, start, end))
      .reduce((sum, s) => sum + saleRevenue(s), 0);
  }

  function sumGP(sales, start, end) {
    return sales.filter(s => inRange(s.date, start, end))
      .reduce((sum, s) => sum + saleGP(s), 0);
  }

  function sumExp(expenses, start, end) {
    return expenses.filter(e => inRange(e.date, start, end))
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }

  // ── TOAST ──────────────────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
    el.innerHTML = `<span>${msg}</span><button class="btn btn-ghost btn-sm" style="padding:2px 6px;">✕</button>`;
    el.querySelector('button').onclick = () => el.remove();
    $('#toastContainer').appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  function setupLogin() {
    $('#forgotPasswordLink').addEventListener('click', e => {
      e.preventDefault();
      alert('Please ask the Owner to reset your password in Settings > Account Management.');
    });

    checkSession();

    $('#loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const u   = $('#loginUsername').value.trim();
      const p   = $('#loginPassword').value;
      const rem = $('#loginRemember').checked;
      const err = $('#loginError');

      // Show loading state
      const btn = $('#loginForm').querySelector('[type=submit]');
      const origText = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }

      const matched = await getUserByCredentials(u, p);

      if (btn) { btn.disabled = false; btn.textContent = origText; }

      if (matched) {
        sessionStorage.setItem('r_in', '1');
        sessionStorage.setItem('r_role', matched.role);
        if (rem) { localStorage.setItem('r_rem', '1'); localStorage.setItem('r_role', matched.role); }
        state.role = matched.role;
        StorageAPI.setSessionUser(matched.display_name || matched.username, rem);
        $('#loginScreen').classList.remove('active');
        $('#appMain').classList.remove('hidden');
        $('#loginForm').reset();
        err.style.display = 'none';
        boot();
      } else {
        err.textContent = 'Invalid username or password.';
        err.style.display = 'block';
        $('#loginPassword').value = '';
        $('#loginPassword').focus();
      }
    });

    $('#logoutBtn').addEventListener('click', () => {
      if (!confirm('Log out?')) return;
      ['r_in', 'r_role'].forEach(k => sessionStorage.removeItem(k));
      ['r_rem', 'r_role'].forEach(k => localStorage.removeItem(k));
      state.role = null; state.booted = false;
      StorageAPI.clearSessionUser();
      const badge = $('#roleBadge'); if (badge) badge.remove();
      const ub = $('#userBadge'); if (ub) ub.remove();
      $('#appMain').classList.add('hidden');
      $('#loginScreen').classList.add('active');
      $('#loginForm').reset();
      $('#loginUsername').focus();
      $('#toastContainer').innerHTML = '';
    });
  }

  function checkSession() {
    const ok = sessionStorage.getItem('r_in') || localStorage.getItem('r_rem');
    const role = sessionStorage.getItem('r_role') || localStorage.getItem('r_role');
    if (ok && role) {
      state.role = role;
      $('#loginScreen').classList.remove('active');
      $('#appMain').classList.remove('hidden');
      boot();
    }
  }

  function isOwner() { return state.role === 'owner'; }

  function applyRoleUI() {
    $$('.nav-link').forEach(btn => {
      btn.style.display = (!isOwner() && OWNER_ONLY.includes(btn.dataset.section)) ? 'none' : '';
    });
    // Hide account management from non-owners
    const amf = $('#accountMgmtFieldset');
    if (amf) amf.style.display = isOwner() ? '' : 'none';
    if (!isOwner() && !$('#roleBadge')) {
      const b = document.createElement('span');
      b.id = 'roleBadge';
      b.textContent = '👷 Staff Mode';
      b.style.cssText = 'font-size:12px;background:var(--green-bg);color:var(--green);padding:4px 10px;border-radius:20px;font-weight:600;border:1px solid #A5D6A7;';
      $('.header-actions').prepend(b);
    }
    let userBadge = $('#userBadge');
    if (!userBadge) {
      userBadge = document.createElement('span');
      userBadge.id = 'userBadge';
      userBadge.style.cssText = 'font-size:12px;background:#E3F2FD;color:#1565C0;padding:4px 10px;border-radius:20px;font-weight:600;border:1px solid #90CAF9;margin-right:6px;';
      $('.header-actions').prepend(userBadge);
    }
    userBadge.textContent = '👤 ' + StorageAPI.getSessionUser();
  }

  function guardSection(sec) {
    if (!isOwner() && OWNER_ONLY.includes(sec)) {
      $$('.section').forEach(s => s.classList.remove('active'));
      let el = $('#noAccess');
      if (!el) {
        el = document.createElement('div');
        el.id = 'noAccess';
        el.className = 'section active';
        el.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:16px;';
        el.innerHTML = '<div style="font-size:60px;">🔒</div><h2 style="color:var(--green)">Access Restricted</h2><p style="color:var(--muted);text-align:center;">This section is only visible to the owner.</p>';
        $('.content').appendChild(el);
      }
      el.style.display = 'flex';
      return true;
    }
    const el = $('#noAccess'); if (el) el.style.display = 'none';
    return false;
  }

  // ── THEME ──────────────────────────────────────────────────────────────────
  let _themeReady = false;
  function setupTheme() {
    const s = StorageAPI.getSettings();
    if (s.theme === 'contrast') document.documentElement.setAttribute('data-theme', 'contrast');
    if (!_themeReady) {
      _themeReady = true;
      $('#themeToggle').addEventListener('click', () => {
        const isC = document.documentElement.getAttribute('data-theme') === 'contrast';
        if (isC) { document.documentElement.removeAttribute('data-theme'); s.theme = 'light'; }
        else { document.documentElement.setAttribute('data-theme', 'contrast'); s.theme = 'contrast'; }
        StorageAPI.saveSettings(s);
      });
    }
  }

  // ── NAV ────────────────────────────────────────────────────────────────────
  let _navReady = false;
  function setupNav() {
    if (_navReady) return;
    _navReady = true;
    $$('.nav-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.section;
        if (guardSection(sec)) return;

        $$('.nav-link').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.section').forEach(s => s.classList.remove('active'));
        $('#' + sec).classList.add('active');

        if (sec === 'inventory' && btn.dataset.type) {
          state.inventoryType = btn.dataset.type;
          renderInventory();
        }
        if (sec === 'menu')        renderMenu();
        if (sec === 'reports')     renderReports();
        if (sec === 'staff')       renderStaff();
        if (sec === 'discountlog') renderDiscountLog();
      });
    });
  }

  // ── DATALISTS ──────────────────────────────────────────────────────────────
  function refreshDatalists() {
    const s = StorageAPI.getSettings() || {};
    const invCats = StorageAPI.getInventory().map(i => i.category).filter(Boolean);
    const cats = Array.from(new Set([...(s.categories || []), ...invCats])).sort();
    const sups = Array.from(new Set(s.suppliers || [])).sort();
    const catEl = $('#categoryList'); if (catEl) catEl.innerHTML = cats.map(c => `<option value="${c}">`).join('');
    const supEl = $('#supplierList'); if (supEl) supEl.innerHTML = sups.map(s => `<option value="${s}">`).join('');
  }

  // ── DASHBOARD ──────────────────────────────────────────────────────────────

  // Dashboard filter state
  const dashFilter = { preset: 'today', start: null, end: null };

  let _dashFilterReady = false;
  function setupDashboardFilter() {
    if (!_dashFilterReady) {
      _dashFilterReady = true;
      $('#dashFilterApply').addEventListener('click', () => {
      const s = $('#dashFilterStart').value;
      const e = $('#dashFilterEnd').value;
      if (!s && !e) { toast('Pick at least one date to filter', 'error'); return; }
      if (s && e && s > e) { toast('Start date must be before end date', 'error'); return; }
      dashFilter.start = s || null;
      dashFilter.end   = e || null;
      renderDashboard();
    });

    $('#dashFilterClear').addEventListener('click', () => {
      $('#dashFilterStart').value = '';
      $('#dashFilterEnd').value   = '';
      dashFilter.start = null;
      dashFilter.end   = null;
      $('#dashFilteredStrip').style.display = 'none';
      renderDashboard();
    });

    $('#dashPrintBtn').addEventListener('click', printDashboard);

    // Populate year selector + re-render chart on change
    const yearSel = $('#dashChartYear');
    if (yearSel) {
      const currentYear = new Date().getFullYear();
      const sales = StorageAPI.getSales();
      // Collect all years that have data + current year + 4 years back
      const yearSet = new Set([String(currentYear)]);
      for (let y = currentYear - 4; y < currentYear; y++) yearSet.add(String(y));
      sales.forEach(s => yearSet.add(s.date.slice(0, 4)));
      const sortedYears = Array.from(yearSet).sort((a, b) => b - a);
      yearSel.innerHTML = sortedYears
        .map(y => `<option value="${y}" ${y === String(currentYear) ? 'selected' : ''}>${y}</option>`)
        .join('');
      yearSel.addEventListener('change', renderDashboard);
    }
    } // end _dashFilterReady
  }

  function renderDashboard() {
    const items     = StorageAPI.getInventory();
    const sales     = StorageAPI.getSales();
    const expenses  = StorageAPI.getExpenses();
    const payroll   = StorageAPI.getPayroll();
    const s         = StorageAPI.getSettings();
    const threshold = Number(s.lowStockThreshold) || 10;

    // Merge payroll into expenses as normalised expense rows so all
    // expense totals, KPIs, the filtered strip, and the chart all
    // treat payroll as an operational cost automatically.
    const allExpenses = [...expenses, ...Calc.payrollToExpenses(payroll)];

    const td      = today();
    const wkStart = getWeekStart();
    const { start: mStart, end: mEnd } = getMonthRange();
    const { start: yStart, end: yEnd } = getYearRange();

    // Today's date label
    const dl = $('#dashDateLabel');
    if (dl) dl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // ── Always-visible KPI rows (fixed periods) ──
    $('#kpiTodaySales').textContent    = cur(sumRevenue(sales, td, td));
    $('#kpiTodayGP').textContent       = cur(sumGP(sales, td, td));
    $('#kpiWeekSales').textContent     = cur(sumRevenue(sales, wkStart, td));
    $('#kpiMonthSales').textContent    = cur(sumRevenue(sales, mStart, mEnd));
    $('#kpiYearSales').textContent     = cur(sumRevenue(sales, yStart, yEnd));

    // Expenses KPIs now include payroll
    const monthExp = sumExp(allExpenses, mStart, mEnd);
    const yearExp  = sumExp(allExpenses, yStart, yEnd);
    const monthNP  = sumGP(sales, mStart, mEnd) - monthExp;
    const yearNP   = sumGP(sales, yStart, yEnd) - yearExp;
    $('#kpiMonthExpenses').textContent = cur(monthExp);
    $('#kpiYearExpenses').textContent  = cur(yearExp);
    $('#kpiMonthNP').textContent       = cur(monthNP);
    $('#kpiYearNP').textContent        = cur(yearNP);
    $('#kpiMonthNP').style.color       = monthNP >= 0 ? 'var(--green)' : 'var(--red)';
    $('#kpiYearNP').style.color        = yearNP  >= 0 ? 'var(--green)' : 'var(--red)';
    $('#kpiStockValue').textContent    = cur(Calc.totalStockValue(items));

    // ── Filtered strip (shown when date filter is active) ──
    const fs    = dashFilter.start;
    const fe    = dashFilter.end;
    const strip = $('#dashFilteredStrip');

    if (fs || fe) {
      const fSales = sales.filter(s => inRange(s.date, fs, fe));
      // Include payroll in filtered expenses for the strip
      const fExp   = allExpenses.filter(e => inRange(e.date, fs, fe));

      const rev = fSales.reduce((sum, s) => sum + saleRevenue(s), 0);
      const gp  = fSales.reduce((sum, s) => sum + saleGP(s), 0);
      const exp = fExp.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
      const np  = gp - exp;

      const fromLbl = fs || '—';
      const toLbl   = fe || '—';
      $('#dashStripLabel').textContent = `📅 ${fromLbl}  →  ${toLbl}`;
      $('#stripRevenue').textContent   = cur(rev);
      $('#stripGP').textContent        = cur(gp);
      $('#stripExp').textContent       = cur(exp);
      $('#stripNP').textContent        = cur(np);
      $('#stripNP').style.color        = np >= 0 ? 'var(--green)' : 'var(--red)';
      $('#stripTxn').textContent       = fSales.length;
      strip.style.display              = 'block';

    } else {
      strip.style.display = 'none';
    }

    // Chart — fixed Jan to Dec for selected year; allExpenses includes payroll
    const chartYear = Number($('#dashChartYear').value) || new Date().getFullYear();
    const grouped   = Calc.groupByCalendarYear(sales, allExpenses, chartYear);
    $('#dashChartLabel').textContent = `Sales vs Expenses (incl. Payroll) — Jan to Dec ${chartYear}`;
    renderDashChart(grouped);

    // Low stock alerts
    const low = items.filter(i => {
      const qty = Number(i.stock_qty) || 0;
      const rl  = Number(i.reorder_level) ?? threshold;
      return qty <= rl;
    });
    const alertList = $('#alertList');
    alertList.innerHTML = low.length
      ? low.map(i => `<li class="low">⚠️ <strong>${i.name}</strong> — ${i.stock_qty} ${i.unit || 'pcs'} remaining (alert ≤ ${Number(i.reorder_level) ?? threshold})</li>`).join('')
      : '<li class="ok">✅ All stock levels are good</li>';
  }

  function renderDashChart(grouped) {
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('#salesExpensesChart'), {
      type: 'line',
      data: {
        labels: grouped.labels,
        datasets: [
          { label: 'Sales Revenue', data: grouped.salesTotals, borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,0.08)', fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#2E7D32', pointBorderColor: '#fff', pointBorderWidth: 2 },
          { label: 'Expenses',      data: grouped.expTotals,   borderColor: '#D32F2F', backgroundColor: 'rgba(211,47,47,0.08)',  fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#D32F2F', pointBorderColor: '#fff', pointBorderWidth: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: true, aspectRatio: 2.5,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, font: { size: 12, weight: '600' }, padding: 16 } },
          tooltip: { backgroundColor: 'rgba(0,0,0,0.82)', titleFont: { size: 13 }, bodyFont: { size: 12 }, padding: 10 }
        },
        scales: {
          x: { ticks: { color: '#6B7280', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { ticks: { color: '#6B7280', font: { size: 11 }, callback: v => cur(v) }, grid: { color: 'rgba(0,0,0,0.04)' } }
        }
      }
    });
  }


  // ── INVENTORY ──────────────────────────────────────────────────────────────
  function renderInventory() {
    const items = StorageAPI.getInventory();
    const s = StorageAPI.getSettings();
    const threshold = Number(s.lowStockThreshold) || 10;
    const type = state.inventoryType;
    const search = ($('#invSearch').value || '').toLowerCase();
    const cat = $('#invFilterCategory').value;
    const sup = $('#invFilterSupplier').value;
    const lowOnly = $('#invFilterLowStock').checked;

    const labels = { kitchen: '🍳 Kitchen Stock', beverage: '🥤 Beverage Stock', stockroom: '📦 Stock Room', pastry: '🥐 Pastry Stock', takeout: '🥡 Takeout Stock' };
    $('#inventoryTitle').textContent = labels[type] || 'Inventory';

    const filtered = items.filter(it => {
      if (it.inventory_type !== type) return false;
      if (search && !JSON.stringify(it).toLowerCase().includes(search)) return false;
      if (cat && it.category !== cat) return false;
      if (sup && it.supplier !== sup) return false;
      if (lowOnly) {
        const qty = Number(it.stock_qty) || 0;
        const rl  = Number(it.reorder_level) ?? threshold;
        if (qty > rl) return false;
      }
      return true;
    });

    $('#inventoryTbody').innerHTML = filtered.length ? filtered.map(it => {
      const qty = Number(it.stock_qty) || 0;
      const rl  = Number(it.reorder_level) ?? threshold;
      const isLow = qty <= rl;
      return `<tr style="${isLow ? 'background:#FFF5F5;' : ''}">
        <td><strong>${it.name}</strong>${isLow ? ' <span style="color:var(--red);font-size:11px;font-weight:700;">⚠ LOW</span>' : ''}</td>
        <td>${it.category || '—'}</td>
        <td>${it.unit || '—'}</td>
        <td>
          <div class="qty-cell">
            <span class="qty-display" data-id="${it.id}">${qty}</span>
            <div class="qty-controls">
              <div class="qty-row">
                <button class="btn btn-ghost btn-sm btn-icon qty-dec" data-id="${it.id}" title="Remove 1">−</button>
                <input  class="qty-input" type="number" min="0.01" step="0.01" placeholder="qty" data-id="${it.id}" data-dir="out" />
                <button class="btn qty-out-btn" data-id="${it.id}" title="Stock Out">Out</button>
              </div>
              <div class="qty-row">
                <button class="btn btn-ghost btn-sm btn-icon qty-inc" data-id="${it.id}" title="Add 1">+</button>
                <input  class="qty-input" type="number" min="0.01" step="0.01" placeholder="qty" data-id="${it.id}" data-dir="in" />
                <button class="btn qty-in-btn" data-id="${it.id}" title="Stock In">In</button>
              </div>
            </div>
          </div>
        </td>
        <td>${rl ?? '—'}</td>
        <td>${it.cost_price ? cur(it.cost_price) : '—'}</td>
        <td>${it.sell_price ? cur(it.sell_price) : '—'}</td>
        <td>${it.supplier || '—'}</td>
        <td>${it.supplier_use || '—'}</td>
        <td style="font-size:12px;color:var(--muted);">${it.updated_at ? new Date(it.updated_at).toLocaleString() : '—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${it.id}">Edit</button>
          <button class="btn btn-secondary btn-sm" data-act="restock" data-id="${it.id}">Restock</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-id="${it.id}">Delete</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="11" class="no-data-placeholder">No items found</td></tr>';

    // Populate filter dropdowns
    const typeItems = items.filter(i => i.inventory_type === type);
    const cats = Array.from(new Set(typeItems.map(i => i.category).filter(Boolean)));
    const sups = Array.from(new Set(typeItems.map(i => i.supplier).filter(Boolean))).sort();
    const pCat = $('#invFilterCategory').value, pSup = $('#invFilterSupplier').value;
    $('#invFilterCategory').innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option ${c === pCat ? 'selected' : ''}>${c}</option>`).join('');
    $('#invFilterSupplier').innerHTML = '<option value="">All Suppliers</option>' + sups.map(s => `<option ${s === pSup ? 'selected' : ''}>${s}</option>`).join('');

    // ±1 quick buttons
    $$('#inventoryTbody .qty-inc').forEach(btn => btn.addEventListener('click', () => adjustQty(btn.dataset.id,  1)));
    $$('#inventoryTbody .qty-dec').forEach(btn => btn.addEventListener('click', () => adjustQty(btn.dataset.id, -1)));

    // Bulk In — type a number then click In (or press Enter)
    $$('#inventoryTbody .qty-in-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = btn.closest('.qty-row').querySelector('.qty-input');
        const val = Number(inp.value);
        if (!val || val <= 0) { toast('Enter a valid quantity to add', 'error'); inp.focus(); return; }
        adjustQty(btn.dataset.id, val); inp.value = '';
      });
    });

    // Bulk Out — type a number then click Out (or press Enter)
    $$('#inventoryTbody .qty-out-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = btn.closest('.qty-row').querySelector('.qty-input');
        const val = Number(inp.value);
        if (!val || val <= 0) { toast('Enter a valid quantity to remove', 'error'); inp.focus(); return; }
        adjustQty(btn.dataset.id, -val); inp.value = '';
      });
    });

    // Enter key inside qty inputs fires the button
    $$('#inventoryTbody .qty-input').forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return; e.preventDefault();
        inp.closest('.qty-row').querySelector(inp.dataset.dir === 'in' ? '.qty-in-btn' : '.qty-out-btn')?.click();
      });
    });

    $$('#inventoryTbody [data-act="edit"], #inventoryTbody [data-act="restock"], #inventoryTbody [data-act="delete"]').forEach(btn =>
      btn.addEventListener('click', onInvAction)
    );

    renderStockLog();
  }

  function adjustQty(id, delta) {
    const it = StorageAPI.getItemById(id); if (!it) return;
    const prev   = Number(it.stock_qty) || 0;
    const newQty = Math.max(0, prev + delta);
    it.stock_qty  = newQty;
    it.updated_at = new Date().toISOString();
    StorageAPI.upsertItem(it);

    const logEntry = { item_id: id, item_name: it.name, inventory_type: it.inventory_type,
      type: delta > 0 ? 'in' : 'out', qty: Math.abs(delta), balance: newQty,
      note: 'Manual adjustment', date: it.updated_at };
    StorageAPI.addStockLog(logEntry);

    // Update qty display inline — no full table rebuild
    const disp = document.querySelector(`#inventoryTbody .qty-display[data-id="${id}"]`);
    if (disp) disp.textContent = newQty;

    // Update low-stock row highlight + badge inline
    const s = StorageAPI.getSettings();
    const rl = Number(it.reorder_level) || Number(s.lowStockThreshold) || 10;
    const row = disp?.closest('tr');
    if (row) {
      row.style.background = newQty <= rl ? '#FFF5F5' : '';
      const badge = row.querySelector('.low-badge');
      if (newQty <= rl && !badge)
        row.querySelector('td strong')?.insertAdjacentHTML('afterend',
          ' <span class="low-badge" style="color:var(--red);font-size:11px;font-weight:700;">⚠ LOW</span>');
      else if (newQty > rl && badge) badge.remove();
    }

    // Inject log row live — no full log rebuild
    injectLogRow(logEntry);
    renderDashboard();
    toast(`${delta > 0 ? '+' : ''}${delta} ${it.unit || 'pcs'} — ${it.name} → ${newQty}`);
  }

  function onInvAction(e) {
    const id = e.currentTarget.dataset.id, act = e.currentTarget.dataset.act;
    if (act === 'edit')    openItemDialog(id);
    if (act === 'restock') openRestockDialog(id);
    if (act === 'delete') {
      if (!confirm(`Delete "${StorageAPI.getItemById(id)?.name}"? This cannot be undone.`)) return;
      StorageAPI.deleteItem(id);
      toast('Item deleted'); renderInventory(); renderDashboard();
    }
  }

  function renderStockLog() {
    const logs  = StorageAPI.getStockLog();
    const items = StorageAPI.getInventory();
    const fItem  = $('#logFilterItem').value;
    const fType  = $('#logFilterType').value;
    const fStart = $('#logFilterStart').value || null;
    const fEnd   = $('#logFilterEnd').value   || null;

    // Build item_id → inventory_type map for section scoping
    const itemTypeMap = {};
    items.forEach(it => { itemTypeMap[it.id] = it.inventory_type; });
    const currentType = state.inventoryType;

    // Item filter dropdown — only items from this section
    const sectionItems = items.filter(i => i.inventory_type === currentType);
    const pItem = fItem;
    $('#logFilterItem').innerHTML = '<option value="">All Items</option>' +
      sectionItems.map(it => `<option value="${it.id}" ${it.id === pItem ? 'selected' : ''}>${it.name}</option>`).join('');

    const filtered = logs.filter(l => {
      // Section-scope:
      // 1. Try item lookup first (most accurate — works even if log has no inventory_type)
      // 2. Fall back to inventory_type stored on the log row
      // 3. If NEITHER is known (item deleted, old log with no column) → show in ALL sections
      //    so historical data is NEVER hidden from the user
      const fromItem = itemTypeMap[l.item_id];
      const fromLog  = l.inventory_type;
      const logType  = fromItem || fromLog || null;
      if (logType !== null && logType !== currentType) return false;
      if (fItem && l.item_id !== fItem) return false;
      if (fType && l.type    !== fType) return false;
      if (!inRange(l.date, fStart, fEnd)) return false;
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));
    // No artificial row limit — show ALL matching entries grouped by day

    // Group by day
    const grouped = {};
    filtered.forEach(l => {
      const dk = l.date.slice(0, 10);
      (grouped[dk] = grouped[dk] || []).push(l);
    });

    const icons = { in: '📥', out: '📤', sale: '🛒' };
    let html = '';
    const td = today();

    Object.keys(grouped).sort((a, b) => b.localeCompare(a)).forEach(dk => {
      const isToday = dk === td;
      const dayLogs = grouped[dk];
      const label = new Date(dk).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

      html += `<tr class="stock-date-header" data-dk="${dk}">
        <td colspan="7">
          <button class="stock-date-toggle">
            <span class="toggle-icon">▼</span>
            ${label}${isToday ? ' (Today)' : ''} — ${dayLogs.length} entry/entries
          </button>
        </td>
      </tr>`;

      const show = isToday ? 'table-row' : 'none';
      dayLogs.forEach(l => {
        html += `<tr class="stock-day-rows" style="display:${show};">
          <td style="font-size:12px;">${new Date(l.date).toLocaleTimeString()}</td>
          <td>${l.item_name || '—'}</td>
          <td>${icons[l.type] || ''} ${l.type}</td>
          <td style="font-weight:700;color:${l.type === 'in' ? 'var(--green)' : 'var(--red)'};">${l.type === 'in' ? '+' : '-'}${l.qty}</td>
          <td>${l.balance}</td>
          <td style="font-size:12px;color:var(--muted);">${l.note || ''}</td>
          <td style="font-size:12px;font-weight:700;color:#1565C0;">${l.done_by || '—'}</td>
        </tr>`;
      });
    });

    if (!html) html = '<tr><td colspan="7" class="no-data-placeholder">No log entries</td></tr>';

    const tbody = $('#stockLogTbody');
    tbody.innerHTML = html;

    // Toggle rows
    tbody.querySelectorAll('.stock-date-toggle').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const icon = btn.querySelector('.toggle-icon');
        const expanded = icon.textContent === '▼';
        let row = btn.closest('tr').nextElementSibling;
        while (row && !row.classList.contains('stock-date-header')) {
          if (row.classList.contains('stock-day-rows')) row.style.display = expanded ? 'none' : 'table-row';
          row = row.nextElementSibling;
        }
        icon.textContent = expanded ? '▶' : '▼';
      });
    });

    $('#exportLogCsv').onclick = () => StorageAPI.downloadCSV('stock_log.csv', filtered);
  }


  // Live-inject a stock log entry at top of the log table without full rebuild
  function injectLogRow(entry) {
    const tbody = $('#stockLogTbody');
    if (!tbody) return;

    // Section scope — same logic as renderStockLog:
    // only skip if we KNOW the type and it's a different section
    const itemTypeMap = {};
    StorageAPI.getInventory().forEach(it => { itemTypeMap[it.id] = it.inventory_type; });
    const currentType = state.inventoryType;
    const fromItem = itemTypeMap[entry.item_id];
    const fromLog  = entry.inventory_type;
    const logType  = fromItem || fromLog || null;
    if (logType !== null && logType !== currentType) return;

    // Filter scope check
    const fItem  = $('#logFilterItem').value;
    const fType  = $('#logFilterType').value;
    const fStart = $('#logFilterStart').value || null;
    const fEnd   = $('#logFilterEnd').value   || null;
    if (fItem && entry.item_id !== fItem) return;
    if (fType && entry.type    !== fType)  return;
    if (!inRange(entry.date, fStart, fEnd))  return;

    const icons   = { in: '📥', out: '📤', sale: '🛒' };
    const dk      = entry.date.slice(0, 10);
    const isToday = dk === today();

    // Build the data row
    const dataRow = document.createElement('tr');
    dataRow.className = 'stock-day-rows';
    dataRow.style.display = 'table-row';
    dataRow.innerHTML = `
      <td style="font-size:12px;">${new Date(entry.date).toLocaleTimeString()}</td>
      <td>${entry.item_name || '—'}</td>
      <td>${icons[entry.type] || ''} ${entry.type}</td>
      <td style="font-weight:700;color:${entry.type === 'in' ? 'var(--green)' : 'var(--red)'};">${entry.type === 'in' ? '+' : '-'}${entry.qty}</td>
      <td>${entry.balance}</td>
      <td style="font-size:12px;color:var(--muted);">${entry.note || ''}</td>
      <td style="font-size:12px;font-weight:700;color:#1565C0;">${entry.done_by || StorageAPI.getSessionUser()}</td>
    `;

    const existingHeader = tbody.querySelector(`.stock-date-header[data-dk="${dk}"]`);
    if (existingHeader) {
      existingHeader.insertAdjacentElement('afterend', dataRow);
      const toggle = existingHeader.querySelector('.stock-date-toggle');
      if (toggle) toggle.innerHTML = toggle.innerHTML.replace(/(\d+) entry\/entries/, (_, n) => `${Number(n)+1} entry/entries`);
    } else {
      const label = new Date(dk).toLocaleDateString('en-US', { weekday:'short', year:'numeric', month:'short', day:'numeric' });
      const headerRow = document.createElement('tr');
      headerRow.className  = 'stock-date-header';
      headerRow.dataset.dk = dk;
      headerRow.innerHTML  = `<td colspan="7"><button class="stock-date-toggle"><span class="toggle-icon">▼</span> ${label}${isToday?' (Today)':''} — 1 entry/entries</button></td>`;
      headerRow.querySelector('.stock-date-toggle').addEventListener('click', ev => {
        ev.stopPropagation();
        const icon = headerRow.querySelector('.toggle-icon');
        const expanded = icon.textContent === '▼';
        let r = headerRow.nextElementSibling;
        while (r && !r.classList.contains('stock-date-header')) {
          if (r.classList.contains('stock-day-rows')) r.style.display = expanded ? 'none' : 'table-row';
          r = r.nextElementSibling;
        }
        icon.textContent = expanded ? '▶' : '▼';
      });
      tbody.querySelector('.no-data-placeholder')?.closest('tr')?.remove();
      tbody.insertBefore(dataRow,   tbody.firstChild);
      tbody.insertBefore(headerRow, dataRow);
    }
  }

  // ── ITEM DIALOG ────────────────────────────────────────────────────────────
  function openItemDialog(id = null) {
    refreshDatalists();
    if (id) {
      const it = StorageAPI.getItemById(id);
      $('#itemDialogTitle').textContent = 'Edit Item';
      $('#itemId').value = it.id;
      $('#itemInventoryType').value = it.inventory_type || 'kitchen';
      $('#itemName').value = it.name || '';
      $('#itemCategory').value = it.category || '';
      $('#itemUnit').value = it.unit || '';
      $('#itemQty').value = it.stock_qty ?? '';
      $('#itemCostPrice').value = it.cost_price || '';
      $('#itemSellPrice').value = it.sell_price || '';
      $('#itemReorderLevel').value = it.reorder_level || '';
      $('#itemSupplier').value = it.supplier || '';
      $('#itemSupplierUse').value = it.supplier_use || '';
      $('#itemExpiry').value = it.expiry_date || '';
    } else {
      $('#itemDialogTitle').textContent = 'Add Item';
      $('#itemForm').reset();
      $('#itemId').value = '';
      $('#itemInventoryType').value = state.inventoryType;
    }
    $('#itemDialog').showModal();
  }

  let _itemDialogReady = false;
  function setupItemDialog() {
    if (_itemDialogReady) return;
    _itemDialogReady = true;
    $('#addItemBtn').addEventListener('click', () => openItemDialog());
    $('#itemDialogCancel').addEventListener('click', () => $('#itemDialog').close());
    $('#itemForm').addEventListener('submit', e => {
      e.preventDefault();
      const isNew = !$('#itemId').value;
      const id = $('#itemId').value || StorageAPI.uid('item');
      const existing = isNew ? null : StorageAPI.getItemById(id);
      const now = new Date().toISOString();
      const newQty = Number($('#itemQty').value) || 0;
      const prevQty = existing ? (Number(existing.stock_qty) || 0) : 0;

      const item = {
        id,
        inventory_type: $('#itemInventoryType').value || 'kitchen',
        name:         $('#itemName').value.trim(),
        category:     $('#itemCategory').value.trim(),
        unit:         $('#itemUnit').value.trim(),
        stock_qty:    newQty,
        cost_price:   Number($('#itemCostPrice').value) || 0,
        sell_price:   Number($('#itemSellPrice').value) || 0,
        reorder_level: Number($('#itemReorderLevel').value) || 0,
        supplier:     $('#itemSupplier').value.trim(),
        supplier_use: $('#itemSupplierUse').value.trim(),
        expiry_date:  $('#itemExpiry').value || null,
        sku:          existing ? (existing.sku || '') : '',
        created_at:   existing ? existing.created_at : now,
        updated_at:   now
      };

      StorageAPI.upsertItem(item);

      if (isNew && newQty > 0) {
        StorageAPI.addStockLog({ item_id: id, item_name: item.name, inventory_type: item.inventory_type, type: 'in', qty: newQty, balance: newQty, note: 'Initial stock', date: now });
      } else if (!isNew && newQty !== prevQty) {
        const diff = newQty - prevQty;
        StorageAPI.addStockLog({ item_id: id, item_name: item.name, inventory_type: item.inventory_type, type: diff > 0 ? 'in' : 'out', qty: Math.abs(diff), balance: newQty, note: 'Edited via form', date: now });
      }

      $('#itemDialog').close();
      toast(isNew ? 'Item added ✓' : 'Item updated ✓', 'success');
      renderInventory(); renderDashboard(); refreshDatalists();
    });
  }

  // ── RESTOCK DIALOG ─────────────────────────────────────────────────────────
  function openRestockDialog(id) {
    const it = StorageAPI.getItemById(id);
    $('#restockItemId').value = id;
    $('#restockQty').value = '';
    $('#restockNote').value = '';
    $('#restockDialogTitle').textContent = `Restock: ${it ? it.name : ''}`;
    $('#restockDialog').showModal();
  }

  let _restockReady = false;
  function setupRestockDialog() {
    if (_restockReady) return;
    _restockReady = true;
    $('#restockDialogCancel').addEventListener('click', () => $('#restockDialog').close());
    $('#restockForm').addEventListener('submit', e => {
      e.preventDefault();
      const id  = $('#restockItemId').value;
      const qty = Number($('#restockQty').value) || 0;
      const note = $('#restockNote').value.trim();
      if (qty <= 0) { toast('Enter a valid quantity', 'error'); return; }
      const it = StorageAPI.getItemById(id); if (!it) return;
      it.stock_qty = (Number(it.stock_qty) || 0) + qty;
      it.updated_at = new Date().toISOString();
      StorageAPI.upsertItem(it);
      const restockEntry = { item_id: id, item_name: it.name, inventory_type: it.inventory_type,
        type: 'in', qty, balance: it.stock_qty, note: note || 'Restock', date: it.updated_at };
      StorageAPI.addStockLog(restockEntry);
      $('#restockDialog').close();
      toast(`${it.name} restocked +${qty} ✓`, 'success');
      // Update qty display inline
      const disp2 = document.querySelector(`#inventoryTbody .qty-display[data-id="${id}"]`);
      if (disp2) disp2.textContent = it.stock_qty;
      const s2 = StorageAPI.getSettings();
      const rl2 = Number(it.reorder_level) || Number(s2.lowStockThreshold) || 10;
      const row2 = disp2?.closest('tr');
      if (row2) {
        row2.style.background = it.stock_qty <= rl2 ? '#FFF5F5' : '';
        const b2 = row2.querySelector('.low-badge');
        if (it.stock_qty <= rl2 && !b2) row2.querySelector('td strong')?.insertAdjacentHTML('afterend', ' <span class="low-badge" style="color:var(--red);font-size:11px;font-weight:700;">⚠ LOW</span>');
        else if (it.stock_qty > rl2 && b2) b2.remove();
      }
      injectLogRow(restockEntry);
      renderDashboard();
    });
  }

  // ── INVENTORY CSV ──────────────────────────────────────────────────────────
  let _csvReady = false;
  function setupInventoryCsv() {
    if (_csvReady) return;
    _csvReady = true;
    $('#exportInventoryCsv').addEventListener('click', () => {
      StorageAPI.downloadCSV('reserve_inventory.csv', StorageAPI.getInventory().map(it => ({
        id: it.id, inventory_type: it.inventory_type, name: it.name,
        category: it.category, unit: it.unit, stock_qty: it.stock_qty,
        cost_price: it.cost_price, sell_price: it.sell_price,
        reorder_level: it.reorder_level, supplier: it.supplier,
        supplier_use: it.supplier_use, expiry_date: it.expiry_date || '',
        last_updated: it.updated_at || ''
      })));
      toast('Inventory exported ✓');
    });

    $('#importInventoryCsv').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const rows = StorageAPI.parseCSV(ev.target.result);
        const existing = StorageAPI.getInventory();
        rows.forEach(r => {
          existing.push({
            id: r.id || StorageAPI.uid('item'),
            inventory_type: ['kitchen','beverage','stockroom','pastry','takeout'].includes((r.inventory_type||'').toLowerCase()) ? r.inventory_type.toLowerCase() : 'kitchen',
            name: r.name || '', category: r.category || '', unit: r.unit || '',
            stock_qty: Number(r.stock_qty) || 0, cost_price: Number(r.cost_price) || 0,
            sell_price: Number(r.sell_price) || 0, reorder_level: Number(r.reorder_level) || 0,
            supplier: r.supplier || '', supplier_use: r.supplier_use || '',
            expiry_date: r.expiry_date || null,
            created_at: new Date().toISOString(), updated_at: r.last_updated || new Date().toISOString()
          });
        });
        StorageAPI.saveInventory(existing);
        toast(`Imported ${rows.length} item(s) ✓`, 'success');
        renderInventory(); renderDashboard(); e.target.value = '';
      };
      reader.readAsText(file);
    });
  }

  // ── SALES ──────────────────────────────────────────────────────────────────
  function createSaleLine(initial = {}) {
    const s = StorageAPI.getSettings();
    const line = document.createElement('div');
    line.className = 'line-item';
    line.innerHTML = `
      <select class="li-cat"><option value="" disabled selected>Category…</option></select>
      <select class="li-item" disabled><option value="" disabled selected>Item…</option></select>
      <input type="number" step="1" min="1" class="li-qty" placeholder="Qty" value="${initial.qty || 1}" style="text-align:center;" />
      <input type="number" step="0.01" class="li-sell" placeholder="Sell ₱" value="${initial.sell_price || ''}" />
      <input type="number" step="0.01" class="li-cost" placeholder="Cost ₱" value="${initial.cost_price || ''}" />
      <div class="li-total">${cur(0)}</div>
      <button type="button" class="li-remove btn btn-ghost btn-sm btn-icon" title="Remove line">✕</button>`;

    const catSel  = line.querySelector('.li-cat');
    const itemSel = line.querySelector('.li-item');
    const qtyIn   = line.querySelector('.li-qty');
    const sellIn  = line.querySelector('.li-sell');
    const costIn  = line.querySelector('.li-cost');
    const totalEl = line.querySelector('.li-total');

    function refreshCats() {
      const inv  = StorageAPI.getInventory();
      const cats = Array.from(new Set(inv.map(i => i.category).filter(Boolean))).sort();
      const prev = catSel.value;
      catSel.innerHTML = '<option value="" disabled>Category…</option>' +
        cats.map(c => `<option value="${c}" ${c === prev ? 'selected' : ''}>${c}</option>`).join('');
    }
    refreshCats();
    catSel.addEventListener('focus', refreshCats);

    catSel.addEventListener('change', () => {
      const inv = StorageAPI.getInventory();
      const inCat = inv.filter(i => i.category === catSel.value);
      itemSel.innerHTML = '<option value="" disabled selected>Select item…</option>' +
        inCat.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
      itemSel.disabled = false;
      sellIn.value = ''; costIn.value = ''; calc();
    });

    itemSel.addEventListener('change', () => {
      const item = StorageAPI.getInventory().find(i => i.id === itemSel.value);
      if (item) { sellIn.value = item.sell_price || ''; costIn.value = item.cost_price || ''; }
      calc();
    });

    if (initial.item_id) {
      const item = StorageAPI.getInventory().find(i => i.id === initial.item_id);
      if (item) {
        catSel.value = item.category;
        catSel.dispatchEvent(new Event('change'));
        setTimeout(() => { itemSel.value = initial.item_id; itemSel.dispatchEvent(new Event('change')); }, 0);
      }
    }

    function calc() {
      const qty  = Number(qtyIn.value)  || 0;
      const sell = Number(sellIn.value) || 0;
      totalEl.textContent = cur(qty * sell);
      renderSaleTotals();
    }
    [qtyIn, sellIn, costIn].forEach(i => i.addEventListener('input', calc));
    line.querySelector('.li-remove').addEventListener('click', () => { line.remove(); renderSaleTotals(); });
    calc();
    return line;
  }

  function renderSaleTotals() {
    if (!$('#saleLines')) return;
    const lines = $$('#saleLines .line-item');
    const totals = lines.reduce((acc, line) => {
      const t = Calc.lineTotals({
        qty:        Number(line.querySelector('.li-qty').value)  || 0,
        sell_price: Number(line.querySelector('.li-sell').value) || 0,
        cost_price: Number(line.querySelector('.li-cost').value) || 0
      });
      return { revenue: acc.revenue + t.revenue, cogs: acc.cogs + t.cogs, gp: acc.gp + t.gp };
    }, { revenue: 0, cogs: 0, gp: 0 });
    if ($('#saleRevenue')) $('#saleRevenue').textContent = cur(totals.revenue);
    if ($('#saleCogs'))    $('#saleCogs').textContent    = cur(totals.cogs);
    if ($('#saleGP'))      $('#saleGP').textContent      = cur(totals.gp);
  }

  function resetSaleForm() {
    const nowLocal = new Date();
    nowLocal.setMinutes(nowLocal.getMinutes() - nowLocal.getTimezoneOffset());
    if ($('#saleDate'))  $('#saleDate').value = nowLocal.toISOString().slice(0, 16);
    if ($('#saleLines')) { $('#saleLines').innerHTML = ''; $('#saleLines').appendChild(createSaleLine()); }
    renderSaleTotals();
  }

  let _salesReady = false;
  function setupSales() {
    resetSaleForm();
    if (_salesReady) return;
    _salesReady = true;

    if ($('#addSaleLine'))  $('#addSaleLine').addEventListener('click', () => $('#saleLines').appendChild(createSaleLine()));
    if ($('#saleCancelBtn')) $('#saleCancelBtn').addEventListener('click', resetSaleForm);

    if ($('#saleSubmitBtn')) $('#saleSubmitBtn').addEventListener('click', () => {
      const inv = StorageAPI.getInventory();
      const lines = $$('#saleLines .line-item').map(line => {
        const sel  = line.querySelector('.li-item');
        const item = inv.find(i => i.id === sel.value);
        return {
          item_id:    sel.value || undefined,
          item_name:  item ? item.name : '',
          qty:        Number(line.querySelector('.li-qty').value)  || 0,
          sell_price: Number(line.querySelector('.li-sell').value) || 0,
          cost_price: Number(line.querySelector('.li-cost').value) || 0
        };
      }).filter(l => l.qty > 0 && l.item_id);

      if (!lines.length) { toast('Please select at least one item', 'error'); return; }
      const noPrice = lines.find(l => !l.sell_price);
      if (noPrice) { toast(`Enter a sell price for "${noPrice.item_name}"`, 'error'); return; }

      const saleDate = $('#saleDate').value;
      if (!saleDate) { toast('Please set the sale date and time', 'error'); return; }

      const _t = Calc.saleTotals({ lines });
      const sale = {
        id:      StorageAPI.uid('sale'),
        date:    new Date(saleDate).toISOString(),
        lines,
        revenue: _t.revenue,
        cogs:    _t.cogs,
        gp:      _t.gp
      };

      // Deduct stock + log
      lines.forEach(l => {
        const item = StorageAPI.getItemById(l.item_id);
        if (item) {
          item.stock_qty = Math.max(0, (Number(item.stock_qty) || 0) - l.qty);
          item.updated_at = new Date().toISOString();
          StorageAPI.upsertItem(item);
          StorageAPI.addStockLog({ item_id: l.item_id, item_name: l.item_name, inventory_type: item.inventory_type, type: 'sale', qty: l.qty, balance: item.stock_qty, note: `Sale ${sale.id}`, date: sale.date });
        }
      });

      StorageAPI.addSale(sale);
      toast(`Sale of ${cur(sale.revenue)} recorded ✓`, 'success');
      resetSaleForm();
      renderDashboard(); renderInventory(); renderSalesHistory();
    }); // end saleSubmitBtn

    // Tabs
    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      const panel = $('#' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
      if (btn.dataset.tab === 'salesWeekly')  renderSalesWeekly();
      if (btn.dataset.tab === 'salesMonthly') renderSalesMonthly();
      if (btn.dataset.tab === 'salesYearly')  renderSalesYearly();
      if (btn.dataset.tab === 'salesPerItem') renderSalesPerItem();
    }));

    // Sales month picker — event wiring only; dropdown is built/refreshed inside renderSalesHistory()
    (function() {
      const sel = $('#salesFilterMonth');
      if (sel) {
        sel.addEventListener('change', () => { applySalesMonthFilter(sel.value); renderSalesHistory(); });
      }
      const allBtn = $('#salesFilterAll');
      if (allBtn) allBtn.addEventListener('click', () => {
        $('#salesFilterStart').value = '';
        $('#salesFilterEnd').value   = '';
        if ($('#salesFilterMonth')) $('#salesFilterMonth').value = '';
        renderSalesHistory();
      });
    })();
    ['salesFilterItem'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('input', renderSalesHistory); });
    $('#perItemApply').addEventListener('click', renderSalesPerItem);
    $('#exportPerItemCsv').addEventListener('click', exportPerItemCsv);
  }

  // Mirror of the deduction logic in recordMenuSale — runs in reverse on delete
  function restoreSaleStock(sale) {
    const inv = StorageAPI.getInventory();

    // Rebuild the same deductMap that was used when the sale was recorded
    const restoreMap = {};
    for (const line of (sale.lines || [])) {
      const product = StorageAPI.getMenuProductById(line.item_id);
      if (!product?.recipes?.length) continue;
      for (const r of product.recipes) {
        if (!r.inventory_item_id) continue;
        const needed = Number(r.quantity) * (Number(line.qty) || 0);
        if (!restoreMap[r.inventory_item_id]) {
          restoreMap[r.inventory_item_id] = {
            item: inv.find(i => i.id === r.inventory_item_id) || null,
            ingredient_name: r.ingredient_name || r.inventory_item_id,
            unit: r.unit || '',
            qty: 0
          };
        }
        restoreMap[r.inventory_item_id].qty += needed;
      }
    }

    if (!Object.keys(restoreMap).length) return; // no recipes — nothing to restore

    const restored = [];
    for (const [itemId, d] of Object.entries(restoreMap)) {
      if (!d.item) continue;
      const newQty = (Number(d.item.stock_qty) || 0) + d.qty;
      d.item.stock_qty  = newQty;
      d.item.updated_at = new Date().toISOString();
      StorageAPI.upsertItem(d.item);
      const logEntry = {
        item_id:        itemId,
        item_name:      d.ingredient_name,
        inventory_type: d.item.inventory_type,
        type:           'return',
        qty:            d.qty,
        balance:        newQty,
        note:           `Sale voided — ${sale.id}`,
        date:           new Date().toISOString()
      };
      StorageAPI.addStockLog(logEntry);
      injectLogRow(logEntry);
      restored.push(`${d.ingredient_name} +${d.qty}${d.unit}`);
    }

    if (restored.length) {
      toast(`♻️ Stock restored: ${restored.join(', ')}`, 'success');
      renderInventory();
    }
  }

  function serviceChargeBadge(sale) {
    const amt  = Number(sale.service_charge_amt) || 0;
    const type = sale.service_charge_type;
    if (!type || type === 'none' || amt === 0) return `<span style="color:var(--muted);font-size:11px;">—</span>`;
    const label = type === 'percent' ? 'Service (%)' : 'Service (Fixed)';
    return `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;">
      <span style="background:#E3F2FD;color:#1565C0;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;white-space:nowrap;">${label}</span>
      <span style="font-size:11px;color:#1565C0;font-weight:600;">${cur(amt)}</span>
    </span>`;
  }

  function discountBadge(sale) {
    const type  = sale.discount_type;
    const amt   = Number(sale.discount_amt) || 0;

    // Per-item discounts from lines
    const itemDiscLines = (sale.lines || []).filter(l => l.item_discount && l.item_discount.type && l.item_discount.type !== 'none');
    const itemDiscTotal = itemDiscLines.reduce((s, l) =>
      s + Calc.lineDiscount({ qty: l.qty, sell_price: l.sell_price || l.price || 0, item_discount: l.item_discount }), 0);

    const hasOrderDisc = type && type !== 'none' && amt > 0;
    const hasItemDisc  = itemDiscTotal > 0;

    if (!hasOrderDisc && !hasItemDisc) return `<span style="color:var(--muted);font-size:11px;">—</span>`;

    let html = `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;gap:3px;">`;

    // Per-item discounts — one row per discounted line
    if (hasItemDisc) {
      itemDiscLines.forEach(l => {
        const d = l.item_discount;
        const discAmt = Calc.lineDiscount({ qty: l.qty, sell_price: l.sell_price || l.price || 0, item_discount: d });
        const discType = d.type === 'senior' ? '20% Senior/PWD' : d.type === 'percent' ? `${d.value}% off` : d.type === 'fixed' ? `Fixed ₱${Number(d.value).toFixed(2)}` : d.type;
        html += `<span style="font-size:11px;white-space:nowrap;">
          <span style="background:#E8F5E9;color:#2E7D32;border-radius:4px;padding:1px 5px;font-weight:700;">${l.item_name}</span>
          <span style="color:#c00;font-weight:600;"> −${cur(discAmt)}</span>
          <span style="color:var(--muted);"> ${discType}</span>
        </span>`;
      });
    }

    // Order-level discount — existing logic unchanged
    if (hasOrderDisc) {
      let label = '';
      if      (type === 'senior')  label = 'Senior/PWD';
      else if (type === 'percent') label = `${sale.discount_pct || ''}% Off`.trim();
      else if (type === 'fixed')   label = 'Fixed';
      else if (type === 'other')   label = sale.discount_label || 'Custom';
      else                         label = type;
      html += `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;">
        <span style="background:#FFF3E0;color:#E65100;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;white-space:nowrap;">${label}</span>
        <span style="font-size:11px;color:#c00;font-weight:600;">−${cur(amt)}</span>
      </span>`;
    }

    html += `</span>`;
    return html;
  }

  function mopBadge(sale) {
    const mop = sale.payment_method || 'Cash';
    const colors = {
      Cash:  { bg: '#F0FDF4', color: '#15803D', border: '#86EFAC' },
      Card:  { bg: '#EFF6FF', color: '#1D4ED8', border: '#93C5FD' },
      QRPH:  { bg: '#FDF4FF', color: '#7C3AED', border: '#C4B5FD' },
      GCash: { bg: '#FFF7ED', color: '#C2410C', border: '#FED7AA' }
    };
    const c = colors[mop] || colors.Cash;
    const icons = { Cash: '💵', Card: '💳', QRPH: '📱', GCash: '📲' };
    return `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;background:${c.bg};color:${c.color};border:1px solid ${c.border};white-space:nowrap;">${icons[mop] || ''} ${mop}</span>`;
  }

  function renderSalesHistory() {
    const sales  = StorageAPI.getSales();

    // Rebuild month dropdown from live cache every render — always reflects all loaded data.
    // Preserve the currently-selected month across rebuilds.
    (function() {
      const sel = $('#salesFilterMonth');
      if (!sel) return;
      const prevVal = sel.value;
      buildMonthOptions(sales.map(s => s.date), 'salesFilterMonth', !prevVal);
      if (prevVal && Array.from(sel.options).some(o => o.value === prevVal)) {
        sel.value = prevVal;
      }
      applySalesMonthFilter(sel.value);
    })();

    const start  = $('#salesFilterStart').value || null;
    const end    = $('#salesFilterEnd').value   || null;
    const term   = ($('#salesFilterItem').value || '').toLowerCase();
    const td     = today();

    const filtered = sales
      .filter(s => inRange(s.date, start, end))
      .filter(s => !term || s.lines.map(l => (l.item_name || '').toLowerCase()).join(' ').includes(term));

    const grouped = {};
    filtered.forEach(s => {
      const dk = s.date.slice(0, 10);
      (grouped[dk] = grouped[dk] || []).push(s);
    });

    let html = '';
    Object.keys(grouped).sort((a, b) => b.localeCompare(a)).forEach(dk => {
      const isToday  = dk === td;
      const daySales = grouped[dk];
      const dayRev   = daySales.reduce((sum, s) => sum + (s.revenue || 0), 0);
      const label    = new Date(dk).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

      html += `<tr class="sales-date-header" data-dk="${dk}">
        <td colspan="10">
          <button class="sales-date-toggle">
            <span class="toggle-icon">▼</span>
            ${label}${isToday ? ' (Today)' : ''} — ${daySales.length} sale(s) &nbsp;·&nbsp; ${cur(dayRev)}
          </button>
        </td>
      </tr>`;

      const show = isToday ? 'table-row' : 'none';
      daySales.forEach(sale => {
        const items = sale.lines.map(l => `${l.item_name} ×${l.qty}`).join(', ');
        html += `<tr class="sales-day-rows" style="display:${show};">
          <td style="font-size:12px;">${new Date(sale.date).toLocaleTimeString()}</td>
          <td>${items}</td>
          <td>${cur(sale.revenue)}</td>
          <td>${cur(sale.cogs)}</td>
          <td style="color:var(--green);font-weight:600;">${cur(sale.gp || (sale.revenue - sale.cogs))}</td>
          <td>${discountBadge(sale)}</td>
          <td>${serviceChargeBadge(sale)}</td>
          <td>${mopBadge(sale)}</td>
          <td style="font-size:12px;font-weight:700;color:#1565C0;">${sale.done_by || '—'}</td>
          <td><button class="btn btn-danger btn-sm" data-act="del" data-id="${sale.id}">Delete</button></td>
        </tr>`;
      });
    });

    if (!html) html = '<tr><td colspan="10" class="no-data-placeholder">No sales found</td></tr>';

    const tbody = $('#salesTbody');
    tbody.innerHTML = html;

    // Toggle rows
    tbody.querySelectorAll('.sales-date-toggle').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const icon = btn.querySelector('.toggle-icon');
        const expanded = icon.textContent === '▼';
        let row = btn.closest('tr').nextElementSibling;
        while (row && !row.classList.contains('sales-date-header')) {
          if (row.classList.contains('sales-day-rows')) row.style.display = expanded ? 'none' : 'table-row';
          row = row.nextElementSibling;
        }
        icon.textContent = expanded ? '▶' : '▼';
      });
    });

    tbody.querySelectorAll('[data-act="del"]').forEach(btn => btn.addEventListener('click', () => {
      if (!confirm('Delete this sale? The ingredients used will be returned to inventory.')) return;
      // Must fetch the sale BEFORE deleteSale removes it from cache
      const sale = StorageAPI.getSales().find(s => s.id === btn.dataset.id);
      if (sale) restoreSaleStock(sale);
      StorageAPI.deleteSale(btn.dataset.id);
      toast('Sale deleted');
      renderSalesHistory();
      renderDashboard();
    }));

    $('#exportSalesCsv').onclick = () => {
      StorageAPI.downloadCSV('sales.csv', filtered.map(s => ({
        id: s.id, date: s.date,
        items: s.lines.map(l => `${l.item_name} x${l.qty}`).join('; '),
        revenue: s.revenue, cogs: s.cogs, gross_profit: s.gp || (s.revenue - s.cogs)
      })));
      toast('Sales exported ✓');
    };
  }


  // Live-inject a new sale row into the sales history table (no refresh needed)
  function injectSaleRow(sale) {
    const tbody = $('#salesTbody');
    if (!tbody) return;

    // Respect active filters
    const start = $('#salesFilterStart').value || null;
    const end   = $('#salesFilterEnd').value   || null;
    const term  = ($('#salesFilterItem').value || '').toLowerCase();
    if (!inRange(sale.date, start, end)) return;
    if (term && !sale.lines.map(l => (l.item_name || '').toLowerCase()).join(' ').includes(term)) return;

    const dk      = sale.date.slice(0, 10);
    const isToday = dk === today();
    const items   = sale.lines.map(l => `${l.item_name} ×${l.qty}`).join(', ');

    const dataRow = document.createElement('tr');
    dataRow.className     = 'sales-day-rows';
    dataRow.style.display = 'table-row';
    dataRow.innerHTML = `
      <td style="font-size:12px;">${new Date(sale.date).toLocaleTimeString()}</td>
      <td>${items}</td>
      <td>${cur(sale.revenue)}</td>
      <td>${cur(sale.cogs)}</td>
      <td style="color:var(--green);font-weight:600;">${cur(sale.gp || (sale.revenue - sale.cogs))}</td>
      <td>${discountBadge(sale)}</td>
      <td>${serviceChargeBadge(sale)}</td>
      <td>${mopBadge(sale)}</td>
      <td style="font-size:12px;font-weight:700;color:#1565C0;">${sale.done_by || StorageAPI.getSessionUser()}</td>
      <td><button class="btn btn-danger btn-sm" data-act="del" data-id="${sale.id}">Delete</button></td>
    `;

    dataRow.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (!confirm('Delete this sale? The ingredients used will be returned to inventory.')) return;
      restoreSaleStock(sale);
      StorageAPI.deleteSale(sale.id);
      toast('Sale deleted'); renderSalesHistory(); renderDashboard();
    });

    const existingHeader = tbody.querySelector(`.sales-date-header[data-dk="${dk}"]`);
    if (existingHeader) {
      existingHeader.insertAdjacentElement('afterend', dataRow);
      const toggle = existingHeader.querySelector('.sales-date-toggle');
      if (toggle) {
        toggle.innerHTML = toggle.innerHTML.replace(/(\d+) sale\(s\)/, (_, n) => `${Number(n)+1} sale(s)`);
        const dayTotal = StorageAPI.getSales()
          .filter(s => s.date.slice(0,10) === dk)
          .reduce((sum, s) => sum + (s.revenue || 0), 0);
        toggle.innerHTML = toggle.innerHTML.replace(/·&nbsp;[^<]+/, `·&nbsp;${cur(dayTotal)}`);
      }
    } else {
      const label = new Date(dk).toLocaleDateString('en-US', { weekday:'short', year:'numeric', month:'short', day:'numeric' });
      const headerRow = document.createElement('tr');
      headerRow.className  = 'sales-date-header';
      headerRow.dataset.dk = dk;
      headerRow.innerHTML  = `<td colspan="10"><button class="sales-date-toggle"><span class="toggle-icon">▼</span> ${label}${isToday?' (Today)':''} — 1 sale(s) &nbsp;·&nbsp; ${cur(sale.revenue)}</button></td>`;
      headerRow.querySelector('.sales-date-toggle').addEventListener('click', ev => {
        ev.stopPropagation();
        const icon = headerRow.querySelector('.toggle-icon');
        const expanded = icon.textContent === '▼';
        let r = headerRow.nextElementSibling;
        while (r && !r.classList.contains('sales-date-header')) {
          if (r.classList.contains('sales-day-rows')) r.style.display = expanded ? 'none' : 'table-row';
          r = r.nextElementSibling;
        }
        icon.textContent = expanded ? '▶' : '▼';
      });
      tbody.querySelector('.no-data-placeholder')?.closest('tr')?.remove();
      tbody.insertBefore(dataRow,   tbody.firstChild);
      tbody.insertBefore(headerRow, dataRow);
    }
  }

  function renderSalesWeekly() {
    const sales = StorageAPI.getSales(), weeks = {};
    sales.forEach(sale => {
      const d = new Date(sale.date), dow = d.getDay();
      const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      const wk = toLocalYMD(mon);
      if (!weeks[wk]) weeks[wk] = { revenue: 0, cogs: 0, gp: 0, count: 0 };
      weeks[wk].revenue += saleRevenue(sale); weeks[wk].cogs += saleCOGS(sale); weeks[wk].gp += saleGP(sale); weeks[wk].count++;
    });
    $('#salesWeeklyTbody').innerHTML = Object.keys(weeks).sort((a, b) => b.localeCompare(a)).map(wk => {
      const d = new Date(wk), e = new Date(wk); e.setDate(d.getDate() + 6);
      const lbl = `${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
      const w = weeks[wk];
      return `<tr><td>${lbl}</td><td>${cur(w.revenue)}</td><td>${cur(w.cogs)}</td><td style="color:var(--green);font-weight:600;">${cur(w.gp)}</td><td>${w.count}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="no-data-placeholder">No data</td></tr>';
  }

  function renderSalesMonthly() {
    const sales = StorageAPI.getSales(), months = {};
    sales.forEach(s => {
      const mk = s.date.slice(0, 7);
      if (!months[mk]) months[mk] = { revenue: 0, cogs: 0, gp: 0, count: 0 };
      months[mk].revenue += saleRevenue(s); months[mk].cogs += saleCOGS(s); months[mk].gp += saleGP(s); months[mk].count++;
    });
    $('#salesMonthlyTbody').innerHTML = Object.keys(months).sort((a, b) => b.localeCompare(a)).map(mk => {
      const m = months[mk];
      return `<tr><td>${new Date(mk + '-01').toLocaleDateString('en-US',{year:'numeric',month:'long'})}</td><td>${cur(m.revenue)}</td><td>${cur(m.cogs)}</td><td style="color:var(--green);font-weight:600;">${cur(m.gp)}</td><td>${m.count}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="no-data-placeholder">No data</td></tr>';
  }

  function renderSalesYearly() {
    const sales = StorageAPI.getSales(), years = {};
    sales.forEach(s => {
      const yr = s.date.slice(0, 4);
      if (!years[yr]) years[yr] = { revenue: 0, cogs: 0, gp: 0, count: 0 };
      years[yr].revenue += saleRevenue(s); years[yr].cogs += saleCOGS(s); years[yr].gp += saleGP(s); years[yr].count++;
    });
    $('#salesYearlyTbody').innerHTML = Object.keys(years).sort((a, b) => b.localeCompare(a)).map(yr => {
      const y = years[yr];
      return `<tr><td><strong>${yr}</strong></td><td>${cur(y.revenue)}</td><td>${cur(y.cogs)}</td><td style="color:var(--green);font-weight:600;">${cur(y.gp)}</td><td>${y.count}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="no-data-placeholder">No data</td></tr>';
  }

  function renderSalesPerItem() {
    const sales = StorageAPI.getSales(), inv = StorageAPI.getInventory();
    const start = $('#perItemStart').value || null, end = $('#perItemEnd').value || null, map = {};
    sales.filter(s => inRange(s.date, start, end)).forEach(sale => {
      sale.lines.forEach(l => {
        const key = l.item_id || l.item_name; if (!key) return;
        if (!map[key]) {
          const item = inv.find(i => i.id === l.item_id);
          map[key] = { name: l.item_name || item?.name || key, category: item?.category || '—', qty: 0, revenue: 0, cogs: 0, gp: 0 };
        }
        const t = Calc.lineTotals(l); map[key].qty += l.qty; map[key].revenue += t.revenue; map[key].cogs += t.cogs; map[key].gp += t.gp;
      });
    });
    const rows = Object.values(map).sort((a, b) => b.qty - a.qty);
    $('#salesPerItemTbody').innerHTML = rows.map(r =>
      `<tr><td>${r.name}</td><td>${r.category}</td><td><strong>${r.qty}</strong></td><td>${cur(r.revenue)}</td><td>${cur(r.cogs)}</td><td style="color:var(--green);font-weight:600;">${cur(r.gp)}</td></tr>`
    ).join('') || '<tr><td colspan="6" class="no-data-placeholder">No data</td></tr>';
  }

  function exportPerItemCsv() {
    const sales = StorageAPI.getSales(), inv = StorageAPI.getInventory();
    const start = $('#perItemStart').value || null, end = $('#perItemEnd').value || null, map = {};
    sales.filter(s => inRange(s.date, start, end)).forEach(sale => {
      sale.lines.forEach(l => {
        const key = l.item_id || l.item_name; if (!key) return;
        if (!map[key]) { const item = inv.find(i => i.id === l.item_id); map[key] = { name: l.item_name || item?.name || key, category: item?.category || '', qty: 0, revenue: 0, cogs: 0, gp: 0 }; }
        const t = Calc.lineTotals(l); map[key].qty += l.qty; map[key].revenue += t.revenue; map[key].cogs += t.cogs; map[key].gp += t.gp;
      });
    });
    StorageAPI.downloadCSV('sales_per_item.csv', Object.values(map).sort((a, b) => b.qty - a.qty));
    toast('Exported ✓');
  }

  // ── EXPENSES ───────────────────────────────────────────────────────────────
  let _expensesReady = false;
  function setupExpenses() {
    $('#expenseDate').value = today();
    if (_expensesReady) return;
    _expensesReady = true;

    const catSel = $('#expenseCategory'), customRow = $('#expenseCustomCategoryRow');
    catSel.addEventListener('change', () => {
      customRow.style.display = catSel.value === 'Other' ? 'grid' : 'none';
      if (catSel.value === 'Other') $('#expenseCustomCategory').focus();
    });

    $('#expenseSubmitBtn').addEventListener('click', () => {
      let cat = catSel.value;
      if (cat === 'Other') { cat = $('#expenseCustomCategory').value.trim(); if (!cat) { toast('Please specify a category', 'error'); return; } }
      if (!cat) { toast('Please select a category', 'error'); return; }
      const amount = Number($('#expenseAmount').value) || 0;
      if (amount <= 0) { toast('Please enter a valid amount', 'error'); return; }
      const date = $('#expenseDate').value;
      if (!date) { toast('Please select a date', 'error'); return; }
      StorageAPI.addExpense({
        id:           StorageAPI.uid('exp'),
        date:         new Date(date).toISOString(),
        account_type: $('#expenseAccountType').value,
        category:     cat,
        tin:          $('#expenseTin').value.trim(),
        amount,
        note:         $('#expenseNote').value.trim()
      });
      toast('Expense added ✓', 'success');
      catSel.value = ''; $('#expenseAccountType').value = ''; $('#expenseTin').value = '';
      $('#expenseAmount').value = ''; $('#expenseNote').value = '';
      $('#expenseDate').value = today(); customRow.style.display = 'none';
      renderExpenses(); renderDashboard();
    });

    $('#expenseClearBtn').addEventListener('click', () => {
      catSel.value = ''; $('#expenseAccountType').value = ''; $('#expenseTin').value = '';
      $('#expenseAmount').value = ''; $('#expenseNote').value = '';
      $('#expenseDate').value = today(); customRow.style.display = 'none';
    });

    ['expenseFilterCategory','expenseFilterAccount'].forEach(id =>
      $('#' + id).addEventListener('change', renderExpenses)
    );

    // Month picker — same pattern as sales/inventory history
    (function() {
      const sel = $('#expenseFilterMonth');
      if (sel) sel.addEventListener('change', renderExpenses);
      const allBtn = $('#expenseFilterAll');
      if (allBtn) allBtn.addEventListener('click', () => {
        if ($('#expenseFilterMonth')) $('#expenseFilterMonth').value = '';
        renderExpenses();
      });
    })();
  }

  function renderExpenses() {
    const expenses = StorageAPI.getExpenses();

    // Rebuild month dropdown from live data — preserve selection across re-renders
    (function() {
      const sel = $('#expenseFilterMonth');
      if (!sel) return;
      const prevVal = sel.value;
      buildMonthOptions(expenses.map(e => e.date), 'expenseFilterMonth', !prevVal);
      if (prevVal && Array.from(sel.options).some(o => o.value === prevVal)) {
        sel.value = prevVal;
      }
    })();

    const { start, end } = monthToRange($('#expenseFilterMonth').value);
    const cat   = $('#expenseFilterCategory').value;
    const acc   = $('#expenseFilterAccount').value;

    const cats = Array.from(new Set(expenses.map(e => e.category).filter(Boolean))).sort();
    const accs = Array.from(new Set(expenses.map(e => e.account_type).filter(Boolean))).sort();
    const pCat = $('#expenseFilterCategory').value, pAcc = $('#expenseFilterAccount').value;
    $('#expenseFilterCategory').innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option ${c === pCat ? 'selected' : ''}>${c}</option>`).join('');
    $('#expenseFilterAccount').innerHTML  = '<option value="">All Accounts</option>'   + accs.map(a => `<option ${a === pAcc ? 'selected' : ''}>${a}</option>`).join('');

    const filtered = expenses.filter(e => inRange(e.date, start, end) && (!cat || e.category === cat) && (!acc || e.account_type === acc));

    $('#expensesTbody').innerHTML = filtered.length ? filtered.map(e => `<tr>
      <td>${new Date(e.date).toLocaleDateString()}</td>
      <td>${e.account_type || '—'}</td>
      <td>${e.category}</td>
      <td style="font-size:12px;">${e.tin || '—'}</td>
      <td style="font-weight:600;">${cur(e.amount)}</td>
      <td style="font-size:12px;max-width:200px;">${e.note || ''}</td>
      <td style="font-size:12px;font-weight:700;color:#1565C0;">${e.done_by || '—'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" data-act="edit" data-id="${e.id}" style="margin-right:4px;">✏ Edit</button>
        <button class="btn btn-danger btn-sm" data-act="del" data-id="${e.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="no-data-placeholder">No expenses found</td></tr>';

    $$('#expensesTbody [data-act="del"]').forEach(btn => btn.addEventListener('click', () => {
      if (!confirm('Delete this expense?')) return;
      StorageAPI.deleteExpense(btn.dataset.id); toast('Deleted'); renderExpenses(); renderDashboard();
    }));

    $$('#expensesTbody [data-act="edit"]').forEach(btn => btn.addEventListener('click', () => {
      const e = StorageAPI.getExpenses().find(x => x.id === btn.dataset.id);
      if (!e) return;

      // If another row is already in edit mode, restore it first
      const existing = $('#expensesTbody .inline-edit-row');
      if (existing) existing.dispatchEvent(new Event('cancel-edit'));

      const row = btn.closest('tr');
      const knownCats = ['Labor','Utilities','Rent','Supplies','Marketing','Repairs & Maintenance','Transportation','Tax','Other'];
      const catOptions = knownCats.map(c => `<option value="${c}" ${e.category === c ? 'selected' : ''}>${c}</option>`).join('');
      const customCat = knownCats.includes(e.category) ? '' : e.category;

      row.classList.add('inline-edit-row');
      row.style.background = 'var(--yellow, #FFF9C4)';

      const originalHTML = row.innerHTML;

      row.innerHTML = `
        <td><input type="date" class="ie-date" value="${e.date ? e.date.slice(0,10) : ''}" style="width:130px;" /></td>
        <td>
          <select class="ie-account" style="width:110px;">
            <option value="">—</option>
            ${['Cash','Bank','Credit Card','GCash','Maya','Other'].map(a => `<option ${(e.account_type||'')===a?'selected':''}>${a}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="ie-cat" style="width:130px;">
            ${catOptions}
            <option value="__custom__" ${!knownCats.includes(e.category)?'selected':''}>Other…</option>
          </select>
          <input class="ie-custom-cat" type="text" value="${customCat}" placeholder="Specify…"
            style="width:110px;margin-top:4px;display:${!knownCats.includes(e.category)?'block':'none'};" />
        </td>
        <td><input type="text" class="ie-tin" value="${e.tin||''}" placeholder="TIN" style="width:110px;" /></td>
        <td><input type="number" class="ie-amount" value="${e.amount}" step="0.01" min="0" style="width:100px;font-weight:600;" /></td>
        <td><textarea class="ie-note" rows="2" style="width:100%;min-width:140px;font-size:12px;">${e.note||''}</textarea></td>
        <td style="font-size:12px;font-weight:700;color:#1565C0;">${e.done_by||'—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-primary btn-sm ie-save" style="margin-right:4px;">✓ Save</button>
          <button class="btn btn-secondary btn-sm ie-cancel">✕</button>
        </td>`;

      // Show/hide custom category input
      row.querySelector('.ie-cat').addEventListener('change', function() {
        row.querySelector('.ie-custom-cat').style.display = this.value === '__custom__' ? 'block' : 'none';
      });

      // Save handler
      row.querySelector('.ie-save').addEventListener('click', () => {
        let cat = row.querySelector('.ie-cat').value;
        if (cat === '__custom__') { cat = row.querySelector('.ie-custom-cat').value.trim(); }
        if (!cat) { toast('Please specify a category', 'error'); return; }
        const amount = Number(row.querySelector('.ie-amount').value) || 0;
        if (amount <= 0) { toast('Enter a valid amount', 'error'); return; }
        const date = row.querySelector('.ie-date').value;
        if (!date) { toast('Select a date', 'error'); return; }
        StorageAPI.updateExpense(e.id, {
          date:         new Date(date).toISOString(),
          account_type: row.querySelector('.ie-account').value,
          category:     cat,
          tin:          row.querySelector('.ie-tin').value.trim(),
          amount,
          note:         row.querySelector('.ie-note').value.trim()
        });
        toast('Expense updated ✓', 'success');
        renderExpenses(); renderDashboard();
      });

      // Cancel handler — just re-render to restore the row cleanly
      const cancelFn = () => { renderExpenses(); };
      row.querySelector('.ie-cancel').addEventListener('click', cancelFn);
      row.addEventListener('cancel-edit', cancelFn);
    }));

    const total = filtered.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    $('#expensesTotal').textContent = cur(total);
    $('#exportExpensesCsv').onclick = () => { StorageAPI.downloadCSV('expenses.csv', filtered); toast('Exported ✓'); };
  }

  // ── STAFF ──────────────────────────────────────────────────────────────────
  let _staffReady = false;
  function setupStaff() {
    // Always default the month filter to the current month on load
    const nowYM = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const payrollMonthEl = $('#payrollMonth');
    if (payrollMonthEl && !payrollMonthEl.value) {
      payrollMonthEl.value = nowYM;
    }

    if (_staffReady) return;
    _staffReady = true;
    $('#addStaffBtn').addEventListener('click', () => openStaffDialog());
    $('#staffDialogCancel').addEventListener('click', () => $('#staffDialog').close());
    $('#staffForm').addEventListener('submit', e => {
      e.preventDefault();
      const id = $('#staffId').value || StorageAPI.uid('staff');
      const existing = $('#staffId').value ? StorageAPI.getStaffById(id) : null;
      StorageAPI.upsertStaff({
        id, name: $('#staffName').value.trim(), position: $('#staffPosition').value.trim(),
        employment_type: $('#staffType').value, salary: Number($('#staffSalary').value) || 0,
        hourly_rate: Number($('#staffHourlyRate').value) || 0,
        contact: $('#staffContact').value.trim(), hire_date: $('#staffHireDate').value,
        created_at: existing ? existing.created_at : new Date().toISOString()
      });
      $('#staffDialog').close(); toast('Staff saved ✓', 'success'); renderStaff();
    });

    $('#addPayrollBtn').addEventListener('click', () => openPayrollDialog());
    $('#payrollDialogCancel').addEventListener('click', () => $('#payrollDialog').close());
    ['payrollBase','payrollOvertime','payrollCashAdvance','payrollDeductions'].forEach(id =>
      $('#' + id).addEventListener('input', updatePayrollPreview)
    );
    $('#payrollHours').addEventListener('input', autoCalculateBaseFromHours);
    $('#payrollStaffId').addEventListener('change', () => {
      const staffId = $('#payrollStaffId').value;
      if (!staffId) return;
      const staff = StorageAPI.getStaffById(staffId);
      if (!staff) return;
      const hourlyRate = Number(staff.hourly_rate) || 0;
      const salary = Number(staff.salary) || 0;
      if (hourlyRate > 0) {
        autoCalculateBaseFromHours();
      } else if (salary > 0 && !$('#payrollBase').value) {
        $('#payrollBase').value = (salary / 2).toFixed(2);
        updatePayrollPreview();
      }
    });

    $('#payrollForm').addEventListener('submit', e => {
      e.preventDefault();
      const id    = $('#payrollEntryId').value || StorageAPI.uid('pay');
      const base  = Number($('#payrollBase').value)           || 0;
      const ot    = Number($('#payrollOvertime').value)       || 0;
      const ca    = Number($('#payrollCashAdvance').value)    || 0;
      const ded   = Number($('#payrollDeductions').value)     || 0;
      const staffId = $('#payrollStaffId').value;
      if (!staffId) { toast('Please select a staff member', 'error'); return; }
      // Build period as "YYYY-MM-C" (e.g. "2025-06-1" for 1st cutoff)
      const periodMonth  = $('#payrollPeriodMonth').value;  // "YYYY-MM"
      const cutoffVal    = $('#payrollCutoff').value;        // "1" or "2"
      if (!periodMonth || !cutoffVal) { toast('Please select a pay period and cut-off', 'error'); return; }
      const period = `${periodMonth}-${cutoffVal}`;
      StorageAPI.upsertPayroll({ id, staff_id: staffId, period, hours_worked: Number($('#payrollHours').value) || 0, base_pay: base, overtime: ot, cash_advance: ca, deductions: ded, net_pay: base + ot - ca - ded, created_at: new Date().toISOString() });
      $('#payrollDialog').close(); toast('Payroll saved ✓', 'success'); renderStaff();
    });

    $('#payrollStaffFilter').addEventListener('change', renderStaff);
    $('#payrollMonth').addEventListener('change', renderStaff);
    $('#payrollCutoffFilter').addEventListener('change', renderStaff);
    $('#payslipPrint').addEventListener('click', printCurrentPayslip);
    $('#payslipClose').addEventListener('click', () => $('#payslipDialog').close());
    $('#printAllPayrollBtn').addEventListener('click', printAllPayroll);
    $('#printAllPayslipsBtn').addEventListener('click', printAllPayslips);
    $('#exportPayrollCsv').addEventListener('click', () => { StorageAPI.downloadCSV('payroll.csv', StorageAPI.getPayroll()); toast('Exported ✓'); });
  }

  function openStaffDialog(id = null) {
    if (id) {
      const st = StorageAPI.getStaffById(id);
      $('#staffDialogTitle').textContent = 'Edit Staff';
      $('#staffId').value = st.id; $('#staffName').value = st.name || '';
      $('#staffPosition').value = st.position || ''; $('#staffType').value = st.employment_type || 'Full-time';
      $('#staffSalary').value = st.salary || ''; $('#staffHourlyRate').value = st.hourly_rate || '';
      $('#staffContact').value = st.contact || '';
      $('#staffHireDate').value = st.hire_date || '';
    } else {
      $('#staffDialogTitle').textContent = 'Add Staff';
      $('#staffForm').reset(); $('#staffId').value = '';
    }
    $('#staffDialog').showModal();
  }

  function openPayrollDialog(entryId = null) {
    const staff = StorageAPI.getStaff(), sel = $('#payrollStaffId');
    sel.innerHTML = '<option value="">Select staff…</option>' + staff.map(st => `<option value="${st.id}">${st.name}</option>`).join('');
    $('#payrollDialogTitle').textContent = entryId ? 'Edit Payroll Entry' : 'New Payroll Entry';
    if (entryId) {
      const entry = StorageAPI.getPayroll().find(p => p.id === entryId);
      if (entry) {
        $('#payrollEntryId').value = entry.id; sel.value = entry.staff_id;
        // Parse "YYYY-MM-C" or legacy "YYYY-MM"
        const cutoffMatch = (entry.period || '').match(/^(\d{4}-\d{2})-([12])$/);
        if (cutoffMatch) {
          $('#payrollPeriodMonth').value = cutoffMatch[1];
          $('#payrollCutoff').value      = cutoffMatch[2];
        } else {
          // Legacy: treat as whole month, default to 1st cutoff
          $('#payrollPeriodMonth').value = (entry.period || '').slice(0, 7);
          $('#payrollCutoff').value      = '1';
        }
        $('#payrollHours').value = entry.hours_worked;
        $('#payrollBase').value = entry.base_pay; $('#payrollOvertime').value = entry.overtime;
        $('#payrollCashAdvance').value = entry.cash_advance || 0; $('#payrollDeductions').value = entry.deductions;
      }
    } else {
      $('#payrollForm').reset(); $('#payrollEntryId').value = '';
      // Default: current month, auto-pick cutoff based on today's date
      const now = new Date();
      const ym  = now.toISOString().slice(0, 7); // "YYYY-MM"
      $('#payrollPeriodMonth').value = ym;
      $('#payrollCutoff').value      = now.getDate() <= 15 ? '1' : '2';
      const fStaff = $('#payrollStaffFilter').value;
      if (fStaff) { 
        sel.value = fStaff;
        const st = StorageAPI.getStaffById(fStaff);
        if (st) {
          $('#payrollHours').value = '';
          $('#payrollBase').value = '';
        }
      }
    }
    updatePayrollPreview(); $('#payrollDialog').showModal();
  }

  function autoCalculateBaseFromHours() {
    const staffId = $('#payrollStaffId').value;
    if (!staffId) return;
    const staff = StorageAPI.getStaffById(staffId);
    if (!staff) return;
    const hourlyRate = Number(staff.hourly_rate) || 0;
    if (hourlyRate > 0) {
      const hours = Number($('#payrollHours').value) || 0;
      const basePay = hourlyRate * hours;
      $('#payrollBase').value = basePay.toFixed(2);
      updatePayrollPreview();
    }
  }

  function updatePayrollPreview() {
    const net = (Number($('#payrollBase').value) || 0)
              + (Number($('#payrollOvertime').value) || 0)
              - (Number($('#payrollCashAdvance').value) || 0)
              - (Number($('#payrollDeductions').value) || 0);
    $('#payrollNetPreview').textContent = cur(net);
  }

  function renderStaff() {
    const allStaff = StorageAPI.getStaff(), payroll = StorageAPI.getPayroll();
    const fStaff  = $('#payrollStaffFilter').value;
    const fMonth  = $('#payrollMonth').value;        // "YYYY-MM" or ""
    const fCutoff = $('#payrollCutoffFilter').value; // "1", "2", or ""

    $('#staffTbody').innerHTML = allStaff.length ? allStaff.map(st => `<tr>
      <td><strong>${st.name}</strong></td>
      <td>${st.position || '—'}</td>
      <td><span style="background:var(--green-bg);color:var(--green);padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">${st.employment_type || '—'}</span></td>
      <td>${st.hourly_rate ? cur(st.hourly_rate) + ' /hr' : (st.salary ? cur(st.salary) : '—')}</td>
      <td>${st.contact || '—'}</td>
      <td style="font-size:12px;">${st.hire_date ? new Date(st.hire_date).toLocaleDateString() : '—'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${st.id}">Edit</button>
        <button class="btn btn-primary btn-sm" data-act="slip" data-id="${st.id}">Payslip</button>
        <button class="btn btn-danger btn-sm" data-act="del" data-id="${st.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="no-data-placeholder">No staff added yet. Click "+ Add Staff" to begin.</td></tr>';

    $$('#staffTbody [data-act="edit"]').forEach(b => b.addEventListener('click', () => openStaffDialog(b.dataset.id)));
    $$('#staffTbody [data-act="slip"]').forEach(b => b.addEventListener('click', () => showPayslipLatest(b.dataset.id)));
    $$('#staffTbody [data-act="del"]').forEach(b => b.addEventListener('click', () => {
      if (!confirm(`Delete "${StorageAPI.getStaffById(b.dataset.id)?.name}"?`)) return;
      StorageAPI.deleteStaff(b.dataset.id); toast('Staff deleted'); renderStaff();
    }));

    // Refresh payroll staff filter
    const prevF = $('#payrollStaffFilter').value;
    $('#payrollStaffFilter').innerHTML = '<option value="">All Staff</option>' + allStaff.map(st => `<option value="${st.id}" ${st.id === prevF ? 'selected' : ''}>${st.name}</option>`).join('');

    // Helper: parse the period field to extract YYYY-MM and cutoff number
    function parsePeriod(period) {
      if (!period) return { ym: '', cutoff: '' };
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) return { ym: m[1], cutoff: m[2] };
      // Legacy "YYYY-MM"
      const leg = period.match(/^(\d{4}-\d{2})$/);
      if (leg) return { ym: leg[1], cutoff: '' };
      return { ym: '', cutoff: '' };
    }

    function cutoffLabel(period) {
      const { ym, cutoff } = parsePeriod(period);
      if (!ym) return period || '—';
      const [year, mon] = ym.split('-');
      const monthName = new Date(Number(year), Number(mon) - 1, 1)
        .toLocaleDateString('en-PH', { month: 'short', year: 'numeric' });
      if (cutoff === '1') return `${monthName} · 1st (1–15)`;
      if (cutoff === '2') return `${monthName} · 2nd (16–end)`;
      return `${monthName} (legacy)`;
    }

    // Filter payroll by staff, month, and cutoff
    const filtered = payroll.filter(p => {
      if (fStaff && p.staff_id !== fStaff) return false;
      const { ym, cutoff } = parsePeriod(p.period);
      if (fMonth && ym !== fMonth) return false;
      if (fCutoff && cutoff !== fCutoff) return false;
      return true;
    });

    // Sort: newest period first, then by cutoff descending (2nd before 1st within same month)
    filtered.sort((a, b) => {
      const pa = parsePeriod(a.period), pb = parsePeriod(b.period);
      if (pa.ym !== pb.ym) return pb.ym.localeCompare(pa.ym);
      return (pb.cutoff || '0').localeCompare(pa.cutoff || '0');
    });

    $('#payrollTbody').innerHTML = filtered.length ? filtered.map(p => {
      const st = allStaff.find(x => x.id === p.staff_id);
      const hourlyRate  = Number(st?.hourly_rate) || 0;
      const hoursWorked = Number(p.hours_worked) || 0;
      const displayBase = (p.base_pay != null && !isNaN(Number(p.base_pay)) && Number(p.base_pay) > 0)
        ? Number(p.base_pay)
        : (hourlyRate > 0 && hoursWorked > 0 ? (hourlyRate * hoursWorked) : (Number(p.base_pay) || 0));
      const { cutoff } = parsePeriod(p.period);
      const cutoffBadgeColor = cutoff === '1'
        ? 'background:#E3F2FD;color:#1565C0;border:1px solid #90CAF9;'
        : cutoff === '2'
        ? 'background:#F3E5F5;color:#6A1B9A;border:1px solid #CE93D8;'
        : 'background:#F5F5F5;color:#555;';
      return `<tr>
        <td>${st ? `<strong>${st.name}</strong>` : '—'}</td>
        <td>
          <div style="font-size:12px;font-weight:600;">${cutoffLabel(p.period)}</div>
          ${cutoff ? `<span style="font-size:10px;padding:1px 6px;border-radius:10px;${cutoffBadgeColor}">${cutoff === '1' ? '1st cut-off' : '2nd cut-off'}</span>` : ''}
        </td>
        <td title="${hourlyRate > 0 ? `Hours × Hourly Rate: ${hoursWorked} hrs @ ${cur(hourlyRate)}/hr` : `${hoursWorked || 0} hrs`}">${hoursWorked || '—'}</td>
        <td style="font-size:12px;color:var(--muted);" title="${(hourlyRate > 0 && hoursWorked > 0) ? `Computed: ${hoursWorked} × ${cur(hourlyRate)}` : `Base Pay: ${cur(displayBase)}`}">${cur(displayBase)}</td>
        <td>${cur(p.overtime)}</td>
        <td style="color:var(--red);">${cur(p.cash_advance || 0)}</td>
        <td style="color:var(--red);">${cur(p.deductions)}</td>
        <td style="font-weight:700;color:var(--green);">${cur(p.net_pay)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${p.id}">Edit</button>
          <button class="btn btn-primary btn-sm" data-act="slip" data-id="${p.id}">Payslip</button>
          <button class="btn btn-danger btn-sm" data-act="del" data-id="${p.id}">Delete</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="9" class="no-data-placeholder">No payroll entries for selected period</td></tr>';

    $$('#payrollTbody [data-act="edit"]').forEach(b => b.addEventListener('click', () => openPayrollDialog(b.dataset.id)));
    $$('#payrollTbody [data-act="slip"]').forEach(b => b.addEventListener('click', () => showPayslipByEntry(b.dataset.id)));
    $$('#payrollTbody [data-act="del"]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Delete this payroll entry?')) return;
      StorageAPI.deletePayroll(b.dataset.id); toast('Deleted'); renderStaff();
    }));

    const total = filtered.reduce((sum, p) => sum + (Number(p.net_pay) || 0), 0);
    $('#payrollTotal').textContent = cur(total);
  }

  function showPayslipLatest(staffId) {
    const latest = StorageAPI.getPayroll()
      .filter(p => p.staff_id === staffId)
      .sort((a, b) => b.period.localeCompare(a.period))[0];
    if (!latest) { toast('No payroll entry found for this staff', 'error'); return; }
    showPayslipByEntry(latest.id);
  }

  // Store current payslip data so the print button can use it
  let _currentPayslipEntryId = null;

  function showPayslipByEntry(entryId) {
    const entry = StorageAPI.getPayroll().find(p => p.id === entryId); if (!entry) return;
    _currentPayslipEntryId = entryId;
    const st          = StorageAPI.getStaffById(entry.staff_id);
    const hourlyRate  = Number(st?.hourly_rate) || 0;
    const salary      = Number(st?.salary) || 0;
    const hoursWorked = Number(entry.hours_worked) || 0;
    const base        = Number(entry.base_pay) || (hourlyRate > 0 ? hourlyRate * hoursWorked : salary);
    const ot          = Number(entry.overtime) || 0;
    const ca          = Number(entry.cash_advance) || 0;
    const ded         = Number(entry.deductions) || 0;
    const net         = Number(entry.net_pay) || (base + ot - ca - ded);

    // Build human-readable period label
    function periodLabel(period) {
      if (!period) return '—';
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) {
        const [year, mon] = m[1].split('-');
        const monthName = new Date(Number(year), Number(mon) - 1, 1)
          .toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        return m[2] === '1' ? `${monthName} · 1st Cut-off (1–15)` : `${monthName} · 2nd Cut-off (16–end)`;
      }
      return period;
    }

    $('#payslipContent').innerHTML = `
      <div style="text-align:center;padding-bottom:14px;border-bottom:2px solid #eee;margin-bottom:14px;">
        <div style="font-size:22px;font-weight:800;letter-spacing:1px;">🍽️ RESERVE</div>
        <div style="font-size:12px;color:#888;margin-top:2px;">Official Payslip</div>
      </div>
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:14px;">
        <tr><td style="color:#888;padding:5px 0;width:50%;">Employee</td><td style="font-weight:700;text-align:right;">${st?.name || '—'}</td></tr>
        <tr><td style="color:#888;padding:5px 0;">Position</td><td style="text-align:right;">${st?.position || '—'}</td></tr>
        <tr><td style="color:#888;padding:5px 0;">Employment Type</td><td style="text-align:right;">${st?.employment_type || '—'}</td></tr>
        <tr><td style="color:#888;padding:5px 0;">Pay Period</td><td style="font-weight:600;text-align:right;">${periodLabel(entry.period)}</td></tr>
        ${hourlyRate > 0 ? `<tr><td style="color:#888;padding:5px 0;">Hourly Rate</td><td style="text-align:right;">${cur(hourlyRate)}</td></tr>
        <tr><td style="color:#888;padding:5px 0;">Hours Worked</td><td style="text-align:right;">${hoursWorked} hrs</td></tr>` : ''}
      </table>
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:14px;">
        <thead><tr style="background:#f3f4f6;"><th style="padding:7px 8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;">Description</th><th style="padding:7px 8px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;">Amount</th></tr></thead>
        <tbody>
          <tr><td style="padding:6px 8px;">Base Pay${hourlyRate > 0 ? ` (${hoursWorked} hrs × ${cur(hourlyRate)})` : ''}</td><td style="text-align:right;font-weight:600;">${cur(base)}</td></tr>
          ${ot > 0 ? `<tr><td style="padding:6px 8px;">Overtime Pay</td><td style="text-align:right;">${cur(ot)}</td></tr>` : ''}
          ${ca > 0 ? `<tr><td style="padding:6px 8px;color:#D32F2F;">Cash Advance</td><td style="text-align:right;color:#D32F2F;">−${cur(ca)}</td></tr>` : ''}
          ${ded > 0 ? `<tr><td style="padding:6px 8px;color:#D32F2F;">Deductions (SSS/PhilHealth/Pag-IBIG)</td><td style="text-align:right;color:#D32F2F;">−${cur(ded)}</td></tr>` : ''}
        </tbody>
      </table>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#E8F5E9;border-radius:8px;border:1.5px solid #A5D6A7;">
        <span style="font-size:15px;font-weight:700;">NET PAY</span>
        <span style="font-size:24px;font-weight:800;color:#2E7D32;">${cur(net)}</span>
      </div>
      <div style="margin-top:16px;font-size:11px;color:#aaa;text-align:center;">Generated ${new Date().toLocaleString('en-PH')}</div>`;
    $('#payslipDialog').showModal();
  }

  function printCurrentPayslip() {
    if (!_currentPayslipEntryId) return;
    const entry = StorageAPI.getPayroll().find(p => p.id === _currentPayslipEntryId);
    if (!entry) return;
    const st          = StorageAPI.getStaffById(entry.staff_id);
    const hourlyRate  = Number(st?.hourly_rate) || 0;
    const salary      = Number(st?.salary) || 0;
    const hoursWorked = Number(entry.hours_worked) || 0;
    const base        = Number(entry.base_pay) || (hourlyRate > 0 ? hourlyRate * hoursWorked : salary);
    const ot          = Number(entry.overtime) || 0;
    const ca          = Number(entry.cash_advance) || 0;
    const ded         = Number(entry.deductions) || 0;
    const net         = Number(entry.net_pay) || (base + ot - ca - ded);

    function periodLabel(period) {
      if (!period) return '—';
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) {
        const [year, mon] = m[1].split('-');
        const monthName = new Date(Number(year), Number(mon) - 1, 1)
          .toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        return m[2] === '1' ? `${monthName} · 1st Cut-off (1–15)` : `${monthName} · 2nd Cut-off (16–end)`;
      }
      return period;
    }

    const win = window.open('', '_blank', 'width=480,height=700');
    if (!win) { toast('Allow pop-ups to print payslips', 'error'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Payslip — ${st?.name || ''}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:"Inter",system-ui,sans-serif;font-size:13px;color:#111;padding:32px;max-width:420px;margin:0 auto;}
      .header{text-align:center;padding-bottom:16px;border-bottom:2px solid #e5e7eb;margin-bottom:18px;}
      .header h1{font-size:22px;font-weight:800;letter-spacing:1px;}
      .header p{font-size:11px;color:#888;margin-top:3px;}
      table{width:100%;border-collapse:collapse;margin-bottom:16px;}
      td{padding:6px 4px;font-size:13px;vertical-align:top;}
      td:last-child{text-align:right;font-weight:500;}
      .label{color:#6b7280;}
      thead tr{background:#f3f4f6;}
      th{padding:8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;text-align:left;}
      th:last-child{text-align:right;}
      .net-box{display:flex;justify-content:space-between;align-items:center;background:#E8F5E9;border:1.5px solid #A5D6A7;border-radius:8px;padding:14px 16px;margin-bottom:20px;}
      .net-label{font-size:15px;font-weight:700;}
      .net-amount{font-size:26px;font-weight:800;color:#2E7D32;}
      .sig-row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:32px;}
      .sig-box{border-top:1px solid #ccc;padding-top:6px;font-size:11px;color:#888;text-align:center;}
      .footer{text-align:center;font-size:10px;color:#aaa;margin-top:20px;}
      @media print{body{padding:16px;}@page{margin:.8cm;size:A5;}}
    </style></head><body>
    <div class="header">
      <h1>🍽️ RESERVE</h1>
      <p>Official Payslip &nbsp;·&nbsp; Pay Period: <strong>${periodLabel(entry.period)}</strong></p>
    </div>

    <table>
      <tr><td class="label">Employee</td><td><strong>${st?.name || '—'}</strong></td></tr>
      <tr><td class="label">Position</td><td>${st?.position || '—'}</td></tr>
      <tr><td class="label">Employment Type</td><td>${st?.employment_type || '—'}</td></tr>
      ${hourlyRate > 0 ? `<tr><td class="label">Hourly Rate</td><td>${cur(hourlyRate)}</td></tr>
      <tr><td class="label">Hours Worked</td><td>${hoursWorked} hrs</td></tr>` : ''}
    </table>

    <table>
      <thead><tr><th>Description</th><th>Amount</th></tr></thead>
      <tbody>
        <tr><td>Base Pay${hourlyRate > 0 ? ` (${hoursWorked} hrs × ${cur(hourlyRate)})` : ''}</td><td style="text-align:right;font-weight:600;">${cur(base)}</td></tr>
        ${ot > 0 ? `<tr><td>Overtime Pay</td><td style="text-align:right;">${cur(ot)}</td></tr>` : ''}
        ${ca > 0 ? `<tr><td style="color:#D32F2F;">Cash Advance</td><td style="text-align:right;color:#D32F2F;">−${cur(ca)}</td></tr>` : ''}
        ${ded > 0 ? `<tr><td style="color:#D32F2F;">Deductions (SSS / PhilHealth / Pag-IBIG)</td><td style="text-align:right;color:#D32F2F;">−${cur(ded)}</td></tr>` : ''}
      </tbody>
    </table>

    <div class="net-box">
      <span class="net-label">NET PAY</span>
      <span class="net-amount">${cur(net)}</span>
    </div>

    <div class="sig-row">
      <div class="sig-box">Prepared by</div>
      <div class="sig-box">Received by</div>
    </div>

    <div class="footer">Generated ${new Date().toLocaleString('en-PH')} &nbsp;·&nbsp; RESERVE Restaurant Manager</div>
    <script>window.onload = () => { window.print(); };<\/script>
    </body></html>`);
    win.document.close();
  }

  // ── PRINT ALL PAYROLL ─────────────────────────────────────────────────────
  function printAllPayroll() {
    const allStaff  = StorageAPI.getStaff();
    const payroll   = StorageAPI.getPayroll();
    const fStaff    = $('#payrollStaffFilter').value;
    const fMonth    = $('#payrollMonth').value;
    const fCutoff   = $('#payrollCutoffFilter').value;

    function parsePeriod(period) {
      if (!period) return { ym: '', cutoff: '' };
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) return { ym: m[1], cutoff: m[2] };
      const leg = period.match(/^(\d{4}-\d{2})$/);
      if (leg) return { ym: leg[1], cutoff: '' };
      return { ym: '', cutoff: '' };
    }
    function periodLabel(period) {
      if (!period) return '—';
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) {
        const [year, mon] = m[1].split('-');
        const mn = new Date(Number(year), Number(mon) - 1, 1)
          .toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        return m[2] === '1' ? `${mn} · 1st Cut-off (1–15)` : `${mn} · 2nd Cut-off (16–end)`;
      }
      return period;
    }

    // Apply same filters as the table
    const filtered = payroll.filter(p => {
      if (fStaff && p.staff_id !== fStaff) return false;
      const { ym, cutoff } = parsePeriod(p.period);
      if (fMonth  && ym     !== fMonth)  return false;
      if (fCutoff && cutoff !== fCutoff) return false;
      return true;
    }).sort((a, b) => {
      const pa = parsePeriod(a.period), pb = parsePeriod(b.period);
      if (pa.ym !== pb.ym) return pb.ym.localeCompare(pa.ym);
      return (pb.cutoff || '0').localeCompare(pa.cutoff || '0');
    });

    if (!filtered.length) { toast('No payroll entries to print for the selected filter.', 'error'); return; }

    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast('Allow pop-ups to print payroll', 'error'); return; }

    // Build filter label for the report header
    let filterDesc = 'All Staff · All Periods';
    const parts = [];
    if (fStaff)  parts.push(allStaff.find(s => s.id === fStaff)?.name || 'Selected Staff');
    if (fMonth)  parts.push(new Date(fMonth + '-01').toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }));
    if (fCutoff) parts.push(fCutoff === '1' ? '1st Cut-off (1–15)' : '2nd Cut-off (16–end)');
    if (parts.length) filterDesc = parts.join(' · ');

    const grandTotal = filtered.reduce((s, p) => s + (Number(p.net_pay) || 0), 0);
    const grandBase  = filtered.reduce((s, p) => s + (Number(p.base_pay) || 0), 0);
    const grandOT    = filtered.reduce((s, p) => s + (Number(p.overtime) || 0), 0);
    const grandCA    = filtered.reduce((s, p) => s + (Number(p.cash_advance) || 0), 0);
    const grandDed   = filtered.reduce((s, p) => s + (Number(p.deductions) || 0), 0);

    const rows = filtered.map((p, idx) => {
      const st = allStaff.find(x => x.id === p.staff_id);
      const base = Number(p.base_pay) || 0;
      const ot   = Number(p.overtime) || 0;
      const ca   = Number(p.cash_advance) || 0;
      const ded  = Number(p.deductions) || 0;
      const net  = Number(p.net_pay) || 0;
      const hrs  = Number(p.hours_worked) || 0;
      return `
        <tr class="${idx % 2 === 0 ? 'even' : 'odd'}">
          <td>${idx + 1}</td>
          <td><strong>${st?.name || '—'}</strong><div class="sub">${st?.position || ''}</div></td>
          <td class="sub">${periodLabel(p.period)}</td>
          <td class="r">${hrs > 0 ? hrs + ' hrs' : '—'}</td>
          <td class="r">${cur(base)}</td>
          <td class="r">${ot > 0 ? cur(ot) : '—'}</td>
          <td class="r red">${ca > 0 ? '−' + cur(ca) : '—'}</td>
          <td class="r red">${ded > 0 ? '−' + cur(ded) : '—'}</td>
          <td class="r net">${cur(net)}</td>
        </tr>`;
    }).join('');

    win.document.write(`<!DOCTYPE html><html><head><title>Payroll Summary — ${filterDesc}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:"Inter",system-ui,sans-serif;font-size:12px;color:#111;padding:28px 32px;}
      .header{text-align:center;margin-bottom:20px;border-bottom:2.5px solid #111;padding-bottom:14px;}
      .header h1{font-size:20px;font-weight:800;letter-spacing:.06em;}
      .header .sub{font-size:11px;color:#555;margin-top:3px;}
      .header .period{font-size:13px;font-weight:700;margin-top:6px;color:#111;background:#F0FDF4;display:inline-block;padding:3px 14px;border-radius:20px;border:1px solid #86EFAC;}
      .meta{display:flex;justify-content:space-between;font-size:11px;color:#888;margin-bottom:14px;}
      table{width:100%;border-collapse:collapse;margin-bottom:18px;}
      th{background:#1a1a2e;color:#fff;padding:8px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;text-align:right;white-space:nowrap;}
      th:first-child,th:nth-child(2),th:nth-child(3){text-align:left;}
      td{padding:7px 10px;vertical-align:middle;border-bottom:1px solid #f0f0f0;}
      td.r{text-align:right;}
      td.red{color:#DC2626;}
      td.net{font-weight:800;color:#16a34a;font-size:13px;text-align:right;}
      .sub{font-size:10px;color:#888;margin-top:1px;}
      .even{background:#fff;} .odd{background:#fafafa;}
      .totals-row td{background:#F0FDF4;font-weight:700;border-top:2px solid #16a34a;font-size:12px;}
      .totals-row td.net{font-size:15px;}
      .summary-box{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}
      .kpi{border:1.5px solid #e5e7eb;border-radius:8px;padding:10px 14px;}
      .kpi-label{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;}
      .kpi-value{font-size:17px;font-weight:800;margin-top:3px;}
      .kpi-value.red{color:#DC2626;} .kpi-value.green{color:#16a34a;}
      .sig-section{margin-top:30px;display:grid;grid-template-columns:repeat(3,1fr);gap:28px;}
      .sig-box{border-top:1px solid #999;padding-top:6px;text-align:center;font-size:10px;color:#888;}
      .footer{text-align:center;font-size:9.5px;color:#aaa;margin-top:20px;border-top:1px solid #eee;padding-top:10px;}
      @media print{
        body{padding:14px 18px;}
        @page{margin:.7cm;size:A4 landscape;}
        .no-print{display:none;}
      }
    </style></head><body>

    <div class="header">
      <h1>🍽️ RESERVE — Payroll Summary</h1>
      <div class="sub">Official Payroll Report</div>
      <div class="period">${filterDesc}</div>
    </div>

    <div class="meta">
      <span>Total Employees in this report: <strong>${filtered.length}</strong></span>
      <span>Generated: <strong>${new Date().toLocaleString('en-PH')}</strong></span>
    </div>

    <div class="summary-box">
      <div class="kpi"><div class="kpi-label">Total Base Pay</div><div class="kpi-value">${cur(grandBase)}</div></div>
      <div class="kpi"><div class="kpi-label">Total Overtime</div><div class="kpi-value">${cur(grandOT)}</div></div>
      <div class="kpi"><div class="kpi-label">Total Deductions</div><div class="kpi-value red">${cur(grandCA + grandDed)}</div></div>
      <div class="kpi"><div class="kpi-label">Grand Net Pay</div><div class="kpi-value green">${cur(grandTotal)}</div></div>
    </div>

    <table>
      <thead><tr>
        <th>#</th><th>Employee</th><th>Pay Period</th><th>Hours</th>
        <th>Base Pay</th><th>Overtime</th><th>Cash Advance</th><th>Deductions</th><th>Net Pay</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="totals-row">
          <td colspan="4"><strong>GRAND TOTAL</strong></td>
          <td class="r">${cur(grandBase)}</td>
          <td class="r">${cur(grandOT)}</td>
          <td class="r red">−${cur(grandCA)}</td>
          <td class="r red">−${cur(grandDed)}</td>
          <td class="net">${cur(grandTotal)}</td>
        </tr>
      </tfoot>
    </table>

    <div class="sig-section">
      <div class="sig-box">Prepared by<br><br><br></div>
      <div class="sig-box">Verified by<br><br><br></div>
      <div class="sig-box">Approved by<br><br><br></div>
    </div>

    <div class="footer">RESERVE Restaurant Manager &nbsp;&middot;&nbsp; This document is computer-generated.</div>
    <script>window.onload = () => { window.print(); };<\/script>
    </body></html>`);
    win.document.close();
  }

  // ── PRINT ALL PAYSLIPS (Dynamic 2x2 or 2x3 grid, zero blank pages) ─────────
  function printAllPayslips() {
    const allStaff = StorageAPI.getStaff();
    const payroll  = StorageAPI.getPayroll();
    const fStaff   = $('#payrollStaffFilter').value;
    const fMonth   = $('#payrollMonth').value;
    const fCutoff  = $('#payrollCutoffFilter').value;

    function parsePeriod(period) {
      if (!period) return { ym: '', cutoff: '' };
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) return { ym: m[1], cutoff: m[2] };
      const leg = period.match(/^(\d{4}-\d{2})$/);
      if (leg) return { ym: leg[1], cutoff: '' };
      return { ym: '', cutoff: '' };
    }
    function periodLabel(period) {
      if (!period) return '—';
      const m = period.match(/^(\d{4}-\d{2})-([12])$/);
      if (m) {
        const [year, mon] = m[1].split('-');
        const mn = new Date(Number(year), Number(mon) - 1, 1)
          .toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        return m[2] === '1' ? `${mn} · 1st Cut-off (1–15)` : `${mn} · 2nd Cut-off (16–end)`;
      }
      return period;
    }

    // Apply same filters as the table
    const filtered = payroll.filter(p => {
      if (fStaff && p.staff_id !== fStaff) return false;
      const { ym, cutoff } = parsePeriod(p.period);
      if (fMonth  && ym     !== fMonth)  return false;
      if (fCutoff && cutoff !== fCutoff) return false;
      return true;
    }).sort((a, b) => {
      const pa = parsePeriod(a.period), pb = parsePeriod(b.period);
      if (pa.ym !== pb.ym) return pb.ym.localeCompare(pa.ym);
      return (pb.cutoff || '0').localeCompare(pa.cutoff || '0');
    });

    if (!filtered.length) {
      toast('No payroll entries to print for the selected filter.', 'error');
      return;
    }

    const pageSize = 8;
    const pages = [];
    for (let i = 0; i < filtered.length; i += pageSize) {
      pages.push(filtered.slice(i, i + pageSize));
    }

    const win = window.open('', '_blank', 'width=1000,height=800');
    if (!win) { toast('Allow pop-ups to print payslips', 'error'); return; }

    const filterParts = [];
    if (fStaff) {
      const stName = allStaff.find(s => s.id === fStaff)?.name;
      if (stName) filterParts.push(stName);
    }
    if (fMonth) {
      const [yr, mo] = fMonth.split('-');
      filterParts.push(new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }));
    }
    if (fCutoff) {
      filterParts.push(fCutoff === '1' ? '1st Cut-off (1–15)' : '2nd Cut-off (16–end)');
    }
    const filterDesc = filterParts.length ? filterParts.join(' · ') : 'All Staff · All Periods';

    const pagesHtml = pages.map((pageEntries, pageIndex) => {
      const cardsHtml = pageEntries.map(p => {
        const st          = StorageAPI.getStaffById(p.staff_id) || allStaff.find(s => s.id === p.staff_id);
        const hourlyRate  = Number(st?.hourly_rate) || 0;
        const salary      = Number(st?.salary) || 0;
        const hoursWorked = Number(p.hours_worked) || 0;
        const base        = Number(p.base_pay) || (hourlyRate > 0 ? hourlyRate * hoursWorked : salary);
        const ot          = Number(p.overtime) || 0;
        const ca          = Number(p.cash_advance) || 0;
        const ded         = Number(p.deductions) || 0;
        const net         = Number(p.net_pay) || (base + ot - ca - ded);

        return `
          <div class="payslip-card">
            <div class="card-body">
              <div class="card-top">
                <div class="card-brand">
                  <img src="logo.jpg" alt="Logo" class="card-logo-img" onerror="this.style.display='none'">
                  <div>
                    <div class="card-brand-title">RESERVED</div>
                    <div class="card-brand-sub">Official Payslip</div>
                  </div>
                </div>
                <div class="card-period-tag">${periodLabel(p.period)}</div>
              </div>

              <div class="card-emp">
                <div class="emp-name">${st?.name || '—'}</div>
                <div class="emp-meta">${st?.position || 'Staff'}${st?.employment_type ? ' &middot; ' + st.employment_type : ''}</div>
              </div>

              <table class="card-table">
                <tbody>
                  <tr>
                    <td>Base Pay${hourlyRate > 0 && hoursWorked > 0 ? ` <span class="rate-note">(${hoursWorked}h &times; ${cur(hourlyRate)})</span>` : ''}</td>
                    <td class="r num">${cur(base)}</td>
                  </tr>
                  ${ot > 0 ? `<tr><td>Overtime Pay</td><td class="r num">+${cur(ot)}</td></tr>` : ''}
                  ${ca > 0 ? `<tr class="ded-row"><td>Cash Advance</td><td class="r num">&minus;${cur(ca)}</td></tr>` : ''}
                  ${ded > 0 ? `<tr class="ded-row"><td>Deductions</td><td class="r num">&minus;${cur(ded)}</td></tr>` : ''}
                </tbody>
              </table>

              <div class="card-net">
                <span class="net-lbl">NET PAY</span>
                <span class="net-amt">${cur(net)}</span>
              </div>
            </div>

            <div class="card-sigs">
              <div class="sig-box">
                <div class="sig-line"></div>
                <div class="sig-title">Prepared by</div>
              </div>
              <div class="sig-box">
                <div class="sig-line"></div>
                <div class="sig-title">Received by (Signature)</div>
              </div>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="page-sheet">
          <div class="page-watermark">Page ${pageIndex + 1} of ${pages.length} &middot; RESERVED Restaurant Manager</div>
          <div class="page-grid">
            ${cardsHtml}
          </div>
        </div>
      `;
    }).join('');

    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>RESERVED — All Payslips (${filterDesc})</title>
    <base href="${window.location.href}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <script>
      window.onload = function() {
        setTimeout(function() { window.print(); }, 350);
      };
    <\/script>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: "Inter", system-ui, -apple-system, sans-serif;
        color: #0f172a;
        background: #f1f5f9;
        padding: 16px 0;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .no-print {
        max-width: 210mm;
        margin: 0 auto 14px auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #1e293b;
        color: #fff;
        padding: 10px 18px;
        border-radius: 8px;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .no-print-btns {
        display: flex;
        gap: 8px;
      }
      .btn-print {
        background: #16a34a;
        color: #fff;
        border: none;
        padding: 6px 14px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
      }
      .btn-print:hover { background: #15803d; }
      .btn-close {
        background: #475569;
        color: #fff;
        border: none;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
      }
      .btn-close:hover { background: #334155; }

      .page-sheet {
        width: 210mm;
        height: 297mm;
        margin: 0 auto 16px auto;
        padding: 6mm 6mm;
        background: #ffffff;
        box-shadow: 0 4px 16px rgba(0,0,0,0.08);
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .page-watermark {
        font-size: 7.5px;
        color: #94a3b8;
        text-align: right;
        margin-bottom: 1.5mm;
      }
      .page-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        grid-template-rows: repeat(4, 1fr);
        gap: 2.5mm;
        width: 100%;
        flex: 1;
        box-sizing: border-box;
      }

      .payslip-card {
        border: 1.2px dashed #94a3b8;
        border-radius: 5px;
        padding: 5px 8px;
        background: #ffffff;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        height: 100%;
        overflow: hidden;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      .card-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .card-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 2px;
      }
      .card-brand {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .card-logo-img {
        width: 18px;
        height: 18px;
        object-fit: contain;
        border-radius: 3px;
      }
      .card-brand-title {
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.4px;
        color: #0f172a;
        line-height: 1.1;
      }
      .card-brand-sub {
        font-size: 7.5px;
        color: #64748b;
      }
      .card-period-tag {
        font-size: 7.5px;
        font-weight: 600;
        color: #1e293b;
        background: #f1f5f9;
        padding: 1.5px 5px;
        border-radius: 3px;
        border: 1px solid #e2e8f0;
        text-align: right;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 52%;
      }
      .card-emp {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 0;
      }
      .emp-name {
        font-size: 10.5px;
        font-weight: 700;
        color: #0f172a;
      }
      .emp-meta {
        font-size: 8px;
        color: #64748b;
      }
      .card-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 8.5px;
      }
      .card-table td {
        padding: 1px 0;
        color: #334155;
      }
      .card-table .num {
        font-weight: 600;
        color: #0f172a;
      }
      .card-table .ded-row td {
        color: #b91c1c;
      }
      .rate-note {
        font-size: 7.5px;
        color: #64748b;
      }
      .r { text-align: right; }
      .card-net {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f0fdf4;
        border: 1px solid #86efac;
        border-radius: 4px;
        padding: 2.5px 6px;
        margin-top: 1.5px;
      }
      .net-lbl {
        font-size: 8.5px;
        font-weight: 800;
        color: #166534;
        letter-spacing: 0.4px;
      }
      .net-amt {
        font-size: 12px;
        font-weight: 800;
        color: #15803d;
      }
      .card-sigs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        padding-top: 3px;
      }
      .sig-box { text-align: center; }
      .sig-line {
        border-top: 1px solid #94a3b8;
        height: 1px;
        margin-bottom: 2px;
      }
      .sig-title {
        font-size: 7.5px;
        color: #64748b;
      }

      @media print {
        @page {
          size: A4 portrait;
          margin: 3.5mm 4mm;
        }
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          background: transparent !important;
          width: 100% !important;
          height: auto !important;
          overflow: visible !important;
        }
        .no-print {
          display: none !important;
        }
        .page-sheet {
          width: 100% !important;
          max-width: 100% !important;
          height: 264mm !important;
          max-height: 264mm !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          box-shadow: none !important;
          box-sizing: border-box !important;
          display: flex !important;
          flex-direction: column !important;
          justify-content: space-between !important;
          overflow: hidden !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
        .page-sheet:not(:last-child) {
          page-break-after: always !important;
          break-after: page !important;
        }
        .page-sheet:last-child {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }
      }
    </style></head><body><div class="no-print">
      <div>
        <strong>RESERVED — Print All Payslips</strong>
        <span style="opacity:0.8;margin-left:8px;">(${filtered.length} entries &middot; ${pages.length} page${pages.length > 1 ? 's' : ''} &middot; 8 per page) &middot; ${filterDesc}</span>
      </div>
      <div class="no-print-btns">
        <button class="btn-print" onclick="window.print()">🖨️ Print</button>
        <button class="btn-close" onclick="window.close()">Close</button>
      </div>
    </div>${pagesHtml}</body></html>`);
    win.document.close();
  }

  // ── REPORTS ────────────────────────────────────────────────────────────────
  let _reportsReady = false;
  let _topItemsFilter = 'selected'; // 'selected' | 'week' | 'month' | 'year' | 'all'
  let _reportFilterMode = 'monthly'; // 'monthly' | 'weekly' | 'custom'

  function updateTopItemsBtnStyles() {
    $$('.top-items-filter-btn').forEach(b => {
      const isActive = b.dataset.filter === _topItemsFilter;
      b.style.background  = isActive ? 'var(--green)' : 'var(--bg)';
      b.style.color       = isActive ? '#fff'         : 'var(--text)';
      b.style.border      = isActive ? '1.5px solid var(--green)' : '1.5px solid var(--border)';
    });
  }

  function updateReportModeUI() {
    const mBtn = $('#reportModeMonthly');
    const wBtn = $('#reportModeWeekly');
    const cBtn = $('#reportModeCustom');
    const mWrap = $('#reportMonthlyWrap');
    const wWrap = $('#reportWeeklyWrap');
    const cWrap = $('#reportCustomWrap');

    const isM = _reportFilterMode === 'monthly';
    const isW = _reportFilterMode === 'weekly';
    const isC = _reportFilterMode === 'custom';

    if (mBtn) {
      mBtn.style.background = isM ? 'var(--green)' : 'transparent';
      mBtn.style.color      = isM ? '#fff'         : 'var(--text)';
    }
    if (wBtn) {
      wBtn.style.background = isW ? 'var(--green)' : 'transparent';
      wBtn.style.color      = isW ? '#fff'         : 'var(--text)';
    }
    if (cBtn) {
      cBtn.style.background = isC ? 'var(--green)' : 'transparent';
      cBtn.style.color      = isC ? '#fff'         : 'var(--text)';
    }

    if (mWrap) mWrap.style.display = isM ? 'inline-flex' : 'none';
    if (wWrap) wWrap.style.display = isW ? 'inline-flex' : 'none';
    if (cWrap) cWrap.style.display = isC ? 'inline-flex' : 'none';
  }

  function applyReportMonthSelection() {
    const sel = $('#reportFilterMonth');
    if (!sel || !sel.value) return;
    const { start, end } = monthToRange(sel.value);
    if ($('#reportStart')) $('#reportStart').value = start || '';
    if ($('#reportEnd'))   $('#reportEnd').value   = end   || '';
  }

  function applyReportWeekSelection() {
    const sel = $('#reportFilterWeek');
    if (!sel || !sel.value) return;
    const parts = sel.value.split('_');
    if (parts.length === 2) {
      if ($('#reportStart')) $('#reportStart').value = parts[0] || '';
      if ($('#reportEnd'))   $('#reportEnd').value   = parts[1] || '';
    }
  }

  function refreshReportFilterDropdowns() {
    const sales = StorageAPI.getSales();
    const expenses = StorageAPI.getExpenses();
    const payroll = StorageAPI.getPayroll();
    const allDates = [
      ...sales.map(s => s.date),
      ...expenses.map(e => e.date),
      ...payroll.map(p => Calc.periodToDate(p.period) || p.date)
    ].filter(Boolean);

    const monthSel = $('#reportFilterMonth');
    if (monthSel) {
      const prevMonth = monthSel.value;
      buildMonthOptions(allDates, 'reportFilterMonth', !prevMonth);
      if (prevMonth && Array.from(monthSel.options).some(o => o.value === prevMonth)) {
        monthSel.value = prevMonth;
      }
    }

    const weekSel = $('#reportFilterWeek');
    if (weekSel) {
      const prevWeek = weekSel.value;
      buildWeekOptions(allDates, 'reportFilterWeek', !prevWeek);
      if (prevWeek && Array.from(weekSel.options).some(o => o.value === prevWeek)) {
        weekSel.value = prevWeek;
      }
    }
  }

  function setReportMode(mode) {
    _reportFilterMode = mode;
    updateReportModeUI();
    if (mode === 'monthly') {
      applyReportMonthSelection();
      renderReports();
    } else if (mode === 'weekly') {
      applyReportWeekSelection();
      renderReports();
    }
  }

  function setupReports() {
    refreshReportFilterDropdowns();
    if (_reportFilterMode === 'monthly') {
      applyReportMonthSelection();
    } else if (_reportFilterMode === 'weekly') {
      applyReportWeekSelection();
    }
    updateReportModeUI();

    if (_reportsReady) return;
    _reportsReady = true;
    updateTopItemsBtnStyles();

    const mBtn = $('#reportModeMonthly');
    if (mBtn) mBtn.addEventListener('click', () => setReportMode('monthly'));
    const wBtn = $('#reportModeWeekly');
    if (wBtn) wBtn.addEventListener('click', () => setReportMode('weekly'));
    const cBtn = $('#reportModeCustom');
    if (cBtn) cBtn.addEventListener('click', () => setReportMode('custom'));

    const mSel = $('#reportFilterMonth');
    if (mSel) {
      mSel.addEventListener('change', () => {
        applyReportMonthSelection();
        renderReports();
      });
    }

    const wSel = $('#reportFilterWeek');
    if (wSel) {
      wSel.addEventListener('change', () => {
        applyReportWeekSelection();
        renderReports();
      });
    }

    $('#reportApply').addEventListener('click', () => {
      _topItemsFilter = 'selected';
      updateTopItemsBtnStyles();
      renderReports();
    });
    $('#reportExportCsv').addEventListener('click', exportReportCsv);

    // Top 10 filter buttons
    $$('.top-items-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _topItemsFilter = btn.dataset.filter;
        updateTopItemsBtnStyles();
        renderTopItems();
      });
    });
  }

  // Compute [start, end] strings for the Top 10 filter
  function _topItemsDateRange() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    function prettyD(str) {
      if (!str) return '';
      const [y, m, d] = str.split('-');
      return new Date(Number(y), Number(m)-1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    switch (_topItemsFilter) {
      case 'selected': {
        const start = $('#reportStart')?.value || null;
        const end   = $('#reportEnd')?.value   || null;
        const label = (start && end) ? `${prettyD(start)} – ${prettyD(end)}` : (start ? `From ${prettyD(start)}` : (end ? `Until ${prettyD(end)}` : 'Selected date range'));
        return { start, end, label };
      }
      case 'week': {
        const dow = now.getDay();
        const mon = new Date(now);
        mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        return { start: fmt(mon), end: fmt(sun),
          label: `Week of ${mon.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${sun.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}` };
      }
      case 'month': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { start: fmt(start), end: fmt(end),
          label: now.toLocaleDateString('en-US',{month:'long',year:'numeric'}) };
      }
      case 'year': {
        return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31`,
          label: `Year ${now.getFullYear()}` };
      }
      default:
        return { start: null, end: null, label: 'All recorded sales' };
    }
  }

  function renderTopItems() {
    const sales = StorageAPI.getSales();
    const inv   = StorageAPI.getInventory();
    const { start, end, label } = _topItemsDateRange();

    const periodLabel = $('#topItemsPeriodLabel');
    if (periodLabel) periodLabel.textContent = `📅 Showing: ${label}`;

    const filtered = sales.filter(s => inRange(s.date, start, end));
    const itemMap = {};
    filtered.forEach(sale => {
      sale.lines.forEach(l => {
        const key = l.item_id || l.item_name; if (!key) return;
        if (!itemMap[key]) {
          const item = inv.find(i => i.id === l.item_id);
          itemMap[key] = { name: l.item_name || item?.name || key, category: item?.category || '—', qty: 0, revenue: 0, gp: 0 };
        }
        const t = Calc.lineTotals(l);
        itemMap[key].qty     += l.qty;
        itemMap[key].revenue += t.revenue;
        itemMap[key].gp      += t.gp;
      });
    });

    const topItems = Object.values(itemMap).sort((a, b) => b.qty - a.qty).slice(0, 10);
    const maxQty = topItems[0]?.qty || 1;

    $('#reportTopItemsTbody').innerHTML = topItems.map((t, i) => {
      const barPct = Math.round((t.qty / maxQty) * 100);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<span style="color:var(--muted);font-weight:700;">#${i+1}</span>`;
      return `<tr>
        <td style="font-weight:700;text-align:center;">${medal}</td>
        <td>
          <div style="font-weight:600;margin-bottom:3px;">${t.name}</div>
          <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden;">
            <div style="height:100%;width:${barPct}%;background:var(--green);border-radius:4px;transition:width .4s;"></div>
          </div>
        </td>
        <td><span class="chip" style="margin:0;font-size:11px;">${t.category}</span></td>
        <td><strong>${t.qty}</strong></td>
        <td>${cur(t.revenue)}</td>
        <td style="color:var(--green);font-weight:600;">${cur(t.gp)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="no-data-placeholder">No sales data for this period</td></tr>';
  }

  function renderReports() {
    refreshReportFilterDropdowns();
    if (_reportFilterMode === 'monthly') {
      applyReportMonthSelection();
    } else if (_reportFilterMode === 'weekly') {
      applyReportWeekSelection();
    }
    const sales    = StorageAPI.getSales();
    const expenses = StorageAPI.getExpenses();
    const payroll  = StorageAPI.getPayroll();
    const inv      = StorageAPI.getInventory();
    const start    = $('#reportStart').value || null;
    const end      = $('#reportEnd').value   || null;

    const fSales = sales.filter(s => inRange(s.date, start, end));
    const fExp   = expenses.filter(e => inRange(e.date, start, end));
    const fPay   = payroll.filter(p => {
      if (!p.period) return true;
      // Use the canonical date for this cutoff period
      const pDate = Calc.periodToDate(p.period);
      if (!pDate) return true;
      return (!start || pDate >= start) && (!end || pDate <= end);
    });

    const salesRev = fSales.reduce((sum, s) => sum + saleRevenue(s), 0);
    const salesGP  = fSales.reduce((sum, s) => sum + saleGP(s), 0);
    const expTotal = fExp.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const payTotal = fPay.reduce((sum, p) => sum + (Number(p.net_pay) || 0), 0);
    const netP     = salesGP - expTotal - payTotal;

    $('#repSales').textContent    = cur(salesRev);
    $('#repGP').textContent       = cur(salesGP);
    $('#repExpenses').textContent = cur(expTotal);
    $('#repPayroll').textContent  = cur(payTotal);
    $('#repNP').textContent       = cur(netP);
    $('#repNP').style.color       = netP >= 0 ? 'var(--green)' : 'var(--red)';

    // Sales by day (most recent first, max 15 days)
    const dayMap = {};
    fSales.forEach(s => {
      const dk = s.date.slice(0, 10);
      if (!dayMap[dk]) dayMap[dk] = { revenue: 0, gp: 0, count: 0 };
      dayMap[dk].revenue += saleRevenue(s); dayMap[dk].gp += saleGP(s); dayMap[dk].count++;
    });
    const dayKeys = Object.keys(dayMap).sort((a, b) => b.localeCompare(a)).slice(0, 15);
    $('#repSalesBreakdownTbody').innerHTML = dayKeys.map(dk => {
      const d = dayMap[dk];
      const lbl = new Date(dk).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `<tr>
        <td style="font-size:12px;">${lbl}</td>
        <td>${cur(d.revenue)}</td>
        <td style="color:var(--green);font-weight:600;">${cur(d.gp)}</td>
        <td style="font-size:11px;color:var(--muted);">${d.count} sale(s)</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="no-data-placeholder">No sales in range</td></tr>';

    // Expenses by category
    const catMap = {};
    fExp.forEach(e => { const c = e.category || 'Other'; catMap[c] = (catMap[c] || 0) + (Number(e.amount) || 0); });
    const catRows = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    $('#repExpensesByCatTbody').innerHTML = catRows.map(([cat, amt]) =>
      `<tr><td>${cat}</td><td style="color:var(--red);font-weight:600;">${cur(amt)}</td><td style="font-size:12px;color:var(--muted);">${expTotal ? ((amt / expTotal) * 100).toFixed(1) + '%' : '—'}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="no-data-placeholder">No expenses in range</td></tr>';

    // Top 10 items — rendered by renderTopItems() with its own independent filter
    renderTopItems();
  }

  function exportReportCsv() {
    const sales = StorageAPI.getSales(), expenses = StorageAPI.getExpenses(), payroll = StorageAPI.getPayroll();
    const start = $('#reportStart').value || null, end = $('#reportEnd').value || null;
    const fSales = sales.filter(s => inRange(s.date, start, end));
    const fExp   = expenses.filter(e => inRange(e.date, start, end));
    const fPay   = payroll.filter(p => {
      if (!p.period) return true;
      const pDate = Calc.periodToDate(p.period);
      if (!pDate) return true;
      return (!start || pDate >= start) && (!end || pDate <= end);
    });
    const salesRev = fSales.reduce((sum, s) => sum + saleRevenue(s), 0);
    const salesGP  = fSales.reduce((sum, s) => sum + saleGP(s), 0);
    const expTotal = fExp.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const payTotal = fPay.reduce((sum, p) => sum + (Number(p.net_pay) || 0), 0);
    StorageAPI.downloadCSV('report.csv', [
      { metric: 'Filter Mode',         value: _reportFilterMode },
      { metric: 'Period From',         value: start || 'All time' },
      { metric: 'Period To',           value: end   || 'All time' },
      { metric: 'Total Sales Revenue', value: salesRev },
      { metric: 'Gross Profit',        value: salesGP  },
      { metric: 'Total Expenses',      value: expTotal },
      { metric: 'Total Payroll',       value: payTotal },
      { metric: 'Net Profit',          value: salesGP - expTotal - payTotal }
    ]);
    toast('Report exported ✓');
  }

  // ── DISCOUNT LOG ────────────────────────────────────────────────────────────
  let _dlReady = false;

  // Backfill discount log from existing sales that have discounts but no log entry.
  // Safe to call multiple times — skips sale_ids already present in the log.
  function backfillDiscountLog() {
    const sales = StorageAPI.getSales();
    const log   = StorageAPI.getDiscountLog();
    const loggedSaleIds = new Set(log.map(e => e.sale_id));
    const newEntries = [];

    sales.forEach(sale => {
      const saleLines = sale.lines || [];

      // Per-item discounts
      saleLines
        .filter(l => l.item_discount && l.item_discount.type && l.item_discount.type !== 'none')
        .forEach(l => {
          // Only add if this sale isn't already logged (avoid duplicates)
          if (loggedSaleIds.has(sale.id)) return;
          const discAmt = Calc.lineDiscount({ qty: l.qty, sell_price: l.sell_price || l.price || 0, item_discount: l.item_discount });
          if (!discAmt) return;
          newEntries.push({
            id:             StorageAPI.uid('dl'),
            sale_id:        sale.id,
            date:           sale.date,
            product_id:     l.item_id || null,
            product_name:   l.item_name || '—',
            discount_type:  l.item_discount.type,
            discount_value: l.item_discount.value,
            discount_amt:   discAmt,
            original_price: l.sell_price || l.price || 0,
            qty:            l.qty,
            done_by:        sale.done_by || 'Unknown'
          });
        });

      // Order-level discount
      if (!loggedSaleIds.has(sale.id) &&
          sale.discount_type && sale.discount_type !== 'none' &&
          (Number(sale.discount_amt) || 0) > 0) {
        const subtotal = saleLines.reduce((s, l) => s + (Number(l.sell_price || l.price || 0) * (Number(l.qty) || 0)), 0);
        const discVal  = sale.discount_type === 'senior'  ? 20
                       : sale.discount_type === 'percent' ? (subtotal > 0 ? +((Number(sale.discount_amt) / subtotal) * 100).toFixed(2) : 0)
                       : Number(sale.discount_amt);
        newEntries.push({
          id:             StorageAPI.uid('dl'),
          sale_id:        sale.id,
          date:           sale.date,
          product_id:     null,
          product_name:   '(Order-level discount)',
          discount_type:  sale.discount_type,
          discount_value: discVal,
          discount_amt:   Number(sale.discount_amt),
          original_price: subtotal,
          qty:            1,
          done_by:        sale.done_by || 'Unknown'
        });
      }
    });

    if (newEntries.length) {
      StorageAPI.addDiscountLogEntries(newEntries);
      console.log(`✅ Backfilled ${newEntries.length} discount log entries from existing sales`);
    } else {
      console.log('✅ Discount log backfill: nothing new to add');
    }
  }

  function setupDiscountLog() {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    const dlStart = $('#dlStart');
    const dlEnd   = $('#dlEnd');
    if (dlStart && !dlStart.value) dlStart.value = firstOfMonth;
    if (dlEnd   && !dlEnd.value)   dlEnd.value   = now.toISOString().slice(0,10);
    if (_dlReady) return;
    _dlReady = true;
    $('#dlApply').addEventListener('click', renderDiscountLog);
    $('#dlExportCsv').addEventListener('click', exportDiscountLogCsv);
    $('#dlClearBtn').addEventListener('click', () => {
      if (!confirm('Clear ALL discount log entries? This cannot be undone.')) return;
      StorageAPI.clearDiscountLog();
      renderDiscountLog();
      toast('Discount log cleared');
    });
  }

  function renderDiscountLog() {
    setupDiscountLog();
    const log    = StorageAPI.getDiscountLog();
    const start  = $('#dlStart') ? $('#dlStart').value || null : null;
    const end    = $('#dlEnd')   ? $('#dlEnd').value   || null : null;
    const filtered = log.filter(e => inRange(e.date, start, end));

    // KPIs — exclude order-level entries so counts reflect actual item discounts
    const filteredItemsOnly = filtered.filter(e => e.product_name !== '(Order-level discount)' && e.product_id !== null);
    const totalAmt = filteredItemsOnly.reduce((s, e) => s + (Number(e.discount_amt) || 0), 0);
    const maxEntry = filteredItemsOnly.reduce((mx, e) => (Number(e.discount_amt)||0) > (Number(mx?.discount_amt)||0) ? e : mx, null);

    const elTotalAmt   = $('#dlTotalAmt');
    const elTotalCount = $('#dlTotalCount');
    const elTopItem    = $('#dlTopItem');
    const elMaxAmt     = $('#dlMaxAmt');
    if (elTotalAmt)   elTotalAmt.textContent   = cur(totalAmt);
    if (elTotalCount) elTotalCount.textContent = filteredItemsOnly.length;
    if (elMaxAmt)     elMaxAmt.textContent     = maxEntry ? cur(maxEntry.discount_amt) : cur(0);

    // Top items by total discount ₱
    const inventory  = StorageAPI.getInventory();
    const menuProds  = StorageAPI.getMenuProducts();
    function lookupCategory(product_id, product_name) {
      if (!product_id) return '—';
      const inv  = inventory.find(i => i.id === product_id);
      if (inv?.category) return inv.category;
      const menu = menuProds.find(p => p.id === product_id);
      if (menu?.category) return menu.category;
      return '—';
    }

    const byItem = new Map();
    filtered
      .filter(e => e.product_name !== '(Order-level discount)' && e.product_id !== null)
      .forEach(e => {
        const key   = e.product_id || e.product_name;
        const entry = byItem.get(key) || {
          name:     e.product_name || key,
          category: lookupCategory(e.product_id, e.product_name),
          count: 0, qty: 0, total: 0
        };
        entry.count += 1;
        entry.qty   += Number(e.qty) || 0;
        entry.total += Number(e.discount_amt) || 0;
        byItem.set(key, entry);
      });
    const topItems = Array.from(byItem.values()).sort((a, b) => b.total - a.total);
    if (elTopItem) elTopItem.textContent = topItems.length ? topItems[0].name : '—';

    const dlTopItemsTbody = $('#dlTopItemsTbody');
    if (dlTopItemsTbody) {
      dlTopItemsTbody.innerHTML = topItems.length
        ? topItems.slice(0,10).map((t,i) => `<tr>
            <td><strong>#${i+1}</strong></td>
            <td>${t.name}</td>
            <td style="color:var(--muted);font-size:12px;">${t.category}</td>
            <td>${t.count}</td>
            <td><strong>${t.qty} pcs</strong></td>
            <td style="color:var(--red);font-weight:600;">${cur(t.total)}</td>
            <td>${cur(t.count ? t.total/t.count : 0)}</td>
          </tr>`).join('')
        : '<tr><td colspan="7" class="no-data-placeholder">No discounts recorded in this period</td></tr>';
    }

    // By type breakdown
    const typeLabels = { percent: 'Percentage (%)', fixed: 'Fixed Amount (₱)', senior: 'Senior / PWD (20%)' };
    const byType = {};
    filtered.forEach(e => {
      const t = e.discount_type || 'unknown';
      if (!byType[t]) byType[t] = { count: 0, total: 0 };
      byType[t].count++;
      byType[t].total += Number(e.discount_amt) || 0;
    });
    const dlByTypeTbody = $('#dlByTypeTbody');
    if (dlByTypeTbody) {
      dlByTypeTbody.innerHTML = Object.keys(byType).length
        ? Object.entries(byType).sort((a,b) => b[1].total - a[1].total).map(([type, v]) => `<tr>
            <td>${typeLabels[type] || type}</td>
            <td>${v.count}</td>
            <td style="color:var(--red);">${cur(v.total)}</td>
          </tr>`).join('')
        : '<tr><td colspan="3" class="no-data-placeholder">No data</td></tr>';
    }

    // Full log table — exclude order-level discount entries
    const dlLogTbody = $('#dlLogTbody');
    if (dlLogTbody) {
      const filteredItems = filtered.filter(e => e.product_name !== '(Order-level discount)' && e.product_id !== null);
      dlLogTbody.innerHTML = filteredItems.length
        ? filteredItems.map(e => {
            const discLabel = e.discount_type === 'percent'  ? `${e.discount_value}%`
                            : e.discount_type === 'senior'   ? '20% Senior/PWD'
                            : e.discount_type === 'fixed'    ? `₱${Number(e.discount_value).toFixed(2)} fixed`
                            : e.discount_type || '—';
            return `<tr>
              <td>${e.date ? e.date.slice(0,16).replace('T',' ') : '—'}</td>
              <td><strong>${e.product_name || '—'}</strong></td>
              <td>${e.qty}</td>
              <td>${cur(e.original_price)}</td>
              <td>${typeLabels[e.discount_type] || e.discount_type || '—'}</td>
              <td>${discLabel}</td>
              <td style="color:var(--red);font-weight:600;">−${cur(e.discount_amt)}</td>
              <td>${e.done_by || '—'}</td>
              <td style="font-size:10px;color:var(--muted);">${e.sale_id || '—'}</td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="9" class="no-data-placeholder">No discount entries in this period</td></tr>';
    }
  }

  function exportDiscountLogCsv() {
    const log   = StorageAPI.getDiscountLog();
    const start = $('#dlStart') ? $('#dlStart').value || null : null;
    const end   = $('#dlEnd')   ? $('#dlEnd').value   || null : null;
    const rows  = log.filter(e => inRange(e.date, start, end)).map(e => ({
      date:           e.date ? e.date.slice(0,16).replace('T',' ') : '',
      product_name:   e.product_name || '',
      qty:            e.qty,
      original_price: e.original_price,
      discount_type:  e.discount_type,
      discount_value: e.discount_value,
      discount_amt:   e.discount_amt,
      done_by:        e.done_by || '',
      sale_id:        e.sale_id || ''
    }));
    if (!rows.length) { toast('No data to export', 'error'); return; }
    StorageAPI.downloadCSV('discount_log.csv', rows);
    toast('Discount log exported ✓');
  }

  // ── MENU ───────────────────────────────────────────────────────────────────
  const menuOrder = [];

  // Guard flag — prevents duplicate event listeners when user logs out and back in
  let _menuReady = false;

  function setupMenu() {
    if (!_menuReady) {
      _menuReady = true;

      $$('#menu .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          $$('#menu .tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          $$('#menu .tab-panel').forEach(p => p.classList.remove('active'));
          const panel = $('#' + btn.dataset.tab);
          if (panel) panel.classList.add('active');
          if (btn.dataset.tab === 'menuManageTab') {
            renderMenuProductsTable();
            // Wire search inputs once the tab is visible
            const srch = $('#manageProductSearch');
            const catF = $('#manageProductCatFilter');
            if (srch  && !srch._wired)  { srch._wired  = true; srch.addEventListener('input',  renderMenuProductsTable); }
            if (catF  && !catF._wired)  { catF._wired  = true; catF.addEventListener('change', renderMenuProductsTable); }
          }
          if (btn.dataset.tab === 'menuPosTab')    renderMenuBoard();
        });
      });

      $('#addMenuProductBtn').addEventListener('click', () => openMenuProductDialog());
      $('#menuProductDialogCancel').addEventListener('click', () => $('#menuProductDialog').close());
      $('#addIngredientBtn').addEventListener('click', () => addIngredientRow());

      $('#menuProductForm').addEventListener('submit', e => {
        e.preventDefault();
        const id       = $('#mpId').value || StorageAPI.uid('mp');
        const existing = StorageAPI.getMenuProductById(id);
        const now      = new Date().toISOString();
        const recipes  = collectIngredientRows();
        const product  = {
          id,
          name:         $('#mpName').value.trim(),
          category:     $('#mpCategory').value.trim(),
          price:        Number($('#mpPrice').value) || 0,
          description:  $('#mpDescription').value.trim(),
          is_available: $('#mpAvailable').checked,
          recipes,
          created_at:   existing ? existing.created_at : now,
          updated_at:   now
        };
        StorageAPI.upsertMenuProduct(product);
        toast(existing ? `"${product.name}" updated ✓` : `"${product.name}" added ✓`, 'success');
        $('#menuProductDialog').close();
        refreshMenuCategoryList();
        renderMenuBoard();
        renderMenuProductsTable();
      });

      $('#menuClearOrderBtn').addEventListener('click', () => {
        if (!menuOrder.length) return;
        if (confirm('Clear the current order?')) {
          menuOrder.length = 0;
          const saleDateEl = $('#menuSaleDate');
          if (saleDateEl) saleDateEl.value = today();
          if ($('#menuDiscountType'))        $('#menuDiscountType').value = 'none';
          if ($('#menuDiscountValue'))       $('#menuDiscountValue').value = '0';
          if ($('#menuDiscountCustomLabel')) $('#menuDiscountCustomLabel').value = '';
          if ($('#menuIncludeVat'))          $('#menuIncludeVat').checked = false;
          if ($('#menuServiceChargeType'))   $('#menuServiceChargeType').value = 'none';
          if ($('#menuServiceChargeValue'))  $('#menuServiceChargeValue').value = '0';
          renderOrderPad(); refreshMenuBadges();
        }
      });
      $('#menuRecordSaleBtn').addEventListener('click',  recordMenuSale);
      $('#menuPrintReceiptBtn').addEventListener('click', printMenuReceipt);

      $('#menuBoard').addEventListener('click', e => {
        const card = e.target.closest('.menu-item-card');
        if (!card || card.classList.contains('menu-unavailable')) return;
        const id = card.dataset.id;
        const product = StorageAPI.getMenuProductById(id);
        if (!product) return;
        const existing = menuOrder.find(o => o.product_id === id);
        if (existing) { existing.qty++; }
        else { menuOrder.push({ product_id: id, name: product.name, category: product.category, qty: 1, price: Number(product.price) || 0, item_discount: { type: 'none', value: 0 } }); }
        card.classList.add('menu-item-added');
        setTimeout(() => card.classList.remove('menu-item-added'), 350);
        refreshMenuBadges();
        renderOrderPad();
      });

      $('#menuOrderLines').addEventListener('click', e => {
        const btn = e.target.closest('button[data-idx]');
        if (!btn) return;
        const i = Number(btn.dataset.idx);
        if (isNaN(i) || i < 0 || i >= menuOrder.length) return;
        if      (btn.classList.contains('ol-minus'))  { menuOrder[i].qty--; if (menuOrder[i].qty <= 0) menuOrder.splice(i, 1); }
        else if (btn.classList.contains('ol-plus'))   { menuOrder[i].qty++; }
        else if (btn.classList.contains('ol-remove')) { menuOrder.splice(i, 1); }
        else if (btn.classList.contains('ol-disc')) {
          // Toggle per-item discount panel
          const panel = $('#ol-disc-panel-' + i);
          if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          return; // don't re-render yet
        }
        else if (btn.classList.contains('ol-disc-apply')) {
          const orderLines = $('#menuOrderLines');
          const typeEl = orderLines.querySelector(`.ol-disc-type[data-idx="${i}"]`);
          const valEl  = orderLines.querySelector(`.ol-disc-val[data-idx="${i}"]`);
          const type   = typeEl ? typeEl.value : 'none';
          const value  = valEl  ? Number(valEl.value) || 0 : 0;
          if (type !== 'none' && type !== 'senior' && value <= 0) {
            toast('Enter a discount value greater than 0', 'error');
            return;
          }
          menuOrder[i].item_discount = { type, value };
          // panel will close on re-render
        }
        else if (btn.classList.contains('ol-disc-clear')) {
          menuOrder[i].item_discount = { type: 'none', value: 0 };
        }
        renderOrderPad(); refreshMenuBadges();
      });

      $('#menuSearch').addEventListener('input',    renderMenuBoard);
      // Per-item discount type → show/hide value input
      $('#menuOrderLines').addEventListener('change', e => {
        const sel = e.target.closest('.ol-disc-type');
        if (!sel) return;
        const i = Number(sel.dataset.idx);
        const valEl = $('#menuOrderLines').querySelector(`.ol-disc-val[data-idx="${i}"]`);
        if (valEl) valEl.style.display = (sel.value === 'none' || sel.value === 'senior') ? 'none' : 'block';
      });
      $('#menuFilterCat').addEventListener('change', renderMenuBoard);
      $('#menuDiscountType').addEventListener('change', () => { updateOrderTotalsUI(); });
      $('#menuDiscountValue').addEventListener('input',  () => { updateOrderTotalsUI(); });
      $('#menuDiscountCustomLabel').addEventListener('input', () => { updateOrderTotalsUI(); });
      $('#menuIncludeVat').addEventListener('change',   () => { updateOrderTotalsUI(); });
      $('#menuServiceChargeType').addEventListener('change', () => { updateOrderTotalsUI(); });
      $('#menuServiceChargeValue').addEventListener('input',  () => { updateOrderTotalsUI(); });
    }
  }

  // ── Ingredient row helpers ─────────────────────────────────────────────────
  function buildInvOptions(selectedId) {
    const sorted = [...StorageAPI.getInventory()].sort((a, b) => (a.name||'').localeCompare(b.name||''));
    return '<option value="">— Select ingredient —</option>' +
      sorted.map(it =>
        `<option value="${it.id}" data-unit="${it.unit||''}" ${it.id === selectedId ? 'selected' : ''}>${it.name}${it.unit ? ' ('+it.unit+')' : ''} [${it.inventory_type}]</option>`
      ).join('');
  }

  function addIngredientRow(data = {}) {
    const container = $('#ingredientRows');
    const emptyMsg  = $('#ingredientEmptyMsg');
    if (emptyMsg) emptyMsg.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.innerHTML = `
      <select class="ing-item-sel">${buildInvOptions(data.inventory_item_id || '')}</select>
      <input  class="ing-qty" type="number" step="0.001" min="0.001" placeholder="Qty" value="${data.quantity || ''}" />
      <span   class="ing-unit">${data.unit || ''}</span>
      <button type="button" class="ing-remove btn btn-ghost btn-sm btn-icon" title="Remove">✕</button>`;
    const sel  = row.querySelector('.ing-item-sel');
    const unit = row.querySelector('.ing-unit');
    sel.addEventListener('change', () => { unit.textContent = sel.options[sel.selectedIndex]?.dataset.unit || ''; });
    row.querySelector('.ing-remove').addEventListener('click', () => {
      row.remove();
      if (!container.children.length && emptyMsg) emptyMsg.style.display = '';
    });
    container.appendChild(row);
  }

  function collectIngredientRows() {
    return $$('#ingredientRows .ingredient-row').reduce((acc, row) => {
      const sel = row.querySelector('.ing-item-sel');
      const qty = Number(row.querySelector('.ing-qty').value) || 0;
      if (!sel.value || qty <= 0) return acc;
      const item = StorageAPI.getInventory().find(i => i.id === sel.value);
      acc.push({
        inventory_item_id: sel.value,
        ingredient_name:   item ? item.name : (sel.options[sel.selectedIndex]?.text || ''),
        quantity:          qty,
        unit:              row.querySelector('.ing-unit').textContent.trim()
      });
      return acc;
    }, []);
  }

  function openMenuProductDialog(id) {
    const existing = id ? StorageAPI.getMenuProductById(id) : null;
    $('#menuProductDialogTitle').textContent = existing ? 'Edit Product' : 'Add Menu Product';
    $('#mpId').value          = existing ? existing.id : '';
    $('#mpName').value        = existing ? existing.name : '';
    $('#mpCategory').value    = existing ? existing.category : '';
    $('#mpPrice').value       = existing ? existing.price : '';
    $('#mpDescription').value = existing ? (existing.description || '') : '';
    $('#mpAvailable').checked = existing ? existing.is_available !== false : true;
    $('#ingredientRows').innerHTML = '';
    const emptyMsg = $('#ingredientEmptyMsg');
    const recipes  = existing ? (existing.recipes || []) : [];
    if (recipes.length) { if (emptyMsg) emptyMsg.style.display = 'none'; recipes.forEach(r => addIngredientRow(r)); }
    else { if (emptyMsg) emptyMsg.style.display = ''; }
    $('#menuProductDialog').showModal();
    setTimeout(() => $('#mpName').focus(), 50);
  }

  function refreshMenuCategoryList() {
    const cats = Array.from(new Set(StorageAPI.getMenuProducts().map(p => p.category).filter(Boolean)));
    const dl = $('#menuCategoryList');
    if (dl) dl.innerHTML = cats.map(c => `<option value="${c}">`).join('');
  }

  function getProductStockStatus(product) {
    const recipes = product.recipes || [];
    if (!recipes.length) return 'ok';
    const inv = StorageAPI.getInventory();
    const threshold = Number(StorageAPI.getSettings().lowStockThreshold) || 10;
    let status = 'ok';
    for (const r of recipes) {
      const item  = inv.find(i => i.id === r.inventory_item_id);
      if (!item) continue;
      const stock = Number(item.stock_qty) || 0;
      const need  = Number(r.quantity)    || 0;
      if (stock < need)              return 'out';
      if (stock - need <= threshold) status = 'low';
    }
    return status;
  }

  function renderMenu() {
    refreshMenuCategoryList();
    const products = StorageAPI.getMenuProducts();
    const cats = Array.from(new Set(products.map(p => p.category).filter(Boolean)));
    const sel  = $('#menuFilterCat');
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Categories</option>' +
      cats.map(c => `<option value="${c}"${c === prev ? ' selected' : ''}>${c}</option>`).join('');
    // Default sale date to today if not already set
    const saleDateInput = $('#menuSaleDate');
    if (saleDateInput && !saleDateInput.value) {
      saleDateInput.value = today();
    }
    renderMenuBoard();
    renderOrderPad();
  }

  function renderMenuBoard() {
    const products  = StorageAPI.getMenuProducts();
    const search    = ($('#menuSearch').value || '').toLowerCase().trim();
    const catFilter = $('#menuFilterCat').value;
    const available = products.filter(p => p.is_available !== false);
    const filtered  = available.filter(p => {
      if (catFilter && p.category !== catFilter) return false;
      if (search) { const hay = ((p.name||'')+' '+(p.category||'')+' '+(p.description||'')).toLowerCase(); if (!hay.includes(search)) return false; }
      return true;
    });
    const board = $('#menuBoard');
    if (!products.length) {
      board.innerHTML = `<div class="no-data-placeholder" style="padding:40px 20px;"><div style="font-size:40px;margin-bottom:12px;">🍽️</div><strong>No menu products yet.</strong><br>Click <strong>+ Add Product</strong> to add your first dish or drink.</div>`;
      return;
    }
    if (!filtered.length) { board.innerHTML = `<div class="no-data-placeholder">No products match your search.</div>`; return; }
    const byCategory = {};
    filtered.forEach(p => { const c = p.category || 'Other'; (byCategory[c] = byCategory[c] || []).push(p); });
    board.innerHTML = Object.entries(byCategory).map(([cat, prods]) => `
      <div class="menu-category-block">
        <div class="menu-category-label">${cat}</div>
        <div class="menu-items-grid">
          ${prods.map(p => {
            const inOrder = menuOrder.find(o => o.product_id === p.id);
            const status  = getProductStockStatus(p);
            const isOut   = status === 'out';
            const badge   = isOut ? `<div class="menu-stock-badge out">⛔ Out of stock</div>` : status === 'low' ? `<div class="menu-stock-badge low">⚠️ Low stock</div>` : '';
            return `<div class="menu-item-card${isOut ? ' menu-unavailable' : ''}" data-id="${p.id}">
              ${inOrder ? `<div class="menu-in-order-badge">×${inOrder.qty}</div>` : ''}
              <div class="menu-item-name">${p.name}</div>
              ${p.description ? `<div class="menu-item-desc">${p.description}</div>` : ''}
              <div class="menu-item-price">${cur(p.price)}</div>
              ${badge}
            </div>`;
          }).join('')}
        </div>
      </div>`).join('');
  }

  function refreshMenuBadges() {
    $$('#menuBoard .menu-item-card').forEach(card => {
      const id    = card.dataset.id;
      let badge   = card.querySelector('.menu-in-order-badge');
      const order = menuOrder.find(o => o.product_id === id);
      const priceEl = card.querySelector('.menu-item-price');
      if (order) {
        if (!badge) { badge = document.createElement('div'); badge.className = 'menu-in-order-badge'; card.insertBefore(badge, card.firstChild); }
        badge.textContent = `×${order.qty}`;
        // Reflect per-item discount on the card price
        if (priceEl) {
          const d = order.item_discount || { type: 'none', value: 0 };
          const discAmt = Calc.lineDiscount({ qty: 1, sell_price: order.price, item_discount: d });
          const hasDisc = d.type && d.type !== 'none' && discAmt > 0;
          const effectivePrice = order.price - discAmt;
          if (hasDisc) {
            priceEl.innerHTML = `<span style="text-decoration:line-through;color:var(--muted);font-size:11px;">${cur(order.price)}</span>&nbsp;<span style="color:var(--red);font-weight:700;">${cur(effectivePrice)}</span>`;
          } else {
            priceEl.textContent = cur(order.price);
          }
        }
      } else {
        if (badge) badge.remove();
        // Restore original price
        const product = StorageAPI.getMenuProductById(id);
        if (priceEl && product) priceEl.textContent = cur(product.price);
      }
    });
  }

  function calcOrderTotals() {
    const subtotal = menuOrder.reduce((s, o) => s + o.qty * o.price, 0);
    // Per-item discounts
    const itemDiscountTotal = menuOrder.reduce((s, o) => {
      return s + Calc.lineDiscount({ qty: o.qty, sell_price: o.price, item_discount: o.item_discount || { type: 'none', value: 0 } });
    }, 0);
    const afterItemDiscounts = subtotal - itemDiscountTotal;

    const discType  = $('#menuDiscountType')?.value || 'none';
    const discVal   = Number($('#menuDiscountValue')?.value) || 0;
    const useVat    = $('#menuIncludeVat')?.checked || false;
    const svcType   = $('#menuServiceChargeType')?.value || 'none';
    const svcVal    = Number($('#menuServiceChargeValue')?.value) || 0;
    const customLabel = ($('#menuDiscountCustomLabel')?.value || '').trim();

    let discount = 0;
    if (discType === 'percent') discount = afterItemDiscounts * Math.min(discVal, 100) / 100;
    else if (discType === 'fixed')  discount = Math.min(discVal, afterItemDiscounts);
    else if (discType === 'senior') discount = afterItemDiscounts * 0.20;
    else if (discType === 'other')  discount = Math.min(discVal, afterItemDiscounts);

    const afterDiscount = afterItemDiscounts - discount;

    let serviceCharge = 0;
    if (svcType === 'percent') serviceCharge = afterDiscount * Math.min(svcVal, 100) / 100;
    else if (svcType === 'fixed') serviceCharge = Math.max(0, svcVal);

    const afterService = afterDiscount + serviceCharge;
    const isSenior = discType === 'senior';
    const vat = (useVat && !isSenior) ? afterService * 0.12 : 0;
    const total = afterService + vat;
    return { subtotal, itemDiscountTotal, discount, vat, total, useVat, serviceCharge, customLabel, discType };
  }

  function renderOrderPad() {
    const pad = $('#menuOrderLines');
    if (!menuOrder.length) {
      pad.innerHTML = `<div style="text-align:center;padding:20px 8px;color:var(--muted);font-size:13px;">👆 Tap a product to add it</div>`;
      $('#menuSubtotal').textContent         = cur(0);
      $('#menuDiscountAmt').textContent      = cur(0);
      $('#menuServiceChargeAmt').textContent = cur(0);
      $('#menuVatAmt').textContent           = cur(0);
      $('#menuTotal').textContent            = cur(0);
      $('#menuOrderCount').textContent = '0 items';
      return;
    }
    pad.innerHTML = menuOrder.map((line, i) => {
      const d = line.item_discount || { type: 'none', value: 0 };
      const discAmt = Calc.lineDiscount({ qty: line.qty, sell_price: line.price, item_discount: d });
      const lt = line.qty * line.price - discAmt;
      const hasDisc = d.type && d.type !== 'none';
      const discLabel = hasDisc
        ? (d.type === 'senior' ? '20% Senior/PWD' : d.type === 'percent' ? `${d.value}% off` : d.type === 'fixed' ? `−₱${Number(d.value).toFixed(2)}` : '')
        : '';
      return `<div class="order-line" data-idx="${i}">
        <div class="order-line-name">${line.name}</div>
        <div style="font-size:11px;color:var(--muted);">${cur(line.price)} × ${line.qty}${hasDisc ? ` <span style="color:var(--red);font-size:10px;">[${discLabel}]</span>` : ''}</div>
        <div class="order-line-controls">
          <button class="ol-minus btn btn-ghost btn-sm btn-icon" data-idx="${i}">−</button>
          <span class="ol-qty">${line.qty}</span>
          <button class="ol-plus btn btn-ghost btn-sm btn-icon" data-idx="${i}">+</button>
        </div>
        <div class="order-line-price">${cur(lt)}</div>
        <button class="ol-disc btn btn-ghost btn-sm btn-icon${hasDisc ? ' ol-disc-active' : ''}" data-idx="${i}" title="Item discount">🏷️</button>
        <button class="ol-remove btn btn-ghost btn-sm btn-icon" data-idx="${i}" title="Remove">✕</button>
        <div class="ol-disc-panel" id="ol-disc-panel-${i}" style="display:none;">
          <select class="ol-disc-type" data-idx="${i}">
            <option value="none"${d.type==='none'?' selected':''}>No Discount</option>
            <option value="percent"${d.type==='percent'?' selected':''}>Percentage (%)</option>
            <option value="fixed"${d.type==='fixed'?' selected':''}>Fixed Amount (₱)</option>
            <option value="senior"${d.type==='senior'?' selected':''}>Senior / PWD (20%)</option>
          </select>
          <input class="ol-disc-val" data-idx="${i}" type="number" min="0" step="0.01"
            placeholder="${d.type==='percent'?'e.g. 10':'e.g. 50'}"
            value="${d.type !== 'none' && d.type !== 'senior' ? d.value : ''}"
            style="display:${d.type === 'none' || d.type === 'senior' ? 'none' : 'block'};" />
          <button class="ol-disc-apply btn btn-primary btn-sm" data-idx="${i}">Apply</button>
          <button class="ol-disc-clear btn btn-ghost btn-sm" data-idx="${i}">Clear</button>
        </div>
      </div>`;
    }).join('');
    const totalItems = menuOrder.reduce((s, o) => s + o.qty, 0);
    $('#menuOrderCount').textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''}`;
    updateOrderTotalsUI();
  }

  function updateOrderTotalsUI() {
    const { subtotal, itemDiscountTotal, discount, vat, total, useVat, serviceCharge, customLabel, discType } = calcOrderTotals();
    const svcType = $('#menuServiceChargeType')?.value || 'none';

    $('#menuSubtotal').textContent         = cur(subtotal);
    $('#menuDiscountAmt').textContent      = discount > 0 ? `−${cur(discount)}` : cur(0);
    $('#menuServiceChargeAmt').textContent = cur(serviceCharge);
    $('#menuVatAmt').textContent           = cur(vat);
    $('#menuTotal').textContent            = cur(total);

    // Show/hide per-item discount row
    const itemDiscRow = $('#menuItemDiscountRow');
    if (itemDiscRow) {
      itemDiscRow.style.display = itemDiscountTotal > 0 ? 'flex' : 'none';
      const itemDiscAmt = $('#menuItemDiscountAmt');
      if (itemDiscAmt) itemDiscAmt.textContent = `−${cur(itemDiscountTotal)}`;
    }

    // Dynamic discount label
    const discLabelEl = $('#menuDiscountLabel');
    if (discLabelEl) {
      if (discType === 'senior')       discLabelEl.textContent = 'Senior / PWD Discount (20%)';
      else if (discType === 'percent') discLabelEl.textContent = `Discount (${$('#menuDiscountValue')?.value || 0}%)`;
      else if (discType === 'other' && customLabel) discLabelEl.textContent = customLabel;
      else                             discLabelEl.textContent = 'Discount';
    }

    // Show/hide discount row
    const discRow = $('#menuDiscountRow');
    if (discRow) discRow.style.display = (discount > 0 || discType !== 'none') ? 'flex' : 'none';

    // Show/hide service charge row
    const svcRow = $('#menuServiceChargeRow');
    if (svcRow) svcRow.style.display = (serviceCharge > 0 || svcType !== 'none') ? 'flex' : 'none';

    // Show/hide VAT row
    const vatRow = $('#menuVatRow');
    if (vatRow) vatRow.style.display = useVat ? 'flex' : 'none';

    // Hide discount value input for senior/none
    const valWrap = $('#menuDiscountValueWrap');
    if (valWrap) valWrap.style.display = (discType === 'none' || discType === 'senior') ? 'none' : 'flex';

    // Show/hide custom label input (only for 'other')
    const customLabelWrap = $('#menuDiscountCustomLabelWrap');
    if (customLabelWrap) customLabelWrap.style.display = (discType === 'other') ? 'block' : 'none';

    // Hide service charge value input when 'none'
    const svcValWrap = $('#menuServiceChargeValueWrap');
    if (svcValWrap) svcValWrap.style.display = (svcType === 'none') ? 'none' : 'flex';
  }

  function recordMenuSale() {
    if (!menuOrder.length) { toast('Add at least one product to the order', 'error'); return; }

    const inv       = StorageAPI.getInventory();
    const threshold = Number(StorageAPI.getSettings().lowStockThreshold) || 10;

    // Build consolidated deduction map
    const deductMap = {};
    for (const ol of menuOrder) {
      const product = StorageAPI.getMenuProductById(ol.product_id);
      for (const r of (product?.recipes || [])) {
        if (!r.inventory_item_id) continue;
        const needed = Number(r.quantity) * ol.qty;
        if (!deductMap[r.inventory_item_id]) {
          deductMap[r.inventory_item_id] = { item: inv.find(i => i.id === r.inventory_item_id) || null, ingredient_name: r.ingredient_name, unit: r.unit || '', needed: 0 };
        }
        deductMap[r.inventory_item_id].needed += needed;
      }
    }

    // Block if any ingredient is short
    const short = Object.values(deductMap).filter(d => d.item && d.needed > (Number(d.item.stock_qty) || 0));
    if (short.length) {
      alert(`❌ Cannot record sale — insufficient ingredients:\n\n${
        short.map(d => `• ${d.ingredient_name}: need ${d.needed}${d.unit}, only ${Number(d.item.stock_qty)||0}${d.unit} left`).join('\n')
      }\n\nPlease restock before proceeding.`);
      return;
    }

    // Record the sale — use selected date from picker, fall back to now
    const saleDateRaw = $('#menuSaleDate').value;
    const saleDate    = saleDateRaw
      ? new Date(saleDateRaw + 'T' + new Date().toTimeString().slice(0, 8)).toISOString()
      : new Date().toISOString();

    function getProductUnitCost(productId, invList) {
      const p = StorageAPI.getMenuProductById(productId);
      if (!p) return 0;
      if (p.recipes && p.recipes.length) {
        return p.recipes.reduce((sum, r) => {
          if (!r.inventory_item_id) return sum;
          const invItem = invList.find(i => i.id === r.inventory_item_id);
          const itemCost = Number(invItem?.cost_price) || 0;
          return sum + (itemCost * (Number(r.quantity) || 0));
        }, 0);
      }
      return Number(p.cost_price) || 0;
    }

    const saleLines = menuOrder.map(o => ({
      item_id: o.product_id,
      item_name: o.name,
      qty: o.qty,
      sell_price: o.price,
      cost_price: getProductUnitCost(o.product_id, inv),
      item_discount: o.item_discount || { type: 'none', value: 0 }
    }));
    const { subtotal, itemDiscountTotal, discount, vat, total, serviceCharge, customLabel, discType } = calcOrderTotals();
    const useVat    = $('#menuIncludeVat')?.checked || false;
    const orderType = $('#menuOrderType')?.value || 'Walk-in';
    const paymentMethod = $('#menuPaymentMethod')?.value || 'Cash';
    const svcType   = $('#menuServiceChargeType')?.value || 'none';
    const baseTotals = Calc.saleTotals({ lines: saleLines });
    const sale = {
      id:                   StorageAPI.uid('sale'),
      date:                 saleDate,
      lines:                saleLines,
      cogs:                 baseTotals.cogs,
      order_type:           orderType,
      payment_method:       paymentMethod,
      discount_type:        discType,
      discount_label:       discType === 'other' ? customLabel : undefined,
      discount_amt:         discount,
      service_charge_type:  svcType,
      service_charge_amt:   serviceCharge,
      vat_amt:              vat,
      vat_included:         useVat,
      revenue:              total,
      gp:                   total - baseTotals.cogs
    };
    StorageAPI.addSale(sale);

    // Log discounts for analytics — per-item AND order-level
    const discountEntries = [];

    // 1) Per-item discounts
    saleLines
      .filter(l => l.item_discount && l.item_discount.type && l.item_discount.type !== 'none')
      .forEach(l => {
        const discAmt = Calc.lineDiscount({ qty: l.qty, sell_price: l.sell_price, item_discount: l.item_discount });
        discountEntries.push({
          id:             StorageAPI.uid('dl'),
          sale_id:        sale.id,
          date:           sale.date,
          product_id:     l.item_id,
          product_name:   l.item_name,
          discount_type:  l.item_discount.type,
          discount_value: l.item_discount.value,
          discount_amt:   discAmt,
          original_price: l.sell_price,
          qty:            l.qty,
          done_by:        sale.done_by || StorageAPI.getSessionUser()
        });
      });

    // 2) Order-level discount (senior, percent, fixed, other)
    if (sale.discount_type && sale.discount_type !== 'none' && (Number(sale.discount_amt) || 0) > 0) {
      const discVal = sale.discount_type === 'percent' ? (subtotal > 0 ? +((Number(sale.discount_amt) / subtotal) * 100).toFixed(2) : 0)
                    : sale.discount_type === 'senior'  ? 20
                    : Number(sale.discount_amt);
      discountEntries.push({
        id:             StorageAPI.uid('dl'),
        sale_id:        sale.id,
        date:           sale.date,
        product_id:     null,
        product_name:   '(Order-level discount)',
        discount_type:  sale.discount_type,
        discount_value: discVal,
        discount_amt:   Number(sale.discount_amt),
        original_price: subtotal,
        qty:            1,
        done_by:        sale.done_by || StorageAPI.getSessionUser()
      });
    }

    if (discountEntries.length) StorageAPI.addDiscountLogEntries(discountEntries);

    // Inject into sales history table instantly
    injectSaleRow(sale);

    // Deduct each ingredient from inventory + write log + inject log row live
    const nowLow = [];
    for (const [itemId, d] of Object.entries(deductMap)) {
      if (!d.item) continue;
      const prevQty = Number(d.item.stock_qty) || 0;
      const newQty  = Math.max(0, prevQty - d.needed);
      d.item.stock_qty  = newQty;
      d.item.updated_at = sale.date;
      StorageAPI.upsertItem(d.item);
      const logEntry = { item_id: itemId, item_name: d.ingredient_name, inventory_type: d.item.inventory_type, type: 'sale', qty: d.needed, balance: newQty, note: `Menu sale — ${sale.id}`, date: sale.date };
      StorageAPI.addStockLog(logEntry);
      injectLogRow(logEntry);
      if (newQty <= threshold) nowLow.push(`${d.ingredient_name} (${newQty}${d.unit} left)`);
    }
    if (nowLow.length) toast(`⚠️ Low stock: ${nowLow.join(', ')}`, 'error');

    const tableNote = $('#menuOrderNote').value.trim();
    const deducted  = Object.keys(deductMap).length;
    toast(`Sale recorded! ${tableNote ? `"${tableNote}" — ` : ''}${cur(sale.revenue)} ✓${deducted ? ` · ${deducted} ingredient${deducted>1?'s':''} deducted` : ''}`, 'success');

    const noteEl = $('#menuReceiptNote');
    noteEl.textContent   = `✅ Sale recorded! Total: ${cur(sale.revenue)}${deducted ? ' · Inventory updated' : ''}`;
    noteEl.style.display = 'block';
    setTimeout(() => { noteEl.style.display = 'none'; }, 4500);

    menuOrder.length = 0;
    $('#menuOrderNote').value = '';
    // Reset all order fields for next order
    if ($('#menuDiscountType'))        $('#menuDiscountType').value = 'none';
    if ($('#menuDiscountValue'))       $('#menuDiscountValue').value = '0';
    if ($('#menuDiscountCustomLabel')) $('#menuDiscountCustomLabel').value = '';
    if ($('#menuIncludeVat'))          $('#menuIncludeVat').checked = false;
    if ($('#menuServiceChargeType'))   $('#menuServiceChargeType').value = 'none';
    if ($('#menuServiceChargeValue'))  $('#menuServiceChargeValue').value = '0';
    if ($('#menuPaymentMethod'))       $('#menuPaymentMethod').value = 'Cash';
    // Reset date back to today for next order
    const saleDateEl = $('#menuSaleDate');
    if (saleDateEl) saleDateEl.value = today();
    renderOrderPad();
    renderMenuBoard();
    renderInventory();
    renderDashboard();
  }

  function printMenuReceipt() {
    if (!menuOrder.length) { toast('Add products before printing', 'error'); return; }
    const tableNote = $('#menuOrderNote').value.trim();
    const orderType = $('#menuOrderType')?.value || 'Walk-in';
    const paymentMethod = $('#menuPaymentMethod')?.value || 'Cash';
    const { subtotal, itemDiscountTotal, discount, vat, total, useVat, serviceCharge, customLabel, discType } = calcOrderTotals();
    const svcType   = $('#menuServiceChargeType')?.value || 'none';
    const now       = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    const win       = window.open('', '_blank', 'width=380,height=640');
    if (!win) { toast('Allow pop-ups to print receipts', 'error'); return; }

    // Determine discount label for receipt
    let discReceiptLabel = 'Discount';
    if (discType === 'senior')       discReceiptLabel = 'Senior / PWD Discount (20%)';
    else if (discType === 'percent') discReceiptLabel = `Discount (${$('#menuDiscountValue')?.value || 0}%)`;
    else if (discType === 'other' && customLabel) discReceiptLabel = customLabel;

    const itemDiscountReceiptRow = itemDiscountTotal > 0
      ? `<tr><td>Item Discounts</td><td class="r" style="color:#c00;">&#8722;${cur(itemDiscountTotal)}</td></tr>`
      : '';

    const discountRow = discount > 0
      ? `<tr><td>${discReceiptLabel}</td><td class="r" style="color:#c00;">&#8722;${cur(discount)}</td></tr>`
      : '';
    const serviceChargeRow = serviceCharge > 0
      ? `<tr><td>Service Charge</td><td class="r">${cur(serviceCharge)}</td></tr>`
      : '';
    const vatRow = (useVat && discType === 'senior')
      ? `<tr><td>VAT</td><td class="r" style="font-size:11px;color:#666;">EXEMPT (RA 9994)</td></tr>`
      : (useVat && vat > 0)
      ? `<tr><td>VAT (12%)</td><td class="r">${cur(vat)}</td></tr>`
      : '';
    win.document.write(`<!DOCTYPE html><html><head><title>Receipt</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:"Courier New",monospace;font-size:13px;padding:20px;max-width:300px;margin:0 auto;color:#111;}
      h1{text-align:center;font-size:20px;letter-spacing:.08em;margin-bottom:2px;}
      .tagline{text-align:center;font-size:10px;color:#666;margin-bottom:14px;}
      .meta{text-align:center;font-size:11px;color:#444;margin-bottom:14px;line-height:1.7;}
      table{width:100%;border-collapse:collapse;}
      td{padding:4px 0;vertical-align:top;font-size:12px;}
      td.r{text-align:right;white-space:nowrap;padding-left:8px;}
      .item-name{font-weight:600;font-size:13px;} .item-sub{font-size:10px;color:#666;} .item-disc{font-size:10px;color:#c00;}
      hr{border:none;border-top:1px dashed #aaa;margin:10px 0;}
      .total-label{font-weight:700;font-size:15px;} .total-amt{font-weight:700;font-size:15px;text-align:right;}
      .mop-row{text-align:center;margin-top:8px;font-size:12px;font-weight:700;letter-spacing:.04em;}
      .footer{text-align:center;color:#999;font-size:10px;margin-top:16px;line-height:2;}
      @media print{body{padding:4px;}}
    </style></head><body>
    <h1>&#127869;&#65039; RESERVE</h1><div class="tagline">Restaurant Manager</div>
    <div class="meta">${now}<br>${orderType}${tableNote ? `<br><strong>${tableNote}</strong>` : ''}</div>
    <hr>
    <table>${menuOrder.map(o => {
      const d = o.item_discount || { type: 'none', value: 0 };
      const ld = Calc.lineDiscount({ qty: o.qty, sell_price: o.price, item_discount: d });
      const lt = o.qty * o.price - ld;
      const dtag = ld > 0 ? `<div class="item-disc">${d.type === 'senior' ? 'Senior/PWD' : d.type === 'percent' ? d.value + '% off' : 'disc'} &#8722;${cur(ld)}</div>` : '';
      return `<tr><td><div class="item-name">${o.name}</div><div class="item-sub">${o.qty} &#xd7; ${cur(o.price)}</div>${dtag}</td><td class="r">${cur(lt)}</td></tr>`;
    }).join('')}
    </table>
    <hr>
    <table>
      <tr><td>Subtotal</td><td class="r">${cur(subtotal)}</td></tr>
      ${itemDiscountReceiptRow}
      ${discountRow}
      ${serviceChargeRow}
      ${vatRow}
    </table>
    <hr>
    <table><tr><td class="total-label">TOTAL</td><td class="total-amt">${cur(total)}</td></tr></table>
    <div class="mop-row">Payment: ${paymentMethod}</div>
    <div class="footer">Thank you for dining with us!<br>Please come again &#128522;</div>
    <script>window.onload = () => { window.print(); };<\/script>
    </body></html>`);
    win.document.close();
  }

  function renderMenuProductsTable() {
    const products = StorageAPI.getMenuProducts();
    const tbody    = $('#menuProductsTbody');
    const term     = ($('#manageProductSearch')?.value || '').toLowerCase().trim();
    const catFilter = ($('#manageProductCatFilter')?.value || '').toLowerCase();

    // Populate category dropdown from live product list (preserve current selection)
    const catSel = $('#manageProductCatFilter');
    if (catSel) {
      const allCats = [...new Set(products.map(p => p.category || '').filter(Boolean))].sort();
      const prevCat = catSel.value;
      catSel.innerHTML = '<option value="">All Categories</option>' +
        allCats.map(c => `<option value="${c.toLowerCase()}" ${c.toLowerCase() === catFilter ? 'selected' : ''}>${c}</option>`).join('');
      catSel.value = prevCat; // restore selection
    }

    // Filter
    const filtered = products.filter(p => {
      const matchName = !term || (p.name || '').toLowerCase().includes(term) || (p.description || '').toLowerCase().includes(term);
      const matchCat  = !catFilter || (p.category || '').toLowerCase() === catFilter;
      return matchName && matchCat;
    });

    // Result count
    const countEl = $('#manageProductCount');
    if (countEl) {
      countEl.textContent = term || catFilter
        ? `${filtered.length} of ${products.length} product${products.length !== 1 ? 's' : ''}`
        : `${products.length} product${products.length !== 1 ? 's' : ''}`;
    }

    if (!products.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="no-data-placeholder">No products yet — click <strong>+ Add Product</strong> to get started.</td></tr>`;
      return;
    }
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="no-data-placeholder">No products match <strong>${term || catFilter}</strong>. Try a different search.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(p => {
      const recipes = p.recipes || [];
      const recipeLabel = recipes.length
        ? `<span style="font-size:12px;font-weight:600;color:var(--green);">✅ ${recipes.length} ingredient${recipes.length !== 1 ? 's' : ''}</span>`
        : `<span style="font-size:12px;color:var(--muted);">— none</span>`;
      // Highlight matching text in product name
      const highlightedName = term
        ? (p.name || '').replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'),
            '<mark style="background:#FEF08A;border-radius:2px;padding:0 2px;">$1</mark>')
        : (p.name || '');
      return `<tr>
        <td><strong>${highlightedName}</strong></td>
        <td><span class="chip" style="margin:0;">${p.category || '—'}</span></td>
        <td style="font-weight:700;color:var(--green);">${cur(p.price)}</td>
        <td style="font-size:12px;color:var(--muted);">${p.description || '—'}</td>
        <td>${recipeLabel}</td>
        <td><span style="font-size:12px;font-weight:600;color:${p.is_available !== false ? 'var(--green)' : 'var(--red)'};"
          >${p.is_available !== false ? '✅ Yes' : '❌ No'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" data-mp-edit="${p.id}">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" data-mp-del="${p.id}" style="margin-left:4px;">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-mp-edit]').forEach(btn => btn.addEventListener('click', () => openMenuProductDialog(btn.dataset.mpEdit)));
    tbody.querySelectorAll('[data-mp-del]').forEach(btn => btn.addEventListener('click', () => {
      const p = StorageAPI.getMenuProductById(btn.dataset.mpDel);
      if (!p || !confirm(`Delete "${p.name}" from the menu?`)) return;
      StorageAPI.deleteMenuProduct(btn.dataset.mpDel);
      toast(`"${p.name}" removed from menu`, 'success');
      renderMenuProductsTable(); renderMenuBoard();
    }));
  }


  // ── SETTINGS ───────────────────────────────────────────────────────────────
  let _settingsReady = false;
  function setupSettings() {
    const s = StorageAPI.getSettings();
    $('#setCurrency').value = s.currency || '₱';
    $('#setLowStockThreshold').value = s.lowStockThreshold || 10;

    renderChips('categoryChips', s.categories || [], name => {
      s.categories = (s.categories || []).filter(c => c !== name);
      StorageAPI.saveSettings(s); setupSettings(); refreshDatalists(); toast('Category removed');
    });
    $('#addCategoryBtn').onclick = () => {
      const v = $('#newCategory').value.trim(); if (!v) return;
      s.categories = Array.from(new Set([...(s.categories || []), v]));
      StorageAPI.saveSettings(s); $('#newCategory').value = ''; setupSettings(); refreshDatalists(); toast('Category added ✓', 'success');
    };

    renderChips('supplierChips', s.suppliers || [], name => {
      s.suppliers = (s.suppliers || []).filter(c => c !== name);
      StorageAPI.saveSettings(s); setupSettings(); refreshDatalists(); toast('Supplier removed');
    });
    $('#addSupplierBtn').onclick = () => {
      const v = $('#newSupplier').value.trim(); if (!v) return;
      s.suppliers = Array.from(new Set([...(s.suppliers || []), v]));
      StorageAPI.saveSettings(s); $('#newSupplier').value = ''; setupSettings(); refreshDatalists(); toast('Supplier added ✓', 'success');
    };

    // Account management (owner only)
    if (isOwner()) renderAccounts();
    $('#addAccountBtn').onclick = () => openAccountDialog();
    $('#accountDialogCancel').onclick = () => $('#accountDialog').close();
    $('#accountForm').onsubmit = handleAccountSubmit;

    if (!_settingsReady) {
      _settingsReady = true;
      $('#settingsForm').addEventListener('submit', e => {
        e.preventDefault();
        const s = StorageAPI.getSettings();
        s.currency = $('#setCurrency').value.trim() || '₱';
        const threshold = Number($('#setLowStockThreshold').value) || 10;
        if (threshold < 0.01) { toast('Minimum threshold is 0.01', 'error'); return; }
        s.lowStockThreshold = threshold;
        StorageAPI.saveSettings(s);
        toast('Settings saved ✓', 'success');
        refreshDatalists(); renderDashboard(); renderInventory();
      });
    }
  }

  // ── ACCOUNT MANAGEMENT ─────────────────────────────────────────────────────
  async function renderAccounts() {
    const tbody = $('#accountsTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);">Loading…</td></tr>';
    const users = await getUsers();
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);">No accounts found.</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${u.username}</strong></td>
        <td>${u.display_name || ''}</td>
        <td><span style="
          display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;
          background:${u.role === 'owner' ? '#FFF3E0' : '#E8F5E9'};
          color:${u.role === 'owner' ? '#E65100' : '#2E7D32'};
          border:1px solid ${u.role === 'owner' ? '#FFCC80' : '#A5D6A7'};
        ">${u.role === 'owner' ? '👑 Owner' : '👷 Staff'}</span></td>
        <td style="text-align:center;">
          <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;margin-right:4px;"
            onclick="window._editAccount('${u.id}')">✏️ Edit</button>
          ${u.role !== 'owner' ? `<button class="btn" style="font-size:12px;padding:4px 10px;background:#FEE2E2;color:#DC2626;border:1px solid #FECACA;"
            onclick="window._deleteAccount('${u.id}', '${u.username}')">🗑️ Delete</button>` : ''}
        </td>
      </tr>`).join('');
  }

  function openAccountDialog(id = null, userData = null) {
    $('#accountEditId').value = id || '';
    $('#accountForm').reset();
    if (id && userData) {
      // Edit mode
      $('#accountDialogTitle').textContent = 'Edit Account';
      $('#accountUsername').value   = userData.username;
      $('#accountDisplayName').value = userData.display_name || '';
      $('#accountRole').value       = userData.role;
      $('#accountUsername').readOnly = true;
      $('#accountUsername').style.opacity = '0.6';
      $('#accountPasswordRow').style.display    = 'none';
      $('#accountNewPasswordRow').style.display = '';
      $('#accountPassword').required = false;
    } else {
      // Add mode
      $('#accountDialogTitle').textContent = 'Add Account';
      $('#accountUsername').readOnly = false;
      $('#accountUsername').style.opacity = '';
      $('#accountPasswordRow').style.display    = '';
      $('#accountNewPasswordRow').style.display = 'none';
      $('#accountPassword').required = true;
    }
    $('#accountDialog').showModal();
  }

  async function handleAccountSubmit(e) {
    e.preventDefault();
    const id          = $('#accountEditId').value;
    const username    = $('#accountUsername').value.trim().toLowerCase();
    const displayName = $('#accountDisplayName').value.trim();
    const role        = $('#accountRole').value;
    const isEdit      = !!id;

    const saveBtn = $('#accountDialogSave');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

    try {
      if (isEdit) {
        const newPass = $('#accountNewPassword').value;
        const updates = { display_name: displayName, role };
        if (newPass) updates.password = newPass;
        const { error } = await db.from('users').update(updates).eq('id', id);
        if (error) throw error;
        toast('Account updated ✓', 'success');
      } else {
        const password = $('#accountPassword').value;
        if (!password) { toast('Password is required', 'error'); return; }
        const { error } = await db.from('users').insert({ username, password, role, display_name: displayName });
        if (error) {
          if (error.code === '23505') toast('Username already exists', 'error');
          else throw error;
          return;
        }
        toast('Account created ✓', 'success');
      }
      $('#accountDialog').close();
      renderAccounts();
    } catch (err) {
      console.error('Account save error:', err);
      toast('Error saving account: ' + (err.message || 'Unknown error'), 'error');
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = '💾 Save Account';
    }
  }

  // Expose edit/delete to inline onclick handlers
  window._editAccount = async (id) => {
    const { data, error } = await db.from('users').select('*').eq('id', id).maybeSingle();
    if (error || !data) { toast('Could not load account', 'error'); return; }
    openAccountDialog(id, data);
  };
  window._deleteAccount = async (id, username) => {
    if (!confirm(`Delete account "${username}"? This cannot be undone.`)) return;
    const { error } = await db.from('users').delete().eq('id', id);
    if (error) { toast('Error deleting account', 'error'); return; }
    toast('Account deleted', 'success');
    renderAccounts();
  };


  function renderChips(containerId, arr, onRemove) {
    const el = $('#' + containerId); if (!el) return;
    el.innerHTML = arr.map(name =>
      `<span class="chip">${name}<button type="button" title="Remove ${name}">✕</button></span>`
    ).join('');
    $$('#' + containerId + ' .chip button').forEach((btn, i) => btn.addEventListener('click', () => onRemove(arr[i])));
  }

  // ── BACKUP ─────────────────────────────────────────────────────────────────
  let _backupReady = false;
  function setupBackup() {
    if (_backupReady) return;
    _backupReady = true;
    $('#backupExportBtn').addEventListener('click', () => { StorageAPI.exportJSON(); toast('Backup downloaded ✓'); });
    $('#backupImportInput').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      StorageAPI.importJSON(file, ok => {
        toast(ok ? 'Backup restored ✓' : 'Invalid backup file', ok ? 'success' : 'error');
        if (ok) renderAll();
      });
      e.target.value = '';
    });
  }

  // ── INVENTORY FILTERS SETUP ────────────────────────────────────────────────
  let _invFiltersReady = false;

  // ── MONTH FILTER HELPER ────────────────────────────────────────────────────
  function buildMonthOptions(dates, selectId, defaultToCurrentMonth = true) {
    const el = $('#' + selectId);
    if (!el) return;
    // Collect unique YYYY-MM keys
    const months = Array.from(new Set(dates.map(d => (d || '').slice(0, 7))))
      .filter(Boolean).sort((a, b) => b.localeCompare(a));
    // Current month key
    const now = new Date();
    const currentKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    // Always include current month even if no data yet
    if (!months.includes(currentKey)) months.unshift(currentKey);
    el.innerHTML = months.map(m => {
      const [y, mo] = m.split('-');
      const label = new Date(Number(y), Number(mo) - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return `<option value="${m}">${label}</option>`;
    }).join('');
    // Default to current month
    if (defaultToCurrentMonth && months.includes(currentKey)) el.value = currentKey;
    return el.value;
  }

  function monthToRange(ym) {
    if (!ym) return { start: null, end: null };
    const [y, m] = ym.split('-').map(Number);
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    // Use local date parts (getFullYear/getMonth/getDate) instead of toISOString()
    // to avoid UTC conversion shifting the day in UTC+8 (Philippines) timezone.
    const lastDay = new Date(y, m, 0);
    const end = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2,'0')}-${String(lastDay.getDate()).padStart(2,'0')}`;
    return { start, end };
  }

  // ── WEEK FILTER HELPER ─────────────────────────────────────────────────────
  function getWeekRangeForDate(dInput) {
    const d = typeof dInput === 'string'
      ? new Date(dInput.slice(0, 10) + 'T00:00:00')
      : new Date(dInput.getFullYear(), dInput.getMonth(), dInput.getDate());
    const dow = d.getDay();
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMon);
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return {
      start: toLocalYMD(mon),
      end:   toLocalYMD(sun),
      mon,
      sun
    };
  }

  function buildWeekOptions(dates, selectId, defaultToCurrentWeek = true) {
    const el = $('#' + selectId);
    if (!el) return;

    const weekMap = new Map();
    function addWeekForDate(dVal) {
      if (!dVal) return;
      const d = typeof dVal === 'string' ? new Date(dVal.slice(0, 10) + 'T00:00:00') : new Date(dVal);
      if (isNaN(d.getTime())) return;
      const wk = getWeekRangeForDate(d);
      const key = `${wk.start}_${wk.end}`;
      if (!weekMap.has(key)) {
        weekMap.set(key, wk);
      }
    }

    // Always include current week and preceding 12 weeks
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (i * 7));
      addWeekForDate(past);
    }

    // Include weeks from all given dates
    (dates || []).forEach(d => addWeekForDate(d));

    // Sort descending (most recent first)
    const sortedWeeks = Array.from(weekMap.values()).sort((a, b) => b.start.localeCompare(a.start));

    // Current week & last week keys
    const curWk = getWeekRangeForDate(now);
    const curKey = `${curWk.start}_${curWk.end}`;
    const lastWkDate = new Date(curWk.mon);
    lastWkDate.setDate(lastWkDate.getDate() - 7);
    const lastWk = getWeekRangeForDate(lastWkDate);
    const lastKey = `${lastWk.start}_${lastWk.end}`;

    el.innerHTML = sortedWeeks.map(w => {
      const key = `${w.start}_${w.end}`;
      const isThisWeek = (key === curKey);
      const isLastWeek = (key === lastKey);
      const mon = w.mon;
      const sun = w.sun;

      let rangeLabel = '';
      if (mon.getFullYear() !== sun.getFullYear()) {
        rangeLabel = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' – ' +
                     sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } else if (mon.getMonth() !== sun.getMonth()) {
        rangeLabel = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' +
                     sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + mon.getFullYear();
      } else {
        rangeLabel = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' +
                     sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + mon.getFullYear();
      }
      if (isThisWeek) rangeLabel += ' (This Week)';
      else if (isLastWeek) rangeLabel += ' (Last Week)';

      return `<option value="${key}">${rangeLabel}</option>`;
    }).join('');

    if (defaultToCurrentWeek && sortedWeeks.some(w => `${w.start}_${w.end}` === curKey)) {
      el.value = curKey;
    }
    return el.value;
  }


  function applyLogMonthFilter(ym) {
    const { start, end } = monthToRange(ym);
    if ($('#logFilterStart')) $('#logFilterStart').value = start || '';
    if ($('#logFilterEnd'))   $('#logFilterEnd').value   = end   || '';
  }

  function applySalesMonthFilter(ym) {
    const { start, end } = monthToRange(ym);
    if ($('#salesFilterStart')) $('#salesFilterStart').value = start || '';
    if ($('#salesFilterEnd'))   $('#salesFilterEnd').value   = end   || '';
  }

  function setupInventoryFilters() {
    if (_invFiltersReady) return;
    _invFiltersReady = true;
    ['invFilterCategory', 'invFilterSupplier'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('change', renderInventory); });
    const low = $('#invFilterLowStock'); if (low) low.addEventListener('change', renderInventory);
    const srch = $('#invSearch'); if (srch) srch.addEventListener('input', renderInventory);
    // Stock log month picker
    (function() {
      const logs = StorageAPI.getStockLog();
      buildMonthOptions(logs.map(l => l.date), 'logFilterMonth', true);
      const sel = $('#logFilterMonth');
      if (sel) {
        applyLogMonthFilter(sel.value);
        sel.addEventListener('change', () => { applyLogMonthFilter(sel.value); renderStockLog(); });
      }
      const allBtn = $('#logFilterAll');
      if (allBtn) allBtn.addEventListener('click', () => {
        $('#logFilterStart').value = '';
        $('#logFilterEnd').value   = '';
        if ($('#logFilterMonth')) $('#logFilterMonth').value = '';
        renderStockLog();
      });
    })();
    ['logFilterItem','logFilterType'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('change', renderStockLog); });
  }

  // ── KEYBOARD NAV ───────────────────────────────────────────────────────────
  let _keyboardReady = false;
  function setupKeyboard() {
    if (_keyboardReady) return;
    _keyboardReady = true;
    const keys = ['dashboard','inventory','menu','sales','expenses','staff','reports','settings'];
    document.addEventListener('keydown', e => {
      if (!e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= keys.length) $(`.nav-link[data-section="${keys[n-1]}"]`)?.click();
    });
  }

  // ── PRINT UTILITIES ────────────────────────────────────────────────────────
  function openPrintWindow(title, bodyHtml, extraCss = '') {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast('Allow pop-ups to print', 'error'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:"Inter",system-ui,sans-serif;font-size:13px;color:#111;padding:28px;}
      h1{font-size:20px;font-weight:700;margin-bottom:4px;}
      .meta{font-size:11px;color:#666;margin-bottom:18px;}
      table{width:100%;border-collapse:collapse;margin-bottom:16px;}
      th{background:#f3f4f6;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;text-align:left;border-bottom:2px solid #d1d5db;}
      td{padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;}
      tr:last-child td{border-bottom:none;}
      .green{color:#2E7D32;font-weight:600;}
      .red{color:#D32F2F;font-weight:600;}
      .r{text-align:right;} th.r{text-align:right;}
      .kpi-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;}
      .kpi-box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;min-width:120px;}
      .kpi-box .label{font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;margin-bottom:4px;}
      .kpi-box .value{font-size:18px;font-weight:700;}
      .section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:18px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;}
      .footer{text-align:center;font-size:10px;color:#999;margin-top:24px;}
      @media print{body{padding:12px;}@page{margin:1cm;}}
      ${extraCss}
    </style></head><body>
    ${bodyHtml}
    <div class="footer">Printed from RESERVE · ${new Date().toLocaleString('en-PH')}</div>
    <script>window.onload=()=>{window.print();}<\/script>
    </body></html>`);
    win.document.close();
  }

  let _printReady = false;
  function setupPrintButtons() {
    if (_printReady) return;
    _printReady = true;
    // Dashboard print
    const dashPrint = $('#dashPrintBtn');
    if (dashPrint) dashPrint.addEventListener('click', printDashboard);

    // Inventory print
    const invPrint = $('#printInventoryBtn');
    if (invPrint) invPrint.addEventListener('click', printInventory);

    // Sales print
    const salPrint = $('#printSalesBtn');
    if (salPrint) salPrint.addEventListener('click', printSales);

    // Expenses print
    const expPrint = $('#printExpensesBtn');
    if (expPrint) expPrint.addEventListener('click', printExpenses);

    // Reports print
    const repPrint = $('#printReportsBtn');
    if (repPrint) repPrint.addEventListener('click', printReports);
  }

  function printDashboard() {
    const sales    = StorageAPI.getSales();
    const expenses = StorageAPI.getExpenses();
    const items    = StorageAPI.getInventory();
    const fs = dashFilter.start, fe = dashFilter.end;

    const presetLabels = { today: 'Today', week: 'This Week', month: 'This Month', year: 'This Year', custom: `${fs} to ${fe}` };
    const periodLabel  = presetLabels[dashFilter.preset] || 'All Time';

    const fSales = (fs && fe) ? sales.filter(s => inRange(s.date, fs, fe)) : sales;
    const fExp   = (fs && fe) ? expenses.filter(e => inRange(e.date, fs, fe)) : expenses;

    const td      = today();
    const wkStart = getWeekStart();
    const { start: mStart, end: mEnd } = getMonthRange();
    const { start: yStart, end: yEnd } = getYearRange();

    const rev  = fSales.reduce((s, x) => s + saleRevenue(x), 0);
    const cogs = fSales.reduce((s, x) => s + saleCOGS(x), 0);
    const gp   = fSales.reduce((s, x) => s + saleGP(x), 0);
    const exp  = fExp.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const np   = gp - exp;

    // Top items
    const itemMap = {};
    fSales.forEach(sale => sale.lines.forEach(l => {
      const key = l.item_id || l.item_name; if (!key) return;
      if (!itemMap[key]) itemMap[key] = { name: l.item_name || key, qty: 0, revenue: 0, gp: 0 };
      const t = Calc.lineTotals(l);
      itemMap[key].qty += l.qty; itemMap[key].revenue += t.revenue; itemMap[key].gp += t.gp;
    }));
    const topItems = Object.values(itemMap).sort((a, b) => b.qty - a.qty).slice(0, 10);

    // Low stock
    const s = StorageAPI.getSettings();
    const threshold = Number(s.lowStockThreshold) || 10;
    const lowStock = items.filter(i => (Number(i.stock_qty) || 0) <= (Number(i.reorder_level) || threshold));

    const body = `
      <h1>🍽️ RESERVE — Dashboard</h1>
      <div class="meta">Period: <strong>${periodLabel}</strong> &nbsp;·&nbsp; Generated: ${new Date().toLocaleString('en-PH')}</div>

      <div class="kpi-row">
        <div class="kpi-box"><div class="label">Revenue</div><div class="value">${cur(rev)}</div></div>
        <div class="kpi-box"><div class="label">COGS</div><div class="value">${cur(cogs)}</div></div>
        <div class="kpi-box"><div class="label">Gross Profit</div><div class="value green">${cur(gp)}</div></div>
        <div class="kpi-box"><div class="label">Expenses</div><div class="value red">${cur(exp)}</div></div>
        <div class="kpi-box"><div class="label">Net Profit</div><div class="value ${np >= 0 ? 'green' : 'red'}">${cur(np)}</div></div>
        <div class="kpi-box"><div class="label">Transactions</div><div class="value">${fSales.length}</div></div>
        <div class="kpi-box"><div class="label">Stock Value</div><div class="value">${cur(Calc.totalStockValue(items))}</div></div>
      </div>

      <div class="section-title">🏆 Top Selling Products (${periodLabel})</div>
      <table>
        <thead><tr><th>#</th><th>Product</th><th>Qty Sold</th><th>Revenue</th><th>GP</th></tr></thead>
        <tbody>
          ${topItems.map((it, i) => `<tr>
            <td><strong>#${i + 1}</strong></td>
            <td>${it.name}</td>
            <td><strong>${it.qty}</strong></td>
            <td>${cur(it.revenue)}</td>
            <td class="green">${cur(it.gp)}</td>
          </tr>`).join('') || '<tr><td colspan="5" style="color:#999;text-align:center;">No sales in this period</td></tr>'}
        </tbody>
      </table>

      ${lowStock.length ? `
      <div class="section-title">⚠️ Low Stock Alerts (${lowStock.length} item${lowStock.length !== 1 ? 's' : ''})</div>
      <table>
        <thead><tr><th>Item</th><th>Category</th><th>Stock Qty</th><th>Alert Level</th></tr></thead>
        <tbody>
          ${lowStock.map(i => `<tr>
            <td><strong>${i.name}</strong></td>
            <td>${i.category || '—'}</td>
            <td class="red"><strong>${i.stock_qty}</strong></td>
            <td>${i.reorder_level || threshold}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : ''}`;

    openPrintWindow('Dashboard — RESERVE', body);
  }

  function printInventory() {
    const items = StorageAPI.getInventory();
    const type  = state.inventoryType;
    const labels = { kitchen: '🍳 Kitchen Stock', beverage: '🥤 Beverage Stock', stockroom: '📦 Stock Room', pastry: '🥐 Pastry Stock', takeout: '🥡 Takeout Stock' };
    const filtered = items.filter(i => i.inventory_type === type);

    const body = `
      <h1>RESERVE — ${labels[type] || 'Inventory'}</h1>
      <div class="meta">Generated: ${new Date().toLocaleString('en-PH')} &nbsp;·&nbsp; ${filtered.length} item(s)</div>
      <table>
        <thead>
          <tr><th>Item</th><th>Category</th><th>Unit</th><th>Stock Qty</th><th>Reorder Lvl</th><th>Cost</th><th>Sell</th><th>Supplier</th></tr>
        </thead>
        <tbody>
          ${filtered.map(i => `<tr>
            <td><strong>${i.name}</strong></td>
            <td>${i.category || '—'}</td>
            <td>${i.unit || '—'}</td>
            <td><strong>${i.stock_qty}</strong></td>
            <td>${i.reorder_level || '—'}</td>
            <td>${cur(i.cost_price)}</td>
            <td class="green">${cur(i.sell_price)}</td>
            <td style="font-size:11px;">${i.supplier || '—'}</td>
          </tr>`).join('') || '<tr><td colspan="8" style="color:#999;text-align:center;">No items</td></tr>'}
        </tbody>
      </table>
      <div class="kpi-row">
        <div class="kpi-box"><div class="label">Total Items</div><div class="value">${filtered.length}</div></div>
        <div class="kpi-box"><div class="label">Total Stock Value</div><div class="value">${cur(Calc.totalStockValue(filtered))}</div></div>
      </div>`;

    openPrintWindow(`Inventory — RESERVE`, body);
  }

  function printSales() {
    const sales = StorageAPI.getSales();
    const start = $('#salesFilterStart').value || null;
    const end   = $('#salesFilterEnd').value   || null;
    const term  = ($('#salesFilterItem').value || '').toLowerCase();

    const filtered = sales
      .filter(s => inRange(s.date, start, end))
      .filter(s => !term || s.lines.some(l => (l.item_name || '').toLowerCase().includes(term)));

    const rev  = filtered.reduce((s, x) => s + (x.revenue || 0), 0);
    const cogs = filtered.reduce((s, x) => s + (x.cogs || 0), 0);
    const gp   = filtered.reduce((s, x) => s + (x.gp || (x.revenue - x.cogs) || 0), 0);

    const periodLabel = start || end ? `${start || '—'} to ${end || '—'}` : 'All Time';

    const body = `
      <h1>RESERVE — Sales History</h1>
      <div class="meta">Period: <strong>${periodLabel}</strong>${term ? ` · Filter: "${term}"` : ''} &nbsp;·&nbsp; ${filtered.length} transaction(s)</div>
      <div class="kpi-row">
        <div class="kpi-box"><div class="label">Total Revenue</div><div class="value">${cur(rev)}</div></div>
        <div class="kpi-box"><div class="label">Total COGS</div><div class="value">${cur(cogs)}</div></div>
        <div class="kpi-box"><div class="label">Gross Profit</div><div class="value green">${cur(gp)}</div></div>
        <div class="kpi-box"><div class="label">Transactions</div><div class="value">${filtered.length}</div></div>
      </div>
      <table>
        <thead><tr><th>Date &amp; Time</th><th>Items Sold</th><th>Revenue</th><th>COGS</th><th>Gross Profit</th></tr></thead>
        <tbody>
          ${[...filtered].sort((a, b) => b.date.localeCompare(a.date)).map(s => `<tr>
            <td style="white-space:nowrap;">${new Date(s.date).toLocaleString('en-PH', {dateStyle:'short',timeStyle:'short'})}</td>
            <td style="font-size:11px;">${s.lines.map(l => `${l.item_name} ×${l.qty}`).join(', ')}</td>
            <td>${cur(s.revenue)}</td>
            <td>${cur(s.cogs)}</td>
            <td class="green">${cur(s.gp || (s.revenue - s.cogs))}</td>
          </tr>`).join('') || '<tr><td colspan="5" style="color:#999;text-align:center;">No sales found</td></tr>'}
        </tbody>
      </table>`;

    openPrintWindow('Sales — RESERVE', body);
  }

  function printExpenses() {
    const expenses = StorageAPI.getExpenses();
    const start = $('#expFilterStart') ? $('#expFilterStart').value : null;
    const end   = $('#expFilterEnd')   ? $('#expFilterEnd').value   : null;
    const filtered = expenses.filter(e => inRange(e.date, start, end));
    const total = filtered.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    // Group by category
    const byCategory = {};
    filtered.forEach(e => { const c = e.category || 'Other'; byCategory[c] = (byCategory[c] || 0) + (Number(e.amount) || 0); });
    const catRows = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

    const periodLabel = start || end ? `${start || '—'} to ${end || '—'}` : 'All Time';

    const body = `
      <h1>RESERVE — Expenses</h1>
      <div class="meta">Period: <strong>${periodLabel}</strong> &nbsp;·&nbsp; ${filtered.length} expense(s)</div>
      <div class="kpi-row">
        <div class="kpi-box"><div class="label">Total Expenses</div><div class="value red">${cur(total)}</div></div>
        <div class="kpi-box"><div class="label">Records</div><div class="value">${filtered.length}</div></div>
      </div>

      <div class="section-title">By Category</div>
      <table>
        <thead><tr><th>Category</th><th>Amount</th><th>Share</th></tr></thead>
        <tbody>
          ${catRows.map(([cat, amt]) => `<tr>
            <td>${cat}</td>
            <td class="red">${cur(amt)}</td>
            <td style="color:#6b7280;">${total ? ((amt / total) * 100).toFixed(1) + '%' : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <div class="section-title">All Records</div>
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Account Type</th><th>Note</th><th>Amount</th></tr></thead>
        <tbody>
          ${[...filtered].sort((a, b) => b.date.localeCompare(a.date)).map(e => `<tr>
            <td>${new Date(e.date).toLocaleDateString('en-PH')}</td>
            <td>${e.category || '—'}</td>
            <td style="font-size:11px;">${e.account_type || '—'}</td>
            <td style="font-size:11px;">${e.note || '—'}</td>
            <td class="red"><strong>${cur(e.amount)}</strong></td>
          </tr>`).join('') || '<tr><td colspan="5" style="color:#999;text-align:center;">No expenses</td></tr>'}
        </tbody>
      </table>`;

    openPrintWindow('Expenses — RESERVE', body);
  }

  function printReports() {
    const sales    = StorageAPI.getSales();
    const expenses = StorageAPI.getExpenses();
    const payroll  = StorageAPI.getPayroll();
    const staff    = StorageAPI.getStaff();
    const inv      = StorageAPI.getInventory();
    const start    = $('#reportStart').value || null;
    const end      = $('#reportEnd').value   || null;

    // Filter transactions, expenses, and payroll to the exact selected date range
    const fSales = sales.filter(s => inRange(s.date, start, end));
    const fExp   = expenses.filter(e => inRange(e.date, start, end));
    const fPay   = payroll.filter(p => {
      if (!p.period) return true;
      const pDate = Calc.periodToDate(p.period);
      if (!pDate) return true;
      return (!start || pDate >= start) && (!end || pDate <= end);
    });

    // 1. Executive Summary Financial KPIs
    const salesRev  = fSales.reduce((sum, s) => sum + saleRevenue(s), 0);
    const salesCOGS = fSales.reduce((sum, s) => sum + saleCOGS(s), 0);
    const salesGP   = fSales.reduce((sum, s) => sum + saleGP(s), 0);
    const expTotal  = fExp.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const payTotal  = fPay.reduce((sum, p) => sum + (Number(p.net_pay) || 0), 0);
    const totalOperatingCost = expTotal + payTotal;
    const netP      = salesGP - totalOperatingCost;
    const gpMargin  = salesRev > 0 ? ((salesGP / salesRev) * 100).toFixed(1) : '0.0';

    function fmtDate(ds) {
      if (!ds) return '';
      const [y, m, d] = ds.split('-');
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    let periodLabel = (start && end)
      ? `${fmtDate(start)} – ${fmtDate(end)}`
      : (start ? `From ${fmtDate(start)}` : (end ? `Until ${fmtDate(end)}` : 'All Recorded History'));

    if (_reportFilterMode === 'monthly' && $('#reportFilterMonth')) {
      const opt = $('#reportFilterMonth').selectedOptions[0];
      if (opt && opt.text) periodLabel = `${opt.text} (${fmtDate(start)} – ${fmtDate(end)})`;
    } else if (_reportFilterMode === 'weekly' && $('#reportFilterWeek')) {
      const opt = $('#reportFilterWeek').selectedOptions[0];
      if (opt && opt.text) periodLabel = opt.text;
    }

    // 2. Total Sales Per Day (Daily Summary)
    const dayMap = {};
    fSales.forEach(s => {
      const dk = (s.date || '').slice(0, 10);
      if (!dk) return;
      if (!dayMap[dk]) dayMap[dk] = { count: 0, revenue: 0, gp: 0 };
      dayMap[dk].count++;
      dayMap[dk].revenue += saleRevenue(s);
      dayMap[dk].gp      += saleGP(s);
    });
    const dayKeys = Object.keys(dayMap).sort((a, b) => a.localeCompare(b));
    const dailyRowsHtml = dayKeys.length ? dayKeys.map(dk => {
      const d = dayMap[dk];
      const dObj = new Date(dk + 'T00:00:00');
      const dateFormatted = dObj.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const margin = d.revenue > 0 ? ((d.gp / d.revenue) * 100).toFixed(1) + '%' : '—';
      return `<tr>
        <td><strong>${dateFormatted}</strong></td>
        <td class="r">${d.count} sale${d.count > 1 ? 's' : ''}</td>
        <td class="r">${cur(d.revenue)}</td>
        <td class="r green">${cur(d.gp)}</td>
        <td class="r" style="font-size:12px;color:#64748b;">${margin}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" style="text-align:center;color:#888;padding:12px;">No sales recorded for the selected date range.</td></tr>`;

    // 3. Top 10 Selling Items on Selected Date Range (strictly top 10, no long product lists)
    const itemMap = {};
    fSales.forEach(sale => (sale.lines || []).forEach(l => {
      const key = l.item_id || l.item_name;
      if (!key) return;
      if (!itemMap[key]) {
        const item = inv.find(i => i.id === l.item_id);
        itemMap[key] = {
          name: l.item_name || item?.name || key,
          category: item?.category || '—',
          qty: 0,
          revenue: 0,
          gp: 0
        };
      }
      const t = Calc.lineTotals(l);
      itemMap[key].qty     += Number(l.qty) || 0;
      itemMap[key].revenue += t.revenue;
      itemMap[key].gp      += t.gp;
    }));
    const top10Items = Object.values(itemMap).sort((a, b) => b.qty - a.qty).slice(0, 10);
    const top10QtyTotal = top10Items.reduce((s, it) => s + it.qty, 0);
    const top10RevTotal = top10Items.reduce((s, it) => s + it.revenue, 0);
    const top10GpTotal  = top10Items.reduce((s, it) => s + it.gp, 0);

    const top10RowsHtml = top10Items.length ? top10Items.map((it, i) => {
      const rankBadge = i === 0 ? '🥇 #1' : i === 1 ? '🥈 #2' : i === 2 ? '🥉 #3' : `#${i + 1}`;
      return `<tr>
        <td style="font-weight:700;white-space:nowrap;">${rankBadge}</td>
        <td><strong>${it.name}</strong></td>
        <td><span style="background:#f1f5f9;color:#475569;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;">${it.category}</span></td>
        <td class="r"><strong>${it.qty}</strong></td>
        <td class="r">${cur(it.revenue)}</td>
        <td class="r green">${cur(it.gp)}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="text-align:center;color:#888;padding:12px;">No products sold for the selected date range.</td></tr>`;

    // 4. Expenses Breakdown by Category (Selected Period)
    const catMap = {};
    fExp.forEach(e => {
      const c = e.category || 'Other';
      catMap[c] = (catMap[c] || 0) + (Number(e.amount) || 0);
    });
    if (payTotal > 0) {
      catMap['Staff Payroll'] = (catMap['Staff Payroll'] || 0) + payTotal;
    }
    const catRowsHtml = Object.entries(catMap).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => {
      const share = totalOperatingCost > 0 ? ((amt / totalOperatingCost) * 100).toFixed(1) + '%' : '—';
      return `<tr>
        <td><strong>${cat}</strong></td>
        <td class="r red">−${cur(amt)}</td>
        <td class="r" style="color:#64748b;">${share}</td>
      </tr>`;
    }).join('');

    const body = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #0f172a;padding-bottom:14px;margin-bottom:18px;">
        <div>
          <h1 style="font-size:24px;font-weight:800;letter-spacing:0.5px;color:#0f172a;margin:0 0 4px 0;">🍽️ RESERVED</h1>
          <div style="font-size:12px;color:#64748b;font-weight:500;">Official Financial &amp; Performance Report</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:700;color:#0f172a;background:#f0fdf4;padding:4px 14px;border-radius:20px;border:1px solid #86efac;display:inline-block;">
            📅 ${periodLabel}
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:5px;">Generated: ${new Date().toLocaleString('en-PH')}</div>
        </div>
      </div>

      <!-- Financial Summary KPIs -->
      <div class="section-title">📊 Executive Financial Summary</div>
      <div class="kpi-row">
        <div class="kpi-box">
          <div class="label">Total Sales Revenue</div>
          <div class="value">${cur(salesRev)}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">${fSales.length} transaction${fSales.length === 1 ? '' : 's'}</div>
        </div>
        <div class="kpi-box">
          <div class="label">Gross Profit</div>
          <div class="value green">${cur(salesGP)}</div>
          <div style="font-size:10px;color:#16a34a;margin-top:2px;">Margin: ${gpMargin}%</div>
        </div>
        <div class="kpi-box">
          <div class="label">Operating Expenses</div>
          <div class="value red">${cur(expTotal)}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">General operating costs</div>
        </div>
        <div class="kpi-box">
          <div class="label">Staff Payroll</div>
          <div class="value red">${cur(payTotal)}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">${fPay.length} payroll payouts</div>
        </div>
        <div class="kpi-box" style="border: 2px solid ${netP >= 0 ? '#86efac' : '#fca5a5'};background:${netP >= 0 ? '#f0fdf4' : '#fef2f2'};">
          <div class="label" style="color:${netP >= 0 ? '#15803d' : '#b91c1c'};">Net Profit</div>
          <div class="value ${netP >= 0 ? 'green' : 'red'}" style="font-size:20px;">${cur(netP)}</div>
          <div style="font-size:10px;color:${netP >= 0 ? '#15803d' : '#b91c1c'};margin-top:2px;">${netP >= 0 ? 'Profitable' : 'Deficit'}</div>
        </div>
      </div>

      <!-- Total Sales Per Day -->
      <div class="section-title">📅 Total Sales per Day</div>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th class="r">Transactions</th>
            <th class="r">Total Revenue</th>
            <th class="r">Gross Profit</th>
            <th class="r">GP Margin</th>
          </tr>
        </thead>
        <tbody>
          ${dailyRowsHtml}
        </tbody>
        ${dayKeys.length ? `
        <tfoot>
          <tr class="totals-row">
            <td><strong>TOTAL (${dayKeys.length} day${dayKeys.length > 1 ? 's' : ''})</strong></td>
            <td class="r">${fSales.length} sale${fSales.length === 1 ? '' : 's'}</td>
            <td class="r">${cur(salesRev)}</td>
            <td class="r green">${cur(salesGP)}</td>
            <td class="r">${gpMargin}%</td>
          </tr>
        </tfoot>` : ''}
      </table>

      <!-- Top 10 Selling Items -->
      <div class="section-title" style="margin-top:26px;">🏆 Top 10 Selling Items (Selected Period)</div>
      <table>
        <thead>
          <tr>
            <th style="width:65px;">Rank</th>
            <th>Item Name</th>
            <th>Category</th>
            <th class="r">Qty Sold</th>
            <th class="r">Total Revenue</th>
            <th class="r">Gross Profit</th>
          </tr>
        </thead>
        <tbody>
          ${top10RowsHtml}
        </tbody>
        ${top10Items.length ? `
        <tfoot>
          <tr class="totals-row">
            <td colspan="3"><strong>TOP 10 TOTAL</strong></td>
            <td class="r">${top10QtyTotal}</td>
            <td class="r">${cur(top10RevTotal)}</td>
            <td class="r green">${cur(top10GpTotal)}</td>
          </tr>
        </tfoot>` : ''}
      </table>

      <!-- Expenses by Category -->
      <div class="section-title" style="margin-top:26px;">💸 Expenses by Category</div>
      <table>
        <thead>
          <tr>
            <th>Expense Category</th>
            <th class="r">Total Amount</th>
            <th class="r" style="width:130px;">Share (%)</th>
          </tr>
        </thead>
        <tbody>
          ${catRowsHtml || '<tr><td colspan="3" style="text-align:center;color:#888;padding:12px;">No expenses recorded for the selected date range.</td></tr>'}
        </tbody>
        ${catRowsHtml ? `
        <tfoot>
          <tr class="totals-row">
            <td><strong>TOTAL EXPENSES &amp; PAYROLL</strong></td>
            <td class="r red">−${cur(totalOperatingCost)}</td>
            <td class="r">100.0%</td>
          </tr>
        </tfoot>` : ''}
      </table>

      <!-- Signatures Section -->
      <div class="sig-section">
        <div class="sig-box">Prepared by</div>
        <div class="sig-box">Verified by</div>
        <div class="sig-box">Approved by</div>
      </div>
    `;

    const extraCss = `
      .r { text-align: right; }
      .totals-row td { font-weight: 700; background: #f8fafc; border-top: 2px solid #0f172a; border-bottom: 2px solid #0f172a; }
      .sig-section { display: flex; justify-content: space-between; gap: 24px; margin-top: 36px; page-break-inside: avoid; }
      .sig-box { flex: 1; border-top: 1.5px solid #334155; padding-top: 8px; font-size: 11px; text-align: center; color: #475569; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
      @media print {
        body { padding: 12px; font-size: 12px; }
        .kpi-box { padding: 8px 12px; min-width: 100px; }
        .kpi-box .value { font-size: 16px; }
        table { page-break-inside: auto; }
        tr { page-break-inside: avoid; page-break-after: auto; }
        .sig-section { margin-top: 28px; }
      }
    `;

    openPrintWindow(`Financial Report — RESERVED (${periodLabel})`, body, extraCss);
  }

  // ── RENDER ALL ─────────────────────────────────────────────────────────────
  function renderAll() {
    renderDashboard();
    // Set current-month default for stock log + sales before first render
    (function() {
      const now = new Date();
      const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      applyLogMonthFilter(ym);
      applySalesMonthFilter(ym);
    })();
    renderInventory();
    renderSalesHistory();
    renderExpenses();
    // Staff and reports are rendered on demand (nav click) to avoid DOM errors
  }

  // ── BOOT ───────────────────────────────────────────────────────────────────
  async function boot() {
    if (state.booted) return;
    state.booted = true;

    // Wait for all data to load from Supabase
    await StorageAPI.ensureDefaults();

    refreshDatalists();
    setupNav();
    applyRoleUI();
    setupTheme();
    setupItemDialog();
    setupRestockDialog();
    setupDashboardFilter();
    setupPrintButtons();
    setupInventoryCsv();
    setupSales();
    setupExpenses();
    setupMenu();
    setupStaff();
    setupReports();
    setupSettings();
    setupBackup();
    setupInventoryFilters();
    setupKeyboard();
    $('#year').textContent = new Date().getFullYear();

    renderAll();
    backfillDiscountLog();
    toast('Welcome to RESERVE 👋', 'success');
  }

  document.addEventListener('DOMContentLoaded', setupLogin);
})();
