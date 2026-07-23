/* =========================================================================
   Mersin Yenişehir Belediyesi – Kütüphane Takip Sistemi
   Ortak veri katmanı ve yardımcı fonksiyonlar. Supabase (Postgres + Auth)
   ile çalışır. Güvenlik veritabanındaki RLS (Row Level Security)
   politikalarında uygulanır (bkz. supabase/schema.sql) — buradaki
   hasPermission() / requirePermission() kontrolleri sadece arayüzü
   (butonları, sayfaları) gizlemek içindir.
   ========================================================================= */

const EFFECTIVE_LIB_KEY = 'kutuphane_effective_library';

/* -------------------------------------------------------------------------
   Sabitler
   ------------------------------------------------------------------------- */

const PERMISSIONS = [
  { id: 'lend_return', label: 'Ödünç Verme / İade' },
  { id: 'retire_books', label: 'İmha Talebi Oluşturma' },
  { id: 'approve_retirements', label: 'İmha Onaylama' },
  { id: 'manage_books', label: 'Kitap Kaydı Yönetimi' },
  { id: 'manage_staff', label: 'Personel Yönetimi' },
  { id: 'view_reports', label: 'Kendi Kütüphane Raporu' },
  { id: 'view_reports_all', label: 'Tüm Kütüphaneler Raporu' },
  { id: 'view_feedback', label: 'Geri Bildirimleri Görüntüleme' },
  { id: 'send_notifications', label: 'Toplu Bildirim Gönderme' },
  { id: 'system_admin', label: 'Site & Sistem Yönetimi (Roller, Form Alanları, Site İçeriği)' }
];

const BOOK_SOURCES = ['Satın Alma', 'İhale', 'Bağış', 'Diğer'];
const RETIREMENT_REASONS = ['Yıprandı', 'Kayboldu', 'Su Hasarı', 'Diğer'];

/* Kitap/Üye/Personel formlarında hâlihazırda bulunan sabit alanlar (referans + etiket düzenleme için). */
const CORE_FIELDS = {
  book: [
    { key: 'title', label: 'Başlık', required: true },
    { key: 'author', label: 'Yazar', required: true },
    { key: 'isbn', label: 'ISBN', required: false },
    { key: 'total', label: 'Adet', required: true },
    { key: 'addedDate', label: 'Kayıt Tarihi', required: false },
    { key: 'source', label: 'Kaynak', required: true },
    { key: 'category', label: 'Kategori', required: false },
    { key: 'description', label: 'Açıklama', required: false }
  ],
  member: [
    { key: 'name', label: 'Ad Soyad', required: true },
    { key: 'phone', label: 'Telefon', required: true },
    { key: 'email', label: 'E-posta', required: false },
    { key: 'birthDate', label: 'Doğum Tarihi', required: false },
    { key: 'nationalId', label: 'T.C. Kimlik No', required: false },
    { key: 'library', label: 'Kütüphane', required: true },
    { key: 'address', label: 'Adres', required: false }
  ],
  staff: [
    { key: 'name', label: 'İsim Soyisim', required: true },
    { key: 'phone', label: 'Telefon', required: true },
    { key: 'username', label: 'Kullanıcı Adı', required: false },
    { key: 'password', label: 'Şifre', required: false },
    { key: 'library', label: 'Kütüphane', required: true },
    { key: 'roles', label: 'Roller', required: true }
  ]
};

function defaultSettings() {
  return {
    smtp: { host: '', port: '587', secure: true, username: '', password: '', fromName: 'Yenişehir Belediyesi Kütüphaneleri', fromEmail: '' },
    sms: { provider: '', apiUrl: '', apiKey: '', apiSecret: '', sender: 'YENISEHIR' },
    reportTemplate: { institutionName: 'Mersin Yenişehir Belediyesi', title: 'İmha Tutanağı', footerText: '' },
    policies: { maxActiveRentals: 3, maxRenewals: 1, inactivityMonths: 6 }
  };
}

/* -------------------------------------------------------------------------
   Yardımcı fonksiyonlar
   ------------------------------------------------------------------------- */

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr);
  const b = new Date(toStr);
  return Math.round((b - a) / 86400000);
}
function formatDateTR(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}.${m}.${y}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
/* Kullanıcının 05XX / 5XX / +905XX gibi girdiği telefon numarasını Supabase
   Auth'un beklediği E.164 biçimine (+905XXXXXXXXX) çevirir. */
function normalizeTrPhone(input) {
  let digits = String(input || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('90') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return '+90' + digits;
  return input && input.startsWith('+') ? input : '+90' + digits;
}

function libraryName(id) {
  if (id === 'all') return 'Tüm Kütüphaneler';
  const lib = getData().libraries.find(l => l.id === id);
  return lib ? lib.name : id;
}

/* -------------------------------------------------------------------------
   Kapak görseli
   ------------------------------------------------------------------------- */

function placeholderCover(title) {
  const colors = ['164194', 'EF7D00', '3AAA35', '5B7FBD', 'C9622A', '2C7A6B'];
  let hash = 0;
  for (const ch of String(title || '?')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = colors[hash % colors.length];
  const letter = String(title || '?').trim().charAt(0).toUpperCase() || '?';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='226'><rect width='160' height='226' rx='8' fill='#${color}'/><text x='80' y='128' font-size='74' fill='white' text-anchor='middle' font-family='Segoe UI, Arial' font-weight='bold'>${letter}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function bookCover(book) {
  return (book && book.coverUrl) ? book.coverUrl : placeholderCover(book ? book.title : '?');
}
async function setBookCover(bookId, url) {
  if (!url) return;
  const book = getData().books.find(b => b.id === bookId);
  if (!book || book.coverUrl) return; // mevcut/elle seçilmiş kapağın üzerine yazma
  book.coverUrl = url;
  await sb.from('books').update({ cover_url: url }).eq('id', bookId);
}
async function enrichBookCovers(books, onEach) {
  for (const book of books) {
    const fresh = getData().books.find(b => b.id === book.id);
    if (!fresh || fresh.coverUrl) continue;
    const results = await searchBookCovers(`${fresh.title} ${fresh.author}`);
    if (results && results.length) {
      await setBookCover(fresh.id, results[0].thumbnail);
      if (onEach) onEach(fresh.id, results[0].thumbnail);
    }
    await new Promise(r => setTimeout(r, 120));
  }
}
async function searchBookCovers(query) {
  if (!query || !query.trim()) return [];
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8&fields=title,author_name,cover_i,isbn`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('İstek başarısız');
    const data = await res.json();
    return (data.docs || [])
      .filter(d => d.cover_i)
      .map(d => ({
        title: d.title || '(başlıksız)',
        authors: (d.author_name || []).join(', ') || '(yazar belirtilmemiş)',
        thumbnail: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
        isbn: (d.isbn || [])[0] || ''
      }));
  } catch (e) {
    console.error('Kapak arama hatası:', e);
    return null;
  }
}

/* =========================================================================
   VERİ KATMANI (Supabase)

   getData() SENKRON çalışır ve bellekteki önbelleği (_dataCache) döndürür —
   bu sayede mevcut arayüz kodu (data.books.find(...) vb.) değişmeden
   çalışmaya devam eder. Önbellek, her sayfa açılışında syncFromSupabase()
   ile Supabase'den doldurulur. Veri DEĞİŞTİREN fonksiyonlar (addBook,
   createRental, ...) hem önbelleği anında günceller (hızlı arayüz tepkisi
   için) hem de gerçek değişikliği Supabase'e yazar — bu yüzden hepsi
   `async`tır ve çağrıldıkları yerde `await` ile beklenmelidir.
   ========================================================================= */

let _dataCache = {
  libraries: [], roles: [], staff: [], categories: [], categoryMode: 'single',
  books: [], users: [], rentals: [], retirements: [], events: [], feedback: [], requests: [],
  sliderContent: [], formFields: { book: [], member: [], staff: [] }, smsTemplates: [], emailTemplates: [],
  broadcasts: [], settings: defaultSettings(), fieldLabels: { book: {}, member: {}, staff: {} },
  activityLogs: [], notificationLog: []
};
let _dataSynced = false;

function getData() {
  return _dataCache;
}

/* ---- DB (snake_case) <-> Arayüz (camelCase) alan eşlemeleri ---- */

function mapLibraryFromDb(r) {
  return { id: r.id, name: r.name, weekday: r.weekday, weekend: r.weekend, address: r.address, phone: r.phone, status: r.status, photoUrl: r.photo_url };
}
function mapRoleFromDb(r) {
  return { id: r.id, name: r.name, permissions: r.permissions || [], isSystem: r.is_system, protected: r.protected };
}
function mapStaffFromDb(r) {
  return { id: r.id, name: r.name, phone: r.phone, email: r.email, username: r.username, library: r.all_libraries ? 'all' : r.library_id, roles: r.roles || [], active: r.active, addedDate: r.added_date, extra: r.extra || {} };
}
function mapMemberFromDb(r) {
  return { id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address, birthDate: r.birth_date, nationalId: r.national_id, addedDate: r.added_date, library: r.library_id, smsVerified: r.sms_verified, termsAcceptedAt: r.terms_accepted_at, extra: r.extra || {} };
}
function mapBookFromDb(r) {
  return { id: r.id, title: r.title, author: r.author, isbn: r.isbn, total: r.total, stock: r.stock, library: r.library_id, category: r.category_ids || [], addedDate: r.added_date, source: r.source, description: r.description, coverUrl: r.cover_url, qr: r.qr, retiredCount: r.retired_count, extra: r.extra || {}, logs: r.logs || [] };
}
function mapRentalFromDb(r) {
  return { id: r.id, userId: r.user_id, bookId: r.book_id, rentalDate: r.rental_date, dueDate: r.due_date, returnDate: r.return_date, extendedCount: r.extended_count, lost: r.lost, lostDate: r.lost_date, smsLog: r.sms_log || [], emailLog: r.email_log || [] };
}
function mapRetirementFromDb(r) {
  return { id: r.id, bookId: r.book_id, rentalId: r.rental_id, title: r.title, library: r.library_id, qty: r.qty, reason: r.reason, desc: r.description, photo: r.photo, date: r.date, status: r.status, requestedBy: r.requested_by, approvedBy: r.approved_by, approvedDate: r.approved_date };
}
function mapEventFromDb(r) {
  return { id: r.id, title: r.title, date: r.date, library: r.library_id, desc: r.description };
}
function mapRequestFromDb(r) {
  return { id: r.id, type: r.type, userId: r.user_id, rentalId: r.rental_id, bookTitle: r.book_title, note: r.note, status: r.status, date: r.date };
}
function mapSliderFromDb(r) {
  return { id: r.id, libraryId: r.library_id, title: r.title, subtitle: r.subtitle, order: r.order, visible: r.visible };
}
function mapBroadcastFromDb(r) {
  return { id: r.id, subject: r.subject, body: r.body, date: r.date, library: r.library_id, channels: r.channels || [], emailRecipientCount: r.email_recipient_count, smsRecipientCount: r.sms_recipient_count };
}
function mapActivityLogFromDb(r) {
  return { id: r.id, at: r.at, date: r.at ? r.at.slice(0, 10) : '', actorType: r.actor_type, actorName: r.actor_name, action: r.action, detail: r.detail };
}
function mapNotificationLogFromDb(r) {
  return { id: r.id, at: r.at, date: r.at ? r.at.slice(0, 10) : '', channel: r.channel, category: r.category, to: r.to, subject: r.subject, body: r.body };
}

async function syncFromSupabase() {
  const [
    libraries, roles, staff, members, categories, books, rentals, retirements,
    events, feedback, requests, sliderContent, formFields, fieldLabels,
    smsTemplates, emailTemplates, broadcasts, activityLogs, notificationLog, settingsRows
  ] = await Promise.all([
    sb.from('libraries').select('*'),
    sb.from('roles').select('*'),
    sb.from('staff').select('*'),
    sb.from('members').select('*'),
    sb.from('categories').select('*'),
    sb.from('books').select('*'),
    sb.from('rentals').select('*'),
    sb.from('retirements').select('*'),
    sb.from('events').select('*'),
    sb.from('feedback').select('*'),
    sb.from('requests').select('*'),
    sb.from('slider_content').select('*'),
    sb.from('form_fields').select('*'),
    sb.from('field_labels').select('*'),
    sb.from('sms_templates').select('*'),
    sb.from('email_templates').select('*'),
    sb.from('broadcasts').select('*'),
    sb.from('activity_logs').select('*').order('at', { ascending: false }).limit(500),
    sb.from('notification_log').select('*').order('at', { ascending: false }).limit(500),
    sb.from('settings').select('*').limit(1)
  ]);

  const formFieldsGrouped = { book: [], member: [], staff: [] };
  (formFields.data || []).forEach(f => {
    (formFieldsGrouped[f.form_key] = formFieldsGrouped[f.form_key] || []).push({ id: f.id, label: f.label, type: f.type, required: f.required, options: f.options || [] });
  });
  const fieldLabelsGrouped = { book: {}, member: {}, staff: {} };
  (fieldLabels.data || []).forEach(f => {
    (fieldLabelsGrouped[f.form_key] = fieldLabelsGrouped[f.form_key] || {})[f.field_key] = f.label;
  });
  const settingsRow = (settingsRows.data || [])[0] || {};

  _dataCache = {
    libraries: (libraries.data || []).map(mapLibraryFromDb),
    roles: (roles.data || []).map(mapRoleFromDb),
    staff: (staff.data || []).map(mapStaffFromDb),
    users: (members.data || []).map(mapMemberFromDb),
    categories: (categories.data || []).map(c => ({ id: c.id, name: c.name })),
    categoryMode: settingsRow.category_mode || 'single',
    books: (books.data || []).map(mapBookFromDb),
    rentals: (rentals.data || []).map(mapRentalFromDb),
    retirements: (retirements.data || []).map(mapRetirementFromDb),
    events: (events.data || []).map(mapEventFromDb),
    feedback: (feedback.data || []).map(f => ({ id: f.id, name: f.name, phone: f.phone, message: f.message, date: f.date, read: !!f.read })),
    requests: (requests.data || []).map(mapRequestFromDb),
    sliderContent: (sliderContent.data || []).map(mapSliderFromDb),
    formFields: formFieldsGrouped,
    fieldLabels: fieldLabelsGrouped,
    smsTemplates: (smsTemplates.data || []).map(t => ({ id: t.id, key: t.key, label: t.label, text: t.text })),
    emailTemplates: (emailTemplates.data || []).map(t => ({ id: t.id, key: t.key, label: t.label, subject: t.subject, body: t.body })),
    broadcasts: (broadcasts.data || []).map(mapBroadcastFromDb),
    settings: {
      smtp: settingsRow.smtp || defaultSettings().smtp,
      sms: settingsRow.sms || defaultSettings().sms,
      reportTemplate: settingsRow.report_template || defaultSettings().reportTemplate,
      policies: settingsRow.policies || defaultSettings().policies
    },
    activityLogs: (activityLogs.data || []).map(mapActivityLogFromDb),
    notificationLog: (notificationLog.data || []).map(mapNotificationLogFromDb)
  };
  _dataSynced = true;
  return _dataCache;
}

function resetDemo() {
  // Canlı/paylaşımlı veritabanında "sıfırlama" anlamsız ve tehlikeli
  // olduğu için bu buton artık sadece oturumu kapatır.
  logoutStaff();
}

/* -------------------------------------------------------------------------
   Kullanıcı işlem logları / bildirim geçmişi
   ------------------------------------------------------------------------- */

async function logActivity(actorType, actorName, action, detail) {
  const entry = { actor_type: actorType, actor_name: actorName || '—', action, detail: detail || '' };
  await sb.from('activity_logs').insert(entry);
}
async function logNotification(channel, category, to, subject, body) {
  const entry = { channel, category, to: to || '—', subject: subject || '', body: body || '' };
  await sb.from('notification_log').insert(entry);
}

/* -------------------------------------------------------------------------
   Durum hesaplama
   ------------------------------------------------------------------------- */

function bookStatus(book) {
  if (book.stock <= 0) return { label: 'Stokta Yok', cls: 'danger' };
  if (book.stock <= 1) return { label: 'Az Stok', cls: 'warning' };
  return { label: 'Ulaşılabilir', cls: 'success' };
}
function rentalStatus(rental) {
  if (rental.lost) return { label: 'Kayıp', cls: 'dark', overdueDays: 0 };
  if (rental.returnDate) return { label: 'İade Edildi', cls: 'secondary', overdueDays: 0 };
  const diff = daysBetween(todayStr(), rental.dueDate);
  if (diff < 0) return { label: `Gecikmiş (${-diff} gün)`, cls: 'danger', overdueDays: -diff };
  return { label: `Ödünçte (${diff} gün kaldı)`, cls: 'success', overdueDays: 0 };
}
function categoryName(id) {
  const cat = getData().categories.find(c => c.id === id);
  return cat ? cat.name : '';
}

/* -------------------------------------------------------------------------
   Oturum: Personel (Supabase Auth — e-posta + şifre)
   ------------------------------------------------------------------------- */

let _currentStaff = null;
let _currentMember = null;

function getCurrentStaff() {
  return _currentStaff;
}
function getCurrentMember() {
  return _currentMember;
}
/* Sayfa yüklenirken bir kere çağrılır: aktif Supabase Auth oturumunu okur,
   ilgili personel/üye satırını getData() önbelleğinden bulup session'a koyar. */
async function loadCurrentSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { _currentStaff = null; _currentMember = null; return; }
  const staffRow = getData().staff.find(s => s.id === session.user.id);
  if (staffRow) {
    const activeLibrary = staffRow.library !== 'all' ? staffRow.library : (sessionStorage.getItem(EFFECTIVE_LIB_KEY) || getData().libraries[0]?.id);
    _currentStaff = { ...staffRow, activeLibrary };
    return;
  }
  const memberRow = getData().users.find(u => u.id === session.user.id);
  if (memberRow) { _currentMember = memberRow; return; }
}

async function staffLogin(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, msg: 'E-posta veya şifre hatalı.' };
  await syncFromSupabase();
  const staffRow = getData().staff.find(s => s.id === data.user.id);
  if (!staffRow) { await sb.auth.signOut(); return { ok: false, msg: 'Bu hesap için personel kaydı bulunamadı.' }; }
  if (!staffRow.active) { await sb.auth.signOut(); return { ok: false, msg: 'Bu personel hesabı pasif durumda.' }; }
  const activeLibrary = staffRow.library !== 'all' ? staffRow.library : (getData().libraries[0]?.id || null);
  _currentStaff = { ...staffRow, activeLibrary };
  await logActivity('staff', staffRow.name, 'Personel Girişi', `${staffRow.name} sisteme giriş yaptı.`);
  return { ok: true, staff: _currentStaff };
}
function setEffectiveLibraryChoice(id) {
  sessionStorage.setItem(EFFECTIVE_LIB_KEY, id);
  if (_currentStaff) _currentStaff.activeLibrary = id;
}
async function logoutStaff() {
  const staff = getCurrentStaff();
  if (staff) await logActivity('staff', staff.name, 'Personel Çıkışı', `${staff.name} sistemden çıkış yaptı.`);
  await sb.auth.signOut();
  sessionStorage.removeItem(EFFECTIVE_LIB_KEY);
  location.href = 'personel-girisi.html';
}
function getEffectiveLibrary() {
  const staff = getCurrentStaff();
  return staff ? staff.activeLibrary : null;
}
function setEffectiveLibrary(id) {
  setEffectiveLibraryChoice(id);
}

/* -------------------------------------------------------------------------
   Oturum: Üye (Supabase Auth — telefon + şifre)
   ------------------------------------------------------------------------- */

async function memberSignup(payload) {
  if (payload.nationalId && getData().users.some(u => u.nationalId && u.nationalId === payload.nationalId)) {
    return { ok: false, msg: 'Bu T.C. Kimlik No ile daha önce üyelik oluşturulmuş.' };
  }
  const { data, error } = await sb.auth.signUp({ phone: payload.phone, password: payload.password });
  if (error) return { ok: false, msg: error.message.includes('already registered') ? 'Bu telefon numarasıyla zaten bir hesap var.' : 'Kayıt başarısız: ' + error.message };
  const row = {
    id: data.user.id, name: payload.name, phone: payload.phone, email: payload.email || '',
    address: payload.address || '', birth_date: payload.birthDate || null, national_id: payload.nationalId || '',
    library_id: payload.library, sms_verified: true, terms_accepted_at: payload.termsAcceptedAt || todayStr(),
    extra: payload.extra || {}
  };
  const { data: inserted, error: insErr } = await sb.from('members').insert(row).select().single();
  if (insErr) return { ok: false, msg: 'Üyelik kaydı oluşturulamadı: ' + insErr.message };
  const user = mapMemberFromDb(inserted);
  _dataCache.users.push(user);
  _currentMember = user;
  await logActivity('member', user.name, 'Üyelik Başvurusu', `${user.name} ${libraryName(user.library)} için üyelik başvurusu yaptı.`);
  return { ok: true, user };
}
async function memberLogin(phone, password) {
  const { data, error } = await sb.auth.signInWithPassword({ phone, password });
  if (error) return { ok: false, msg: 'Telefon numarası veya şifre hatalı.' };
  await syncFromSupabase();
  const user = getData().users.find(u => u.id === data.user.id);
  if (!user) { await sb.auth.signOut(); return { ok: false, msg: 'Bu hesap için üyelik kaydı bulunamadı.' }; }
  _currentMember = user;
  await logActivity('member', user.name, 'Üye Girişi', `${user.name} üye portalına giriş yaptı.`);
  return { ok: true, user };
}
async function logoutMember() {
  const member = getCurrentMember();
  if (member) await logActivity('member', member.name, 'Üye Çıkışı', `${member.name} üye portalından çıkış yaptı.`);
  await sb.auth.signOut();
  location.href = 'index.html';
}
async function updateOwnMemberProfile(payload) {
  const member = getCurrentMember();
  if (!member) return { ok: false, msg: 'Oturum bulunamadı.' };
  const patch = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.email !== undefined) patch.email = payload.email;
  if (payload.address !== undefined) patch.address = payload.address;
  const { error } = await sb.from('members').update(patch).eq('id', member.id);
  if (error) return { ok: false, msg: error.message };
  Object.assign(member, payload);
  const cached = getData().users.find(u => u.id === member.id);
  if (cached) Object.assign(cached, payload);
  await logActivity('member', member.name, 'Profil Güncellendi', `${member.name} kendi üyelik bilgilerini güncelledi.`);
  return { ok: true, user: member };
}

/* -------------------------------------------------------------------------
   Rol / yetki
   ------------------------------------------------------------------------- */

function getRoleById(id) {
  return getData().roles.find(r => r.id === id);
}
function staffRoleNames(staff) {
  if (!staff) return [];
  return staff.roles.map(rid => getRoleById(rid)).filter(Boolean).map(r => r.name);
}
function hasPermission(perm) {
  const staff = getCurrentStaff();
  if (!staff) return false;
  return staff.roles.some(rid => {
    const role = getRoleById(rid);
    return role && role.permissions.includes(perm);
  });
}
function requirePermission(perm, label) {
  if (!hasPermission(perm)) {
    const permLabel = label || (PERMISSIONS.find(p => p.id === perm) || {}).label || perm;
    showToast(`Bu işlem için yetkiniz yok: ${permLabel}`, 'danger');
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------
   SMS / OTP simülasyonu (ödünç verme masasında kimlik teyidi için —
   gerçek SMS sağlayıcı Site Yönetimi > Bildirim Ayarları'ndan
   bağlanana kadar demo modunda kalır: kod olarak "1" her zaman geçerlidir.)
   ------------------------------------------------------------------------- */

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function verifyOtp(input, realOtp) {
  return input === '1' || input === realOtp;
}
function sendSms(phone, message, opts) {
  logNotification('sms', (opts && opts.category) || 'Diğer', phone, '', message);
  alert(`📱 SMS Gönderildi (Demo)\nAlıcı: ${phone}\n\n${message}`);
}
function sendEmail(to, subject, body, opts) {
  logNotification('email', (opts && opts.category) || 'Diğer', to, subject, body);
  alert(`✉️ E-posta Gönderildi (Demo)\nAlıcı: ${to}\nKonu: ${subject}\n\n${body}`);
}

/* -------------------------------------------------------------------------
   SMS / E-posta şablonları
   ------------------------------------------------------------------------- */

function fillTemplate(text, vars) {
  vars = vars || {};
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? vars[k] : m));
}
function getSmsTemplate(key) {
  return (getData().smsTemplates || []).find(t => t.key === key);
}
function getEmailTemplate(key) {
  return (getData().emailTemplates || []).find(t => t.key === key);
}
async function updateSmsTemplate(id, payload) {
  const t = (getData().smsTemplates || []).find(x => x.id === id);
  if (!t) return { ok: false, msg: 'Şablon bulunamadı.' };
  const patch = {};
  if (payload.text !== undefined) patch.text = payload.text;
  if (payload.label !== undefined) patch.label = payload.label;
  const { error } = await sb.from('sms_templates').update(patch).eq('id', id);
  if (error) return { ok: false, msg: error.message };
  Object.assign(t, payload);
  return { ok: true, template: t };
}
async function updateEmailTemplate(id, payload) {
  const t = (getData().emailTemplates || []).find(x => x.id === id);
  if (!t) return { ok: false, msg: 'Şablon bulunamadı.' };
  const patch = {};
  if (payload.subject !== undefined) patch.subject = payload.subject;
  if (payload.body !== undefined) patch.body = payload.body;
  if (payload.label !== undefined) patch.label = payload.label;
  const { error } = await sb.from('email_templates').update(patch).eq('id', id);
  if (error) return { ok: false, msg: error.message };
  Object.assign(t, payload);
  return { ok: true, template: t };
}
async function logRentalEmail(rentalId, subject, body) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental) return;
  rental.emailLog = rental.emailLog || [];
  const entry = { date: todayStr(), subject, body };
  rental.emailLog.push(entry);
  await sb.from('rentals').update({ email_log: rental.emailLog }).eq('id', rentalId);
}
async function updateSettings(section, payload) {
  const data = getData();
  data.settings[section] = { ...(data.settings[section] || {}), ...payload };
  const columnBySection = { smtp: 'smtp', sms: 'sms', reportTemplate: 'report_template', policies: 'policies' };
  const column = columnBySection[section];
  const { error } = await sb.from('settings').update({ [column]: data.settings[section] }).eq('id', true);
  if (error) return { ok: false, msg: error.message };
  return { ok: true, settings: data.settings[section] };
}
function getPolicies() {
  return getData().settings.policies || defaultSettings().policies;
}

/* -------------------------------------------------------------------------
   Üye aktivite / pasiflik durumu
   ------------------------------------------------------------------------- */

function getLastActivityDate(user) {
  const dates = [user.addedDate].filter(Boolean);
  getData().rentals.filter(r => r.userId === user.id).forEach(r => dates.push(r.rentalDate));
  return dates.sort().pop();
}
function isMemberInactive(user) {
  const last = getLastActivityDate(user);
  if (!last) return false;
  return daysBetween(last, todayStr()) >= getPolicies().inactivityMonths * 30;
}
function getLostRentalsForUser(userId) {
  return getData().rentals.filter(r => r.userId === userId && r.lost);
}

async function sendBroadcast(subject, body, opts) {
  opts = opts || {};
  const channels = opts.channels || {};
  const data = getData();
  let recipients = data.users;
  if (opts.library && opts.library !== 'all') recipients = recipients.filter(u => u.library === opts.library);
  const emailRecipients = channels.email ? recipients.filter(u => u.email) : [];
  const smsRecipients = channels.sms ? recipients.filter(u => u.phone) : [];

  const row = {
    subject, body, library_id: (opts.library && opts.library !== 'all') ? opts.library : null,
    channels: [channels.email ? 'email' : null, channels.sms ? 'sms' : null].filter(Boolean),
    email_recipient_count: emailRecipients.length, sms_recipient_count: smsRecipients.length
  };
  const { data: inserted, error } = await sb.from('broadcasts').insert(row).select().single();
  if (error) return { ok: false, msg: error.message };
  const broadcast = mapBroadcastFromDb(inserted);
  data.broadcasts.unshift(broadcast);

  for (const u of emailRecipients) await logNotification('email', 'Toplu Bildirim', u.email, subject, body);
  for (const u of smsRecipients) await logNotification('sms', 'Toplu Bildirim', u.phone, '', body);
  const staff = getCurrentStaff();
  await logActivity('staff', staff ? staff.name : '—', 'Toplu Bildirim Gönderildi',
    `"${subject}" konulu bildirim ${!opts.library || opts.library === 'all' ? 'tüm üyelere' : libraryName(opts.library) + ' üyelerine'} gönderildi (${emailRecipients.length} e-posta, ${smsRecipients.length} SMS).`);

  const lines = [`📢 Toplu Bildirim Gönderildi (Demo)`, `Konu: ${subject}`];
  if (channels.email) lines.push(`E-posta alıcı sayısı: ${emailRecipients.length}`);
  if (channels.sms) lines.push(`SMS alıcı sayısı: ${smsRecipients.length}`);
  lines.push('', body);
  alert(lines.join('\n'));
  return { ok: true, broadcast };
}

/* -------------------------------------------------------------------------
   Dinamik form alanları
   ------------------------------------------------------------------------- */

function getFieldLabel(formKey, key) {
  const data = getData();
  return (data.fieldLabels && data.fieldLabels[formKey] && data.fieldLabels[formKey][key]) || '';
}
async function setFieldLabel(formKey, key, label) {
  const data = getData();
  data.fieldLabels[formKey] = data.fieldLabels[formKey] || {};
  if (label) {
    data.fieldLabels[formKey][key] = label;
    await sb.from('field_labels').upsert({ form_key: formKey, field_key: key, label });
  } else {
    delete data.fieldLabels[formKey][key];
    await sb.from('field_labels').delete().eq('form_key', formKey).eq('field_key', key);
  }
}
function applyCoreFieldLabels() {
  document.querySelectorAll('[data-field]').forEach(el => {
    const [formKey, key] = el.dataset.field.split('.');
    const override = getFieldLabel(formKey, key);
    if (override) el.textContent = override;
  });
}

function renderExtraFieldsHtml(formKey, values) {
  values = values || {};
  const fields = getData().formFields[formKey] || [];
  if (!fields.length) return '';
  return fields.map(f => {
    const val = values[f.id] ?? '';
    const req = f.required ? 'required' : '';
    let input;
    if (f.type === 'select') {
      input = `<select class="form-select extra-field" data-field-id="${f.id}" ${req}>
        <option value="">Seçiniz</option>
        ${(f.options || []).map(o => `<option value="${escapeHtml(o)}" ${o === val ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>`;
    } else {
      const type = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
      input = `<input type="${type}" class="form-control extra-field" data-field-id="${f.id}" value="${escapeHtml(val)}" ${req}>`;
    }
    return `<div class="col-md-6 mb-3">
      <label class="form-label">${escapeHtml(f.label)}${f.required ? ' <span class="text-danger">*</span>' : ''}</label>
      ${input}
    </div>`;
  }).join('');
}
function collectExtraFields(containerEl) {
  const out = {};
  containerEl.querySelectorAll('.extra-field').forEach(el => { out[el.dataset.fieldId] = el.value; });
  return out;
}
async function addFormField(formKey, field) {
  const row = { form_key: formKey, label: field.label, type: field.type, required: !!field.required, options: field.options || null };
  const { data, error } = await sb.from('form_fields').insert(row).select().single();
  if (error) return;
  getData().formFields[formKey].push({ id: data.id, label: data.label, type: data.type, required: data.required, options: data.options || [] });
}
async function deleteFormField(formKey, fieldId) {
  getData().formFields[formKey] = getData().formFields[formKey].filter(f => f.id !== fieldId);
  await sb.from('form_fields').delete().eq('id', fieldId);
}

/* -------------------------------------------------------------------------
   Kütüphane yönetimi
   ------------------------------------------------------------------------- */

async function addLibrary(payload) {
  const row = { name: payload.name, weekday: payload.weekday || '', weekend: payload.weekend || '', address: payload.address || '', phone: payload.phone || '', status: payload.status || 'active', photo_url: payload.photoUrl || '' };
  const { data, error } = await sb.from('libraries').insert(row).select().single();
  if (error) return { ok: false, msg: error.message };
  const lib = mapLibraryFromDb(data);
  getData().libraries.push(lib);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Kütüphane Eklendi', `${lib.name} eklendi.`);
  return { ok: true, library: lib };
}
async function updateLibrary(id, payload) {
  const lib = getData().libraries.find(l => l.id === id);
  if (!lib) return { ok: false, msg: 'Kütüphane bulunamadı.' };
  const patch = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.weekday !== undefined) patch.weekday = payload.weekday;
  if (payload.weekend !== undefined) patch.weekend = payload.weekend;
  if (payload.address !== undefined) patch.address = payload.address;
  if (payload.phone !== undefined) patch.phone = payload.phone;
  if (payload.status !== undefined) patch.status = payload.status;
  if (payload.photoUrl !== undefined) patch.photo_url = payload.photoUrl;
  const { error } = await sb.from('libraries').update(patch).eq('id', id);
  if (error) return { ok: false, msg: error.message };
  Object.assign(lib, payload);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Kütüphane Güncellendi', `${lib.name} bilgileri güncellendi.`);
  return { ok: true, library: lib };
}

/* -------------------------------------------------------------------------
   Kategori yönetimi
   ------------------------------------------------------------------------- */

async function addCategory(name) {
  if (getData().categories.some(c => c.name.toLowerCase() === name.toLowerCase())) return false;
  const { data, error } = await sb.from('categories').insert({ name }).select().single();
  if (error) return false;
  getData().categories.push({ id: data.id, name: data.name });
  return true;
}
async function deleteCategory(id) {
  getData().categories = getData().categories.filter(c => c.id !== id);
  await sb.from('categories').delete().eq('id', id);
}
async function setCategoryMode(mode) {
  getData().categoryMode = mode;
  await sb.from('settings').update({ category_mode: mode }).eq('id', true);
}

/* -------------------------------------------------------------------------
   Rol yönetimi (CRUD)
   ------------------------------------------------------------------------- */

async function addRole(name, permissions) {
  const row = { name, permissions: permissions || [], is_system: false, protected: false };
  const { data, error } = await sb.from('roles').insert(row).select().single();
  if (error) return null;
  const role = mapRoleFromDb(data);
  getData().roles.push(role);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Rol Eklendi', `${role.name} rolü eklendi.`);
  return role;
}
async function updateRolePermissions(roleId, permissions) {
  const role = getData().roles.find(r => r.id === roleId);
  if (!role) return false;
  const { error } = await sb.from('roles').update({ permissions }).eq('id', roleId);
  if (error) return false;
  role.permissions = permissions;
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Rol Yetkileri Güncellendi', `${role.name} rolünün yetkileri değiştirildi: ${permissions.join(', ') || 'yok'}.`);
  return true;
}
async function deleteRole(roleId) {
  const role = getData().roles.find(r => r.id === roleId);
  if (role && role.protected) return { ok: false, msg: 'Bu sistem rolü silinemez.' };
  const inUse = getData().staff.some(s => s.roles.includes(roleId));
  if (inUse) return { ok: false, msg: 'Bu role atanmış personel var, önce personelin rolünü değiştirin.' };
  const { error } = await sb.from('roles').delete().eq('id', roleId);
  if (error) return { ok: false, msg: error.message };
  getData().roles = getData().roles.filter(r => r.id !== roleId);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Rol Silindi', `${role ? role.name : roleId} rolü silindi.`);
  return { ok: true };
}

/* -------------------------------------------------------------------------
   Kitap işlemleri
   ------------------------------------------------------------------------- */

async function addBook(payload) {
  const row = {
    title: payload.title, author: payload.author, isbn: payload.isbn || '',
    total: Number(payload.total), stock: Number(payload.total), library_id: payload.library,
    category_ids: payload.category ? (Array.isArray(payload.category) ? payload.category : [payload.category]) : [],
    added_date: payload.addedDate || todayStr(), source: payload.source,
    description: payload.description || '', cover_url: payload.coverUrl || '', extra: payload.extra || {},
    logs: [{ date: payload.addedDate || todayStr(), type: 'Kayıt', note: `Kayıt eklendi (${payload.source}).` }]
  };
  const { data, error } = await sb.from('books').insert(row).select().single();
  if (error) return null;
  const book = mapBookFromDb(data);
  getData().books.push(book);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Kitap Eklendi', `"${book.title}" (${libraryName(book.library)}) eklendi.`);
  return book;
}
async function deleteBook(bookId) {
  const hasActiveRental = getData().rentals.some(r => r.bookId === bookId && !r.returnDate && !r.lost);
  if (hasActiveRental) return { ok: false, msg: 'Bu kitabın aktif ödünç kaydı var, silinemez.' };
  const removedBook = getData().books.find(b => b.id === bookId);
  const { error } = await sb.from('books').delete().eq('id', bookId);
  if (error) return { ok: false, msg: error.message };
  getData().books = getData().books.filter(b => b.id !== bookId);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Kitap Silindi', `"${removedBook ? removedBook.title : bookId}" silindi.`);
  return { ok: true };
}
async function updateBook(bookId, payload) {
  const book = getData().books.find(b => b.id === bookId);
  if (!book) return { ok: false, msg: 'Kitap bulunamadı.' };
  const patch = {};
  const borrowed = book.total - book.stock;
  if (payload.total !== undefined) {
    const newTotal = Number(payload.total);
    if (newTotal < borrowed) return { ok: false, msg: `Toplam adet, şu an ödünçte olan ${borrowed} adetten az olamaz.` };
    patch.total = newTotal;
    patch.stock = newTotal - borrowed;
  }
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.author !== undefined) patch.author = payload.author;
  if (payload.isbn !== undefined) patch.isbn = payload.isbn;
  if (payload.category !== undefined) patch.category_ids = Array.isArray(payload.category) ? payload.category : [payload.category];
  if (payload.description !== undefined) patch.description = payload.description;
  if (payload.source !== undefined) patch.source = payload.source;
  if (payload.addedDate !== undefined) patch.added_date = payload.addedDate;
  if (payload.coverUrl) patch.cover_url = payload.coverUrl;
  if (payload.extra) patch.extra = { ...book.extra, ...payload.extra };
  const newLogs = [...book.logs, { date: todayStr(), type: 'Güncelleme', note: 'Kitap bilgileri güncellendi.' }];
  patch.logs = newLogs;
  const { error } = await sb.from('books').update(patch).eq('id', bookId);
  if (error) return { ok: false, msg: error.message };
  if (patch.total !== undefined) { book.total = patch.total; book.stock = patch.stock; }
  if (payload.title !== undefined) book.title = payload.title;
  if (payload.author !== undefined) book.author = payload.author;
  if (payload.isbn !== undefined) book.isbn = payload.isbn;
  if (payload.category !== undefined) book.category = patch.category_ids;
  if (payload.description !== undefined) book.description = payload.description;
  if (payload.source !== undefined) book.source = payload.source;
  if (payload.addedDate !== undefined) book.addedDate = payload.addedDate;
  if (payload.coverUrl) book.coverUrl = payload.coverUrl;
  if (payload.extra) book.extra = patch.extra;
  book.logs = newLogs;
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Kitap Güncellendi', `"${book.title}" bilgileri güncellendi.`);
  return { ok: true, book };
}

/* -------------------------------------------------------------------------
   Üye işlemleri (personel tarafından — bkz. addStaffOrMemberAccount()
   fonksiyonu ve Supabase Edge Function için ayrı not)
   ------------------------------------------------------------------------- */

async function updateMember(userId, payload) {
  const user = getData().users.find(u => u.id === userId);
  if (!user) return { ok: false, msg: 'Üye bulunamadı.' };
  if (payload.nationalId) {
    const dup = getData().users.find(u => u.id !== userId && u.nationalId && u.nationalId === payload.nationalId);
    if (dup) return { ok: false, msg: 'Bu T.C. Kimlik No başka bir üyeye kayıtlı.' };
  }
  const patch = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.phone !== undefined && payload.phone) patch.phone = payload.phone;
  if (payload.email !== undefined) patch.email = payload.email;
  if (payload.address !== undefined) patch.address = payload.address;
  if (payload.birthDate !== undefined) patch.birth_date = payload.birthDate || null;
  if (payload.nationalId !== undefined) patch.national_id = payload.nationalId;
  if (payload.library !== undefined) patch.library_id = payload.library;
  if (payload.extra) patch.extra = { ...user.extra, ...payload.extra };
  const { error } = await sb.from('members').update(patch).eq('id', userId);
  if (error) return { ok: false, msg: error.message };
  if (payload.name !== undefined) user.name = payload.name;
  if (payload.phone) user.phone = payload.phone;
  if (payload.email !== undefined) user.email = payload.email;
  if (payload.address !== undefined) user.address = payload.address;
  if (payload.birthDate !== undefined) user.birthDate = payload.birthDate;
  if (payload.nationalId !== undefined) user.nationalId = payload.nationalId;
  if (payload.library !== undefined) user.library = payload.library;
  if (payload.extra) user.extra = patch.extra;
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Üye Bilgileri Güncellendi', `${user.name} adlı üyenin bilgileri güncellendi.`);
  return { ok: true, user };
}

/* Personel & üye HESABI oluşturma (yeni Supabase Auth kaydı gerektirir).
   Tarayıcıda secret/admin anahtarı OLMADIĞI için bu işlem, personel oturum
   açmışken normal signUp() çağrısı yapar — Supabase istemcisi bu sırada
   aktif oturumu yeni oluşturulan hesaba geçirir, bu yüzden işlem sonunda
   personeli güvenlik gereği tekrar giriş yapmaya yönlendiririz. */
async function addStaffAccount(payload) {
  const currentSession = getCurrentStaff();
  const { data, error } = await sb.auth.signUp({ email: payload.email, password: payload.password });
  if (error) return { ok: false, msg: 'Hesap oluşturulamadı: ' + error.message };
  const row = {
    id: data.user.id, name: payload.name, phone: payload.phone || '', email: payload.email,
    username: payload.username || payload.email.split('@')[0], library_id: payload.library === 'all' ? null : payload.library,
    all_libraries: payload.library === 'all', roles: payload.roles || [], active: true, extra: payload.extra || {}
  };
  const { data: inserted, error: insErr } = await sb.from('staff').insert(row).select().single();
  await sb.auth.signOut();
  if (insErr) return { ok: false, msg: 'Personel kaydı oluşturulamadı: ' + insErr.message };
  return { ok: true, staff: mapStaffFromDb(inserted), needsRelogin: !!currentSession };
}
async function addMemberAccount(payload) {
  const currentSession = getCurrentStaff();
  if (payload.nationalId && getData().users.some(u => u.nationalId && u.nationalId === payload.nationalId)) {
    return { ok: false, msg: 'Bu T.C. Kimlik No ile daha önce üyelik oluşturulmuş.' };
  }
  const { data, error } = await sb.auth.signUp({ phone: payload.phone, password: payload.password });
  if (error) return { ok: false, msg: 'Hesap oluşturulamadı: ' + error.message };
  const row = {
    id: data.user.id, name: payload.name, phone: payload.phone, email: payload.email || '',
    address: payload.address || '', birth_date: payload.birthDate || null, national_id: payload.nationalId || '',
    library_id: payload.library, sms_verified: true, terms_accepted_at: todayStr(), extra: payload.extra || {}
  };
  const { data: inserted, error: insErr } = await sb.from('members').insert(row).select().single();
  await sb.auth.signOut();
  if (insErr) return { ok: false, msg: 'Üye kaydı oluşturulamadı: ' + insErr.message };
  const user = mapMemberFromDb(inserted);
  getData().users.push(user);
  if (currentSession) await logActivity('staff', currentSession.name, 'Üye Eklendi', `${user.name} adlı üye eklendi (${libraryName(user.library)}).`);
  return { ok: true, user, needsRelogin: !!currentSession };
}

/* -------------------------------------------------------------------------
   Personel işlemleri
   ------------------------------------------------------------------------- */

async function updateStaff(staffId, payload) {
  const staff = getData().staff.find(s => s.id === staffId);
  if (!staff) return { ok: false, msg: 'Personel bulunamadı.' };
  const patch = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.phone !== undefined) patch.phone = payload.phone;
  if (payload.username !== undefined) patch.username = payload.username;
  if (payload.library !== undefined) { patch.library_id = payload.library === 'all' ? null : payload.library; patch.all_libraries = payload.library === 'all'; }
  if (payload.roles !== undefined) patch.roles = payload.roles;
  if (payload.extra) patch.extra = { ...staff.extra, ...payload.extra };
  const { error } = await sb.from('staff').update(patch).eq('id', staffId);
  if (error) return { ok: false, msg: error.message };
  if (payload.name !== undefined) staff.name = payload.name;
  if (payload.phone !== undefined) staff.phone = payload.phone;
  if (payload.username !== undefined) staff.username = payload.username;
  if (payload.library !== undefined) staff.library = payload.library;
  if (payload.roles !== undefined) staff.roles = payload.roles;
  if (payload.extra) staff.extra = patch.extra;
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Personel Güncellendi', `${staff.name} adlı personelin bilgileri güncellendi.`);
  return { ok: true, staff };
}
async function deleteStaff(staffId) {
  const removedStaff = getData().staff.find(s => s.id === staffId);
  const { error } = await sb.from('staff').delete().eq('id', staffId);
  if (error) { showToast(error.message, 'danger'); return; }
  getData().staff = getData().staff.filter(s => s.id !== staffId);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Personel Silindi', `${removedStaff ? removedStaff.name : staffId} adlı personel silindi.`);
}
async function toggleStaffActive(staffId) {
  const s = getData().staff.find(x => x.id === staffId);
  if (!s) return;
  const newActive = !s.active;
  const { error } = await sb.from('staff').update({ active: newActive }).eq('id', staffId);
  if (error) { showToast(error.message, 'danger'); return; }
  s.active = newActive;
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Personel Durumu Değiştirildi', `${s.name} adlı personel ${s.active ? 'aktif' : 'pasif'} yapıldı.`);
}
/* NOT: Şifre sıfırlama artık Supabase Auth üzerinden e-posta ile yapılır
   (bkz. personel.html) — burada personel tablosunda saklanan bir şifre yok. */

/* -------------------------------------------------------------------------
   Ödünç işlemleri
   ------------------------------------------------------------------------- */

async function createRental(payload) {
  const book = getData().books.find(b => b.id === payload.bookId);
  if (!book || book.stock <= 0) return { ok: false, msg: 'Kitap stokta yok.' };
  const user = getData().users.find(u => u.id === payload.userId);
  const activeCount = getData().rentals.filter(r => r.userId === payload.userId && !r.returnDate && !r.lost).length;
  const maxActiveRentals = getPolicies().maxActiveRentals;
  if (activeCount >= maxActiveRentals) return { ok: false, msg: `Bu üye maksimum ödünç kitap sayısına ulaşmış (${maxActiveRentals}).` };

  const row = { user_id: payload.userId, book_id: payload.bookId, rental_date: todayStr(), due_date: addDays(todayStr(), Number(payload.days) || 14) };
  const { data, error } = await sb.from('rentals').insert(row).select().single();
  if (error) return { ok: false, msg: error.message };
  const rental = mapRentalFromDb(data);
  getData().rentals.push(rental);

  book.stock -= 1;
  book.logs = [...book.logs, { date: todayStr(), type: 'Ödünç', note: `${user ? user.name : '—'} adlı üyeye ödünç verildi.` }];
  await sb.from('books').update({ stock: book.stock, logs: book.logs }).eq('id', book.id);

  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Ödünç Verildi', `"${book.title}" kitabı ${user ? user.name : '—'} adlı üyeye ödünç verildi.`);
  return { ok: true, rental };
}
async function returnRental(rentalId) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental || rental.returnDate || rental.lost) return false;
  const returnDate = todayStr();
  const { error } = await sb.from('rentals').update({ return_date: returnDate }).eq('id', rentalId);
  if (error) return false;
  rental.returnDate = returnDate;
  const book = getData().books.find(b => b.id === rental.bookId);
  const user = getData().users.find(u => u.id === rental.userId);
  if (book) {
    book.stock += 1;
    book.logs = [...book.logs, { date: todayStr(), type: 'İade', note: 'Kitap iade alındı.' }];
    await sb.from('books').update({ stock: book.stock, logs: book.logs }).eq('id', book.id);
  }
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'İade Alındı', `"${book ? book.title : '—'}" kitabı ${user ? user.name : '—'} adlı üyeden iade alındı.`);
  return true;
}
async function extendRental(rentalId, days) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental || rental.returnDate || rental.lost) return { ok: false, msg: 'Bu ödünç kaydı uzatılamaz.' };
  const maxRenewals = getPolicies().maxRenewals;
  if ((rental.extendedCount || 0) >= maxRenewals) return { ok: false, msg: `Bu kitap için maksimum süre uzatma hakkı (${maxRenewals}) kullanılmış.` };
  const newDueDate = addDays(rental.dueDate, days || 7);
  const newExtendedCount = (rental.extendedCount || 0) + 1;
  const { error } = await sb.from('rentals').update({ due_date: newDueDate, extended_count: newExtendedCount }).eq('id', rentalId);
  if (error) return { ok: false, msg: error.message };
  rental.dueDate = newDueDate;
  rental.extendedCount = newExtendedCount;
  const book = getData().books.find(b => b.id === rental.bookId);
  const user = getData().users.find(u => u.id === rental.userId);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Süre Uzatıldı', `"${book ? book.title : '—'}" kitabının (${user ? user.name : '—'}) iade süresi ${formatDateTR(rental.dueDate)} tarihine uzatıldı.`);
  return { ok: true, rental };
}
async function reportLostRental(rentalId) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental || rental.returnDate || rental.lost) return { ok: false, msg: 'Bu ödünç kaydı için kayıp bildirilemez.' };
  const user = getData().users.find(u => u.id === rental.userId);
  const book = getData().books.find(b => b.id === rental.bookId);
  const staff = getCurrentStaff();
  const lostDate = todayStr();

  const { error: rentErr } = await sb.from('rentals').update({ lost: true, lost_date: lostDate }).eq('id', rentalId);
  if (rentErr) return { ok: false, msg: rentErr.message };
  rental.lost = true;
  rental.lostDate = lostDate;

  const recRow = {
    book_id: rental.bookId, rental_id: rental.id, title: book ? book.title : '—', library_id: book ? book.library : null,
    qty: 1, reason: 'Kayboldu',
    description: `${user ? user.name : '—'} adlı üye tarafından ${formatDateTR(rental.rentalDate)} tarihinde alınan kitap, ${formatDateTR(lostDate)} tarihinde kayıp olarak işaretlenmiştir. Gerekli işlemlerin yapılması gerekmektedir.`,
    date: todayStr(), status: 'pending', requested_by: staff ? staff.name : '—'
  };
  const { data: recData, error: recErr } = await sb.from('retirements').insert(recRow).select().single();
  if (recErr) return { ok: false, msg: recErr.message };
  const rec = mapRetirementFromDb(recData);
  getData().retirements.push(rec);

  if (book) {
    book.logs = [...book.logs, { date: todayStr(), type: 'Kayıp', note: `${user ? user.name : '—'} adlı üye tarafından iade edilmedi, kayıp bildirildi. İmha onayı bekleniyor.` }];
    await sb.from('books').update({ logs: book.logs }).eq('id', book.id);
  }
  await logActivity('staff', staff ? staff.name : '—', 'Kayıp Bildirildi', `"${book ? book.title : '—'}" kitabı ${user ? user.name : '—'} adlı üye tarafından kayıp bildirildi, imha onayı için talep oluşturuldu.`);
  return { ok: true, rental, retirement: rec };
}
async function undoLostRental(rentalId) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental || !rental.lost) return { ok: false, msg: 'Bu ödünç kaydı kayıp olarak işaretli değil.' };
  const rec = getData().retirements.find(r => r.rentalId === rentalId);
  if (rec && rec.status !== 'pending') return { ok: false, msg: 'Bu kayıp için imha talebi zaten onaylanmış/reddedilmiş, geri alınamaz.' };

  if (rec) {
    const { error } = await sb.from('retirements').delete().eq('id', rec.id);
    if (error) return { ok: false, msg: error.message };
    getData().retirements = getData().retirements.filter(r => r.id !== rec.id);
  }
  const returnDate = todayStr();
  const { error: rentErr } = await sb.from('rentals').update({ lost: false, lost_date: null, return_date: returnDate }).eq('id', rentalId);
  if (rentErr) return { ok: false, msg: rentErr.message };
  rental.lost = false;
  rental.lostDate = null;
  rental.returnDate = returnDate;

  const book = getData().books.find(b => b.id === rental.bookId);
  const user = getData().users.find(u => u.id === rental.userId);
  if (book) {
    book.stock += 1;
    book.logs = [...book.logs, { date: todayStr(), type: 'İade', note: 'Kayıp bildirimi geri alındı, kitap iade alınmış olarak işaretlendi.' }];
    await sb.from('books').update({ stock: book.stock, logs: book.logs }).eq('id', book.id);
  }
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Kayıp Bildirimi Geri Alındı', `"${book ? book.title : '—'}" kitabı (${user ? user.name : '—'}) için kayıp bildirimi geri alındı, iade alınmış olarak işaretlendi.`);
  return { ok: true, rental };
}
async function cancelRental(rentalId) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental || rental.returnDate || rental.lost) return { ok: false, msg: 'Bu ödünç kaydı iptal edilemez.' };
  const book = getData().books.find(b => b.id === rental.bookId);
  const user = getData().users.find(u => u.id === rental.userId);
  const { error } = await sb.from('rentals').delete().eq('id', rentalId);
  if (error) return { ok: false, msg: error.message };
  getData().rentals = getData().rentals.filter(r => r.id !== rentalId);
  if (book) {
    book.stock += 1;
    book.logs = [...book.logs, { date: todayStr(), type: 'İptal', note: `${user ? user.name : '—'} adlı üyeye hatalı verilen ödünç kaydı iptal edildi.` }];
    await sb.from('books').update({ stock: book.stock, logs: book.logs }).eq('id', book.id);
  }
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Ödünç Kaydı İptal Edildi', `"${book ? book.title : '—'}" kitabının ${user ? user.name : '—'} adlı üyeye verilme kaydı iptal edildi (hatalı kayıt).`);
  return { ok: true };
}
async function updateRentalDueDate(rentalId, newDate) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental || rental.returnDate || rental.lost) return { ok: false, msg: 'Bu ödünç kaydı düzenlenemez.' };
  if (!newDate) return { ok: false, msg: 'Geçerli bir tarih girin.' };
  const oldDate = rental.dueDate;
  const { error } = await sb.from('rentals').update({ due_date: newDate }).eq('id', rentalId);
  if (error) return { ok: false, msg: error.message };
  rental.dueDate = newDate;
  const book = getData().books.find(b => b.id === rental.bookId);
  const user = getData().users.find(u => u.id === rental.userId);
  const actor = getCurrentStaff();
  await logActivity('staff', actor ? actor.name : '—', 'Ödünç Kaydı Düzenlendi', `"${book ? book.title : '—'}" (${user ? user.name : '—'}) iade tarihi ${formatDateTR(oldDate)} yerine ${formatDateTR(newDate)} olarak düzeltildi.`);
  return { ok: true, rental };
}
async function logRentalSms(rentalId, message) {
  const rental = getData().rentals.find(r => r.id === rentalId);
  if (!rental) return;
  rental.smsLog = rental.smsLog || [];
  rental.smsLog.push({ date: todayStr(), message });
  await sb.from('rentals').update({ sms_log: rental.smsLog }).eq('id', rentalId);
}

/* -------------------------------------------------------------------------
   İmha (yıpranmış kitap) işlemleri
   ------------------------------------------------------------------------- */

async function createRetirementRequest(payload) {
  const book = getData().books.find(b => b.id === payload.bookId);
  if (!book) return { ok: false, msg: 'Kitap bulunamadı.' };
  const staff = getCurrentStaff();
  const row = {
    book_id: payload.bookId, title: book.title, library_id: book.library,
    qty: Number(payload.qty), reason: payload.reason, description: payload.desc || '', photo: payload.photo || '',
    date: todayStr(), status: 'pending', requested_by: staff ? staff.name : '—'
  };
  const { data, error } = await sb.from('retirements').insert(row).select().single();
  if (error) return { ok: false, msg: error.message };
  const rec = mapRetirementFromDb(data);
  getData().retirements.push(rec);
  await logActivity('staff', staff ? staff.name : '—', 'İmha Talebi Oluşturuldu', `"${book.title}" için ${rec.qty} adet imha talebi oluşturuldu (${rec.reason}).`);
  return { ok: true, rec };
}
async function approveRetirement(id) {
  const rec = getData().retirements.find(r => r.id === id);
  if (!rec || rec.status !== 'pending') return false;
  const book = getData().books.find(b => b.id === rec.bookId);
  const staff = getCurrentStaff();
  if (book) {
    const newStock = rec.rentalId ? book.stock : Math.max(0, book.stock - rec.qty);
    const newTotal = Math.max(0, book.total - rec.qty);
    const newRetiredCount = (book.retiredCount || 0) + rec.qty;
    const newLogs = [...book.logs, { date: todayStr(), type: 'İmha', note: `${rec.qty} adet imha edildi (${rec.reason}). Onaylayan: ${staff ? staff.name : '—'}` }];
    await sb.from('books').update({ stock: newStock, total: newTotal, retired_count: newRetiredCount, logs: newLogs }).eq('id', book.id);
    book.stock = newStock; book.total = newTotal; book.retiredCount = newRetiredCount; book.logs = newLogs;
  }
  const approvedDate = todayStr();
  const { error } = await sb.from('retirements').update({ status: 'approved', approved_by: staff ? staff.name : '—', approved_date: approvedDate }).eq('id', id);
  if (error) return false;
  rec.status = 'approved'; rec.approvedBy = staff ? staff.name : '—'; rec.approvedDate = approvedDate;
  await logActivity('staff', staff ? staff.name : '—', 'İmha Onaylandı', `"${rec.title}" için ${rec.qty} adet imha onaylandı (${rec.reason}).`);
  return true;
}
async function rejectRetirement(id) {
  const rec = getData().retirements.find(r => r.id === id);
  if (!rec) return false;
  const staff = getCurrentStaff();
  const approvedDate = todayStr();
  const { error } = await sb.from('retirements').update({ status: 'rejected', approved_by: staff ? staff.name : '—', approved_date: approvedDate }).eq('id', id);
  if (error) return false;
  rec.status = 'rejected'; rec.approvedBy = staff ? staff.name : '—'; rec.approvedDate = approvedDate;
  await logActivity('staff', staff ? staff.name : '—', 'İmha Reddedildi', `"${rec.title}" için imha talebi reddedildi.`);
  return true;
}

/* -------------------------------------------------------------------------
   Etkinlik / geri bildirim / talepler
   ------------------------------------------------------------------------- */

async function updateSlide(id, payload) {
  const slide = getData().sliderContent.find(s => s.id === id);
  if (!slide) return;
  const patch = {};
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.subtitle !== undefined) patch.subtitle = payload.subtitle;
  if (payload.order !== undefined) patch.order = payload.order;
  if (payload.visible !== undefined) patch.visible = payload.visible;
  const { error } = await sb.from('slider_content').update(patch).eq('id', id);
  if (error) return;
  Object.assign(slide, payload);
}

async function addEvent(ev) {
  const row = { title: ev.title, date: ev.date, library_id: ev.library, description: ev.desc || '' };
  const { data, error } = await sb.from('events').insert(row).select().single();
  if (error) return;
  getData().events.push(mapEventFromDb(data));
}
async function deleteEvent(id) {
  getData().events = getData().events.filter(e => e.id !== id);
  await sb.from('events').delete().eq('id', id);
}
async function addFeedback(fb) {
  const row = { name: fb.name, phone: fb.phone || '', message: fb.message };
  const { data, error } = await sb.from('feedback').insert(row).select().single();
  if (error) return;
  getData().feedback.push({ id: data.id, name: data.name, phone: data.phone, message: data.message, date: data.date, read: !!data.read });
  await logActivity('member', fb.name || '—', 'Geri Bildirim Gönderildi', `${fb.name || 'Bir ziyaretçi'} geri bildirim gönderdi: "${fb.message}"`);
}
async function setFeedbackRead(id, read) {
  const fb = getData().feedback.find(f => f.id === id);
  if (!fb) return { ok: false, msg: 'Geri bildirim bulunamadı.' };
  const { error } = await sb.from('feedback').update({ read }).eq('id', id);
  if (error) return { ok: false, msg: error.message };
  fb.read = read;
  return { ok: true };
}
async function addRequest(req) {
  const row = { type: req.type, user_id: req.userId, rental_id: req.rentalId || null, book_title: req.bookTitle || null, note: req.note || '' };
  const { data, error } = await sb.from('requests').insert(row).select().single();
  if (error) return;
  getData().requests.push(mapRequestFromDb(data));
  const reqUser = getData().users.find(u => u.id === req.userId);
  const actionLabel = req.type === 'extend' ? 'Süre Uzatma Talebi' : 'İstek Listesi Talebi';
  const detail = req.type === 'extend'
    ? `${reqUser ? reqUser.name : '—'} bir kitap için süre uzatma talebinde bulundu.`
    : `${reqUser ? reqUser.name : '—'} "${req.bookTitle}" kitabının kataloğa eklenmesini talep etti.`;
  await logActivity('member', reqUser ? reqUser.name : '—', actionLabel, detail);
}
async function updateRequestStatus(id, status) {
  const r = getData().requests.find(x => x.id === id);
  if (!r) return { ok: false, msg: 'Talep bulunamadı.' };
  if (status === 'approved' && r.type === 'extend' && r.rentalId) {
    const rental = getData().rentals.find(x => x.id === r.rentalId);
    if (!rental || rental.returnDate || rental.lost) return { ok: false, msg: 'Bu ödünç kaydı uzatılamaz.' };
    const maxRenewals = getPolicies().maxRenewals;
    if ((rental.extendedCount || 0) >= maxRenewals) return { ok: false, msg: `Bu kitap için maksimum süre uzatma hakkı (${maxRenewals}) kullanılmış.` };
    const newDueDate = addDays(rental.dueDate, 7);
    const newExtendedCount = (rental.extendedCount || 0) + 1;
    const { error: rentErr } = await sb.from('rentals').update({ due_date: newDueDate, extended_count: newExtendedCount }).eq('id', rental.id);
    if (rentErr) return { ok: false, msg: rentErr.message };
    rental.dueDate = newDueDate;
    rental.extendedCount = newExtendedCount;
  }
  const { error } = await sb.from('requests').update({ status }).eq('id', id);
  if (error) return { ok: false, msg: error.message };
  r.status = status;
  const reqActor = getCurrentStaff();
  const reqUser2 = getData().users.find(u => u.id === r.userId);
  await logActivity('staff', reqActor ? reqActor.name : '—', status === 'approved' ? 'Talep Onaylandı' : 'Talep Reddedildi',
    `${reqUser2 ? reqUser2.name : '—'} adlı üyenin talebi ${status === 'approved' ? 'onaylandı' : 'reddedildi'}.`);
  return { ok: true };
}

/* -------------------------------------------------------------------------
   Toast bildirimi
   ------------------------------------------------------------------------- */

function showToast(message, type) {
  type = type || 'primary';
  let holder = document.getElementById('toast-holder');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'toast-holder';
    holder.style.position = 'fixed';
    holder.style.top = '1rem';
    holder.style.right = '1rem';
    holder.style.zIndex = '2000';
    document.body.appendChild(holder);
  }
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${type} border-0 show mb-2`;
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${escapeHtml(message)}</div>
    <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.closest('.toast').remove()"></button></div>`;
  holder.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* -------------------------------------------------------------------------
   Navbar / sayfa iskeleti
   ------------------------------------------------------------------------- */

const ADMIN_NAV_ITEMS = [
  { key: 'index', href: 'panel.html', label: 'Ana Sayfa' },
  { key: 'kitaplar', href: 'kitaplar.html', label: 'Kitaplar', perm: 'manage_books' },
  { key: 'uyeler', href: 'uyeler.html', label: 'Üyeler', perm: ['manage_staff', 'lend_return'] },
  { key: 'kiralama', href: 'kiralama.html', label: 'Ödünç İşlemleri', perm: 'lend_return' },
  { key: 'rapor', href: 'rapor.html', label: 'Rapor', perm: ['view_reports', 'view_reports_all'] },
  { key: 'imha', href: 'imha.html', label: 'Yıpranmış Kitaplar', perm: ['retire_books', 'lend_return', 'approve_retirements'] },
  { key: 'talepler', href: 'talepler.html', label: 'Talepler', perm: ['lend_return', 'view_feedback'] },
  { key: 'personel', href: 'personel.html', label: 'Personel', perm: 'manage_staff' }
];

function hasAnyPermission(perm) {
  if (!perm) return true;
  const perms = Array.isArray(perm) ? perm : [perm];
  return perms.some(p => hasPermission(p));
}

function renderAdminNavbar(activeKey) {
  const holder = document.getElementById('app-navbar');
  if (!holder) return;
  const staff = getCurrentStaff();
  const pendingApprovals = staff && hasPermission('approve_retirements')
    ? getData().retirements.filter(r => r.status === 'pending').length : 0;
  const pendingRequests = staff ? getData().requests.filter(r => r.status === 'pending').length : 0;
  const unreadFeedback = staff && hasPermission('view_feedback') ? getData().feedback.filter(f => !f.read).length : 0;
  const talepBadgeCount = pendingRequests + unreadFeedback;

  let links = '';
  if (staff) {
    links = ADMIN_NAV_ITEMS.filter(item => hasAnyPermission(item.perm)).map(item => {
      let badge = '';
      if (item.key === 'imha' && pendingApprovals > 0) badge = ` <span class="badge bg-orange ms-1">${pendingApprovals}</span>`;
      if (item.key === 'talepler' && talepBadgeCount > 0) badge = ` <span class="badge bg-orange ms-1">${talepBadgeCount}</span>`;
      return `<li class="nav-item"><a class="nav-link ${item.key === activeKey ? 'active' : ''}" href="${item.href}">${item.label}${badge}</a></li>`;
    }).join('');

    if (hasPermission('send_notifications')) {
      links += `<li class="nav-item"><a class="nav-link ${activeKey === 'toplu-bildirim' ? 'active' : ''}" href="toplu-bildirim.html">Toplu Bildirim</a></li>`;
    }
    if (hasPermission('system_admin')) {
      links += `<li class="nav-item"><a class="nav-link ${activeKey === 'site-yonetimi' ? 'active' : ''}" href="site-yonetimi.html">Site Yönetimi</a></li>`;
    }
  }

  const rightSide = staff
    ? `<span class="navbar-text text-white-50 small me-3 d-none d-lg-inline">${escapeHtml(staff.name)} · ${escapeHtml(staffRoleNames(staff).join(', '))} · ${escapeHtml(libraryName(staff.activeLibrary))}</span>
       <button class="btn btn-sm btn-warning" onclick="logoutStaff()">Çıkış</button>`
    : `<a href="personel-girisi.html" class="btn btn-sm btn-warning">Personel Girişi</a>`;

  holder.innerHTML = `
  <nav class="navbar navbar-expand-lg navbar-dark app-navbar sticky-top">
    <div class="container-fluid">
      <a class="navbar-brand d-flex align-items-center gap-2" href="panel.html">
        <img src="assets/yenisehir-logo.svg" alt="Mersin Yenişehir Belediyesi" class="brand-logo">
        <span class="d-none d-md-inline">Yenişehir Kütüphane Sistemi</span>
      </a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#adminNav">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="adminNav">
        <ul class="navbar-nav me-auto">${links}</ul>
        <div class="d-flex align-items-center flex-wrap gap-1 mt-2 mt-lg-0">${rightSide}</div>
      </div>
    </div>
  </nav>`;
}

const PUBLIC_NAV_LINKS = [
  { href: 'index.html#anasayfa', label: 'Ana Sayfa', key: 'anasayfa' },
  { href: 'index.html#koleksiyon', label: 'Koleksiyon', key: 'koleksiyon' },
  { href: 'index.html#hizmetler', label: 'Hizmetler', key: 'hizmetler' },
  { href: 'index.html#etkinlikler', label: 'Etkinlikler', key: 'etkinlikler' },
  { href: 'index.html#kutuphanelerimiz', label: 'Kütüphanelerimiz', key: 'kutuphanelerimiz' },
  { href: 'index.html#hakkimizda', label: 'Hakkımızda', key: 'hakkimizda' },
  { href: 'index.html#iletisim', label: 'İletişim', key: 'iletisim' }
];

function renderPublicNavbar(activeKey) {
  const holder = document.getElementById('app-navbar');
  if (!holder) return;
  const member = getCurrentMember();
  const rightSide = member
    ? `<span class="text-navy small me-2 fw-semibold d-none d-md-inline">${escapeHtml(member.name)}</span>
       <a href="uye-girisi.html" class="btn btn-sm btn-navy">Portalım</a>`
    : `<a href="uye-girisi.html" class="btn btn-sm btn-outline-navy ${activeKey === 'giris' ? 'active' : ''}">Üye Girişi</a>
       <a href="uye-basvuru.html" class="btn btn-sm btn-navy ${activeKey === 'basvuru' ? 'active' : ''}">Üye Ol</a>`;

  const navLinks = PUBLIC_NAV_LINKS.map(l =>
    `<li class="nav-item"><a class="nav-link ${activeKey === l.key ? 'active' : ''}" href="${l.href}">${l.label}</a></li>`
  ).join('');

  holder.innerHTML = `
  <nav class="navbar navbar-expand-lg public-navbar sticky-top">
    <div class="container-fluid px-3 px-lg-4">
      <a class="navbar-brand d-flex align-items-center gap-2" href="index.html#anasayfa">
        <img src="assets/yenisehir-logo.svg" alt="Mersin Yenişehir Belediyesi" class="brand-logo">
        <span class="brand-wordmark">YENİŞEHİR<br>KÜTÜPHANELERİ</span>
      </a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#publicNav">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="publicNav">
        <ul class="navbar-nav mx-lg-auto public-nav-links">${navLinks}</ul>
        <div class="d-flex align-items-center flex-wrap gap-2 mt-2 mt-lg-0">${rightSide}</div>
      </div>
    </div>
  </nav>`;
}

function renderPublicFooter() {
  const holder = document.getElementById('app-footer');
  if (!holder) return;
  holder.innerHTML = `
  <footer class="app-footer mt-5 pt-5 pb-4">
    <div class="container">
      <div class="newsletter-box mb-5">
        <div class="row align-items-center g-3">
          <div class="col-md-6 d-flex align-items-center gap-2">
            <i class="bi bi-envelope fs-4"></i>
            <div>
              <div class="fw-semibold">Bültenimize Abone Olun</div>
              <div class="small text-white-50">Etkinliklerden ve duyurulardan haberdar olun.</div>
            </div>
          </div>
          <div class="col-md-6">
            <div class="input-group">
              <input type="email" id="newsletterEmail" class="form-control" placeholder="E-posta adresiniz">
              <button class="btn btn-orange" onclick="subscribeNewsletter()">Abone Ol</button>
            </div>
          </div>
        </div>
      </div>
      <div class="d-flex flex-wrap justify-content-between align-items-center border-top border-light border-opacity-10 pt-4">
        <div class="small text-white-50">Mersin Yenişehir Belediyesi Kütüphane Takip Sistemi · <a href="personel-girisi.html" class="text-white-50">Personel Girişi</a></div>
        <div class="d-flex align-items-center gap-3">
          <span class="small text-white-50 me-1">Bizi Takip Edin</span>
          <a href="#" class="social-icon" title="Yakında"><i class="bi bi-facebook"></i></a>
          <a href="#" class="social-icon" title="Yakında"><i class="bi bi-instagram"></i></a>
          <a href="#" class="social-icon" title="Yakında"><i class="bi bi-twitter-x"></i></a>
          <a href="#" class="social-icon" title="Yakında"><i class="bi bi-youtube"></i></a>
        </div>
      </div>
    </div>
  </footer>`;
}

function subscribeNewsletter() {
  const email = (document.getElementById('newsletterEmail') || {}).value || '';
  if (!email.trim()) { showToast('Lütfen e-posta adresinizi girin.', 'danger'); return; }
  showToast('Bültenimize abone oldunuz. Teşekkür ederiz!', 'success');
  document.getElementById('newsletterEmail').value = '';
}

/* -------------------------------------------------------------------------
   Sayfa iskeleti başlatma

   NOT: Artık asenkrondur (Supabase'den veri çekmesi gerekir). Her sayfanın
   kendi <script> bloğu şu şekilde çağırmalıdır:
     (async () => { if (await initAdminPage('kiralama', {...})) boot(); })();
   ------------------------------------------------------------------------- */

async function initAdminPage(activeKey, opts) {
  opts = opts || {};
  await syncFromSupabase();
  await loadCurrentSession();
  renderAdminNavbar(activeKey);
  const staff = getCurrentStaff();
  const guard = document.getElementById('login-required');
  const content = document.getElementById('page-content');
  if (opts.requireLogin && !staff) {
    if (guard) guard.classList.remove('d-none');
    if (content) content.classList.add('d-none');
    return false;
  }
  if (opts.requirePermission && staff && !hasAnyPermission(opts.requirePermission)) {
    if (guard) {
      guard.classList.remove('d-none');
      guard.innerHTML = `<div class="alert alert-warning">Bu sayfayı görüntülemek için yetkiniz bulunmuyor.</div>`;
    }
    if (content) content.classList.add('d-none');
    return false;
  }
  if (guard) guard.classList.add('d-none');
  if (content) content.classList.remove('d-none');
  return true;
}

/* Halka açık sayfalar (index.html, uye-girisi.html, uye-basvuru.html) için:
   veriyi çeker ve mevcut üye oturumunu (varsa) yükler. */
async function initPublicPage() {
  await syncFromSupabase();
  await loadCurrentSession();
}
