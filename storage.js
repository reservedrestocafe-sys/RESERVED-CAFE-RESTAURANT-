// storage.js — Supabase CRUD for RESERVE
// All field names match exactly what app.js uses.
// Includes connection test on boot to catch issues early.

(function () {

  // ── CACHE ──────────────────────────────────────────────────────────────────
  const cache = {
    inventory:       [],
    sales:           [],
    expenses:        [],
    monthlyTopItems: [],
    staff:           [],
    payroll:         [],
    stockLog:        [],
    menuProducts:    [],
    discountLog:     []
  };

  // ── SETTINGS (localStorage) ────────────────────────────────────────────────
  const SK = 'reserve_settings';
  function readLocal(k)    { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function writeLocal(k,v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error(e); } }
  function getSettings()   { return readLocal(SK) || {}; }
  function saveSettings(s) { writeLocal(SK, s); }

  // ── UID ────────────────────────────────────────────────────────────────────
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  }

  // ── SESSION USER ──────────────────────────────────────────────────────────────
  function getSessionUser() {
    return sessionStorage.getItem('r_active_user') || localStorage.getItem('r_active_user') || 'Unknown';
  }
  function setSessionUser(name, remember) {
    sessionStorage.setItem('r_active_user', name);
    if (remember) localStorage.setItem('r_active_user', name);
    else          localStorage.removeItem('r_active_user');
  }
  function clearSessionUser() {
    sessionStorage.removeItem('r_active_user');
    localStorage.removeItem('r_active_user');
  }

  // ── BOOT ───────────────────────────────────────────────────────────────────
  async function ensureDefaults() {
    // Merge settings defaults
    const defaults = {
      currency: '₱', theme: 'light', lowStockThreshold: 10,
      categories: ['STARTERS','CHICKEN WINGS','PASTA','ALL-DAY BREAKFAST','JAPAN & KOREAN','BURGERS & SANDWICHES'],
      suppliers: ['Default Supplier']
    };
    const ex = getSettings();
    if (!ex || !ex.currency) {
      writeLocal(SK, { ...defaults, ...ex });
    } else {
      let changed = false;
      if (!ex.currency)          { ex.currency = defaults.currency; changed = true; }
      if (!ex.lowStockThreshold) { ex.lowStockThreshold = 10;       changed = true; }
      if (!ex.theme)             { ex.theme = defaults.theme;        changed = true; }
      if (!Array.isArray(ex.categories)) ex.categories = [];
      const bad = new Set(['food','beverage','supplies']);
      const mc = Array.from(new Set([...defaults.categories,...ex.categories])).filter(c=>!bad.has((c||'').toLowerCase()));
      if (mc.join()!==ex.categories.join()) { ex.categories=mc; changed=true; }
      if (!Array.isArray(ex.suppliers)) ex.suppliers=[];
      const ms = Array.from(new Set([...defaults.suppliers,...ex.suppliers]));
      if (ms.length!==ex.suppliers.length) { ex.suppliers=ms; changed=true; }
      if (changed) writeLocal(SK, ex);
    }

    // Test connection first
    const ok = await _testConnection();
    if (!ok) {
      console.error('⛔ RESERVE: Cannot connect to Supabase. Check your URL and ANON KEY in supabase.js');
      // Show a visible banner in the UI so the user knows what's wrong
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#D32F2F;color:#fff;padding:14px 20px;font-size:14px;font-weight:600;text-align:center;';
      banner.innerHTML = '⛔ Cannot connect to Supabase — check your URL and ANON KEY in <code>supabase.js</code>. Open the browser console (F12) for details.';
      document.body.prepend(banner);
      return;
    }
    console.log('✅ RESERVE: Supabase connected');

    // Load all tables in parallel — stock_log uses paginated loader to get ALL rows
    await Promise.all([
      _loadTable('inventory',        'created_at', true),
      _loadAllSales(),
      _loadTable('expenses',         'date',       false),
      _loadTable('monthly_top_items','month',      false),
      _loadTable('staff',            'name',       true),
      _loadTable('payroll',          'period',     false),
      _loadAllStockLog(),
      _loadTable('menu_products',    'created_at', true),
      _loadAllDiscountLog()
    ]);

    console.log('✅ RESERVE: All data loaded —',
      `inventory:${cache.inventory.length}`,
      `sales:${cache.sales.length}`,
      `expenses:${cache.expenses.length}`,
      `staff:${cache.staff.length}`,
      `payroll:${cache.payroll.length}`,
      `stockLog:${cache.stockLog.length}`
    );
  }

  async function _testConnection() {
    try {
      const { error } = await db.from('inventory').select('id').limit(1);
      return !error;
    } catch { return false; }
  }

  async function _loadTable(table, orderCol, ascending, limit = null) {
    try {
      let q = db.from(table).select('*').order(orderCol, { ascending });
      if (limit) q = q.limit(limit);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];

      switch(table) {
        case 'inventory':
          cache.inventory = rows; break;
        case 'sales':
          cache.sales = rows.map(s => _unpackSaleFromDB(s)); break;
        case 'expenses':
          cache.expenses = rows; break;
        case 'monthly_top_items':
          cache.monthlyTopItems = rows.map(r => ({ ...r, items: _parseJ(r.items, []) })); break;
        case 'staff':
          cache.staff = rows; break;
        case 'payroll':
          // 'allowance' column in DB is now repurposed as 'cash_advance' (no schema change needed)
          cache.payroll = rows.map(p => ({
            ...p,
            cash_advance: p.cash_advance ?? p.allowance ?? 0
          }));
          break;
        case 'stock_log':
          cache.stockLog = rows; break;
        case 'menu_products':
          cache.menuProducts = rows.map(p => ({ ...p, recipes: _parseJ(p.recipes, []) })); break;
      }
    } catch(e) {
      console.error(`❌ Failed to load ${table}:`, e.message || e);
      console.warn(`Hint: Make sure the "${table}" table exists in your Supabase project and RLS policies allow SELECT.`);
    }
  }

  // Supabase returns max 1000 rows per query by default.
  // This function pages through ALL stock_log rows so nothing is lost.
  async function _loadAllStockLog() {
    try {
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await db
          .from('stock_log')
          .select('*')
          .order('date', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        allRows = allRows.concat(rows);
        if (rows.length < PAGE) break;  // last page
        from += PAGE;
      }
      cache.stockLog = allRows;
      console.log(`✅ stock_log: loaded ${allRows.length} total rows`);
    } catch(e) {
      console.error('❌ Failed to load stock_log:', e.message || e);
    }
  }

  // Paginated sales loader — pages through ALL rows so nothing is ever missing.
  // No row limit, no assumptions about count. Identical pattern to _loadAllStockLog.
  async function _loadAllSales() {
    try {
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await db
          .from('sales')
          .select('*')
          .order('date', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        allRows = allRows.concat(rows);
        if (rows.length < PAGE) break; // last page reached
        from += PAGE;
      }
      cache.sales = allRows.map(s => _unpackSaleFromDB(s));
      console.log(`✅ sales: loaded ${allRows.length} total rows`);
    } catch(e) {
      console.error('❌ Failed to load sales:', e.message || e);
    }
  }

  function _parseJ(val, fallback) {
    if (Array.isArray(val) || (val && typeof val === 'object')) return val;
    try { return JSON.parse(val); } catch { return fallback; }
  }

  // Fire-and-forget Supabase write — logs errors without blocking UI
  async function _save(label, promise) {
    try {
      const { error } = await Promise.resolve(promise);
      if (error) {
        console.error(`❌ ${label}:`, error.message || error);
        if (error.code)    console.error(`   Code: ${error.code}`);
        if (error.details) console.error(`   Details: ${error.details}`);
        if (error.hint)    console.error(`   Hint: ${error.hint}`);
      } else {
        console.log(`✅ ${label}: saved`);
      }
    } catch(e) {
      console.error(`❌ ${label} exception:`, e.message || e);
    }
  }

  // ── INVENTORY ──────────────────────────────────────────────────────────────
  function getInventory()  { return cache.inventory; }
  function getItemById(id) { return cache.inventory.find(i => i.id === id) || null; }

  function upsertItem(item) {
    const idx = cache.inventory.findIndex(i => i.id === item.id);
    if (idx >= 0) cache.inventory[idx] = item; else cache.inventory.push(item);
    _save(`upsert inventory [${item.name}]`, db.from('inventory').upsert(item, { onConflict: 'id' }));
    return item;
  }

  function saveInventory(items) {
    cache.inventory = items;
    items.forEach(it => _save(`upsert inventory [${it.name}]`, db.from('inventory').upsert(it, { onConflict: 'id' })));
  }

  function deleteItem(id) {
    const name = getItemById(id)?.name || id;
    cache.inventory = cache.inventory.filter(i => i.id !== id);
    _save(`delete inventory [${name}]`, db.from('inventory').delete().eq('id', id));
  }

  // ── SALES ──────────────────────────────────────────────────────────────────
  function getSales()   { return cache.sales; }
  function saveSales(s) { cache.sales = s; }

  // Pack discount/VAT/order_type into the existing `lines` JSON column so no
  // DB schema change is needed. Format: { _meta: {...}, lines: [...] }
  // Pack all sale fields into the `lines` JSON column.
  // Only sends columns that EXIST in the Supabase sales table: id, date, lines, revenue, cogs, gp
  // Everything else (discount, vat, order_type, etc.) lives inside the lines JSON _meta block.
  function _packSaleForDB(sale) {
    const revenue = Number(sale.revenue) || 0;
    const cogs    = Number(sale.cogs)    || 0;
    const gp      = Number(sale.gp)      || (revenue - cogs);
    return {
      id:      sale.id,
      date:    sale.date,
      revenue,
      cogs,
      gp,
      done_by: sale.done_by  || 'Unknown',
      lines: JSON.stringify({
        _meta: {
          order_type:          sale.order_type,
          payment_method:      sale.payment_method || 'Cash',
          discount_type:       sale.discount_type,
          discount_amt:        Number(sale.discount_amt) || 0,
          vat_amt:             Number(sale.vat_amt) || 0,
          vat_included:        sale.vat_included,
          service_charge_type: sale.service_charge_type,
          service_charge_amt:  Number(sale.service_charge_amt) || 0,
          done_by:             sale.done_by || 'Unknown',
          revenue,
          gp,
          cogs
        },
        lines: sale.lines || []
      })
    };
  }

  function _unpackSaleFromDB(row) {
    const parsed = _parseJ(row.lines, null);
    if (parsed && parsed._meta !== undefined) {
      const { _meta, lines } = parsed;
      const revenue = Number(_meta.revenue ?? row.revenue ?? 0) || 0;
      const cogs    = Number(_meta.cogs    ?? row.cogs    ?? 0) || 0;
      const gp      = Number(_meta.gp      ?? row.gp      ?? (revenue - cogs)) || 0;
      return {
        ...row,
        lines:               lines || [],
        order_type:          _meta.order_type          ?? row.order_type,
        payment_method:      _meta.payment_method      ?? row.payment_method ?? 'Cash',
        discount_type:       _meta.discount_type       ?? row.discount_type ?? 'none',
        discount_amt:        Number(_meta.discount_amt  ?? row.discount_amt  ?? 0) || 0,
        vat_amt:             Number(_meta.vat_amt       ?? row.vat_amt       ?? 0) || 0,
        vat_included:        _meta.vat_included        ?? row.vat_included ?? false,
        service_charge_type: _meta.service_charge_type ?? 'none',
        service_charge_amt:  Number(_meta.service_charge_amt ?? 0) || 0,
        done_by:             _meta.done_by ?? row.done_by ?? 'Unknown',
        revenue,
        gp,
        cogs
      };
    }
    // Legacy plain-array format — keep revenue/gp/cogs from DB columns
    const revenue = Number(row.revenue) || 0;
    const cogs    = Number(row.cogs)    || 0;
    const gp      = Number(row.gp)      || (revenue - cogs);
    return {
      ...row,
      lines: Array.isArray(parsed) ? parsed : [],
      revenue,
      cogs,
      gp
    };
  }

  function addSale(sale) {
    sale.done_by = sale.done_by || getSessionUser();
    cache.sales.unshift(sale);
    _save(`insert sale [${sale.id}]`, db.from('sales').insert([_packSaleForDB(sale)]));
    return sale;
  }

  function deleteSale(id) {
    cache.sales = cache.sales.filter(s => s.id !== id);
    _save(`delete sale [${id}]`, db.from('sales').delete().eq('id', id));
  }

  // ── EXPENSES ───────────────────────────────────────────────────────────────
  // app.js saves: id, date, account_type, category, tin, amount, note
  function getExpenses()     { return cache.expenses; }
  function saveExpenses(exp) { cache.expenses = exp; }

  function addExpense(expense) {
    expense.done_by = expense.done_by || getSessionUser();
    cache.expenses.unshift(expense);
    _save(`insert expense [${expense.id}]`, db.from('expenses').insert([expense]));
    return expense;
  }

  function deleteExpense(id) {
    cache.expenses = cache.expenses.filter(e => e.id !== id);
    _save(`delete expense [${id}]`, db.from('expenses').delete().eq('id', id));
  }

  function updateExpense(id, fields) {
    cache.expenses = cache.expenses.map(e => e.id === id ? { ...e, ...fields } : e);
    _save(`update expense [${id}]`, db.from('expenses').update(fields).eq('id', id));
  }

  // ── STOCK LOG ──────────────────────────────────────────────────────────────
  // app.js calls addStockLog({ item_id, item_name, type, qty, balance, note, date })
  function getStockLog() { return cache.stockLog; }

  function addStockLog(entry) {
    const row = { id: uid('log'), done_by: getSessionUser(), ...entry };
    // Push to cache immediately with inventory_type for in-session section display
    cache.stockLog.unshift(row);
    // Save to DB — strip inventory_type because your stock_log table may not have
    // this column yet. Run migration_stock_log.sql to add it, then remove this stripping.
    const { inventory_type: _it, ...dbRow } = row;
    _save(`insert stock_log [${entry.item_name}]`, db.from('stock_log').insert([dbRow]));
  }

  // ── STAFF ──────────────────────────────────────────────────────────────────
  // app.js saves: id, name, position, employment_type, salary, hourly_rate, contact, hire_date
  function getStaff()       { return cache.staff; }
  function getStaffById(id) { return cache.staff.find(s => s.id === id) || null; }

  function upsertStaff(staff) {
    const idx = cache.staff.findIndex(s => s.id === staff.id);
    if (idx >= 0) cache.staff[idx] = staff; else cache.staff.push(staff);
    _save(`upsert staff [${staff.name}]`, db.from('staff').upsert(staff, { onConflict: 'id' }));
    return staff;
  }

  function deleteStaff(id) {
    cache.staff = cache.staff.filter(s => s.id !== id);
    _save(`delete staff [${id}]`, db.from('staff').delete().eq('id', id));
  }

  // ── PAYROLL ────────────────────────────────────────────────────────────────
  // app.js saves: id, staff_id, period, hours_worked, base_pay,
  //               overtime, cash_advance, deductions, net_pay
  // Note: cash_advance is stored in the existing DB 'allowance' column —
  // no schema migration required. On read, 'allowance' is surfaced as 'cash_advance'.
  function getPayroll() { return cache.payroll; }

  function upsertPayroll(entry) {
    const idx = cache.payroll.findIndex(p => p.id === entry.id);
    if (idx >= 0) cache.payroll[idx] = entry; else cache.payroll.unshift(entry);
    // Write cash_advance into the existing 'allowance' column so no DB change is needed
    const { cash_advance, ...rest } = entry;
    const dbRow = { ...rest, allowance: cash_advance ?? 0 };
    _save(`upsert payroll [${entry.id}]`, db.from('payroll').upsert(dbRow, { onConflict: 'id' }));
    return entry;
  }

  function deletePayroll(id) {
    cache.payroll = cache.payroll.filter(p => p.id !== id);
    _save(`delete payroll [${id}]`, db.from('payroll').delete().eq('id', id));
  }

  // ── MONTHLY TOP ITEMS ──────────────────────────────────────────────────────
  function getMonthlyTopItems()      { return cache.monthlyTopItems; }
  function saveMonthlyTopItems(recs) { cache.monthlyTopItems = recs; }

  function saveMonthlyTopRecord(month, items) {
    const rec = { month, saved_at: new Date().toISOString(), items };
    const idx = cache.monthlyTopItems.findIndex(r => r.month === month);
    if (idx >= 0) cache.monthlyTopItems[idx] = rec; else cache.monthlyTopItems.unshift(rec);
    _save(`upsert monthly_top_items [${month}]`,
      db.from('monthly_top_items').upsert(
        { month, saved_at: rec.saved_at, items: JSON.stringify(items) },
        { onConflict: 'month' }
      )
    );
    return rec;
  }

  function getMonthlyRecord(month) { return cache.monthlyTopItems.find(r => r.month === month) || null; }
  function getCurrentMonthKey() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  }

  // ── BACKUP / RESTORE ───────────────────────────────────────────────────────
  function exportJSON() {
    const blob = new Blob([JSON.stringify({
      inventory: getInventory(), sales: getSales(), expenses: getExpenses(),
      staff: getStaff(), payroll: getPayroll(), settings: getSettings()
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'reserve_backup.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function importJSON(file, onDone) {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.inventory) { cache.inventory = data.inventory; for (const it of data.inventory) await db.from('inventory').upsert(it, { onConflict:'id' }); }
        if (data.sales)     { cache.sales = data.sales; for (const s of data.sales) await db.from('sales').upsert(_packSaleForDB(s),{onConflict:'id'}); }
        if (data.expenses)  { cache.expenses = data.expenses; for (const ex of data.expenses) await db.from('expenses').upsert(ex, {onConflict:'id'}); }
        if (data.staff)     { cache.staff = data.staff; for (const st of data.staff) await db.from('staff').upsert(st, {onConflict:'id'}); }
        if (data.payroll)   { cache.payroll = data.payroll; for (const p of data.payroll) await db.from('payroll').upsert(p, {onConflict:'id'}); }
        if (data.settings)  { writeLocal(SK, data.settings); }
        onDone && onDone(true);
      } catch(err) { console.error(err); onDone && onDone(false); }
    };
    reader.readAsText(file);
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  function toCSV(rows) {
    if (!rows || !rows.length) return '';
    const headers = Object.keys(rows[0]);
    const esc = v => { if (v==null) return ''; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`  :s; };
    return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  }
  function downloadCSV(filename, rows) {
    if (!rows || !rows.length) return;
    const blob = new Blob([toCSV(rows)], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    const headers = lines.shift().split(',').map(h => h.trim());
    return lines.map(line => {
      const cols = line.split(',').map(c => c.trim());
      const obj = {}; headers.forEach((h,i) => obj[h] = cols[i]); return obj;
    });
  }

  // ── MENU PRODUCTS ──────────────────────────────────────────────────────────
  // Columns: id, name, category, price, description, is_available, created_at, updated_at
  function getMenuProducts()      { return cache.menuProducts; }
  function getMenuProductById(id) { return cache.menuProducts.find(p => p.id === id) || null; }

  function upsertMenuProduct(product) {
    const cached = { ...product, recipes: _parseJ(product.recipes, []) };
    const idx = cache.menuProducts.findIndex(p => p.id === product.id);
    if (idx >= 0) cache.menuProducts[idx] = cached; else cache.menuProducts.push(cached);
    const dbRow = { ...product, recipes: JSON.stringify(product.recipes || []) };
    _save(`upsert menu_products [${product.name}]`,
      db.from('menu_products').upsert(dbRow, { onConflict: 'id' })
    );
    return cached;
  }

  function deleteMenuProduct(id) {
    const name = getMenuProductById(id)?.name || id;
    cache.menuProducts = cache.menuProducts.filter(p => p.id !== id);
    _save(`delete menu_products [${name}]`, db.from('menu_products').delete().eq('id', id));
  }

  // ── DISCOUNT LOG ────────────────────────────────────────────────────────────
  // Stored in Supabase so logs are synced across all devices/browsers.
  // Entry shape: { id, sale_id, date, product_id, product_name, discount_type,
  //               discount_value, discount_amt, original_price, qty, done_by }
  //
  // Required Supabase table (run once in your Supabase SQL editor):
  //
  //   create table discount_log (
  //     id            text primary key,
  //     sale_id       text,
  //     date          text,
  //     product_id    text,
  //     product_name  text,
  //     discount_type text,
  //     discount_value numeric,
  //     discount_amt   numeric,
  //     original_price numeric,
  //     qty            numeric,
  //     done_by        text,
  //     created_at     timestamptz default now()
  //   );
  //
  // To migrate existing localStorage data, open the browser console on your
  // LOCAL machine and run:
  //
  //   const old = JSON.parse(localStorage.getItem('reserve_discount_log') || '[]');
  //   if (old.length) { StorageAPI.addDiscountLogEntries(old); console.log('Migrated', old.length, 'entries'); }

  async function _loadAllDiscountLog() {
    try {
      const PAGE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await db
          .from('discount_log')
          .select('*')
          .order('date', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        allRows = allRows.concat(rows);
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      cache.discountLog = allRows;
      console.log(`✅ discount_log: loaded ${allRows.length} total rows`);
    } catch(e) {
      console.error('❌ Failed to load discount_log:', e.message || e);
      console.warn('Hint: Make sure the "discount_log" table exists in Supabase and RLS allows SELECT.');
    }
  }

  function getDiscountLog() {
    return cache.discountLog;
  }

  function addDiscountLogEntries(entries) {
    // Optimistic cache update so UI reflects immediately
    cache.discountLog.unshift(...entries);
    // Persist to Supabase
    entries.forEach(entry => {
      _save(`insert discount_log [${entry.id}]`,
        db.from('discount_log').upsert(entry, { onConflict: 'id' })
      );
    });
  }

  function clearDiscountLog() {
    cache.discountLog = [];
    _save('clear discount_log', db.from('discount_log').delete().neq('id', ''));
  }

  // ── EXPOSE ─────────────────────────────────────────────────────────────────
  window.StorageAPI = {
    ensureDefaults, uid,
    getSessionUser, setSessionUser, clearSessionUser,
    getInventory, saveInventory, upsertItem, deleteItem, getItemById,
    getSales, saveSales, addSale, deleteSale,
    getExpenses, saveExpenses, addExpense, deleteExpense, updateExpense,
    getStockLog, addStockLog,
    getStaff, getStaffById, upsertStaff, deleteStaff,
    getPayroll, upsertPayroll, deletePayroll,
    getSettings, saveSettings,
    exportJSON, importJSON,
    toCSV, downloadCSV, parseCSV,
    getMonthlyTopItems, saveMonthlyTopItems, saveMonthlyTopRecord,
    getMonthlyRecord, getCurrentMonthKey,
    getMenuProducts, getMenuProductById, upsertMenuProduct, deleteMenuProduct,
    getDiscountLog, addDiscountLogEntries, clearDiscountLog
  };
})();
