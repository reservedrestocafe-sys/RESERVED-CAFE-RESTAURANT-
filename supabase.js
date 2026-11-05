// supabase.js — Supabase client setup for RESERVE
// ─────────────────────────────────────────────────
// Replace the two values below with your actual keys
// Found in: Supabase Dashboard → Project Settings → API

const SUPABASE_URL = 'https://gtmttxhligaoqzzvanxk.supabase.co'    // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = 'sb_publishable_Z9U_WRifEL7pE0KJ2NgguA_R2hOvTHh'  // starts with sb_publishable_...

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Test connection on load
console.log('✓ Supabase initialized:', { url: SUPABASE_URL.slice(0, 30) + '...', key: SUPABASE_ANON_KEY.slice(0, 20) + '...' })