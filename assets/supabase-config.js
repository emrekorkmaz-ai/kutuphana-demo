/* Supabase istemci bağlantısı — publishable key güvenlidir, istemci kodunda
   açıkça saklanabilir (asıl güvenlik veritabanındaki RLS politikalarındadır). */
const SUPABASE_URL = 'https://nzahavzumdnilanfstfy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QYQkbSdz1fVcOZpuCepQPw_4cv_eI3-';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
